const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = "./proa.db";
const fs = require("fs");
const csv = require("csv-parser");

const tables_initialized = {
    SOCSensor: false,
    MainBatteryState: false,
    AlternateBatteryState: false,
    KCL_Correctionstate: false,
    MainRCMapping: false,
    AlternateRCMapping: false,
    RunInfo: false,
    SensorReadings: false,
};

let db = null;

async function startDB() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error("Error opening database:", err.message);
                reject(err);
            } else {
                db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;", (pragmaErr) => {
                    if (pragmaErr) {
                        console.error("Error setting SQLite pragmas:", pragmaErr.message);
                    }
                });
                new Promise((res, rej) => {
                    for (let attempt = 0; attempt < 10; attempt++) {
                        initializeDatabase();
                        setTimeout(() => {
                            if (Object.values(tables_initialized).every((v) => v)) {
                                res();
                            } else {
                                console.log(
                                    `Database initialization attempt ${attempt + 1} failed. Retrying...`,
                                );
                            }
                        }, 1000);
                    }
                }).then(() => {
                    console.log("Database initialized successfully.");
                    resolve(db);
                });
            }
        });
    });
}

function getDB() {
    if (!db) {
        throw new Error("Database not initialized. Call startDB() first.");
    }
    return db;
}

function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(
                `
            CREATE TABLE IF NOT EXISTS SOCSensor (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                run_id INTEGER NOT NULL,
                time_diff INTEGER NOT NULL,
                adcReading0 INTEGER NOT NULL,
                adcReading1 INTEGER NOT NULL,
                adcReading2 INTEGER NOT NULL,
                adcReading3 INTEGER NOT NULL,
                adcReading4 INTEGER NOT NULL,
                adcReading5 INTEGER NOT NULL,
                adcReading6 INTEGER NOT NULL,
                adcReading7 INTEGER NOT NULL
        )`,
                (err) => {
                    if (err) {
                        console.error("Error creating SOCSensor table:", err.message);
                        reject(err);
                        return;
                    }
                    tables_initialized.SOCSensor = true;
                },
            );
            db.run(
                `
            CREATE INDEX IF NOT EXISTS idx_socsensor_run_id_id
            ON SOCSensor (run_id, id)
        `,
                (err) => {
                    if (err) {
                        console.error("Error creating SOCSensor run/id index:", err.message);
                    }
                },
            );

            db.run(
                `
            CREATE TABLE IF NOT EXISTS MainBatteryState (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                run_id INTEGER NOT NULL,
                state_vector TEXT NOT NULL,
                covariance_matrix TEXT NOT NULL
            )`,
                (err) => {
                    if (err) {
                        console.error(
                            "Error creating MainBatteryState table:",
                            err.message,
                        );
                        reject(err);
                    } else {
                        tables_initialized.MainBatteryState = true;
                    }
                },
            );

            db.run(
                `
            CREATE TABLE IF NOT EXISTS AlternateBatteryState (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                run_id INTEGER NOT NULL,
                state_vector TEXT NOT NULL,
                covariance_matrix TEXT NOT NULL
            )`,
                (err) => {
                    if (err) {
                        console.error(
                            "Error creating AlternateBatteryState table:",
                            err.message,
                        );
                        reject(err);
                    } else {
                        tables_initialized.AlternateBatteryState = true;
                    }
                },
            );

            db.run(
                `
                CREATE TABLE IF NOT EXISTS KCL_Correctionstate (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    run_id INTEGER NOT NULL,
                    biases TEXT NOT NULL,
                    covariance_matrix TEXT NOT NULL
                )`,
                (err) => {
                    if (err) {
                        console.error(
                            "Error creating KCL_Correctionstate table:",
                            err.message,
                        );
                        reject(err);
                    } else {
                        tables_initialized.KCL_Correctionstate = true;
                    }
                },
            );

            db.run(
                `
            CREATE TABLE IF NOT EXISTS MainRCMapping (
                SoC REAL PRIMARY KEY,
                R0 REAL NOT NULL,
                R1 REAL NOT NULL,
                R2 REAL NOT NULL,
                C1 REAL NOT NULL,
                C2 REAL NOT NULL,
                Tau1 REAL NOT NULL,
                Tau2 REAL NOT NULL,
                OCV REAL NOT NULL
            )`,
                (err) => {
                    if (err) {
                        console.error("Error creating MainRCMapping table:", err.message);
                        reject(err);
                    } else {
                        tables_initialized.MainRCMapping = true;
                    }
                },
            );

            db.run(
                `
            CREATE TABLE IF NOT EXISTS AlternateRCMapping (
                SoC REAL PRIMARY KEY,
                R0 REAL NOT NULL,
                R1 REAL NOT NULL,
                R2 REAL NOT NULL,
                C1 REAL NOT NULL,
                C2 REAL NOT NULL,
                Tau1 REAL NOT NULL,
                Tau2 REAL NOT NULL,
                OCV REAL NOT NULL
            )`,
                (err) => {
                    if (err) {
                        console.error(
                            "Error creating AlternateRCMapping table:",
                            err.message,
                        );
                        reject(err);
                    } else {
                        tables_initialized.AlternateRCMapping = true;
                    }
                },
            );

            db.run(
                `
                CREATE TABLE IF NOT EXISTS RunInfo (
                    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    total_runtime INTEGER NOT NULL,
                    total_load_W REAL NOT NULL,
                    total_mppt_W REAL NOT NULL,
                    total_batt1_net_W REAL NOT NULL,
                    total_batt2_net_W REAL NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,
                (err) => {
                    if (err) {
                        console.error("Error creating RunInfo table:", err.message);
                        reject(err);
                    } else {
                        tables_initialized.RunInfo = true;
                    }
                },
            );
            db.run(
                `
                CREATE TABLE IF NOT EXISTS SensorReadings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER,
                    total_time INTEGER,
                    total_load_W REAL,
                    total_mppt_W REAL,
                    total_batt1_net_W REAL,
                    total_batt2_net_W REAL,
                    I_batt_main REAL,
                    I_batt_alternate REAL,
                    I_mppt REAL,
                    I_load REAL,
                    Corrected_I_batt_main REAL,
                    Corrected_I_batt_alternate REAL,
                    Corrected_I_mppt REAL,
                    Corrected_I_load REAL,
                    V_batt_main REAL,
                    V_batt_alternate REAL,
                    Corrected_V_batt_main REAL,
                    Corrected_V_batt_alternate REAL,
                    OCV_batt_main REAL,
                    OCV_batt_alternate REAL,
                    SoC_batt_main REAL,
                    SoC_batt_alternate REAL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,
                (err) => {
                    if (err) {
                        console.error("Error creating SensorReadings table:", err.message);
                        reject(err);
                    } else {
                        tables_initialized.SensorReadings = true;
                    }
                },
            );
        });
    });
}

function insertBulkBatteryState(batch, tableName = "MainRCMapping") {
    const db = getDB();
    const placeholders = batch
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
    const flatValues = batch.flat();
    const sql = `INSERT INTO ${tableName} (SoC, R0, R1, R2, C1, C2, Tau1, Tau2, OCV) VALUES ${placeholders}
        ON CONFLICT(SoC)
        DO UPDATE SET
            R0 = excluded.R0,
            R1 = excluded.R1,
            R2 = excluded.R2,
            C1 = excluded.C1,
            C2 = excluded.C2,
            Tau1 = excluded.Tau1,
            Tau2 = excluded.Tau2,
            OCV = excluded.OCV;`;
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(sql, flatValues, function (err) {
            if (err) {
                console.error("Error inserting battery state batch:", err.message);
            }
        });
        db.run("COMMIT");
    });
    return batch.length;
}

async function getRCTableLength(tableName = "MainRCMapping") {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) AS count FROM ${tableName}`, (err, row) => {
            if (err) {
                console.error(`Error counting rows in ${tableName}:`, err.message);
                reject(err);
            } else {
                resolve(row.count);
            }
        });
    });
}

async function clearRCTable(tableName = "MainRCMapping") {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM ${tableName}`, (err) => {
            if (err) {
                console.error(`Error clearing ${tableName}:`, err.message);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function insertBatteryState(
    battery_type = "LiNMC",
    tableName = "MainRCMapping",
    override = false,
) {
    const batteryModelPath = path.join(__dirname, "battery_model", battery_type, "battery_state.csv");
    if (!fs.existsSync(batteryModelPath)) {
        console.error(`Battery model CSV file not found for type: ${battery_type}`);
        return;
    }
    
    let batch = [];
    const batch_size = 2000;
    let inserted = 0;
    const db = getDB();

    const tableLength = await getRCTableLength(tableName);
    console.log(`${tableName} currently has ${tableLength} records.`);
    if (tableLength > 0 && !override) {
        console.log(
            `${tableName} already has ${tableLength} records. Skipping insertion.`,
        );
        return;
    }

    if (tableLength > 0 && override) {
        await clearRCTable(tableName);
        console.log(`Cleared ${tableLength} existing records from ${tableName} before override.`);
    }

    return new Promise((resolve, reject) => {
        fs.createReadStream(batteryModelPath)
            .pipe(csv())
            .on("data", (row) => {
                const { SoC, R0, R1, R2, C1, C2, Tau1, Tau2, OCV } = row;
                batch.push([
                    parseFloat(SoC),
                    parseFloat(R0),
                    parseFloat(R1),
                    parseFloat(R2),
                    parseFloat(C1),
                    parseFloat(C2),
                    parseFloat(Tau1),
                    parseFloat(Tau2),
                    parseFloat(OCV),
                ]);
                if (batch.length >= batch_size) {
                    inserted += insertBulkBatteryState(batch, tableName);
                    batch = [];
                }
            })
            .on("end", () => {
                if (batch.length > 0) {
                    inserted += insertBulkBatteryState(batch, tableName);
                }
                console.log(`Total inserted records: ${inserted} into ${tableName}`);
                resolve(inserted);
            })
            .on("error", (err) => {
                console.error("Error reading CSV file:", err.message);
                reject(err);
            });
    });
}

module.exports = {
    getDB,
    startDB,
    initializeDatabase,
    insertBatteryState,
};
