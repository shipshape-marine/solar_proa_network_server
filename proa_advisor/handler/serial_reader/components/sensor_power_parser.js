const { setSensorPowerConsumption } = require('../../../lib/Kalman Filter/kalman_filter');
const { getRunMode } = require('../../run_mode');

function checksum16Bytes(buf) {
    let sum = 0;

    for (let i = 0; i < buf.length; i++) {
        sum = ((sum << 1) ^ buf[i] ^ (sum >>> 15)) & 0xFFFF;
    }

    return sum;
}

/*
struct __attribute__((packed)) PacketTemplate {
  uint32_t header;
  uint16_t counter;
  PayloadT payload;
  uint8_t padding[PAD_BYTES];   // 0 as the total packet size adds up to exactly 28 bytes
  uint16_t chksum;
};

struct __attribute__((packed)) Sensor_Power_Payload {
  float shuntvoltage;  // float equivalent to 32bit
  float busvoltage;
  float current_mA;
  float loadvoltage;
  float power_mW;
};
*/

function parseSensorPowerData(recvBuf, packet_bytes, packetSkipped = 0) {
    const counter = recvBuf.readUInt16LE(4);
    const shuntvoltage = recvBuf.readFloatLE(6);
    const busvoltage = recvBuf.readFloatLE(10);
    const current_mA = recvBuf.readFloatLE(14);
    const loadvoltage = recvBuf.readFloatLE(18);
    const power_mW = recvBuf.readFloatLE(22);
    const chksum = recvBuf.readUInt16LE(26); 

    const checksumCalBuffer = recvBuf.subarray(4, 26);

    if (chksum !== checksum16Bytes(checksumCalBuffer)) {
        console.warn(`Checksum fail at counter ${counter}. Re-syncing.`);
        recvBuf = recvBuf.subarray(1);
        return null;
    }

    //console.log(`Shunt: ${shuntvoltage}V; Bus: ${busvoltage}V; Load: ${loadvoltage}V`)
    //console.log(`Load: ${current_mA}mA; Power: ${power_mW}mW`)

    // Update the sensor power consumption in the Kalman filter.
    // Live only: it would add today's sensor draw to a replay (test) or a simulation (game).
    if (getRunMode() === 'normal') {
        setSensorPowerConsumption(power_mW / 1000); // Convert mW to W
    }
    
    return recvBuf.subarray(packet_bytes); // Return the remaining buffer after processing the packet
}

module.exports = {
    parseSensorPowerData
}