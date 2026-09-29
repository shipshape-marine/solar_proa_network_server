const dotenv = require("dotenv");
dotenv.config();

const HARD_STOP_SUPABASE = true;

const { startDB, insertBatteryState } = require('./model/power_management_models');
const { initializeIMUTable } = require('./model/imu_models');
const { initializeStrainTable } = require('./model/strain_models');
const { initializeGPSTable } = require('./model/gps_models');
const { run_test } = require("./lib/Kalman Filter/ekf_test")
const { getCurrentRunId, setAlternateBatteryType, setMainBatteryType } = require("./lib/Kalman Filter/kalman_filter");
const { startSerialReader } = require('./handler/serial_reader/serialReader');
const { updateDatabase } = require("./handler/database_update/supabase_update");


const OVERRIDE_DB = process.env.OVERRIDE_DB === 'true';

function startBackend() {
    useSupabase();

    startDB().then(() => {
        return initializeIMUTable();
    }).then(() => {
        return initializeStrainTable();
    }).then(() => {
        return initializeGPSTable();
    }).then(() => {
        //return insertBatteryState(battery_type = "LiNMC", tableName = "MainRCMapping", override = OVERRIDE_DB);
        setMainBatteryType(process.env.MAIN_BATTERY_TYPE);
        return insertBatteryState(battery_type = process.env.MAIN_BATTERY_TYPE  , tableName = "MainRCMapping", override = OVERRIDE_DB);
    }).then((count) => {
        count && console.log(`Inserted ${count} records into MainRCMapping.`);
    }).then(() => {
        //return insertBatteryState("LiFePO4", "AlternateRCMapping", OVERRIDE_DB);
        setAlternateBatteryType(process.env.ALTERNATE_BATTERY_TYPE);
        return insertBatteryState(process.env.ALTERNATE_BATTERY_TYPE, "AlternateRCMapping", OVERRIDE_DB);
    }).then((count) => {
        count && console.log(`Inserted ${count} records into AlternateRCMapping.`);
    }).then(() => {
        console.log("\n//====================================================//\nDatabase setup complete.\n//====================================================//\n");
        if (process.env.IS_TEST_RUN === 'true') {
            run_test();
        } else {
            startSerialReader();
        }
    }).catch((err) => {
        console.error("\n//====================================================//\nBackend startup failed:", err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '');
        console.error("//====================================================//\n");
    });
}

function useSupabase() {
    if (process.env.USE_SUPABASE === 'true') {
        if (HARD_STOP_SUPABASE) {
            console.log("Forcefully stopped the connection with supabase")
        } else {
            setInterval(updateDatabase, 10000); // Call updateDatabase every 10 seconds only if there is internet connection
        }
    }
}

module.exports = {
    startBackend
}