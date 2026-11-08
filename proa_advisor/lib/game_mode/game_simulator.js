const { adc_to_voltage } = require("../adc_converter");
const { load_battery_constants } = require("../Kalman Filter/kalman_filter_helper/helper");
const { getBatteryRC_SoC } = require("../../model/power_management_db");
const { write_to_clients } = require("../../handler/client_transmission");

/*
Game mode: a bare ADS8688 board with pots and switches (no battery, no real load).
Battery state is coulomb counting only, and battery voltage is the OCV looked up from SoC.
No EKF, no KCL corrector, and nothing is written to the DB, so game data never mixes
into live runs (getRunId and the EKF restore both read the newest DB rows).

ADS8688 pin   Game input                               Wiring (0 to GAME_FULL_SCALE_V)
A0            MPPT current pot                         pot ends to 5 V / GND, wiper to pin
A1            Load current pot                         same
A2            Charge selector: MPPT -> main / spare     switch: 0 V = main, 5 V = spare
A3            Discharge selector: load <- main / spare  switch: 0 V = main, 5 V = spare
A4            Simulation speed pot                     0 V = paused, 5 V = GAME_MAX_SPEED x
A5            unused                                   tie to GND
A6, A7        unused (battery voltage divider pins)    leave unconnected

A0-A5 use the firmware's +-5.12 V range (range 1), so no firmware change is needed.
Each charge source and each load goes to exactly one battery, so both batteries can
never charge (or discharge) at the same time. If both switches pick the same battery,
its net current is load - MPPT.
*/

const num = (key, fallback) => {
    const v = parseFloat(process.env[key]);
    return Number.isFinite(v) ? v : fallback;
};

const FULL_SCALE_V      = num("GAME_FULL_SCALE_V", 5.0);    // Pot supply voltage
const MPPT_MAX_A        = num("GAME_MPPT_MAX_A", 20);       // MPPT current at full scale
const LOAD_MAX_A        = num("GAME_LOAD_MAX_A", 30);       // Load current at full scale
const MAX_SPEED         = num("GAME_MAX_SPEED", 5);         // Speed multiplier at full scale
const INITIAL_SOC_MAIN  = num("GAME_INITIAL_SOC_MAIN", 0.8);
const INITIAL_SOC_ALT   = num("GAME_INITIAL_SOC_ALT", 0.8);

const STEP_SAMPLES      = 1000;     // Raw samples per step: ~0.83 s at 1200 SPS, same cadence as live SSE
const DEAD_ZONE         = 0.01;     // Fraction of full scale read as 0 (pot end-stop noise)
const SWITCH_ON         = 0.6;      // Schmitt trigger thresholds, fraction of full scale
const SWITCH_OFF        = 0.4;
const HISTORY_SIZE      = 5000;     // Same as the frontend chart length

const PIN = { mppt: 0, load: 1, charge_sel: 2, load_sel: 3, speed: 4 };

let batteries   = null;     // { main: {...}, alternate: {...} }
let charge_to   = "main";   // Switch states persist between steps (hysteresis)
let load_from   = "main";
const totals    = { total_time: 0, total_load_W: 0, total_mppt_W: 0, total_batt1_net_W: 0, total_batt2_net_W: 0 };
const history   = [];

// Window accumulators
let window_count = 0;
let window_dt_us = 0;
let window_sum   = [0, 0, 0, 0, 0];

function initBatteries() {
    const make = (type, table, soc) => {
        const { Q_total } = load_battery_constants(type);
        return { type, table, Q_Ah: Q_total, soc: clamp(soc, 0, 1) };
    };
    batteries = {
        main:      make(process.env.MAIN_BATTERY_TYPE, "MainRCMapping", INITIAL_SOC_MAIN),
        alternate: make(process.env.ALTERNATE_BATTERY_TYPE, "AlternateRCMapping", INITIAL_SOC_ALT),
    };
    console.log("====================================================");
    console.log("Started game mode simulation (coulomb counting + OCV)");
    console.log(`Main: ${batteries.main.type} ${batteries.main.Q_Ah} Ah @ ${(batteries.main.soc * 100).toFixed(1)}%, `
        + `Spare: ${batteries.alternate.type} ${batteries.alternate.Q_Ah} Ah @ ${(batteries.alternate.soc * 100).toFixed(1)}%`);
    console.log(`Full scale ${FULL_SCALE_V} V -> MPPT ${MPPT_MAX_A} A, Load ${LOAD_MAX_A} A, Speed ${MAX_SPEED}x`);
    console.log("====================================================\n");
}

async function onGameSample(sample) {
    if (!batteries) initBatteries();

    window_dt_us += Number(sample.time_diff_us);
    window_sum[PIN.mppt]       += adc_to_voltage(Number(sample.a0), 1);
    window_sum[PIN.load]       += adc_to_voltage(Number(sample.a1), 1);
    window_sum[PIN.charge_sel] += adc_to_voltage(Number(sample.a2), 1);
    window_sum[PIN.load_sel]   += adc_to_voltage(Number(sample.a3), 1);
    window_sum[PIN.speed]      += adc_to_voltage(Number(sample.a4), 1);
    window_count++;

    if (window_count < STEP_SAMPLES) return;

    const v = window_sum.map(s => s / window_count);
    const dt_real = window_dt_us / 1e6;
    window_count = 0;
    window_dt_us = 0;
    window_sum = [0, 0, 0, 0, 0];

    try {
        await step(v, dt_real);
    } catch (err) {
        console.error("Game mode step failed:", err);
    }
}

async function step(v, dt_real) {
    let i_mppt  = norm(v[PIN.mppt]) * MPPT_MAX_A;
    let i_load  = norm(v[PIN.load]) * LOAD_MAX_A;
    charge_to   = schmitt(v[PIN.charge_sel], charge_to === "alternate") ? "alternate" : "main";
    load_from   = schmitt(v[PIN.load_sel], load_from === "alternate") ? "alternate" : "main";
    const speed = norm(v[PIN.speed]) * MAX_SPEED;
    const dt    = dt_real * speed;      // Simulated seconds this step

    // Empty battery: the load browns out (an MPPT on the same battery can still carry it).
    // Full battery: charging stops (except what a load on the same battery takes).
    const same = charge_to === load_from;
    if (batteries[load_from].soc <= 0) i_load = same ? Math.min(i_load, i_mppt) : 0;
    if (batteries[charge_to].soc >= 1) i_mppt = same ? Math.min(i_mppt, i_load) : 0;

    // +ve = discharging, same sign convention as the EKF (filter.js)
    const net = {};
    for (const name of ["main", "alternate"]) {
        const b = batteries[name];
        net[name] = (load_from === name ? i_load : 0) - (charge_to === name ? i_mppt : 0);
        b.soc = clamp(b.soc - (net[name] * dt) / (b.Q_Ah * 3600), 0, 1);
        b.ocv = (await getBatteryRC_SoC(b.soc, b.table))[0].OCV;
    }

    // Energy totals, in W*s like the live filter (frontend divides by 3600 for Wh)
    totals.total_time        += dt;
    totals.total_load_W      += i_load * batteries[load_from].ocv * dt;
    totals.total_mppt_W      += i_mppt * batteries[charge_to].ocv * dt;
    totals.total_batt1_net_W += net.main * batteries.main.ocv * dt;
    totals.total_batt2_net_W += net.alternate * batteries.alternate.ocv * dt;

    // Same keys as the live sensor_readings (kalman_filter.js), so the frontend is unchanged
    const main = batteries.main;
    const alt = batteries.alternate;
    const sensor_readings = {
        ...totals,
        I_batt_main: net.main,
        I_batt_alternate: net.alternate,
        I_mppt: i_mppt,
        I_load: i_load,
        Corrected_I_batt_main: net.main,
        Corrected_I_batt_alternate: net.alternate,
        Corrected_I_mppt: i_mppt,
        Corrected_I_load: i_load,
        V_batt_main: main.ocv,
        V_batt_alternate: alt.ocv,
        Corrected_V_batt_main: main.ocv,
        Corrected_V_batt_alternate: alt.ocv,
        OCV_batt_main: main.ocv,
        OCV_batt_alternate: alt.ocv,
        SoC_batt_main: main.soc * 100,
        SoC_batt_alternate: alt.soc * 100,
    };

    history.push({ ...sensor_readings, timestamp: new Date().toISOString() });
    if (history.length > HISTORY_SIZE) history.shift();

    if (process.env.LOG_POWER_MANAGEMENT === "true") {
        console.log(`Game: speed ${speed.toFixed(2)}x, MPPT ${i_mppt.toFixed(2)} A -> ${charge_to}, Load ${i_load.toFixed(2)} A <- ${load_from}, `
            + `Main ${(main.soc * 100).toFixed(3)}% ${main.ocv.toFixed(3)} V, Spare ${(alt.soc * 100).toFixed(3)}% ${alt.ocv.toFixed(3)} V`);
    }
    write_to_clients("power", sensor_readings);
}

function norm(voltage) {
    const x = clamp(voltage / FULL_SCALE_V, 0, 1);
    return x < DEAD_ZONE ? 0 : x;
}

function schmitt(voltage, was_on) {
    const x = voltage / FULL_SCALE_V;
    if (x > SWITCH_ON) return true;
    if (x < SWITCH_OFF) return false;
    return was_on;
}

function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}

// Oldest first, same order as /initial_power_data in normal mode
function getGameHistory() {
    return history;
}

module.exports = {
    onGameSample,
    getGameHistory,
};
