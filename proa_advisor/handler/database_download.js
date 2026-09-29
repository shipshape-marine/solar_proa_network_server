const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const STREAM_BATCH_SIZE = 500;
const INTER_BATCH_DELAY_MS = 2;
const DB_PATH = path.resolve(__dirname, "..", "proa.db");
let activeDownload = null;

/**
 * Each sensor stream has its own table and run_id counter.
 *
 * run_id is NOT shared across these tables: run 1 in StrainReadings is a
 * different time window from run 1 in SOCSensor. Every lookup here is therefore
 * scoped to a single table.
 *
 * Table and column names are interpolated into SQL because SQLite cannot bind
 * identifiers. Only the hard-coded values below ever reach a statement - the
 * caller-supplied key is validated against this registry by normalizeSensorKey
 * before use, so no request data becomes SQL.
 *
 * Columns are listed explicitly rather than using SELECT * so the CSV order is
 * stable even where the physical layout differs (recv_ms was appended by
 * migration on older databases, so it sits last in IMUReadings there).
 */
const SENSOR_TABLES = {
    power: {
        label: "Power",
        table: "SOCSensor",
        fileStem: "SOCSensor",
        columns: [
            "id",
            "timestamp",
            "run_id",
            "time_diff",
            "adcReading0",
            "adcReading1",
            "adcReading2",
            "adcReading3",
            "adcReading4",
            "adcReading5",
            "adcReading6",
            "adcReading7",
        ],
    },
    imu: {
        label: "IMU",
        table: "IMUReadings",
        fileStem: "IMUReadings",
        columns: [
            "id",
            "timestamp",
            "recv_ms",
            "run_id",
            "counter",
            "baseRoll",
            "basePitch",
            "topRoll",
            "topPitch",
            "topMinusBaseRoll",
            "topMinusBasePitch",
            "vectorAngle",
            "bendMagnitude",
            "topSeq",
            "topConnected",
            "sensingEnabled",
            "zeroReady",
        ],
    },
    strain: {
        label: "Strain",
        table: "StrainReadings",
        fileStem: "StrainReadings",
        columns: [
            "id",
            "timestamp",
            "recv_ms",
            "run_id",
            "counter",
            "adjustedReading",
        ],
    },
    gps: {
        label: "GPS",
        table: "GPSReadings",
        fileStem: "GPSReadings",
        columns: [
            "id",
            "timestamp",
            "recv_ms",
            "run_id",
            "counter",
            "latitude",
            "longitude",
            "altitude",
            "speed",
            "course",
            "hdop",
            "satellites",
            "valid",
        ],
    },
};

class DownloadInProgressError extends Error {
    constructor(message = "Another sensor data download is already in progress.") {
        super(message);
        this.name = "DownloadInProgressError";
        this.statusCode = 409;
    }
}

/**
 * Validate a caller-supplied sensor type against the registry.
 * @param {string} value "power" | "imu" | "strain" | "gps"
 */
function normalizeSensorKey(value) {
    const key = String(value ?? "").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SENSOR_TABLES, key)) {
        throw new Error(`sensor type must be one of: ${Object.keys(SENSOR_TABLES).join(", ")}.`);
    }
    return key;
}

function getSensorLabel(sensorKey) {
    return SENSOR_TABLES[normalizeSensorKey(sensorKey)].label;
}

function acquireDownloadLock() {
    if (activeDownload !== null) {
        throw new DownloadInProgressError();
    }
    const token = Symbol("sensor-download-lock");
    activeDownload = { token, startedAt: Date.now() };
    return token;
}

function releaseDownloadLock(token) {
    if (activeDownload?.token === token) {
        activeDownload = null;
    }
}

function waitForDrain(stream) {
    return new Promise((resolve, reject) => {
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onClose = () => {
            cleanup();
            resolve();
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            stream.off("drain", onDrain);
            stream.off("close", onClose);
            stream.off("error", onError);
        };

        stream.on("drain", onDrain);
        stream.on("close", onClose);
        stream.on("error", onError);
    });
}

function escapeCsvValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const asString = String(value);
    if (asString.includes(",") || asString.includes('"') || asString.includes("\n") || asString.includes("\r")) {
        return `"${asString.replace(/"/g, '""')}"`;
    }
    return asString;
}

function openReadOnlyDB() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                reject(err);
            } else {
                db.configure("busyTimeout", 2000);
                resolve(db);
            }
        });
    });
}

function closeDB(db) {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }
        db.close(() => resolve());
    });
}

function fetchRowsBatch(db, sensor, runId, startRowId, lastId, batchSize) {
    return new Promise((resolve, reject) => {
        db.all(
            `
                SELECT ${sensor.columns.join(", ")}
                FROM ${sensor.table}
                WHERE run_id = ? AND id >= ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
            `,
            [runId, startRowId, lastId, batchSize],
            (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            },
        );
    });
}

function writeCsvRow(res, values) {
    const line = `${values.map(escapeCsvValue).join(",")}\n`;
    return res.write(line);
}

function normalizeRowId(value) {
    if (value === undefined || value === null || value === "") {
        return 0;
    }
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("rowid must be a non-negative integer.");
    }
    return parsed;
}

function normalizeRunId(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("run_id must be a positive integer.");
    }
    return parsed;
}

/**
 * Per-run summaries for one sensor stream, newest run first.
 *
 * @param {string} sensorKey "power" | "imu" | "strain" | "gps"
 * @returns {Promise<Array<{run_id:number,start_row_id:number,start_datetime:string,row_count:number}>>}
 */
async function getRunSummaries(sensorKey) {
    const sensor = SENSOR_TABLES[normalizeSensorKey(sensorKey)];
    const db = await openReadOnlyDB();
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `
                    SELECT run_id, MIN(id) AS start_row_id, MIN(timestamp) AS start_datetime, COUNT(*) AS row_count
                    FROM ${sensor.table}
                    GROUP BY run_id
                    ORDER BY run_id DESC
                `,
                [],
                (err, summaryRows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(summaryRows ?? []);
                    }
                },
            );
        });
        return rows.map((row) => ({
            run_id: row.run_id,
            start_row_id: row.start_row_id,
            start_datetime: row.start_datetime,
            row_count: row.row_count,
        }));
    } finally {
        await closeDB(db);
    }
}

/**
 * Stream one run of one sensor table out as CSV, in batches, without holding the
 * whole result set in memory.
 *
 * @param {string} sensorKey "power" | "imu" | "strain"
 */
async function streamSensorCsvByRun(req, res, sensorKey, runId, startRowId = 0) {
    const sensor = SENSOR_TABLES[normalizeSensorKey(sensorKey)];
    const lockToken = acquireDownloadLock();
    let readOnlyDB = null;
    let reqClosed = false;
    const onClose = () => {
        reqClosed = true;
    };
    req.on("close", onClose);

    const fileName = `${sensor.fileStem}_run_${runId}_from_rowid_${startRowId}.csv`;

    try {
        readOnlyDB = await openReadOnlyDB();

        let lastId = startRowId - 1;
        let rows = await fetchRowsBatch(readOnlyDB, sensor, runId, startRowId, lastId, STREAM_BATCH_SIZE);
        if (rows.length === 0) {
            res.status(404).json({
                message: `No ${sensor.label} rows found for run_id=${runId} from rowid=${startRowId}.`,
            });
            return;
        }

        res.status(200);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Run-Id", String(runId));
        res.setHeader("X-Sensor-Type", sensor.label);
        res.flushHeaders?.();

        if (!writeCsvRow(res, sensor.columns)) {
            await waitForDrain(res);
        }

        while (!reqClosed && !res.writableEnded) {
            for (const row of rows) {
                if (reqClosed || res.writableEnded) {
                    break;
                }

                const canContinue = writeCsvRow(res, sensor.columns.map((column) => row[column]));
                if (!canContinue) {
                    await waitForDrain(res);
                }
            }

            lastId = rows[rows.length - 1].id;
            if (rows.length < STREAM_BATCH_SIZE) {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, INTER_BATCH_DELAY_MS));
            rows = await fetchRowsBatch(readOnlyDB, sensor, runId, startRowId, lastId, STREAM_BATCH_SIZE);
            if (rows.length === 0) {
                break;
            }
        }

        if (!res.writableEnded) {
            res.end();
        }
    } finally {
        req.off("close", onClose);
        releaseDownloadLock(lockToken);
        await closeDB(readOnlyDB);
    }
}

// Kept so the existing power-only routes keep working unchanged.
function getSOCSensorRunSummaries() {
    return getRunSummaries("power");
}

function streamSOCSensorCsvByRun(req, res, runId, startRowId = 0) {
    return streamSensorCsvByRun(req, res, "power", runId, startRowId);
}

module.exports = {
    DownloadInProgressError,
    SENSOR_TABLES,
    getRunSummaries,
    getSensorLabel,
    getSOCSensorRunSummaries,
    normalizeRowId,
    normalizeRunId,
    normalizeSensorKey,
    streamSensorCsvByRun,
    streamSOCSensorCsvByRun,
};
