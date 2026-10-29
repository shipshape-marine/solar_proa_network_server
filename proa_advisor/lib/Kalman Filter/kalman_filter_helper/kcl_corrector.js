'use strict';

/*
Current corrector for the four current sensors: load, MPPT, battery 1 and battery 2.
It estimates each sensor's zero offset (bias) and returns the readings with the offsets removed.

Offset correction (ENABLE_OFFSET_CORRECTION, default on):
    A sensor that has been idle for idleTime seconds should read 0 A, so its reading is its offset. Each offset is
    learned on its own and re-learned at every idle period. Load and MPPT are idle below idleCurrent. A battery is
    idle when load and MPPT are idle, its own reading is below idleBatteryCurrent, and it is above the cutoff voltage
    (below the cutoff the server zeroes its current, which is not a real zero).

KCL correction (ENABLE_KCL_CORRECTION, default off):
    Also updates the offsets from the current balance load - mppt - bat1 - bat2 = 0 while sensors are active, and
    skips balance innovations beyond kclGate standard deviations.
    HARMFUL as a corrector. One balance equation cannot tell which active sensor is wrong, so it splits the residual
    by the assumed drift rates, and a lasting fault (for example a reversed MPPT reading) eventually passes the gate
    and is pushed into the battery currents. Evidence: final_report/kcl_correction_explained.md, Section 5.

Channels below activeCurrent output 0 A. Values are the tuned ones from final_report/soc_eval.py (OFFSETS, KCL_GATED).
*/

const SIGN = [1, -1, -1, -1];       // KCL: load - mppt - bat1 - bat2 = 0

function diag(values) {
    return values.map((v, i) => {
        const row = Array(values.length).fill(0);
        row[i] = v;
        return row;
    });
}

class CurrentKCLCorrector {
    constructor(options = {}) {
        this.offsets = options.offsets ?? true;
        this.kcl = options.kcl ?? false;
        this.cutoffVoltage = options.cutoffVoltage ?? 30;

        this.settings = {
            activeCurrent: 0.3,             // A, a channel above this is active (load and MPPT signed, batteries |I|)
            process: [1e-7, 1e-7, 1e-7, 1e-7],  // A^2/s, offset drift of load, MPPT, battery 1, battery 2
            kclNoise: 2.5e-3,               // A^2*s, balance noise density (R = kclNoise / dt)
            kclGate: 4.0,                   // standard deviations
            idleCurrent: 0.3,               // A
            idleBatteryCurrent: 1.0,        // A
            idleTime: 10,                   // s
            idleNoise: 1e-3,                // A^2*s, idle reading noise density (R = idleNoise / dt)
            ...options.settings,
        };

        this.initial = {
            bLoad: options.initial?.bLoad ?? 0,
            bCharge: options.initial?.bCharge ?? 0,
            bBat1: options.initial?.bBat1 ?? 0,
            bBat2: options.initial?.bBat2 ?? 0,
        };

        this.initialCovariance = options.initialCovariance || diag([
            1e-4, // bLoad uncertainty
            1e-4, // bCharge uncertainty
            1e-5, // bBat1 uncertainty
            1e-5, // bBat2 uncertainty
        ]);

        this.bias = null;
        this.covariance = null;
        this.idleSeconds = null;
    }

    init() {
        const { bLoad, bCharge, bBat1, bBat2 } = this.initial;
        this.bias = [bLoad, bCharge, bBat1, bBat2];
        this.covariance = this.initialCovariance.map(row => [...row]);
        this.idleSeconds = [0, 0, 0, 0];
        return this;
    }

    update(reading) {
        if (!this.bias) {
            throw new Error('Call init() on CurrentKCLCorrector first.');
        }

        const { dt, loadCurrent, chargeCurrent, battery1NetCurrent, battery2NetCurrent, battery1Voltage, battery2Voltage } = reading;
        const s = this.settings;
        const x = [loadCurrent, chargeCurrent, battery1NetCurrent, battery2NetCurrent];
        const b = this.bias;
        const P = this.covariance;
        const step = Math.max(dt, 1e-9);
        const active = [x[0] > s.activeCurrent, x[1] > s.activeCurrent, Math.abs(x[2]) > s.activeCurrent, Math.abs(x[3]) > s.activeCurrent];

        // Predict: the offsets drift as random walks
        for (let j = 0; j < 4; j++) {
            P[j][j] += s.process[j] * dt;
        }

        if (this.kcl) {
            // Balance of the active channels with their offsets removed; dh/db = -SIGN on active channels
            const H = SIGN.map((sign, j) => active[j] ? -sign : 0);
            let h = 0;
            for (let j = 0; j < 4; j++) {
                if (active[j]) h += SIGN[j] * (x[j] - b[j]);
            }
            const PH = P.map(row => row.reduce((sum, p, j) => sum + p * H[j], 0));
            const S = H.reduce((sum, hj, j) => sum + hj * PH[j], 0) + s.kclNoise / step;
            const innovation = -h;
            if (innovation * innovation <= s.kclGate * s.kclGate * S) {
                this._apply(PH.map(v => v / S), innovation, PH);
            }
        }

        if (this.offsets) {
            const own = x.map(v => Math.abs(v) < s.idleCurrent);
            const quiet = own[0] && own[1];
            const idleNow = [
                own[0],
                own[1],
                quiet && Math.abs(x[2]) < s.idleBatteryCurrent && battery1Voltage > this.cutoffVoltage,
                quiet && Math.abs(x[3]) < s.idleBatteryCurrent && battery2Voltage > this.cutoffVoltage,
            ];
            for (let ch = 0; ch < 4; ch++) {
                this.idleSeconds[ch] = idleNow[ch] ? this.idleSeconds[ch] + dt : 0;
            }
            // Idle sensor: its reading is its offset
            const r = s.idleNoise / step;
            for (let ch = 0; ch < 4; ch++) {
                if (this.idleSeconds[ch] < s.idleTime) continue;
                const Pc = P.map(row => row[ch]);
                this._apply(Pc.map(v => v / (P[ch][ch] + r)), x[ch] - b[ch], Pc);
            }
        }

        const [loadCorrected, chargeCorrected, battery1NetCorrected, battery2NetCorrected] = x.map((v, j) => active[j] ? v - b[j] : 0);
        const rawKcl = x.reduce((sum, v, j) => sum + SIGN[j] * v, 0);
        const correctedKcl = x.reduce((sum, v, j) => sum + SIGN[j] * (v - b[j]), 0);     // all channels, offsets removed

        return {
            state: {
                mean: b.map(v => [v]),
                covariance: P.map(row => [...row]),
            },

            biases: {
                bLoad: b[0],
                bCharge: b[1],
                bBat1: b[2],
                bBat2: b[3],
            },

            currents: {
                loadCorrected,
                chargeCorrected,
                battery1NetCorrected,
                battery2NetCorrected,
            },

            diagnostics: {
                rawKcl,
                correctedKcl,
            },
        };
    }

    // Kalman update of the offsets with gain K, innovation nu and PH (P times the measurement row)
    _apply(K, nu, PH) {
        for (let i = 0; i < 4; i++) {
            this.bias[i] += K[i] * nu;
            for (let j = 0; j < 4; j++) {
                this.covariance[i][j] -= K[i] * PH[j];
            }
        }
    }
}

module.exports = { CurrentKCLCorrector };
