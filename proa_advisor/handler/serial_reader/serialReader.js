const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { onNewSample } = require("../../lib/Kalman Filter/kalman_filter")
const { parsePowerData, consumePowerQueue } = require('./components/power_data_parser');
const { parseSensorPowerData } = require('./components/sensor_power_parser');
const { parseIMUData, consumeIMUQueue, flushIMUQueue } = require('./components/imu_data_parser');
const { parseStrainData, consumeStrainQueue, flushStrainQueue } = require('./components/strain_data_parser');
const { parseGPSData, consumeGPSQueue, flushGPSQueue } = require('./components/gps_data_parser');
const PACKET_BYTES = 4 + 2 + 4 + (8 * 2) + 2; // Fix at 28 bytes
const POWER_HEADER = 'PWER';
const POWER_HEADER_BUFFER = Buffer.from(POWER_HEADER, 'ascii');
const POWER_HEADER_INT = POWER_HEADER_BUFFER.readUInt32LE(0);

const SENSOR_HEADER = 'SENS';
const SENSOR_HEADER_BUFFER = Buffer.from(SENSOR_HEADER, 'ascii');
const SENSOR_HEADER_INT = SENSOR_HEADER_BUFFER.readUInt32LE(0);

const IMU_HEADER = 'MAST';
const IMU_HEADER_BUFFER = Buffer.from(IMU_HEADER, 'ascii');
const IMU_HEADER_INT = IMU_HEADER_BUFFER.readUInt32LE(0);

const STRAIN_HEADER = 'STRN';
const STRAIN_HEADER_BUFFER = Buffer.from(STRAIN_HEADER, 'ascii');
const STRAIN_HEADER_INT = STRAIN_HEADER_BUFFER.readUInt32LE(0);

const GPS_HEADER = 'GPSM';
const GPS_HEADER_BUFFER = Buffer.from(GPS_HEADER, 'ascii');
const GPS_HEADER_INT = GPS_HEADER_BUFFER.readUInt32LE(0);

let connectedPort = null;
function getConnectedPort() {
    return connectedPort;
}

async function findValidPort(baudRate = 2000000, timeoutMs = 2000) {
    // Get the list of ports for the device
    // Ports only show up when something is connected, so need to re-fetch the list
    const portList = await SerialPort.list();

    if (portList.length === 0) {
        console.log('No connected serial ports found.');
        return null;
    }

    for (const portInfo of portList) {
        // Iterate through serial port
        // Write a trigger b'START\n' to each port and wait for a valid response of "ADC READY'
        // or if length of line == packet bytes, return that port
        try {
            const port = new SerialPort({ path: portInfo.path, baudRate, autoOpen: false });
            if (!portInfo.vendorId || !portInfo.productId) {
                console.log(`Skipping port ${portInfo.path} with missing vendor or product ID.`);
                continue;
            }
            port.on('error', (err) => {
                console.error(`SerialPort error on ${portInfo.path}:`, err.message);
            });
            port.open();
            const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

            for (let attempt = 0; attempt < 3; attempt++) {
                port.write('START\n');
                await port.drain();

                const line = await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        parser.removeAllListeners('data');
                        resolve(null);
                    }, timeoutMs);

                    parser.once('data', (data) => {
                        clearTimeout(timeout);
                        parser.removeAllListeners('data');
                        resolve(data.trim());
                    });
                });
                if (line == null) {
                    
                } else if (line && line.includes('ADC Ready')) {
                    return { port, path: portInfo.path };
                } else if (line && line.includes(POWER_HEADER) || line.includes(SENSOR_HEADER)
                    || line.includes(IMU_HEADER) || line.includes(STRAIN_HEADER) || line.includes(GPS_HEADER) ) {
                    return { port, path: portInfo.path };
                }
                console.log(`Attempt ${attempt + 1}/3: No valid response from ${portInfo.path}`);
            }

            port.close();
        }
        catch (err) {
            console.error(`Error testing port ${portInfo.path}: ${err.message}`);
        }
    }

    console.log('No valid serial ports found after testing all candidates.');
    return null;
}


let recvBuf = Buffer.alloc(0);

let packetSkipped = 0;
function processBuffer() {
    let headerType = null;
    // Scan for a valid packet starting at offset 0, discard bytes until we find one
    while (recvBuf.length >= PACKET_BYTES) {
        // Find header
        headerType = recvBuf.readUInt32LE(0);
        //console.log("Header found:", headerType)
        if (headerType === POWER_HEADER_INT) {
            //console.log("power");
            if (recvBuf.length < PACKET_BYTES) break;
            const result = parsePowerData(recvBuf, PACKET_BYTES, packetSkipped);
            if (!result) {
                packetSkipped++;
                recvBuf = recvBuf.subarray(1); // Advance one byte to re-sync
                    continue; // Resync to next header
            } else {
                recvBuf = result;
                packetSkipped = 0;
            }
        } else if (headerType === SENSOR_HEADER_INT) {
            //console.log("Sensor");
            if (recvBuf.length < PACKET_BYTES) break;
            const result = parseSensorPowerData(recvBuf, PACKET_BYTES, packetSkipped);
            if (!result) {
                packetSkipped++;
                recvBuf = recvBuf.subarray(1); // Advance one byte to re-sync
                continue; // Resync to next header
            } else {
                recvBuf = result;
                packetSkipped = 0;
            }
        } else if (headerType === IMU_HEADER_INT) {
            //console.log("IMU");
            if (recvBuf.length < PACKET_BYTES) break;
            const result = parseIMUData(recvBuf, PACKET_BYTES, packetSkipped);
            if (!result) {
                packetSkipped++;
                recvBuf = recvBuf.subarray(1); // Advance one byte to re-sync
                continue; // Resync to next header
            } else {
                recvBuf = result;
                packetSkipped = 0;
            }
        } else if (headerType === STRAIN_HEADER_INT) {
            //console.log("Strain");
            if (recvBuf.length < PACKET_BYTES) break;
            const result = parseStrainData(recvBuf, PACKET_BYTES, packetSkipped);
            if (!result) {
                packetSkipped++;
                recvBuf = recvBuf.subarray(1);
                continue;
            } else {
                recvBuf = result;
                packetSkipped = 0;
            }
        } else if (headerType === GPS_HEADER_INT) {
            //console.log("GPS");
            if (recvBuf.length < PACKET_BYTES) break;
            const result = parseGPSData(recvBuf, PACKET_BYTES, packetSkipped);
            if (!result) {
                packetSkipped++;
                recvBuf = recvBuf.subarray(1); // Advance one byte to re-sync
                continue; // Resync to next header
            } else {
                recvBuf = result;
                packetSkipped = 0;
            }
        } else {
            recvBuf = recvBuf.subarray(1); // Advance one byte to re-sync
            packetSkipped++;
            continue;
        }
    }
    if (headerType === POWER_HEADER_INT) {
        consumePowerQueue();
    }
    // IMU and strain queues are drained unconditionally: each consumer is a
    // no-op until its batch threshold is reached, and gating them on the last
    // header seen meant their samples were never written to the DB.
    consumeIMUQueue();
    consumeStrainQueue();
    consumeGPSQueue();
}

async function startSerialReader() {
    console.log('Starting serial reader...');
    let result;
    try {
        result = await findValidPort();
    } catch (err) {
        console.error(`Error finding valid port: ${err.message}`);
        setTimeout(startSerialReader, 3000);
        return;
    }

    if (!result) {
        console.log('Retrying in 3 seconds...');
        setTimeout(startSerialReader, 3000);
        return;
    }

    const { port, path } = result;
    console.log(`Listening on ${path}`);
    connectedPort = port; 

    // Use raw data events — not a line parser since this is binary
    port.on('data', (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);
        processBuffer();
    });

    port.on('close', () => {
        console.warn(`Port ${path} closed. Rescanning...`);
        recvBuf = Buffer.alloc(0); // Clear buffer on disconnect
        
        // Persist whatever is still queued below the batch threshold so a
        // disconnect does not silently drop the tail of the run.
        flushIMUQueue();
        flushStrainQueue();
        flushGPSQueue();
        setTimeout(startSerialReader, 5000);
    });

    port.on('error', (err) => {
        console.error(`Port error: ${err.message}. Rescanning...`);
        setTimeout(startSerialReader, 5000);
    });
}

module.exports = { 
    startSerialReader,
    getConnectedPort
};