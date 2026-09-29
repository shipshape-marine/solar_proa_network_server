const { write_to_clients } = require("../../client_transmission");
const { insertGPSDataBulk, getLatestGPSRunId } = require("../../../model/gps_db");

const BULK_INSERT_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const MAX_QUEUE = 5000;

const gpsQueue = [];
let gpsRunId = null;
let runIdPromise = null;
let consuming = false;
let flushTimer = null;

async function getCurrentGPSRunId() {
    if (gpsRunId !== null) return gpsRunId;
    if (!runIdPromise) {
        runIdPromise = getLatestGPSRunId()
            .then(({ run_id, is_new }) => {
                gpsRunId = run_id;
                console.log(`[GPS] Current run_id: ${run_id}, is_new: ${is_new}`);
                return run_id;
            })
            .catch((err) => {
                console.error('[GPS] Failed to resolve run_id, defaulting to 1:', err.message);
                gpsRunId = 1;
                return 1;
            });
    }
    return runIdPromise;
}

function ensureFlushTimer() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        consumeGPSQueue(true);
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

function checksum16Bytes(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
        sum = ((sum << 1) ^ buf[i] ^ (sum >>> 15)) & 0xFFFF;
    }
    return sum;
}

/*
GPS Data structure:
struct __attribute__((packed)) PacketTemplate {
  uint32_t header;
  uint16_t counter;
  PayloadT payload;
  uint8_t padding[PAD_BYTES];   // 0 as the total packet size adds up to exactly 28 bytes
  uint16_t chksum;
};

struct __attribute__((packed)) GPSPayload {
  int32_t latitude;    // fixed-point ×1e7
  int32_t longitude;   // fixed-point ×1e7
  int16_t altitude;    // meters
  uint16_t speed;      // km/h
  uint16_t course;     // degrees ×100
  uint16_t hdop;       // cm
  uint8_t satellites;  // number of satellites
};
// Total size = 4+4+2+2+2+2+1 = 17 bytes
*/
function parseGPSData(recvBuf, packet_bytes, packetSkipped = 0) {
    const counter = recvBuf.readUInt16LE(4);
    const latitude = recvBuf.readInt32LE(6) / 1e7; // Convert from fixed-point to degrees
    const longitude = recvBuf.readInt32LE(10) / 1e7;
    const altitude = recvBuf.readInt16LE(14);
    const speed = recvBuf.readUInt16LE(16);
    const course = recvBuf.readUInt16LE(18) / 100;
    const hdop = recvBuf.readUInt16LE(20) / 100; // Convert from cm to meters
    const satellites = recvBuf.readUInt8(22);
    const padding = recvBuf.readUInt8(23); // Padding byte, should be 0
    const chksum = recvBuf.readUInt16LE(26);

    const checksumBuf = recvBuf.subarray(4, 26); // Checksum covers counter, payload, and padding
    if (recvBuf[23] !== 0 || recvBuf[24] !== 0 || recvBuf[25] !== 0) {
        console.warn(`[GPS] Padding byte is not zero at counter ${counter}. Re-syncing.`);
        return null;
    }
    if (chksum !== checksum16Bytes(checksumBuf)) {
        console.warn(`[GPS] Checksum fail. Re-syncing.`);
        return null;
    }

    const valid = Number.isFinite(latitude)
        && Number.isFinite(longitude)
        && latitude >= -90
        && latitude <= 90
        && longitude >= -180
        && longitude <= 180
        && satellites > 0
        && !(latitude === 0 && longitude === 0);

    const telemetry = {
        counter,
        latitude,
        longitude,
        altitude,
        speed,
        course,
        hdop,
        satellites,
        valid,
        recv_ms: Date.now()
    };

    if (!valid) {
        console.warn(`[GPS] No valid fix at counter ${counter}; skipped packets: ${packetSkipped}`);
    }
    write_to_clients("gps", telemetry);
    gpsQueue.push(telemetry);
    ensureFlushTimer();

    return recvBuf.subarray(packet_bytes); // Return the remaining buffer after processing the packet
}

async function consumeGPSQueue(force = false) {
    if (consuming || gpsQueue.length === 0) return;
    if (!force && gpsQueue.length < BULK_INSERT_SIZE) return;

    consuming = true;
    const batch = gpsQueue.splice(0, gpsQueue.length);
    try {
        const runId = await getCurrentGPSRunId();
        await insertGPSDataBulk(batch.map((sample) => ({ ...sample, run_id: runId })));
    } catch (err) {
        console.error('[GPS] Bulk insert error:', err.message);
        if (gpsQueue.length + batch.length <= MAX_QUEUE) {
            gpsQueue.unshift(...batch);
        } else {
            console.error(`[GPS] Backlog over ${MAX_QUEUE}, dropping ${batch.length} rows.`);
        }
    } finally {
        consuming = false;
    }
}

async function flushGPSQueue() {
    return consumeGPSQueue(true);
}

module.exports = {
    parseGPSData,
    consumeGPSQueue,
    flushGPSQueue,
    getCurrentGPSRunId,
};