const { getDB } = require('./power_management_models');
const { withWriteLock } = require('./write_lock');

const NEW_RUN_GAP_MS = 5 * 60 * 1000;

function runSQL(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}

function runStmt(stmt, params) {
    return new Promise((resolve, reject) => {
        stmt.run(params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}

function finalizeStmt(stmt) {
    return new Promise((resolve) => {
        stmt.finalize((err) => {
            if (err) console.error('Error finalizing GPS stmt:', err.message);
            resolve();
        });
    });
}

async function insertGPSDataBulk(dataArray) {
    if (!dataArray || dataArray.length === 0) return 0;
    return withWriteLock(() => insertGPSBatch(dataArray));
}

async function insertGPSBatch(dataArray) {
    const db = getDB();
    await runSQL(db, 'BEGIN TRANSACTION');
    const stmt = db.prepare(`
        INSERT INTO GPSReadings
            (run_id, counter, latitude, longitude, altitude, speed, course, hdop, satellites, valid, recv_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results = await Promise.allSettled(dataArray.map((d) => runStmt(stmt, [
        d.run_id,
        d.counter,
        d.latitude,
        d.longitude,
        d.altitude,
        d.speed,
        d.course,
        d.hdop,
        d.satellites,
        d.valid ? 1 : 0,
        d.recv_ms ?? null,
    ])));
    await finalizeStmt(stmt);

    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
        await runSQL(db, 'ROLLBACK').catch(() => {});
        throw new Error(`${failed.length}/${dataArray.length} GPS rows failed: ${failed[0].reason.message}`);
    }

    await runSQL(db, 'COMMIT');
    return dataArray.length;
}

async function getGPSDataByRunId(runId, limit = 2000) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM GPSReadings
            WHERE run_id = ?
            ORDER BY id DESC
            LIMIT ?
        `, [runId, limit], (err, rows) => {
            if (err) {
                console.error('Error fetching GPS data:', err.message);
                reject(err);
            } else {
                resolve(rows ? rows.reverse() : []);
            }
        });
    });
}

async function getLatestGPSRunId() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT run_id, timestamp FROM GPSReadings ORDER BY id DESC LIMIT 1
        `, [], (err, row) => {
            if (err) {
                console.error('Error fetching latest GPS run_id:', err.message);
                reject(err);
                return;
            }
            if (!row) {
                resolve({ run_id: 1, is_new: true });
                return;
            }

            const timeLast = new Date(row.timestamp.replace(' ', 'T') + 'Z');
            const isNew = new Date() - timeLast > NEW_RUN_GAP_MS;
            resolve({ run_id: isNew ? row.run_id + 1 : row.run_id, is_new: isNew });
        });
    });
}

module.exports = {
    insertGPSDataBulk,
    getGPSDataByRunId,
    getLatestGPSRunId,
};
