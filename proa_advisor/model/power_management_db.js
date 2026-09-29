const { getDB, initializeDatabase } = require('./power_management_models');
const { soc_to_index } = require('../lib/Kalman Filter/kalman_filter_helper/helper');
const { withWriteLock } = require('./write_lock');

async function insertSocSensorData(run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7) {
    const db = getDB();
    db.serialize(() => {
        db.run(`
            INSERT INTO SOCSensor (run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7], function (err) {
            if (err) {
                console.error('Error inserting SOC sensor data:', err.message);
            }
        });
    });
}

async function insertSocSensorDataBulk(dataArray) {
    if (!dataArray || dataArray.length === 0) return;
    // Shared connection: hold the write lock so this transaction cannot
    // interleave with the IMU or strain ones.
    return withWriteLock(() => insertSocSensorBatch(dataArray));
}

async function insertSocSensorBatch(dataArray) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            const stmt = db.prepare(`
                INSERT INTO SOCSensor (run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) {
                    console.error('Error beginning transaction for SOCSensor bulk insert:', err.message);
                }
                let pending = dataArray.length;
                dataArray.forEach(({ run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7 }) => {
                    stmt.run([run_id, time_diff, adcReading0, adcReading1, adcReading2, adcReading3, adcReading4, adcReading5, adcReading6, adcReading7], function (err) {
                        if (err) {
                            console.error('Error inserting SOC sensor data:', err.message);
                        }
                        pending--;
                        if (pending === 0) {
                            stmt.finalize((err) => {
                                if (err) {
                                    console.error('Error finalizing statement:', err.message);
                                }
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        console.error('Error committing SOCSensor bulk insert:', err.message);
                                        reject(err);
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        }
                    });
                });
            });
        });
    });
}

async function insertMainBatteryState(run_id, state_vector, covariance_matrix) {
    const db = getDB();
    db.serialize(() => {
        db.run(`
            INSERT INTO MainBatteryState (run_id, state_vector, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(state_vector), JSON.stringify(covariance_matrix)], function (err) {
            if (err) {
                console.error('Error inserting main battery state data:', err.message);
            }
        });
    });
}

async function insertAlternateBatteryState(run_id, state_vector, covariance_matrix) {
    const db = getDB();
    db.serialize(() => {
        db.run(`
            INSERT INTO AlternateBatteryState (run_id, state_vector, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(state_vector), JSON.stringify(covariance_matrix)], function (err) {
            if (err) {
                console.error('Error inserting alternate battery state data:', err.message);
            }
        });
    });
}

async function insertSensorReadings(run_id, { total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate }) {
    const db = getDB();
    db.serialize(() => {
        db.run(`
            INSERT INTO SensorReadings (run_id, total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [run_id, total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate], function (err) {
            if (err) {
                console.error('Error inserting sensor readings data:', err.message);
            }
        });
    });
}

async function insertKCLCorrectionState(run_id, biases, covariance_matrix) {
    const db = getDB();
    db.serialize(() => {
        db.run(`
            INSERT INTO KCL_Correctionstate (run_id, biases, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(biases), JSON.stringify(covariance_matrix)], function (err) {
            if (err) {
                console.error('Error inserting KCL correction state data:', err.message);
            }
        });
    });
}

function runSQL(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
}

async function insertAllStatesAndReadings(run_id, main, alt, readings, kcl) {
    // Shared connection: hold the write lock so this transaction cannot
    // interleave with the IMU or strain ones.
    return withWriteLock(() => insertAllStatesAndReadingsLocked(run_id, main, alt, readings, kcl));
}

async function insertAllStatesAndReadingsLocked(run_id, { main_state_vector, main_state_cov}, { alt_state_vector, alt_state_cov }, { total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate }, { kcl_cov, kcl_biases }) {
    // Insert main, alt, kcl and sensor readings in a single transaction to avoid backlog
    const db = getDB();
    try {
        await runSQL(db, 'BEGIN TRANSACTION');
        await runSQL(db, `
            INSERT INTO MainBatteryState (run_id, state_vector, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(main_state_vector), JSON.stringify(main_state_cov)]);
        await runSQL(db, `
            INSERT INTO AlternateBatteryState (run_id, state_vector, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(alt_state_vector), JSON.stringify(alt_state_cov)]);
        await runSQL(db, `
            INSERT INTO SensorReadings (run_id, total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [run_id, total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W, I_batt_main, I_batt_alternate, I_mppt, I_load, Corrected_I_batt_main, Corrected_I_batt_alternate, Corrected_I_mppt, Corrected_I_load, V_batt_main, V_batt_alternate, Corrected_V_batt_main, Corrected_V_batt_alternate, OCV_batt_main, OCV_batt_alternate, SoC_batt_main, SoC_batt_alternate]);
        await runSQL(db, `
            INSERT INTO KCL_Correctionstate (run_id, biases, covariance_matrix)
            VALUES (?, ?, ?)
        `, [run_id, JSON.stringify(kcl_biases), JSON.stringify(kcl_cov)]);
        await runSQL(db, 'COMMIT');
    } catch (err) {
        await runSQL(db, 'ROLLBACK');
        console.error('Error inserting states and readings in transaction:', err.message);
    }
}

const persistent_main_RC = [];
const persistent_alternate_RC = [];

async function fetchAndCacheRC(tableName = "MainRCMapping") {
    const db = getDB();
    if (tableName === "MainRCMapping") {

        if (persistent_main_RC.length > 0) {
            return persistent_main_RC;
        }
        return new Promise((resolve, reject) => {
            db.all(`SELECT * FROM MainRCMapping ORDER BY SoC ASC`, [], (err, rows) => {
                if (err) {
                    console.error('Error retrieving main RC data:', err.message);
                    reject(err);
                } else {
                    persistent_main_RC.push(...rows);
                    resolve(rows);
                }
            });
        });
    } else if (tableName === "AlternateRCMapping") {
        if (persistent_alternate_RC.length > 0) {
            return persistent_alternate_RC;
        }
        return new Promise((resolve, reject) => {
            db.all(`SELECT * FROM AlternateRCMapping ORDER BY SoC ASC`, [], (err, rows) => {
                if (err) {
                    console.error('Error retrieving alternate RC data:', err.message);
                    reject(err);
                } else {
                    persistent_alternate_RC.push(...rows);
                    resolve(rows);
                }
            });
        });
    } else {
        throw new Error("Invalid table name. Must be 'MainRCMapping' or 'AlternateRCMapping'.");
    }
}


async function getBatteryRC_SoC(soc, tableName, count = 1) {
    if (tableName !== "MainRCMapping" && tableName !== "AlternateRCMapping") {
        throw new Error("Invalid table name. Must be 'MainRCMapping' or 'AlternateRCMapping'.");
    }

    const rc_data = await fetchAndCacheRC(tableName);
    let filtered = null;

    if (1 - soc < 0.00001) {
        filtered = rc_data.slice(-count);
    } else if (soc < 0.00001) {
        filtered = rc_data.slice(0, count);
    } else {
        const half = Math.floor(count / 2);
        const index = soc_to_index(soc);
        const start_index = Math.max(0, index - half);
        const end_index = index + half;
        
        filtered = rc_data.slice(start_index, end_index + 1);
    }

    if (Math.abs(soc - filtered[0].SoC) > 0.05 || (filtered[0].SoC < 1e-10 && soc > 0)) {
        console.error(`Requested SoC ${soc.toFixed(40)} is wrong. Received ${filtered[0].SoC.toFixed(40)} from database.`);
    }
    return filtered;
}

async function getBatteryRC_OCV(voltage, factor, tableName, count = 1) {
    if (tableName !== "MainRCMapping" && tableName !== "AlternateRCMapping") {
        throw new Error("Invalid table name. Must be 'MainRCMapping' or 'AlternateRCMapping'.");
    }
    const table_size = 10 ** (factor + 2) + 1;

    const rc_data = await fetchAndCacheRC(tableName);
    // Fast enough. Only run once per filter + array almost fully sorted
    const sorted = rc_data.sort((a, b) => Math.abs(a.OCV - voltage) - Math.abs(b.OCV - voltage));
    const sliced = sorted.slice(0, count);
    return sliced;
}

async function getLastMainBatteryState() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT * FROM MainBatteryState ORDER BY id DESC LIMIT 1
        `, [], (err, row) => {
            if (err) {
                console.error('Error retrieving last main battery state data:', err.message);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function getLastAlternateBatteryState() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT * FROM AlternateBatteryState ORDER BY id DESC LIMIT 1
        `, [], (err, row) => {
            if (err) {
                console.error('Error retrieving last alternate battery state data:', err.message);
                reject(err);
            }
            else {
                resolve(row);
            }
        });
    });
}

async function getLastKCLCorrectionState() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT * FROM KCL_Correctionstate ORDER BY id DESC LIMIT 1
        `, [], (err, row) => {
            if (err) {
                console.error('Error retrieving last KCL correction state data:', err.message);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function getRunId(use_new = false, time_before_new_run = 5 * 60 * 1000) { // 5 minutes
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT run_id, timestamp FROM MainBatteryState ORDER BY timestamp DESC LIMIT 1
        `, [], (err, row) => {
            if (err) {
                console.error('Error retrieving last run_id:', err.message);
                reject(err);
            } else {
                if (!row) {
                    resolve({ run_id: 1, is_new: true }); // No previous run, start with run_id 1
                    return;
                }
                const time_now = new Date();
                const time_last = new Date(row.timestamp.replace(' ', 'T') + 'Z'); // Convert to ISO format for Date parsing
                const time_diff = time_now - time_last;
                
                if (time_diff > time_before_new_run || use_new) {
                    resolve({ run_id: row.run_id + 1, is_new: true }); // Start new run
                } else {
                    resolve({ run_id: row.run_id, is_new: false });
                }
            }
        });
    });
}

async function createOrUpdateRunInfo(run_id, total_runtime, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.run(`
            INSERT INTO RunInfo (run_id, total_runtime, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id)
            DO UPDATE SET
                total_runtime = excluded.total_runtime,
                total_load_W = excluded.total_load_W,
                total_mppt_W = excluded.total_mppt_W,
                total_batt1_net_W = excluded.total_batt1_net_W,
                total_batt2_net_W = excluded.total_batt2_net_W;
        `, [run_id, total_runtime, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W], (err) => {
            if (err) {
                console.error('Error creating or updating run info:', err.message);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function getRunInfo(run_id) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT * FROM RunInfo WHERE run_id = ?
        `, [run_id], (err, row) => {
            if (err) {
                console.error('Error retrieving run info:', err.message);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function populateInitalChartData(run_id = null, size = 100) {
    const db = getDB();
    if (!run_id) {
        const lastRun = await getRunId();
        run_id = lastRun.run_id;
    }
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM SensorReadings WHERE run_id = ? ORDER BY total_time DESC LIMIT ?
        `, [run_id, size], (err, rows) => {
            if (err) {
                console.error('Error retrieving initial chart data:', err.message);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

module.exports = {
    insertSocSensorData,
    insertSocSensorDataBulk,
    insertMainBatteryState,
    insertAlternateBatteryState,
    insertSensorReadings,
    insertKCLCorrectionState,
    getBatteryRC_SoC,
    getBatteryRC_OCV,
    getLastMainBatteryState,
    getLastAlternateBatteryState,
    getRunId,
    getLastKCLCorrectionState,
    createOrUpdateRunInfo,
    getRunInfo, 
    populateInitalChartData,
    insertAllStatesAndReadings,
};
