const { Battery2RCEKF } = require("./kalman_filter_helper/filter")
const { CurrentKCLCorrector } = require("./kalman_filter_helper/kcl_corrector")
const { adc_to_current, adc_to_voltage } = require("../adc_converter")
const { load_battery_noise, load_battery_constants, diag } = require('./kalman_filter_helper/helper');
const { insertSocSensorDataBulk, insertAllStatesAndReadings, getLastMainBatteryState, getLastAlternateBatteryState, getLastKCLCorrectionState, getRunId, createOrUpdateRunInfo, getRunInfo } = require("../../model/power_management_db")
const { getBatteryRC_OCV } = require("../../model/power_management_db");
const { write_to_clients } = require('../../handler/client_transmission')
const dotenv = require('dotenv');
dotenv.config();

/*
ADS8688 Pinouts:
Pin     Setup 1     Setup 2 (not in use)   Description
A0      MPPT_Out    Batt1_In                (Always positive; set MPPT_SENSOR_REVERSED=true if the sensor is wired backwards)
A1      Load_In     Batt1_Out               (Always positive but use bipolar ADC reading to detect miswiring and flip it)
A2      Batt1_Net   Batt2_In
A3      Batt2_Net   Batt2_Out
A4      NA          NA                      (Unused)
A5      NA          NA                      (Unused)
A6      Batt1_V     Batt1_V                 (Voltage divider of R1: 100k; R2: 20k)
A7      Batt2_V     Batt2_V                 (Voltage divider of R1: 100k; R2: 20k)

All inputs are wired to be positive (Current flow into MPPT / Load), 
except battery which can have both direction, 
face it such that reading positive for current into battery

Batt 1: Main battery, LiNMC, 2s1p pack, 48.0V nominal, 104Ah
Batt 2: Alternate battery, LiFePO4, 2s1p pack, 48.0V nominal, 50Ah
*/

const ENABLE_EKF_RESTORE            = process.env.ENABLE_EKF_RESTORE === 'true';
const USE_NEW_RUN_ID                = process.env.USE_NEW_RUN_ID === 'true';
const SAVE_STATES_TO_DB             = process.env.SAVE_STATES_TO_DB === 'true';
const SAVE_ADC_READINGS_TO_DB       = process.env.SAVE_ADC_READINGS_TO_DB === 'true';
// Current correction before the EKF (see kalman_filter_helper/kcl_corrector.js)
const ENABLE_OFFSET_CORRECTION      = process.env.ENABLE_OFFSET_CORRECTION !== 'false';    // default on
const ENABLE_KCL_CORRECTION         = process.env.ENABLE_KCL_CORRECTION === 'true';        // default off: harmful as a corrector
// Fixed MPPT sign. Replaces the old auto-detect, where one glitch below -5 A negated every later reading until restart
const MPPT_SENSOR_REVERSED          = process.env.MPPT_SENSOR_REVERSED === 'true';         // default off
const SAMPLE_INTERVAL_MS            = 0;       // Only for test data
let ekf_sample_count                = 0;
let current_run_id                  = null;

const MIDPOINT                      = 2 ** 15 - 1;      // Midpoint of 16-bit ADC
const VOLTAGE_DIVIDER_RATIO         = (100 + 20) / 20;  // R1 + R2 / R2
const BATT_CUTOFF_VOLTAGE           = 30;               // Voltage below which battery is considered disconnected or fully drained
const INITIAL_COVARIANCE            = [1e-2, 1e-8, 1e-8];   // EKF P0: SoC (fraction^2), Vrc1, Vrc2 (V^2)

let data_array                  = [];       // For saving adc readings to db

// EKF Implements
let main_battery_type           = null;
let alternate_battery_type      = null;
let main_battery                = null;
let alternate_battery           = null;
let kcl_corrector               = null;
let filter_started              = false;

// Self correction
// Removed load flip detection in case of regenerative braking, as load current can be negative in that case

// Statistic
let activeUpdates               = 0;  // Detect async update falling behind
let total_load_W                = 0;
let total_mppt_W                = 0;
let total_batt1_net_W           = 0;
let total_batt2_net_W           = 0;
let total_time = 0;
let sensor_power_consumption    = 0;  // Total power consumption of sensors in Watts


// Smoothing
const MEDIAN_WINDOW_SIZE    = 10;
let window_counter          = 0;
let time_diff_window        = [];
let mppt_out_window         = [];   let load_in_window      = [];
let batt1_net_window        = [];   let batt2_net_window    = [];
let batt1_v_window          = [];   let batt2_v_window      = [];

// Recovery
let last_main_battery_state         = null;
let last_alternate_battery_state    = null;
let last_kcl_correction_state       = null;

const SAMPLE_INTERVAL_BEFORE_WRITE  = 1000 / MEDIAN_WINDOW_SIZE;

async function onNewSample(sample, force_log = false, is_test = false) {
    activeUpdates++;
    if (activeUpdates % 20 === 0) {
        console.warn("Background update backup:", activeUpdates);
    }

    try {
        if (current_run_id === null) {
            const { run_id, is_new } = await resolveRun();
            if (!is_new) {
                if (!is_test && ENABLE_EKF_RESTORE) {
                    last_main_battery_state         = await getLastMainBatteryState(run_id);
                    last_alternate_battery_state    = await getLastAlternateBatteryState(run_id);
                    last_kcl_correction_state       = await getLastKCLCorrectionState(run_id);
                }
                const runInfo = await getRunInfo(run_id);
                if (runInfo) {
                    total_load_W = runInfo.total_load_W;
                    total_mppt_W = runInfo.total_mppt_W;
                    total_batt1_net_W = runInfo.total_batt1_net_W;
                    total_batt2_net_W = runInfo.total_batt2_net_W;
                    total_time = runInfo.total_runtime;
                    console.log(`Recovered run info - Total Time: ${(total_time / 3600).toFixed(2)} hrs, Total Load Energy: ${(total_load_W / 3600).toFixed(2)} Wh, Total MPPT Energy: ${(total_mppt_W / 3600).toFixed(2)} Wh, Total Batt1 Net Energy: ${(total_batt1_net_W / 3600).toFixed(2)} Wh, Total Batt2 Net Energy: ${(total_batt2_net_W / 3600).toFixed(2)} Wh`);
                }
            }
            current_run_id = run_id;
        }

        let { counter, time_diff_us, a0, a1, a2, a3, a4, a5, a6, a7 } = sample;

        let load_in = adc_to_current(a1, 1);
        let mppt_out = MPPT_SENSOR_REVERSED ? -adc_to_current(a0, 1) : adc_to_current(a0, 1);
        let batt1_net = adc_to_current(a2, 1);
        let batt2_net = adc_to_current(a3, 1);
        let batt1_v = adc_to_voltage(a6, 5) * VOLTAGE_DIVIDER_RATIO;
        let batt2_v = adc_to_voltage(a7, 5) * VOLTAGE_DIVIDER_RATIO;
        
        if (sensor_power_consumption > 0) {
            if (alternate_battery) {
                batt2_net += sensor_power_consumption / batt2_v;
            } else if (main_battery) {
                batt1_net += sensor_power_consumption / batt1_v;
            }
            load_in += sensor_power_consumption / (alternate_battery ? batt2_v : batt1_v);
        }

        try {
            [mppt_out, load_in, batt1_net, batt2_net, batt1_v, batt2_v] = detectAndCorrectFlips(mppt_out, load_in, batt1_net, batt2_net, batt1_v, batt2_v);
        } catch (err) {
            console.error(err.message);
            return; // Skip this sample due to uncorrectable KCL violation
        }

        // Calculate total power for display use only (Not fully accurate)
        let mppt_power = 0;
        let load_power = 0;
        if (batt2_net < 0.5) {                      // assume both mppt and load going to batt1
            mppt_power = time_diff_us / 1e6 * mppt_out * batt1_v;
            load_power = time_diff_us / 1e6 * load_in * batt1_v;
        } else if (batt1_net < 0.5) { 
            mppt_power = time_diff_us / 1e6 * mppt_out * batt2_v;
            load_power = time_diff_us / 1e6 * load_in * batt2_v;
        } else if (load_in - batt1_net < 0.5) {     // assume load mostly going to batt1 and mppt mostly going to batt2
            load_power = time_diff_us / 1e6 * load_in * batt1_v;
            mppt_power = time_diff_us / 1e6 * mppt_out * batt2_v;
        } else {    
            load_power = time_diff_us / 1e6 * load_in * batt2_v;
            mppt_power = time_diff_us / 1e6 * mppt_out * batt1_v;
        }
        const batt2_net_W = time_diff_us / 1e6 * batt2_net * batt2_v;
        total_mppt_W += mppt_power;
        total_load_W += load_power;
        total_batt2_net_W += batt2_net_W;
        // For display purposes, let batt1 adjust for total = 0 as it is assumed to be always connected
        const batt1_net_W = -mppt_power + load_power - batt2_net_W;
        total_batt1_net_W += batt1_net_W;

        total_time += time_diff_us / 1e6;

        SAVE_ADC_READINGS_TO_DB && data_array.push({
            run_id: current_run_id,
            time_diff: Math.trunc(time_diff_us),
            adcReading0: a0,
            adcReading1: a1,
            adcReading2: a2,
            adcReading3: a3,
            adcReading4: a4,
            adcReading5: a5,
            adcReading6: a6,
            adcReading7: a7
        });

        // Initialising EKF instance for the batteries and KCL corrector
        if (!main_battery && batt1_v > BATT_CUTOFF_VOLTAGE) {
            try {
                const { Q_total, sigma_v, sigma_i, interval_factor } = load_battery_constants(main_battery_type);
                const loaded_noise = load_battery_noise(main_battery_type);
                const rc_values = await getBatteryRC_OCV(batt1_v, interval_factor, "MainRCMapping");
                if (rc_values.length < 1) {
                    throw new Error(`No RC values found for voltage ${batt1_v.toFixed(4)}V in MainRCMapping`);
                }
                const { SoC, R0, R1, C1, C2, Tau1, Tau2, OCV } = rc_values[0];

                const noise = {
                    voltage: sigma_v ** 2,
                    voltageRate: loaded_noise?.voltageRate,
                    socProcess: loaded_noise ? loaded_noise.socProcess : 1e-22,
                    rcProcess: loaded_noise ? loaded_noise.rcProcess : 1e-22,
                }

                const initial = {
                    soc: SoC,
                    vrc1: 0,
                    vrc2: 0,
                }
                let initialCovariance = diag(INITIAL_COVARIANCE);

                if (last_main_battery_state) {
                    const last_state_vector = JSON.parse(last_main_battery_state.state_vector);
                    const last_covariance_matrix = JSON.parse(last_main_battery_state.covariance_matrix);
                    initial.soc = last_state_vector.soc;
                    initial.vrc1 = last_state_vector.vrc1;
                    initial.vrc2 = last_state_vector.vrc2;
                    initialCovariance = last_covariance_matrix;
                    console.log(`Recovered main battery state from previous run with SoC: ${100 * initial.soc.toFixed(4)}%`);
                }
                main_battery = new Battery2RCEKF({
                    name: "main",
                    capacityAh: Q_total,
                    noise: noise,
                    voltageGate: loaded_noise?.voltageGate,
                    gapDecay: loaded_noise?.gapDecay,
                    initial: initial,
                    initialCovariance: initialCovariance
                });
                await main_battery.init();
                
                console.log(`Initialized main battery with SoC: ${100 * SoC.toFixed(4)}%, R0: ${R0.toFixed(4)}Ω, R1: ${R1.toFixed(4)}Ω, C1: ${C1.toFixed(2)}F, C2: ${C2.toFixed(2)}F`);
            } catch (err) {
                throw err;
            }
        }

        if (!alternate_battery && batt2_v > BATT_CUTOFF_VOLTAGE) {
            try {
                const { Q_total, sigma_v, sigma_i, interval_factor } = load_battery_constants(alternate_battery_type);
                const loaded_noise = load_battery_noise(alternate_battery_type);
                const rc_values = await getBatteryRC_OCV(batt2_v, interval_factor, "AlternateRCMapping");
                if (rc_values.length < 1) {
                    throw new Error(`No RC values found for voltage ${batt2_v.toFixed(4)}V in AlternateRCMapping`);
                }

                const { SoC, R0, R1, C1, C2, Tau1, Tau2, OCV } = rc_values[0];

                const noise = {
                    socProcess: loaded_noise ? loaded_noise.socProcess : 1e-22,
                    rcProcess: loaded_noise ? loaded_noise.rcProcess : 1e-20,
                    voltage: sigma_v ** 2,
                    voltageRate: loaded_noise?.voltageRate,
                }
                const initial = {
                    soc: SoC,
                    vrc1: 0,
                    vrc2: 0,
                }
                let initialCovariance = diag(INITIAL_COVARIANCE);

                if (last_alternate_battery_state) {
                    const last_state_vector = JSON.parse(last_alternate_battery_state.state_vector);
                    const last_covariance_matrix = JSON.parse(last_alternate_battery_state.covariance_matrix);
                    initial.soc = last_state_vector.soc;
                    initial.vrc1 = last_state_vector.vrc1;
                    initial.vrc2 = last_state_vector.vrc2;
                    initialCovariance = last_covariance_matrix;
                    console.log(`Recovered alternate battery state from previous run with SoC: ${100 * initial.soc.toFixed(4)}%`);
                }

                alternate_battery = new Battery2RCEKF({
                    name: "alternate",
                    capacityAh: Q_total,
                    noise: noise,
                    voltageGate: loaded_noise?.voltageGate,
                    gapDecay: loaded_noise?.gapDecay,
                    initial: initial,
                    initialCovariance: initialCovariance
                });
                await alternate_battery.init();
                console.log(`Initialized alternate battery with SoC: ${100 * SoC.toFixed(4)}%, R0: ${R0.toFixed(4)}Ω, R1: ${R1.toFixed(4)}Ω, C1: ${C1.toFixed(2)}F, C2: ${C2.toFixed(2)}F`);
            } catch (err) {
                throw err;
            }
        }
        
        time_diff_window.push(Number(time_diff_us));
        mppt_out_window.push(Number(mppt_out));
        load_in_window.push(Number(load_in));
        batt1_net_window.push(Number(batt1_net));
        batt2_net_window.push(Number(batt2_net));
        batt1_v_window.push(Number(batt1_v));
        batt2_v_window.push(Number(batt2_v));
        window_counter++;

        if (window_counter < MEDIAN_WINDOW_SIZE) {
            return; // Wait until we have enough samples to compute median
        }

        try {
            // Check the values actually passed to the filter (window sum / medians), not the raw sample
            const inputs = {
                time_diff_us: time_diff_window.reduce((a, b) => a + b, 0),
                mppt_out: getMedian(mppt_out_window),
                load_in: getMedian(load_in_window),
                batt1_net: getMedian(batt1_net_window),
                batt2_net: getMedian(batt2_net_window),
                batt1_v: getMedian(batt1_v_window),
                batt2_v: getMedian(batt2_v_window),
            };
            const bad = Object.entries(inputs).filter(([, v]) => !Number.isFinite(v));
            if (bad.length) {
                console.warn('Skipping filter step, non-finite inputs:', inputs, {
                    time_diff_window, mppt_out_window, load_in_window, batt1_net_window, batt2_net_window, batt1_v_window, batt2_v_window,
                });
            } else {
                await updateFilter(
                    inputs.time_diff_us,
                    inputs.mppt_out,
                    inputs.load_in,
                    inputs.batt1_net,
                    inputs.batt2_net,
                    inputs.batt1_v,
                    inputs.batt2_v,
                    is_test
                );
            }
        } catch (error) {
            console.error('Error updating filter:', error);
        }

        time_diff_window = [];
        mppt_out_window = [];
        load_in_window = [];
        batt1_net_window = [];
        batt2_net_window = [];
        batt1_v_window = [];
        batt2_v_window = [];
        window_counter = 0;
    } finally {
        activeUpdates--;
    }
}

async function updateFilter(time_diff_us, mppt_out, load_in, batt1_net, batt2_net, batt1_v, batt2_v, is_test = false) {
    if (!filter_started) {
        filter_started = true;
        if (ENABLE_OFFSET_CORRECTION || ENABLE_KCL_CORRECTION) {
            kcl_corrector = new CurrentKCLCorrector({
                offsets: ENABLE_OFFSET_CORRECTION,
                kcl: ENABLE_KCL_CORRECTION,
                cutoffVoltage: BATT_CUTOFF_VOLTAGE,
            }).init();
        }
        console.log(`Current correction: offsets ${ENABLE_OFFSET_CORRECTION ? 'on' : 'off'}, KCL ${ENABLE_KCL_CORRECTION ? 'on' : 'off'}`);
        if (ENABLE_KCL_CORRECTION) {
            console.warn("KCL correction is harmful as a corrector (see final_report/kcl_correction_explained.md). Set ENABLE_KCL_CORRECTION=false.");
        }
        console.log("====================================================");
        console.log("Started Kalman filter for power management");
        console.log("====================================================\n");
    }

    let corrected_currents = {
        loadCorrected: load_in,
        chargeCorrected: mppt_out,
        battery1NetCorrected: batt1_net,
        battery2NetCorrected: batt2_net,
    };
    let kcl_cov = null;
    let kcl_biases = null;

    if (kcl_corrector) {
        const { state, biases, currents } = kcl_corrector.update({
            dt: time_diff_us / 1e6,
            loadCurrent: load_in,
            chargeCurrent: mppt_out,
            battery1NetCurrent: batt1_net,
            battery2NetCurrent: batt2_net,
            battery1Voltage: batt1_v,
            battery2Voltage: batt2_v,
        });

        if (!state || !biases || !currents) {
            throw new Error('KCL Corrector update failed to return valid state, biases, or currents.');
        }
        corrected_currents = currents;
        if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
            kcl_cov = state.covariance;
            kcl_biases = biases;
        }
    }

    if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
        if (process.env.LOG_POWER_MANAGEMENT === 'true') {
            console.log("\nInput values - \tMain: " + batt1_v.toFixed(5) + "V, Alt: " + batt2_v.toFixed(5) + "V, \t\tLoad: " + load_in.toFixed(5) + "A, \tCharge: " + mppt_out.toFixed(5) + "A, \tBatt1: " + batt1_net.toFixed(5) + "A, \tBatt2: " + batt2_net.toFixed(5) + "A");
            console.log(`EKF Update: ${ekf_sample_count}, KCL Corrected Currents: \t\t\tLoad: ${corrected_currents.loadCorrected.toFixed(5)}A, \tCharge: ${corrected_currents.chargeCorrected.toFixed(5)}A, \tBatt1: ${corrected_currents.battery1NetCorrected.toFixed(5)}A, \tBatt2: ${corrected_currents.battery2NetCorrected.toFixed(5)}A`);
        }
    }

    let sensor_readings = {};
    if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
        sensor_readings = {
            total_time: total_time,
            total_load_W: total_load_W,
            total_mppt_W: total_mppt_W,
            total_batt1_net_W: total_batt1_net_W,
            total_batt2_net_W: total_batt2_net_W,
            I_batt_main: batt1_net,
            I_batt_alternate: batt2_net,
            I_mppt: mppt_out,
            I_load: load_in,
            Corrected_I_batt_main: corrected_currents.battery1NetCorrected,
            Corrected_I_batt_alternate: corrected_currents.battery2NetCorrected,
            Corrected_I_mppt: corrected_currents.chargeCorrected,
            Corrected_I_load: corrected_currents.loadCorrected,
            V_batt_main: batt1_v,
            V_batt_alternate: batt2_v > BATT_CUTOFF_VOLTAGE ? batt2_v : null,
            Corrected_V_batt_main: null,
            Corrected_V_batt_alternate: null,
            OCV_batt_main: null,
            OCV_batt_alternate: null,
            SoC_batt_main: null,
            SoC_batt_alternate: null
        };
    }

    let main_state_vector = null; let main_state_cov = null;
    let alt_state_vector = null; let alt_state_cov = null;
    if (batt1_v > BATT_CUTOFF_VOLTAGE) {
        const { name, state, state_vector, rc, voltageEstimate, voltageResidual, netCurrent } = await main_battery.update({
            dt: time_diff_us / 1e6,
            voltage: batt1_v,
            netCurrent: corrected_currents.battery1NetCorrected,
        });
        main_state_vector = state_vector; main_state_cov = state.covariance;

        if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
            if (process.env.LOG_POWER_MANAGEMENT === 'true') {
                console.log(`Counter: ${ekf_sample_count}, \tSoC Main: ${(100 * state_vector.soc).toFixed(5)}%, \tCorrected Main: ${voltageEstimate.toFixed(5)}V, Correct OCV: ${rc.OCV.toFixed(5)}V, \tCurrent Main: ${corrected_currents.battery1NetCorrected.toFixed(5)}A, \tVoltage Residual: ${voltageResidual.toFixed(5)}V`);
            }
            sensor_readings.Corrected_V_batt_main = voltageEstimate;
            sensor_readings.OCV_batt_main = rc.OCV;
            sensor_readings.SoC_batt_main = state_vector.soc * 100;
        }
    }

    if (batt2_v > BATT_CUTOFF_VOLTAGE) {
        const { name, state, state_vector, rc, voltageEstimate, voltageResidual, netCurrent } = await alternate_battery.update({
            dt: time_diff_us / 1e6,
            voltage: batt2_v,
            netCurrent: corrected_currents.battery2NetCorrected,
        });

        alt_state_vector = state_vector; alt_state_cov = state.covariance;
        if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
            if (process.env.LOG_POWER_MANAGEMENT === 'true') {
                console.log(`Counter: ${ekf_sample_count}, \tSoC Alternate: ${(100 * state_vector.soc).toFixed(5)}%, \tCorrected Alt: ${voltageEstimate.toFixed(5)}V, Correct OCV: ${rc.OCV.toFixed(5)}V, \tCurrent Alternate: ${corrected_currents.battery2NetCorrected.toFixed(5)}A, \tVoltage Residual: ${voltageResidual.toFixed(5)}V`);
            }
            sensor_readings.Corrected_V_batt_alternate = voltageEstimate;
            sensor_readings.OCV_batt_alternate = rc.OCV;
            sensor_readings.SoC_batt_alternate = state_vector.soc * 100;
        }
    }

    if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0) {
        if (SAVE_STATES_TO_DB) {
            await insertAllStatesAndReadings(current_run_id, 
                { main_state_vector, main_state_cov }, 
                { alt_state_vector, alt_state_cov }, 
                sensor_readings,
                { kcl_cov, kcl_biases }
            );
        }
        await createOrUpdateRunInfo(current_run_id, total_time, total_load_W, total_mppt_W, total_batt1_net_W, total_batt2_net_W);
        write_to_clients("power", sensor_readings);
    }

    ekf_sample_count++;
    if (ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0 && SAVE_ADC_READINGS_TO_DB) {
        await insertSocSensorDataBulk(data_array);
        data_array = [];
    }

    if (is_test && ekf_sample_count % SAMPLE_INTERVAL_BEFORE_WRITE === 0 && SAMPLE_INTERVAL_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS)); // Simulate delay for real-time processing
    }
}

function detectAndCorrectFlips(mppt_out, load_in, batt1_net, batt2_net, batt1_v, batt2_v) {
    if (batt1_v < BATT_CUTOFF_VOLTAGE) {
        batt1_v = 0;
        batt1_net = 0;
    }
    if (batt2_v < BATT_CUTOFF_VOLTAGE) {
        batt2_v = 0;
        batt2_net = 0;
    }

    if (batt1_net + batt2_net - load_in + mppt_out > 2) {
        if ((-batt1_net) + batt2_net - load_in + mppt_out < 1) {
            batt1_net = -batt1_net; // Flip the sign of batt1_net to correct the KCL violation
        } else if (batt1_net + (-batt2_net) - load_in + mppt_out < 1) {
            batt2_net = -batt2_net; // Flip the sign of batt2_net to correct the KCL violation
        } else {
            throw new Error("KCL violation due to miswiring of MPPT or Load current sensor detected and cannot be corrected. Check wiring.");
        }
    }
    return [mppt_out, load_in, batt1_net, batt2_net, batt1_v, batt2_v];
}

/**
 * Resolve the run for this session once and share it.
 *
 * getCurrentRunId() must not set current_run_id itself: if /initial_power_data
 * arrives before the first sample, onNewSample would then skip restoring the
 * RunInfo totals, total_time would restart at 0 and the run's totals would be
 * overwritten. Both callers share this promise instead, and only onNewSample
 * sets current_run_id once the restore has run.
 */
let runPromise = null;
function resolveRun() {
    if (!runPromise) {
        runPromise = getRunId(USE_NEW_RUN_ID)
            .then((run) => {
                console.log(`Current run_id: ${run.run_id}, is_new: ${run.is_new}`);
                return run;
            })
            .catch((err) => {
                runPromise = null; // allow a retry on the next call
                throw err;
            });
    }
    return runPromise;
}

async function getCurrentRunId() {
    return current_run_id ?? (await resolveRun()).run_id;
}

function getMedian(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function setSensorPowerConsumption(power) {
    sensor_power_consumption = Math.abs(power);
}

function setMainBatteryType(battery_type) {
    main_battery_type = battery_type;
}

function setAlternateBatteryType(battery_type) {
    alternate_battery_type = battery_type;
}

module.exports = {
    onNewSample,
    getCurrentRunId,
    setSensorPowerConsumption,
    setMainBatteryType,
    setAlternateBatteryType
}