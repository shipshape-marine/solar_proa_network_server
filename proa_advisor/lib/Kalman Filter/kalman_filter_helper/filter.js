'use strict';

const { KalmanFilter, State } = require('kalman-filter');
const { getBatteryRC_SoC, getBatteryRCTable } = require('../../../model/power_management_db');
const { diag } = require('./helper');

const MAX_STEP_S = 60;      // s, a longer step is a logging gap: no current is integrated over it

// OCV -> SoC lookup: the first row of each new running maximum of OCV, so the curve is strictly increasing
function buildInverseOcv(table) {
    const rows = [...table].sort((a, b) => a.SoC - b.SoC);
    const ocv = [], soc = [];
    for (const row of rows) {
        if (ocv.length === 0 || row.OCV > ocv[ocv.length - 1]) {
            ocv.push(row.OCV);
            soc.push(row.SoC);
        }
    }
    return { rows, ocv, soc };
}

// Linear interpolation, held at the ends
function interpolate(x, xs, ys) {
    const n = xs.length - 1;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n]) return ys[n];
    let lo = 0, hi = n;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const slope = (ys[hi] - ys[lo]) / (xs[hi] - xs[lo]);
    return slope * (x - xs[lo]) + ys[lo];
}

function ocvSlope(low, high) {
    return (high.OCV - low.OCV) / (high.SoC - low.SoC);
}

function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
}

function clampSocState(state) {
    state.mean[0][0] = clamp(state.mean[0][0], 0, 1);
}

function alphas(rc, dt) {
    return {
        a1: Math.exp(-dt / (rc.R1 * rc.C1)),
        a2: Math.exp(-dt / (rc.R2 * rc.C2)),
    };
}

class Battery2RCEKF {
    constructor(options) {
        this.name = options.name || 'main';

        this.capacityAh = options.capacityAh;
        this.Qn = this.capacityAh * 3600;

        this.noise = {
            socProcess: options.noise?.socProcess ?? 1e-22,
            rcProcess: options.noise?.rcProcess ?? 1e-22,
            voltage: options.noise?.voltage ?? 1e-14,
            voltageRate: options.noise?.voltageRate ?? null,   // V^2*s; when set, R = voltageRate / dt instead of voltage
        };

        // Voltage-update gate for flat OCV curves (LiFePO4): update only where |dOCV/dSoC| >= minSlope at the estimate,
        // or after restTime seconds below restCurrent where the voltage itself maps to a part of the curve that steep
        this.voltageGate = options.voltageGate ?? null;
        this.restSeconds = 0;
        // Over a logging gap the RC voltages relax with no current (gapDecay) or reset to 0
        this.gapDecay = options.gapDecay ?? false;

        this.initial = {
            soc: options.initial.soc,
            vrc1: options.initial.vrc1,
            vrc2: options.initial.vrc2,
        };

        this.initialCovariance = options.initialCovariance || diag([
            1e-8,
            1e-8,
            1e-8,
        ]);

        this.ctx = null;
        this.kf = null;
        this.rc_values = null;
        this.previousCorrected = null;
    }

    async init() {
        const tableName = this.name === "main" ? "MainRCMapping" : "AlternateRCMapping";
        this.rc_values = await getBatteryRC_SoC(this.initial.soc, tableName, 2);
        if (this.voltageGate) {
            this.inverseOcv = buildInverseOcv(await getBatteryRCTable(tableName));
        }
        this.kf = new KalmanFilter({
            dynamic: {
                dimension: 3,

                fn: ({ previousCorrected }) => {
                    return this._stateFn(previousCorrected.mean);
                },

                transition: ({ previousCorrected }) => {
                    return this._stateJacobian(previousCorrected.mean);
                },

                covariance: () => {
                    const dt = this.ctx?.dt ?? 1;
                    return diag([
                        this.noise.socProcess * dt,
                        this.noise.rcProcess * dt,
                        this.noise.rcProcess * dt,
                    ]);
                },

                init: {
                    mean: [
                        [this.initial.soc],
                        [this.initial.vrc1],
                        [this.initial.vrc2],
                    ],
                    covariance: this.initialCovariance,
                },
            },

            observation: {
                dimension: 1,

                fn: ({ predicted }) => {
                    return this._measurementFn(predicted.mean);
                },

                stateProjection: ({ predicted }) => {
                    return this._measurementJacobian(predicted.mean);
                },

                covariance: () => {
                    const dt = this.ctx?.dt ?? 1;
                    return [[this.noise.voltageRate ? this.noise.voltageRate / dt : this.noise.voltage]];
                },
            },
        });

        this.previousCorrected = null;
        return this;
    }

    async update(reading, log=false) {
        if (!this.kf) {
            throw new Error(`Call init() on ${this.name} EKF first.`);
        }

        const { dt, voltage, netCurrent } = reading;

        if (!Number.isFinite(dt) || dt <= 0) {
            throw new Error(`${this.name}: dt must be positive.`);
        }

        if (!Number.isFinite(voltage)) {
            throw new Error(`${this.name}: voltage must be finite.`);
        }

        if (!Number.isFinite(netCurrent)) {
            throw new Error(`${this.name}: netCurrent must be finite.`);
        }

        if (dt > MAX_STEP_S) {
            this.skipGap(dt);
            return this._result(this.previousCorrected, voltage, netCurrent);
        }

        this.ctx = { dt, voltage, netCurrent };
        const useVoltage = this._voltageUpdateAllowed(voltage, netCurrent, dt);

        const predicted = this.kf.predict({
            previousCorrected: this.previousCorrected || undefined,
        });

        clampSocState(predicted);

        const corrected = useVoltage ? this.kf.correct({
            predicted,
            observation: [voltage],
        }) : predicted;

        clampSocState(corrected);

        if (log) {
            console.log(`Previous corrected: ${this.previousCorrected ? this.previousCorrected.mean : 'null'}`);
        }

        this.previousCorrected = corrected;
        this.rc_values = await getBatteryRC_SoC(corrected.mean[0][0], this.name === "main" ? "MainRCMapping" : "AlternateRCMapping", 2);

        if (log) {
            console.log(`After predict`, predicted.mean, `After correct`, corrected.mean);
        }
        return this._result(corrected, voltage, netCurrent, log);
    }

    // Unrecorded time: no charge is counted and there is no voltage update; the RC voltages relax or reset
    skipGap(seconds) {
        const state = this.previousCorrected || new State({
            mean: [[this.initial.soc], [this.initial.vrc1], [this.initial.vrc2]],
            covariance: this.initialCovariance,
        });
        const rc = this.rc_values[0];
        const keep1 = this.gapDecay ? Math.exp(-seconds / (rc.R1 * rc.C1)) : 0;
        const keep2 = this.gapDecay ? Math.exp(-seconds / (rc.R2 * rc.C2)) : 0;
        this.previousCorrected = new State({
            mean: [[state.mean[0][0]], [state.mean[1][0] * keep1], [state.mean[2][0] * keep2]],
            covariance: state.covariance,
        });
    }

    _voltageUpdateAllowed(voltage, current, dt) {
        const gate = this.voltageGate;
        if (!gate) {
            return true;
        }
        this.restSeconds = Math.abs(current) < gate.restCurrent ? this.restSeconds + dt : 0;
        const [low, high] = this.rc_values;
        if (Math.abs(ocvSlope(low, high)) >= gate.minSlope) {
            return true;
        }
        if (this.restSeconds < gate.restTime) {
            return false;
        }
        const { rows, ocv, soc } = this.inverseOcv;
        const k = clamp(Math.floor(interpolate(voltage + low.R0 * current, ocv, soc) * 1e5 + 0.5), 0, rows.length - 2);
        return Math.abs(ocvSlope(rows[k], rows[k + 1])) >= gate.minSlope;
    }

    _result(corrected, voltage, netCurrent, log = false) {
        const soc = corrected.mean[0][0];
        const vrc1 = corrected.mean[1][0];
        const vrc2 = corrected.mean[2][0];

        const rc = this.rc_values[0];
        if (log) {
            console.log(rc.OCV, vrc1, vrc2, rc.R0 * netCurrent);
        }
        const voltageEstimate =
            rc.OCV
            - vrc1
            - vrc2
            - rc.R0 * netCurrent;

        return {
            name: this.name,
            state: corrected,

            state_vector: {
                soc,
                vrc1: vrc1,
                vrc2: vrc2,
            },

            rc,

            voltageEstimate,
            voltageResidual: voltage - voltageEstimate,

            netCurrent,
        };
    }

    _stateFn(mean) {
        const soc = mean[0][0];
        const vrc1 = mean[1][0];
        const vrc2 = mean[2][0];
        const rc = this.rc_values[0];
        const { a1, a2 } = alphas(rc, this.ctx.dt);

        const I = this.ctx.netCurrent;
        const socNext = soc - (I * this.ctx.dt) / (this.Qn);

        const vrc1Next = a1 * vrc1 + rc.R1 * (1 - a1) * I;
        const vrc2Next = a2 * vrc2 + rc.R2 * (1 - a2) * I;

        return [
            [clamp(socNext, 0, 1)],
            [vrc1Next],
            [vrc2Next],
        ];
    }

    _stateJacobian(mean) {
        const soc = mean[0][0];
        const rc = this.rc_values[0];

        // RC lookup is treated as locally constant during one timestep.
        const { a1, a2 } = alphas(rc, this.ctx.dt);
        return [
            [1, 0, 0],
            [0, a1, 0],
            [0, 0, a2],
        ];
    }

    _measurementFn(mean) {
        const soc = mean[0][0];
        const vrc1 = mean[1][0];
        const vrc2 = mean[2][0];

        const I = this.ctx.netCurrent;
        const rc = this.rc_values[0];
        const ocv = rc.OCV;

        const terminalVoltage =
            ocv
            - vrc1
            - vrc2
            - rc.R0 * I;

        return [[terminalVoltage]];
    }

    _measurementJacobian(mean) {
        const soc = mean[0][0];
        const rc_values = this.rc_values;

        if (rc_values.length < 2) {
            throw new Error(`Not enough RC values returned for Jacobian calculation at SoC ${soc}.`);
        }
        const rc_high = rc_values[1];
        const rc_low = rc_values[0];
        const dOCVdSoC = (rc_high.OCV - rc_low.OCV) / (rc_high.SoC - rc_low.SoC);

        return [[
            dOCVdSoC,
            -1,
            -1,
        ]];
    }
}

module.exports = { Battery2RCEKF };