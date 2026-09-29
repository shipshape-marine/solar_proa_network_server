const { getDB } = require('./power_management_models');
const { ensureColumn } = require('./schema_utils');

let tableInitialized = false;

function initializeGPSTable() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS GPSReadings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL,
                    counter INTEGER,
                    latitude REAL,
                    longitude REAL,
                    altitude REAL,
                    speed REAL,
                    course REAL,
                    hdop REAL,
                    satellites INTEGER,
                    valid INTEGER NOT NULL,
                    recv_ms INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) {
                    console.error('Error creating GPSReadings table:', err.message);
                    reject(err);
                    return;
                }
                tableInitialized = true;
            });

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_gps_run_id_id
                ON GPSReadings (run_id, id)
            `, (err) => {
                if (err) {
                    console.error('Error creating GPSReadings index:', err.message);
                    reject(err);
                    return;
                }
                ensureColumn('GPSReadings', 'recv_ms', 'INTEGER')
                    .then(() => resolve())
                    .catch(reject);
            });
        });
    });
}

function isGPSTableReady() {
    return tableInitialized;
}

module.exports = {
    initializeGPSTable,
    isGPSTableReady,
};
