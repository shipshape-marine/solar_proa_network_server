"""Shared code for the SoC estimator evaluation notebooks.

Used by controlled_evaluation.ipynb, operational_evaluation.ipynb and summary.ipynb. No Node, .env or database is
needed: the EKF and the current corrector are batched ports of proa_advisor/lib/Kalman Filter
(kalman_filter_helper/filter.js and kalman_filter_helper/kcl_corrector.js). With the ORIGINAL settings they reproduce
the server's output; TUNED holds the settings chosen in the tuning study.

Sign convention: positive current is discharge (as in filter.js). Methods compared:
- CC: coulomb counting.
- OCV: SoC looked up from the terminal voltage at every step (no memory, no IR compensation).
- EKF: 2RC EKF.
- EKF + KCL: 2RC EKF fed the current after the gated KCL corrector (offsets + current-balance update).
Offset correction is a shared input step for CC, EKF and EKF + KCL, not a method of its own
(see final_report/kcl_correction_explained.md).
"""
from pathlib import Path
import json
import re

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = REPO_ROOT / 'proa_advisor' / 'model' / 'battery_model'
TEST_DATA = MODEL_DIR / 'test_data'
# Folder under TEST_DATA for each run. When a folder is renamed, change it here only: every notebook reads these.
FOLDERS = {
    'LiNMC controlled': 'LiNMC Controlled Discharge',
    'LiFePO4 controlled': 'LiFePO4 Controlled Discharge',
    'General Discharge Test': 'General Discharge Test',
    'General Discharge Test 2': 'General Discharge Test 2',
    'LiFePO4 General Test': 'LiFePO4 General Test',
    'LiNMC General Test': 'LiNMC General Test',
}
FIG_DIR = REPO_ROOT / 'final_report' / 'figures'
TABLE_DIR = REPO_ROOT / 'final_report' / 'tables'

# Rest-window definition (the same windows are used for every method)
I_ACTIVE = 1.0             # A, battery |I| above this counts as load or charge
I_REST = 0.5               # A, every current below this counts as rest
T_VERIFY = 10              # s after the last switching event before t0
MIN_REST = 5 * 60          # s, controlled runs (operational runs use MIN_REST_OPERATIONAL)
MIN_REST_OPERATIONAL = 2 * 60
DVDT_LIMIT = 10e-3 / 60    # V/s, the 10 mV per minute criterion (pack voltage)
SLOPE_WIN = 60             # s, trailing window for the dV/dt fit
AVG_WIN = 2.5              # s, values at t0, t1 and rest end are means over +/- this
V_CUTOFF = 30              # V, BATT_CUTOFF_VOLTAGE in kalman_filter.js
SESSION_GAP = 60           # s, a larger time step starts a new session (unrecorded gap)
CURRENT_FLIP_THRESHOLD = 5.0

METHODS = {'soc_cc': 'Coulomb counting', 'soc_ocv': 'OCV mapping', 'soc_ekf': 'EKF', 'soc_ekf_kcl': 'EKF + KCL'}


# --------------------------------------------------------------------------- sensor conversion and loading
V_REF = 4.096
ADC_FS = {0: 2.5, 1: 1.25, 2: 0.625, 3: 0.3125, 4: 0.15625, 5: 2.5, 6: 1.25, 7: 0.625, 8: 0.3125}
VOLTAGE_DIVIDER_RATIO = (100 + 20) / 20
DB_EXPORT_COLUMNS = {'time_diff': 'timediff_us', **{f'adcReading{i}': f'ch{i}' for i in range(8)}}


def adc_to_voltage(adc, rng):
    fs = ADC_FS[rng] * V_REF
    adc = np.asarray(adc, dtype=float)
    if rng <= 4:
        return (adc - 32768) / 32768 * fs
    return adc / 65536 * fs


def adc_to_current(adc, rng=1):
    v = adc_to_voltage(adc, rng)
    a = np.abs(v)
    return np.sign(v) * (0.90225289 * a ** 2 + 15.06345527 * a)


def read_test_file(path):
    """One logger CSV, either the SD-card format or a database export."""
    df = pd.read_csv(path)
    if 'timediff_us' not in df.columns:
        df = df.rename(columns=DB_EXPORT_COLUMNS | {'id': 'counter'})
    return df[['counter', 'timediff_us'] + [f'ch{i}' for i in range(8)]].astype(float)


def detect_and_correct_flips(df, verbose=True, mppt_latch=True):
    """detectAndCorrectFlips in kalman_filter.js: zero a battery below the cutoff, latch an MPPT sign flip below
    -5 A, flip a battery whose sign breaks KCL by more than 2 A, and drop samples that cannot be corrected.

    The server's latch was permanent: after one raw sample below -5 A every later MPPT reading was negated. It was
    removed on 2026-10-29 (now the fixed MPPT_SENSOR_REVERSED setting). mppt_latch=False leaves the MPPT sign as
    recorded (audit correction, and what the server does now). The latch never trips on the controlled runs."""
    for i, v in (('I_b1', 'V_b1'), ('I_b2', 'V_b2')):
        low = df[v] < V_CUTOFF
        df.loc[low, [i, v]] = 0.0
    if mppt_latch:
        mppt = df.I_mppt.to_numpy()
        flipped_before = np.r_[False, np.maximum.accumulate(mppt < -CURRENT_FLIP_THRESHOLD)[:-1]]
        mppt = np.where(flipped_before, -mppt, mppt)
        df['I_mppt'] = np.where(mppt < -CURRENT_FLIP_THRESHOLD, -mppt, mppt)
    b1, b2, load, mppt = df.I_b1, df.I_b2, df.I_load, df.I_mppt
    violation = b1 + b2 - load + mppt > 2
    flip1 = violation & (-b1 + b2 - load + mppt < 1)
    flip2 = violation & ~flip1 & (b1 - b2 - load + mppt < 1)
    df.loc[flip1, 'I_b1'] = -df.loc[flip1, 'I_b1']
    df.loc[flip2, 'I_b2'] = -df.loc[flip2, 'I_b2']
    keep = ~violation | flip1 | flip2
    if verbose and (~keep).any():
        print(f'  skipped {(~keep).sum()} samples with an uncorrectable KCL violation')
    return df[keep].reset_index(drop=True)


def _natural(p):
    return [int(s) if s.isdigit() else s for s in re.split(r'(\d+)', p.name)]


def load_run(folder, slot='main', files=None, verbose=True, correct_flips=True, mppt_latch=True):
    """Raw samples of one test folder (files in natural order, or the given subset).

    A file continues the previous session only if its counter carries on (part files of one recording); a time step
    above SESSION_GAP also starts a session. dt is 0 at a session start and gap_s holds the unrecorded time there
    (a new recording's first time step, which is not the true gap when the recordings are days apart).
    correct_flips=False skips detectAndCorrectFlips (for the audit, which needs the signs as recorded);
    mppt_latch=False keeps the rest of it but leaves the MPPT sign as recorded.
    """
    frames, next_session, last_counter = [], 0, None
    paths = sorted(Path(folder).glob('*.csv'), key=_natural) if files is None else [Path(folder) / f for f in files]
    for file in paths:
        df = read_test_file(file)
        dt = df.timediff_us.to_numpy() / 1e6
        continues = last_counter is not None and df.counter.iloc[0] == last_counter + 1 and dt[0] <= SESSION_GAP
        last_counter = df.counter.iloc[-1]
        new_session = np.r_[not continues, dt[1:] > SESSION_GAP]
        session = next_session + np.cumsum(new_session) - 1
        next_session = session[-1] + 1
        frames.append(pd.DataFrame({
            'file': file.name, 'session': session,
            'dt': np.where(new_session, 0.0, dt), 'gap_s': np.where(new_session, np.maximum(dt, 1e-9), 0.0),
            'I_mppt': adc_to_current(df.ch0), 'I_load': adc_to_current(df.ch1),
            'I_b1': adc_to_current(df.ch2), 'I_b2': adc_to_current(df.ch3),
            'V_b1': adc_to_voltage(df.ch6, 5) * VOLTAGE_DIVIDER_RATIO,
            'V_b2': adc_to_voltage(df.ch7, 5) * VOLTAGE_DIVIDER_RATIO,
        }))
    raw = pd.concat(frames, ignore_index=True)
    if correct_flips:
        raw = detect_and_correct_flips(raw, verbose, mppt_latch)
    i_col, v_col = {'main': ('I_b1', 'V_b1'), 'alternate': ('I_b2', 'V_b2')}[slot]
    raw['I_bat'], raw['V_bat'] = raw[i_col], raw[v_col]
    raw['t'] = raw.dt.cumsum()
    return raw


def window_median(raw, n=10):
    """The 10-sample median stream that kalman_filter.js feeds the filters."""
    block = raw.groupby('session').cumcount() // n
    groups = raw.groupby([raw.session, block], sort=True)
    cols = ['I_mppt', 'I_load', 'I_b1', 'I_b2', 'I_bat', 'V_b1', 'V_b2', 'V_bat']
    win = groups[cols].median()
    win['file'] = groups.file.first()
    win['dt'] = groups.dt.sum()
    win['gap_s'] = groups.gap_s.sum()            # unrecorded time before the first window of a session
    win = win.reset_index(level=0).reset_index(drop=True)
    win['t'] = win.dt.cumsum()
    return win


def window_mean(raw, n=10):
    """The charge-preserving 10-sample stream that kalman_filter.js feeds the filters since 2026-11-08 (windowInputs):
    currents as sum(I*dt)/sum(dt) (a battery's current is already 0 below the cutoff), voltages as the mean of the
    samples above V_CUTOFF (0 V when none is). A window with sum(dt) = 0 takes the plain mean of the currents."""
    block = raw.groupby('session').cumcount() // n
    keys = [raw.session.to_numpy(), block.to_numpy()]
    cur, volt = ['I_mppt', 'I_load', 'I_b1', 'I_b2', 'I_bat'], ['V_b1', 'V_b2', 'V_bat']
    x = raw[cur].mul(raw.dt, axis=0).assign(dt=raw.dt)
    groups = x.groupby(keys, sort=True)
    q, dt = groups[cur].sum(), groups.dt.sum()
    plain = raw[cur].groupby(keys, sort=True).mean()
    win = q.div(dt.where(dt > 0), axis=0).fillna(plain)
    win[volt] = raw[volt].where(raw[volt] > V_CUTOFF).groupby(keys, sort=True).mean().fillna(0.0)
    g = raw.groupby(keys, sort=True)
    win['file'] = g.file.first()
    win['dt'] = dt
    win['gap_s'] = g.gap_s.sum()
    win = win.reset_index(level=0, names='session').reset_index(drop=True)
    win['t'] = win.dt.cumsum()
    return win


WINDOWS = {'median': window_median, 'mean': window_mean}


# --------------------------------------------------------------------------- battery model
def load_model(folder):
    """A model folder (battery_constants.json, battery_state.csv, optional noise.json). SoC stored in percent is
    converted to a fraction, as the server's model folders use."""
    folder = Path(folder)
    const = json.loads((folder / 'battery_constants.json').read_text())
    noise_file = folder / 'noise.json'
    noise = json.loads(noise_file.read_text()) if noise_file.exists() else {'socProcess': 1e-22, 'rcProcess': 1e-22}
    table = pd.read_csv(folder / 'battery_state.csv')
    if table.SoC.max() > 1.5:
        table['SoC'] = table.SoC / 100
    inv_ocv, first = np.unique(np.maximum.accumulate(table.OCV.to_numpy()), return_index=True)
    return {'name': folder.name, 'folder': folder, 'Q_total': const['Q_total'], 'sigma_v': const['sigma_v'],
            'sigma_kcl': const['sigma_kcl'], 'noise': noise,
            'table': {c: table[c].to_numpy() for c in ['SoC', 'OCV', 'R0', 'R1', 'R2', 'C1', 'C2']},
            'inv_ocv': inv_ocv, 'inv_soc': table.SoC.to_numpy()[first]}


def ocv_to_soc(v, model):
    return np.interp(v, model['inv_ocv'], model['inv_soc'])


def soc_to_ocv(soc, model):
    return np.interp(soc, model['table']['SoC'], model['table']['OCV'])


def nearest_ocv_soc(v, model):
    """Initial SoC as the server picks it: the table row whose OCV is closest to the voltage."""
    t = model['table']
    return t['SoC'][np.argmin(np.abs(t['OCV'] - v))]


# --------------------------------------------------------------------------- batched EKF
def as_cfg(cfgs, defaults):
    df = pd.DataFrame([{**defaults, **c} for c in cfgs])
    return {k: df[k].to_numpy() for k in df.columns}, df


EKF_BASE = dict(soc0=1.0, p0_soc=1e-8, p0_rc=1e-8, q_soc=1e-22, q_rc=1e-22, r=0.001833551135313909 ** 2, rate=False,
                h_min=0.0, gate_v=False, gate_i=1.0, gate_t=0.0)


def ekf_batch(win, model, cfgs, current=None, record_dt=1.0, gap_decay=False, voltage=None):
    """Run len(cfgs) EKFs side by side. current: None (win.I_bat), array (steps,) or (N, steps); voltage likewise
    (the cutoff check always uses win.V_bat).

    r is the voltage noise variance per step, or with rate=True a density in V^2*s (R_k = r / dt_k), which keeps the
    filter's trust in voltage per second the same at any sampling rate. h_min skips the voltage update where
    |dOCV/dSoC| at the estimate is below it; with gate_v the update is also allowed once |I| < gate_i for gate_t
    seconds and the rested voltage maps to a part of the curve at least that steep. gap_decay lets the RC voltages
    relax over unrecorded gaps instead of resetting them.
    Returns SoC recorded about every record_dt seconds, the record times, and innovation statistics.
    """
    c, df = as_cfg(cfgs, EKF_BASE)
    N = len(df)
    tab = model['table']
    SOC, OCV, R0, R1, R2 = (tab[k] for k in ('SoC', 'OCV', 'R0', 'R1', 'R2'))
    INV1, INV2 = 1 / (tab['R1'] * tab['C1']), 1 / (tab['R2'] * tab['C2'])
    SLOPE = np.r_[np.diff(OCV) / np.diff(SOC), 0.0]
    n_tab, Qn = len(SOC), model['Q_total'] * 3600

    dt, v, sess, t = (win[k].to_numpy() for k in ('dt', 'V_bat', 'session', 't'))
    vm = v if voltage is None else np.asarray(voltage)
    per_cfg_v = vm.ndim == 2
    I = win.I_bat.to_numpy() if current is None else np.asarray(current)
    gap = win.gap_s.to_numpy() if gap_decay else None
    per_cfg_i = I.ndim == 2
    rec = record_steps(t, record_dt)
    is_rec = np.zeros(len(t), bool); is_rec[rec] = True

    def row(s):
        k = np.floor(s * 100 * 1000 + 0.5).astype(np.int64)
        return np.where(1 - s < 1e-5, n_tab - 2, np.where(s < 1e-5, 0, k))

    soc = c['soc0'].astype(float).copy()
    v1, v2 = np.zeros(N), np.zeros(N)
    p00, p11, p22 = c['p0_soc'].astype(float).copy(), c['p0_rc'].astype(float).copy(), c['p0_rc'].astype(float).copy()
    p01, p02, p12 = np.zeros(N), np.zeros(N), np.zeros(N)
    qs, qr, r, rate = c['q_soc'], c['q_rc'], c['r'], c['rate'].astype(bool)
    h_min, gate_v, gate_i, gate_t = c['h_min'], c['gate_v'].astype(bool), c['gate_i'], c['gate_t']
    rest_t = np.zeros(N)
    inv_ocv, inv_soc = model['inv_ocv'], model['inv_soc']
    k = row(soc)
    out = np.empty((N, len(rec)))
    nu2, nis, n_upd = np.zeros(N), np.zeros(N), 0
    j = 0
    for s in range(len(t)):
        if s and sess[s] != sess[s - 1]:
            if gap_decay:      # RC voltages relax over the unrecorded gap with no current (days: same as a reset)
                v1 = v1 * np.exp(-gap[s] * INV1[k]); v2 = v2 * np.exp(-gap[s] * INV2[k])
            else:
                v1[:] = 0.0; v2[:] = 0.0
        d = dt[s]
        if v[s] > V_CUTOFF and d > 0:
            i = I[:, s] if per_cfg_i else I[s]
            vs = vm[:, s] if per_cfg_v else vm[s]
            r0, r1, r2, ocv, h0 = R0[k], R1[k], R2[k], OCV[k], SLOPE[k]
            a1, a2 = np.exp(-d * INV1[k]), np.exp(-d * INV2[k])
            socp = np.clip(soc - i * d / Qn, 0.0, 1.0)
            v1p = a1 * v1 + r1 * (1 - a1) * i
            v2p = a2 * v2 + r2 * (1 - a2) * i
            p00 = p00 + qs * d; p01 = a1 * p01; p02 = a2 * p02
            p11 = a1 * a1 * p11 + qr * d; p12 = a1 * a2 * p12; p22 = a2 * a2 * p22 + qr * d
            ph0 = p00 * h0 - p01 - p02
            ph1 = p01 * h0 - p11 - p12
            ph2 = p02 * h0 - p12 - p22
            S = h0 * ph0 - ph1 - ph2 + np.where(rate, r / d, r)
            nu = vs - (ocv - v1p - v2p - r0 * i)
            use = np.abs(h0) >= h_min          # skip the voltage update where the OCV curve is too flat to carry SoC
            if gate_v.any():                   # also open the gate when, at low current, the voltage itself sits on a steep part
                kv = np.clip(np.floor(np.interp(vs + r0 * i, inv_ocv, inv_soc) * 1e5 + 0.5).astype(np.int64), 0, n_tab - 2)
                rest_t = np.where(np.abs(i) < gate_i, rest_t + d, 0.0)
                use = use | (gate_v & (rest_t >= gate_t) & (np.abs(SLOPE[kv]) >= h_min))
            K0, K1, K2 = ph0 / S * use, ph1 / S * use, ph2 / S * use
            soc = np.clip(socp + K0 * nu, 0.0, 1.0)
            v1 = v1p + K1 * nu; v2 = v2p + K2 * nu
            p00 = p00 - K0 * ph0; p01 = p01 - K0 * ph1; p02 = p02 - K0 * ph2
            p11 = p11 - K1 * ph1; p12 = p12 - K1 * ph2; p22 = p22 - K2 * ph2
            k = row(soc)
            nu2 += nu * nu; nis += nu * nu / S; n_upd += 1
        if is_rec[s]:
            out[:, j] = soc; j += 1
    stats = pd.DataFrame({'innov_rms_mV': 1e3 * np.sqrt(nu2 / n_upd), 'nis_mean': nis / n_upd})
    return out, t[rec], stats


def record_steps(t, record_dt):
    """Indices of the first step in each record_dt bin (every step when record_dt <= 0)."""
    return np.arange(len(t)) if record_dt <= 0 else np.flatnonzero(np.diff(np.floor(t / record_dt), prepend=-1) > 0)


# --------------------------------------------------------------------------- batched current corrector
SIGN = np.array([1.0, -1.0, -1.0, -1.0])      # KCL: load - mppt - bat1 - bat2 = 0

KCL_BASE = dict(
    r=0.03268307258978865, rate=False,              # pseudo-measurement noise (A^2 per step, or A^2*s with rate)
    q_load=1e-12, q_mppt=1e-12, q_b1=1e-18, q_b2=1e-18,
    p0_load=1e-4, p0_mppt=1e-4, p0_b1=1e-5, p0_b2=1e-5,
    th=0.05,                                        # activity threshold (KCL_CURRENT_THRESHOLD)
    guard='signed',                                 # 'signed' (repo), 'abs', 'none'
    mask_h=False,                                   # True: residual uses active channels only, like H
    gate=0.0,                                       # >0: skip KCL updates with |innovation| > gate * sqrt(S)
    idle=False,                                     # zero-current updates on idle channels
    q_always=False,                                 # process noise on every channel (repo: active channels only)
    kcl_update=True,                                # False: skip the KCL pseudo-measurement (idle offsets only)
    idle_th=0.3, idle_t=10.0, idle_bat_th=1.0, r_idle=1e-3,
)


def kcl_batch(win, cfgs, record_dt=1.0):
    """Run len(cfgs) current correctors. Returns corrected bat1/bat2 currents per step, the residual with the learned
    biases removed, and the biases (recorded)."""
    c, df = as_cfg(cfgs, KCL_BASE)
    N = len(df)
    cur = win[['I_load', 'I_mppt', 'I_b1', 'I_b2']].to_numpy()
    XA = np.c_[cur[:, 0], cur[:, 1], np.abs(cur[:, 2]), np.abs(cur[:, 3])]   # activity test: load/MPPT signed, batteries |I|
    # Below the cutoff the server zeroes a battery's current: not a real zero, so no idle update there
    v_ok1, v_ok2 = win.V_b1.to_numpy() > V_CUTOFF, win.V_b2.to_numpy() > V_CUTOFF
    dt, t = win.dt.to_numpy(), win.t.to_numpy()
    rec = record_steps(t, record_dt)
    is_rec = np.zeros(len(t), bool); is_rec[rec] = True

    q = np.c_[c['q_load'], c['q_mppt'], c['q_b1'], c['q_b2']]
    b = np.zeros((N, 4))
    P = np.zeros((N, 4, 4))
    P[:, range(4), range(4)] = np.c_[c['p0_load'], c['p0_mppt'], c['p0_b1'], c['p0_b2']]
    th, r, rate, mask_h, gate = c['th'][:, None], c['r'], c['rate'].astype(bool), c['mask_h'].astype(bool), c['gate']
    q_always, kcl_update = c['q_always'].astype(bool)[:, None], c['kcl_update'].astype(bool)
    guard = c['guard']
    g_signed, g_abs = guard == 'signed', guard == 'abs'
    idle_on, idle_th, idle_t, idle_bat_th, r_idle = (c['idle'].astype(bool), c['idle_th'], c['idle_t'],
                                                     c['idle_bat_th'], c['r_idle'])
    idle_time = np.zeros((N, 4))
    d4 = np.arange(4)

    i_b1, i_b2 = np.zeros((N, len(t))), np.zeros((N, len(t)))
    res_corr = np.zeros((N, len(t)))
    bias_rec = np.zeros((N, 4, len(rec)))
    reverted = np.zeros(N)
    j = 0
    for s in range(len(t)):
        x, d = cur[s], dt[s]
        active = XA[s][None, :] > th
        raw = SIGN @ x
        # Predict: random-walk biases, process noise only on active channels (clampNoise) unless q_always
        P[:, d4, d4] += np.where(active | q_always, q, 0.0) * d
        H = -SIGN * active                                       # dh/db
        # h = sum SIGN_j (x_j - b_j); the repo sums every channel, mask_h only the active ones (matching H)
        m = np.where(mask_h[:, None], active, 1.0)
        h = ((x - b) * SIGN * m).sum(1)
        PH = np.einsum('nij,nj->ni', P, H)
        S = (H * PH).sum(1) + np.where(rate, r / max(d, 1e-9), r)
        nu = -h
        ok = kcl_update & ((gate <= 0) | (nu * nu <= gate * gate * S))
        K = PH / S[:, None] * ok[:, None]
        b = b + K * nu[:, None]
        P = P - K[:, :, None] * PH[:, None, :]

        if idle_on.any():
            # Zero-current pseudo-measurements: an idle sensor reads its own bias. A battery is idle when the
            # load and MPPT are idle (KCL then forces it to ~0), its own reading is small and it is above the cutoff.
            own = np.abs(x)[None, :] < idle_th[:, None]
            lm = own[:, 0] & own[:, 1]
            idle_now = np.c_[own[:, 0], own[:, 1], lm & (abs(x[2]) < idle_bat_th) & v_ok1[s],
                             lm & (abs(x[3]) < idle_bat_th) & v_ok2[s]]
            idle_time = np.where(idle_now, idle_time + d, 0.0)
            use = idle_on[:, None] & (idle_time >= idle_t[:, None])
            r0 = np.where(rate, r_idle / max(d, 1e-9), r_idle)
            for ch in range(4):
                u = use[:, ch]
                if not u.any():
                    continue
                Pc = P[:, :, ch]
                Kc = Pc / (P[:, ch, ch] + r0)[:, None] * u[:, None]
                b = b + Kc * (x[ch] - b[:, ch])[:, None]
                P = P - Kc[:, :, None] * Pc[:, None, :]

        corrected = np.where(active, x - b, 0.0)
        corr_kcl = corrected @ SIGN
        raw_cmp = np.where(mask_h, np.where(active, x, 0.0) @ SIGN, raw)
        rev = (g_signed & (corr_kcl > raw_cmp)) | (g_abs & (np.abs(corr_kcl) > np.abs(raw_cmp)))
        corrected = np.where(rev[:, None], np.where(active, x, 0.0), corrected)
        reverted += rev
        i_b1[:, s], i_b2[:, s] = corrected[:, 2], corrected[:, 3]
        res_corr[:, s] = ((x - b) * SIGN).sum(1)                 # all channels, learned biases removed
        if is_rec[s]:
            bias_rec[:, :, j] = b; j += 1
    return {'i_b1': i_b1, 'i_b2': i_b2, 'res_corr': res_corr, 'bias': bias_rec, 't_rec': t[rec],
            'reverted_frac': reverted / len(t), 'cfg': df}


# --------------------------------------------------------------------------- configuration (frozen)
# Offset correction (K3): learns each sensor's zero offset while it is idle; no current-balance update.
OFFSETS = dict(idle=True, q_always=True, rate=True, r=2.5e-3, r_idle=1e-3, q_load=1e-7, q_mppt=1e-7, q_b1=1e-7,
               q_b2=1e-7, idle_th=0.3, idle_t=10.0, idle_bat_th=1.0, th=0.3, mask_h=True, guard='none',
               kcl_update=False)
# Gated KCL corrector (K3k): the offsets plus the current-balance update with a 4-sigma innovation gate.
KCL_GATED = dict(OFFSETS, kcl_update=True, gate=4.0)

BATTERIES = {
    'LiNMC': dict(
        model=MODEL_DIR / 'LiNMC',
        controlled=dict(folder=FOLDERS['LiNMC controlled'], slot='main'),
        # Characterization SoC: mean of battery and load sensor, rows above the cutoff, 0 % at the last such row
        reference=dict(current='average', anchor='end'),
        score_soc=(0.034, 0.922), score_sessions=(0, 1, 2),     # 8 Apr session excluded (week-long rest)
        # Sessions are days apart and the files do not record the gap: RC voltages reset at a session break
        gap_decay=False,
        ekf=dict(rate=True, r=1e-4, q_soc=1e-12, q_rc=1e-7, p0_soc=1e-2)),
    'LiFePO4': dict(
        model=REPO_ROOT / 'final_report' / 'Calibration Code' / 'LiFePO4 Patch Output',
        controlled=dict(folder=FOLDERS['LiFePO4 controlled'], slot='main'),
        # Characterization SoC: mean of battery and load sensor with negatives clipped, 100 % at the start
        reference=dict(current='average_clipped', anchor='start'),
        score_soc=(0.11, 0.84), score_sessions=None,
        gap_decay=True,                                         # file gaps of minutes: RC voltages relax over them
        ekf=dict(rate=True, r=1e-4, q_soc=1e-9, q_rc=1e-7, p0_soc=1e-2,
                 h_min=5.0, gate_v=True, gate_i=1.0, gate_t=300.0)),   # voltage update only where the curve is steep
}


def settings(battery, model, which='tuned'):
    """Filter settings for one battery. 'tuned': the frozen configuration used in the report.
    'original': the server as it was (noise.json, P0 1e-8, R = sigma_v^2, raw current, repo KCL corrector)."""
    if which == 'tuned':
        return dict(ekf=BATTERIES[battery]['ekf'], offsets=OFFSETS, kcl=KCL_GATED, gap_decay=BATTERIES[battery]['gap_decay'])
    if which == 'original':
        ekf = dict(p0_soc=1e-8, p0_rc=1e-8, q_soc=model['noise']['socProcess'], q_rc=model['noise']['rcProcess'],
                   r=model['sigma_v'] ** 2, rate=False)
        return dict(ekf=ekf, offsets=None, kcl=dict(r=model['sigma_kcl']), gap_decay=False)
    raise ValueError(which)


# --------------------------------------------------------------------------- running the methods
def characterization_soc(win, battery, model):
    """Characterization SoC per step of a controlled run (descriptive reference, not ground truth)."""
    ref = BATTERIES[battery]['reference']
    dt, V = win.dt.to_numpy(), win.V_bat.to_numpy()
    valid = V > V_CUTOFF
    avg = (win.I_bat.to_numpy() + win.I_load.to_numpy()) / 2
    if ref['current'] == 'average_clipped':
        avg = np.clip(avg, 0, None)
    soc = 1.0 - np.cumsum(np.where(valid, avg * dt, 0.0)) / (model['Q_total'] * 3600)
    if ref['anchor'] == 'end':
        soc -= soc[np.flatnonzero(valid)[-1]]
    return soc


def run_methods(win, model, cfg, slot='main', soc0=1.0, start_offsets=(), record_dt=1.0):
    """Run every method on one median stream with one settings dict (see settings()).

    Returns (est, extra). est has one row per record (about every record_dt s): t, session, V, the currents (raw,
    offset-corrected, KCL-corrected) and the SoC of each method started from soc0. extra holds the corrector
    diagnostics and, with start_offsets, each method's SoC from soc0 + offset (clipped to 0-1), shape (starts, records).
    """
    bat = 'i_b1' if slot == 'main' else 'i_b2'
    raw = win.I_bat.to_numpy()
    dt, V, t = win.dt.to_numpy(), win.V_bat.to_numpy(), win.t.to_numpy()

    corr_cfgs = ([cfg['offsets']] if cfg['offsets'] is not None else []) + [cfg['kcl']]
    kb = kcl_batch(win, corr_cfgs, record_dt)
    i_off = kb[bat][0] if cfg['offsets'] is not None else raw
    i_kcl = kb[bat][-1]

    starts = np.clip(soc0 + np.r_[0.0, start_offsets], 0.0, 1.0)
    n = len(starts)
    # EKF from every start on the offset-corrected and the KCL-corrected current, plus one on the raw current
    cfgs = [dict(cfg['ekf'], soc0=s) for s in starts] * 2 + [dict(cfg['ekf'], soc0=starts[0])]
    current = np.vstack([np.broadcast_to(i_off, (n, len(t))), np.broadcast_to(i_kcl, (n, len(t))), raw[None, :]])
    soc, t_rec, stats = ekf_batch(win, model, cfgs, current=current, record_dt=record_dt, gap_decay=cfg['gap_decay'])

    rec = record_steps(t, record_dt)
    Qn = model['Q_total'] * 3600
    cc = starts[:, None] - np.cumsum(i_off * dt)[rec][None, :] / Qn
    ocv = np.where(V > V_CUTOFF, ocv_to_soc(V, model), np.nan)[rec]
    res_raw = (win[['I_load', 'I_mppt', 'I_b1', 'I_b2']].to_numpy() @ SIGN)[rec]
    est = pd.DataFrame({
        't': t_rec, 'session': win.session.to_numpy()[rec], 'V': V[rec],
        'I_raw': raw[rec], 'I_off': i_off[rec], 'I_kcl': i_kcl[rec],
        'I_load': win.I_load.to_numpy()[rec], 'I_mppt': win.I_mppt.to_numpy()[rec],
        'soc_cc': cc[0], 'soc_ocv': ocv, 'soc_ekf': soc[0], 'soc_ekf_kcl': soc[n],
        # the same CC and EKF on the raw battery current (input table only)
        'soc_cc_raw': starts[0] - np.cumsum(raw * dt)[rec] / Qn, 'soc_ekf_raw': soc[2 * n],
    })
    valid = V > V_CUTOFF
    ah = lambda x: float(np.sum(np.where(valid, x * dt, 0.0)) / 3600)
    extra = {
        'starts': starts,
        'Ah': {'raw': ah(raw), 'offsets': ah(i_off), 'kcl': ah(i_kcl)},     # battery charge out (+) above the cutoff
        'by_start': {'soc_cc': cc, 'soc_ocv': np.broadcast_to(ocv, (n, len(rec))), 'soc_ekf': soc[:n], 'soc_ekf_kcl': soc[n:2 * n]},
        'bias_offsets': kb['bias'][0] if cfg['offsets'] is not None else None,      # (4 channels, records)
        'bias_kcl': kb['bias'][-1],
        'res_raw': res_raw, 'res_offsets': kb['res_corr'][0][rec] if cfg['offsets'] is not None else None,
        'res_kcl': kb['res_corr'][-1][rec], 'reverted_frac': kb['reverted_frac'][-1],
        'innov_rms_mV': {'soc_ekf': stats.innov_rms_mV[0], 'soc_ekf_kcl': stats.innov_rms_mV[n],
                         'soc_ekf_raw': stats.innov_rms_mV[2 * n]},
    }
    return est, extra


def add_reference(est, win, battery, model):
    """Characterization SoC at the record times (column soc_ref) and the scoring mask (column scored)."""
    b = BATTERIES[battery]
    ref = characterization_soc(win, battery, model)
    est['soc_ref'] = ref[np.searchsorted(win.t.to_numpy(), est.t)]
    lo, hi = b['score_soc']
    scored = (est.V > V_CUTOFF) & est.soc_ref.between(lo, hi) & (est.t > 300)
    if b['score_sessions'] is not None:
        scored &= est.session.isin(b['score_sessions'])
    est['scored'] = scored
    return est


# --------------------------------------------------------------------------- rest windows
def _trailing_slope(t, v, window):
    c = lambda a: np.r_[0.0, np.cumsum(a)]
    St, Sv, Stt, Stv = c(t), c(v), c(t * t), c(t * v)
    hi = np.arange(1, len(t) + 1)
    lo = np.searchsorted(t, t - window, side='right')
    n = hi - lo
    st, sv, stt, stv = St[hi] - St[lo], Sv[hi] - Sv[lo], Stt[hi] - Stt[lo], Stv[hi] - Stv[lo]
    with np.errstate(invalid='ignore', divide='ignore'):
        slope = (n * stv - st * sv) / (n * stt - st ** 2)
    slope[t - t[0] < window] = np.nan
    return slope


def mean_near(t, y, tc, lo, hi):
    """Mean of y within +/- AVG_WIN s of tc, kept inside [lo, hi]."""
    mask = (t >= max(tc - AVG_WIN, lo)) & (t <= min(tc + AVG_WIN, hi))
    return np.nanmean(y[mask])


def find_rests(win, min_rest=MIN_REST):
    """Rest windows of a median stream.

    A rest is a block where every current (both batteries, load, MPPT) is below I_REST and the voltage is above the
    cutoff, lasting at least min_rest and preceded in the same session by an active block (battery |I| > I_ACTIVE).
    t_disc: start of the block; t0 = t_disc + T_VERIFY; t1: first time the trailing 60 s voltage slope is within
    10 mV/min (t_end if never); t_end: last rest step. type: after_discharge or after_charge, from the mean battery
    current of the preceding active block.
    """
    t_all, v_all, i_all, s_all = (win[k].to_numpy() for k in ('t', 'V_bat', 'I_bat', 'session'))
    quiet_all = (win[['I_b1', 'I_b2', 'I_load', 'I_mppt']].abs().max(axis=1) < I_REST).to_numpy() & (v_all > V_CUTOFF)
    rests = []
    for session in np.unique(s_all):
        m = s_all == session
        t, i, v, quiet = t_all[m], i_all[m], v_all[m], quiet_all[m]
        edges = np.flatnonzero(np.diff(np.r_[0, quiet.astype(int), 0]))
        for s, e in zip(edges[::2], edges[1::2]):
            t_disc, t_end = t[s], t[e - 1]
            if t_end - t_disc < min_rest:
                continue
            active = np.flatnonzero(np.abs(i[:s]) > I_ACTIVE)
            if not len(active):
                continue
            run_start = active[np.flatnonzero(np.diff(np.r_[-2, active]) > 1)[-1]]
            i_before = i[run_start:active[-1] + 1].mean()
            t0 = t_disc + T_VERIFY
            seg = slice(np.searchsorted(t, t0), e)
            slope = _trailing_slope(t[seg] - t0, v[seg], SLOPE_WIN)
            ok = np.flatnonzero(np.abs(slope) <= DVDT_LIMIT)
            t1 = t[seg][ok[0]] if len(ok) else t_end
            rests.append({'session': session, 'type': 'after_discharge' if i_before > 0 else 'after_charge',
                          't_disc': t_disc, 't0': t0, 't1': t1, 't_end': t_end, 'criterion_met': bool(len(ok)),
                          'I_before': i_before})
    rests = pd.DataFrame(rests, columns=['session', 'type', 't_disc', 't0', 't1', 't_end', 'criterion_met', 'I_before'])
    rests.insert(0, 'rest', np.arange(1, len(rests) + 1))
    return rests


# --------------------------------------------------------------------------- plot style
# Method colours were checked for colour-vision separation and stay fixed per method in every figure.
# Measured signals are drawn in neutral ink, told apart by line style.
COLORS = {'soc_cc': '#1baf7a', 'soc_ocv': '#eda100', 'soc_ekf': '#eb6834', 'soc_ekf_kcl': '#2a78d6'}
MARKERS = {'soc_cc': 'o', 'soc_ocv': 's', 'soc_ekf': '^', 'soc_ekf_kcl': 'D'}
INK, INK2, MUTED, GRID, AXIS, SHADE = '#0b0b0b', '#52514e', '#898781', '#e1e0d9', '#c3c2b7', '#f0efec'
CHANNELS = {'I_mppt': dict(color=INK, ls='-', label='MPPT'),
            'I_b1': dict(color=INK2, ls=(0, (4, 2)), label='Battery 1 (main)'),
            'I_b2': dict(color=INK2, ls=(0, (6, 2, 1, 2)), label='Battery 2 (alternate)'),
            'I_load': dict(color=MUTED, ls=(0, (1, 1.5)), label='Load')}


def apply_style():
    plt.rcParams.update({
        'font.family': 'sans-serif', 'font.sans-serif': ['Segoe UI', 'Helvetica', 'Arial', 'DejaVu Sans'],
        'font.size': 9, 'axes.edgecolor': AXIS, 'axes.labelcolor': INK2, 'axes.titlesize': 10, 'axes.titlecolor': INK,
        'xtick.color': MUTED, 'ytick.color': MUTED, 'xtick.labelcolor': INK2, 'ytick.labelcolor': INK2,
        'axes.grid': True, 'grid.color': GRID, 'grid.linewidth': 0.6, 'axes.spines.top': False,
        'axes.spines.right': False, 'lines.linewidth': 1.5, 'lines.solid_capstyle': 'round', 'legend.frameon': False,
        'savefig.dpi': 200})


def save(fig, name):
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ('png', 'pdf'):
        fig.savefig(FIG_DIR / f'{name}.{ext}', bbox_inches='tight')


def save_table(df, name, **kw):
    TABLE_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(TABLE_DIR / f'{name}.csv', **kw)


def suptitle(fig, text):
    fig.suptitle(text, x=0.01, ha='left', fontsize=10, color=INK)


# --------------------------------------------------------------------------- operational audit
OPERATIONAL_FOLDERS = tuple(FOLDERS[r] for r in ('General Discharge Test', 'General Discharge Test 2',
                                                 'LiNMC General Test', 'LiFePO4 General Test'))
# Controlled and older recordings an operational folder must not duplicate. The two old conversions wait in
# TO_DELETE; once they are deleted the audit skips them.
REFERENCE_FOLDERS = tuple(p for p in (TEST_DATA / FOLDERS['LiNMC controlled'], TEST_DATA / FOLDERS['LiFePO4 controlled'],
                                      MODEL_DIR / 'TO_DELETE' / 'LiNMC Full Discharge Test',
                                      MODEL_DIR / 'TO_DELETE' / 'LiFePO4 (Converted from ADS1115) Full Discharge')
                          if p.exists())
FAULT_RESIDUAL = 2.0       # A, per-minute median KCL residual above this is flagged
STATES = ('rest', 'discharging', 'charging', 'pass-through', 'transition')


def file_inventory(folder):
    """Per file: rows, counter range and breaks, sampled time (sum of time steps). Database exports also give the
    wall-clock span, the server run ids, and logger stalls (wall clock advancing more than 5 s between samples while
    the recorded time step stays at about 1 ms), with the charge each battery passed while unrecorded (stall length
    times the median current around it, gross). SD-card files give the start time in their name."""
    rows = []
    bat_cols = (('adcReading2', 'adcReading6'), ('adcReading3', 'adcReading7'))
    for path in sorted(Path(folder).glob('*.csv'), key=_natural):
        head = pd.read_csv(path, nrows=0).columns
        db = 'timestamp' in head
        df = pd.read_csv(path, usecols=['id', 'timestamp', 'run_id', 'time_diff', *[c for p in bat_cols for c in p]] if db
                         else ['counter', 'timediff_us'])
        counter = df['id' if db else 'counter'].to_numpy()
        dt = df['time_diff' if db else 'timediff_us'].to_numpy() / 1e6
        row = {'file': path.name, 'rows': len(df), 'counter_first': counter[0], 'counter_last': counter[-1],
               'counter_breaks': int((np.diff(counter) != 1).sum()), 'median_dt_ms': 1e3 * np.median(dt[1:]),
               'max_step_s': dt[1:].max(), 'sampled_min': dt[1:].sum() / 60}
        if db:
            ts = pd.to_datetime(df.timestamp, format='%Y-%m-%d %H:%M:%S')
            wall = ((ts - ts.iloc[0]).dt.total_seconds()).to_numpy()
            step = np.diff(wall)
            stall = step > 5
            missing = step[stall] - dt[1:][stall]
            row.update(start=ts.iloc[0], end=ts.iloc[-1], wall_min=wall[-1] / 60, run_ids=sorted(df.run_id.unique().tolist()),
                       stalls=int(stall.sum()), stalled_min=missing.sum() / 60)
            for b, (ic, vc) in enumerate(bat_cols, 1):
                cur = np.where(adc_to_voltage(df[vc], 5) * VOLTAGE_DIVIDER_RATIO < V_CUTOFF, 0.0, adc_to_current(df[ic]))
                around = np.array([np.median(cur[max(j - 1000, 0):j + 1001]) for j in np.flatnonzero(stall)])
                row[f'unrecorded Ah, battery {b}'] = np.sum(np.abs(around) * missing) / 3600 if len(around) else 0.0
        else:
            m = re.search(r'(\d{8})-(\d{6})', path.name)
            row['start'] = pd.to_datetime(m.group(1) + m.group(2), format='%Y%m%d%H%M%S') if m else pd.NaT
        rows.append(row)
    return pd.DataFrame(rows)


def fingerprints(paths, k=8):
    """uint64 hash of every k consecutive (time step, battery-1 voltage ADC) pairs, skipping constant windows.
    A copied recording shares these fingerprints; independent recordings practically never do (the time step
    jitters by a few microseconds)."""
    out = []
    for p in paths:
        head = pd.read_csv(p, nrows=0).columns
        cols = ('time_diff', 'adcReading6') if 'time_diff' in head else ('timediff_us', 'ch6')
        if not set(cols) <= set(head):
            continue
        df = pd.read_csv(p, usecols=list(cols))
        x = (df[cols[0]].to_numpy().astype(np.uint64) << np.uint64(20)) ^ df[cols[1]].to_numpy().astype(np.uint64)
        if len(x) < k:
            continue
        n = len(x) - k + 1
        h = np.zeros(n, np.uint64)
        varies = np.zeros(n, bool)
        for j in range(k):
            h = h * np.uint64(1000003) + x[j:n + j]
            varies |= x[j:n + j] != x[:n]
        out.append(h[varies])
    return np.concatenate(out) if out else np.zeros(0, np.uint64)


def duplicate_share(folder, reference):
    """Share of a folder's fingerprints found in the reference fingerprints (sorted uint64 array)."""
    fp = fingerprints(sorted(Path(folder).glob('*.csv'), key=_natural))
    hit = np.isin(fp, reference, assume_unique=False)
    return hit.mean() if len(fp) else np.nan, int(hit.sum())


def infer_state(i_bat, i_mppt, i_load):
    """Operating state from the currents alone (there is no switch-state channel), so it is labelled inferred.
    i_bat is the net battery current (both batteries, zero when disconnected)."""
    rest = (np.abs(i_bat) < I_REST) & (np.abs(i_mppt) < I_REST) & (np.abs(i_load) < I_REST)
    state = np.full(len(i_bat), 'transition', dtype=object)
    state[i_bat >= I_REST] = 'discharging'
    state[i_bat <= -I_REST] = 'charging'
    state[(np.abs(i_bat) < I_REST) & ((i_mppt >= I_REST) | (i_load >= I_REST))] = 'pass-through'
    state[rest] = 'rest'
    return state


def _step_response(t, i, v, ok):
    """Current steps above 2 A (1 s records, 2 s apart) and the share where the voltage moved against the current."""
    r = record_steps(t, 1.0)
    I1, V1, ok1 = i[r], v[r], ok[r]
    dI, dV = I1[2:] - I1[:-2], V1[2:] - V1[:-2]
    step = (np.abs(dI) > 2) & ok1[2:] & ok1[:-2]
    return int(step.sum()), (100 * np.mean(dI[step] * dV[step] < 0) if step.any() else np.nan)


def flip_events(raw):
    """What detectAndCorrectFlips does to a run (raw samples loaded with correct_flips=False): MPPT samples below
    -5 A (the first one latches a sign flip for the rest of the run), battery samples it flips, samples it drops."""
    t, m = raw.t.to_numpy(), raw.I_mppt.to_numpy()
    b1 = np.where(raw.V_b1 < V_CUTOFF, 0.0, raw.I_b1)
    b2 = np.where(raw.V_b2 < V_CUTOFF, 0.0, raw.I_b2)
    load = raw.I_load.to_numpy()
    neg = np.flatnonzero(m < -CURRENT_FLIP_THRESHOLD)
    latched = np.r_[False, np.maximum.accumulate(m < -CURRENT_FLIP_THRESHOLD)[:-1]]
    mp = np.where(latched, -m, m)
    mp = np.where(mp < -CURRENT_FLIP_THRESHOLD, -mp, mp)
    viol = b1 + b2 - load + mp > 2
    flip1 = viol & (-b1 + b2 - load + mp < 1)
    flip2 = viol & ~flip1 & (b1 - b2 - load + mp < 1)
    return pd.Series({
        'raw MPPT samples below -5 A': len(neg),
        'first one at (h)': t[neg[0]] / 3600 if len(neg) else np.nan,
        'its value (A)': m[neg[0]] if len(neg) else np.nan,
        'MPPT samples negated by the latch': int(latched.sum()),
        'of which carrying more than 0.5 A': int((latched & (np.abs(m) > I_REST)).sum()),
        'battery samples sign-flipped': int(flip1.sum() + flip2.sum()),
        'samples dropped (uncorrectable)': int((viol & ~flip1 & ~flip2).sum()),
    })


def intervals(mask, t, min_len=0.0):
    """[start, end) times of the True runs in mask, at least min_len long."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    out = [(t[a], t[min(b, len(t) - 1)]) for a, b in zip(edges[::2], edges[1::2])]
    return [(a, b) for a, b in out if b - a >= min_len]


def per_minute(win, cols):
    """Per-minute medians of the given columns (index: minute of recorded time)."""
    return win.groupby((win.t // 60).astype(int))[cols].median()


def audit_signals(win, models):
    """Signal checks on a median stream loaded with correct_flips=False. models: {'LiNMC': model, 'LiFePO4': model},
    used to say which chemistry each voltage channel fits. Returns a dict of tables and flagged intervals."""
    dt, t = win.dt.to_numpy(), win.t.to_numpy()
    out = {}
    rows = []
    for c in ('I_mppt', 'I_load', 'I_b1', 'I_b2'):
        x = win[c].to_numpy()
        rows.append({'channel': CHANNELS[c]['label'], 'active % (|I| > 1 A)': 100 * np.mean(np.abs(x) > I_ACTIVE),
                     'below -0.5 A %': 100 * np.mean(x < -I_REST), 'min A': x.min(), 'median A': np.median(x),
                     'max A': x.max(), 'Ah out (+)': np.sum(np.clip(x, 0, None) * dt) / 3600,
                     'Ah in (-)': np.sum(np.clip(x, None, 0) * dt) / 3600})
    out['currents'] = pd.DataFrame(rows)

    rows = []
    for slot, (vc, ic) in {'main': ('V_b1', 'I_b1'), 'alternate': ('V_b2', 'I_b2')}.items():
        v, i = win[vc].to_numpy(), win[ic].to_numpy()
        ok = v > V_CUTOFF
        row = {'slot': slot, 'connected %': 100 * ok.mean()}
        if (~ok).any():
            row['current reading while disconnected (A, median)'] = np.median(i[~ok])
        if ok.any():
            row.update({'V min': v[ok].min(), 'V first': v[ok][0], 'V max': v[ok].max()})
            for name, m in models.items():
                lo, hi = m['table']['OCV'].min(), m['table']['OCV'].max()
                row[f'within {name} OCV range %'] = 100 * np.mean((v[ok] >= lo - 1.0) & (v[ok] <= hi + 0.5))
            # Battery sign: a rise in discharge current must pull the voltage down
            row['current steps > 2 A'], row['steps with V moving against I %'] = _step_response(t, i, v, ok)
        rows.append(row)
    out['voltages'] = pd.DataFrame(rows)

    # The server zeroes a battery below the cutoff (not connected); the balance uses the zeroed currents
    load, mppt = win.I_load.to_numpy(), win.I_mppt.to_numpy()
    bat = np.where(win.V_b1 > V_CUTOFF, win.I_b1, 0.0) + np.where(win.V_b2 > V_CUTOFF, win.I_b2, 0.0)

    # Old-wiring signature (controlled-test layout): the battery sensors stay silent while the load runs, and the
    # MPPT channel (old ch0 = battery current) behaves like a discharge current: the voltage falls when it rises
    on = np.abs(load) > I_ACTIVE
    silent = bool(on.any() and np.mean(np.abs(bat[on]) < I_REST) > 0.95)
    v_any = np.where(win.V_b1 > V_CUTOFF, win.V_b1, win.V_b2).astype(float)
    n_mppt, against = _step_response(t, mppt, v_any, v_any > V_CUTOFF)
    out['wiring'] = pd.DataFrame([{
        'battery sensors silent while the load runs': silent,
        'MPPT steps > 2 A': n_mppt,
        'voltage falls when MPPT current rises (%)': against,
        'old wiring signature': bool(silent and n_mppt and against > 80),
        'load reads negative while on (%)': 100 * np.mean(load[on] < 0) if on.any() else np.nan,
    }])

    # KCL residual and inferred operating state, per minute
    pm = per_minute(win.assign(res=load - mppt - bat, I_batnet=bat), ['res', 'I_mppt', 'I_load', 'I_b1', 'I_b2', 'I_batnet'])
    pm['state'] = infer_state(pm.I_batnet.to_numpy(), pm.I_mppt.to_numpy(), pm.I_load.to_numpy())
    out['per_minute'] = pm
    out['states'] = (pm.groupby('state').res.agg(minutes='size', median_residual_A='median',
                                                  max_abs_residual_A=lambda x: x.abs().max())
                     .reindex([s for s in STATES if s in set(pm.state)]))
    minutes = pm.index.to_numpy().astype(float)
    out['residual_faults_h'] = [(a / 60, (b + 1) / 60) for a, b in intervals(pm.res.abs().to_numpy() > FAULT_RESIDUAL, minutes, 1)]
    out['mppt_negative_h'] = [(a / 60, (b + 1) / 60) for a, b in intervals(pm.I_mppt.to_numpy() < -I_REST, minutes, 1)]
    return out


def with_slot(win, slot):
    """The median stream with I_bat / V_bat pointing at the given battery slot."""
    i, v = {'main': ('I_b1', 'V_b1'), 'alternate': ('I_b2', 'V_b2')}[slot]
    return win.assign(I_bat=win[i], V_bat=win[v])


def audit_verdict(folder, inventory, flips, audit, win, dup_share):
    """One summary row per run for the audit table."""
    volts = audit['voltages'].set_index('slot')
    connected = [s for s in volts.index if volts.loc[s, 'connected %'] > 50]
    phantom = volts.get('current reading while disconnected (A, median)', pd.Series(dtype=float)).dropna()
    rests = {s: len(find_rests(with_slot(win, s), MIN_REST_OPERATIONAL)) for s in connected}
    pm = audit['per_minute']
    row = {
        'first sample': inventory.start.iloc[0],
        'recorded (h)': win.t.iloc[-1] / 3600,
        'sessions': win.session.nunique(),
        'connected slots (V at start)': ', '.join(f'{s} ({volts.loc[s, "V first"]:.1f} V)' for s in connected),
        'logger stalls > 5 s (min)': inventory.stalled_min.sum() if 'stalled_min' in inventory else np.nan,
        'wall clock minus sampled time (min)': (inventory.wall_min - inventory.sampled_min).sum() if 'wall_min' in inventory else np.nan,
        'charge passed during stalls (Ah, battery 1 / 2)': (f'{inventory["unrecorded Ah, battery 1"].sum():.3f} / '
                                                            f'{inventory["unrecorded Ah, battery 2"].sum():.3f}')
                                                           if 'unrecorded Ah, battery 1' in inventory else 'n/a',
        'server run ids': ', '.join(map(str, sorted({r for ids in inventory.run_ids for r in ids}))) if 'run_ids' in inventory else 'n/a',
        'copied from controlled/older data (%)': 100 * dup_share,
        'old wiring signature': bool(audit['wiring']['old wiring signature'].iloc[0]),
        'MPPT flip latch at (h)': flips['first one at (h)'],
        'MPPT samples negated by the latch': int(flips['MPPT samples negated by the latch']),
        'battery samples sign-flipped': int(flips['battery samples sign-flipped']),
        'disconnected channel reading (A)': ', '.join(f'{s}: {v:.2f}' for s, v in phantom.items()) or 'none',
        'max |per-minute KCL residual| (A), as recorded': pm.res.abs().max(),
        'minutes with residual > 2 A': int((pm.res.abs() > FAULT_RESIDUAL).sum()),
        'rests of 2 min or more, per connected slot': ', '.join(f'{s}: {n}' for s, n in rests.items()),
        'minutes per inferred state': ', '.join(f'{s} {n}' for s, n in audit['states'].minutes.items()),
    }
    return pd.Series(row, name=folder)


def plot_audit(win, audit, title, latch_h=None):
    """Diagnostic figure: currents, slot voltages, per-minute KCL residual and inferred state, flagged intervals
    shaded; latch_h marks where the server's MPPT flip latch would trigger."""
    r = record_steps(win.t.to_numpy(), 2.0)
    w = win.iloc[r]
    h = w.t / 3600
    pm = audit['per_minute']
    hm = pm.index / 60
    fig, axes = plt.subplots(4, 1, figsize=(10, 8.2), sharex=True, gridspec_kw={'height_ratios': [1.4, 0.9, 0.9, 0.55]})
    for c, st in CHANNELS.items():
        x = w[c].where(w[f'V_b{c[-1]}'] > V_CUTOFF, 0.0) if c in ('I_b1', 'I_b2') else w[c]
        if (x.abs() > I_REST).any():
            axes[0].plot(h, x, lw=1, **st)
    axes[0].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[0].set_ylabel('Current (A), sign as\nrecorded (battery: 0\nwhen disconnected)')
    if latch_h is not None and np.isfinite(latch_h):
        for ax in axes:
            ax.axvline(latch_h, color=INK, lw=1, ls=(0, (1, 2)), zorder=2)
        axes[0].annotate('server MPPT flip latch', (latch_h, 1), xycoords=('data', 'axes fraction'), xytext=(3, -2),
                         textcoords='offset points', va='top', fontsize=8, color=INK2)
    axes[0].legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=4, borderaxespad=0.2)
    for vc, st, lab in (('V_b1', dict(color=INK2, ls=(0, (4, 2))), 'Battery 1 (main)'),
                        ('V_b2', dict(color=INK2, ls=(0, (6, 2, 1, 2))), 'Battery 2 (alternate)')):
        v = w[vc].where(w[vc] > V_CUTOFF)
        if v.notna().any():
            axes[1].plot(h, v, lw=1, label=lab, **st)
    axes[1].set_ylabel('Voltage (V)')
    axes[1].legend(loc='best', ncol=2)
    axes[2].plot(hm, pm.res, color=INK, lw=1.2, drawstyle='steps-post')
    for y in (FAULT_RESIDUAL, -FAULT_RESIDUAL):
        axes[2].axhline(y, color=MUTED, lw=1, ls=(0, (3, 3)))
    axes[2].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[2].set_ylabel('KCL residual (A)\nper-minute median')
    lanes = [s for s in STATES if s in set(pm.state)]
    for j, s in enumerate(lanes):
        m = (pm.state == s).to_numpy()
        for a, b in intervals(m, hm.to_numpy()):
            axes[3].plot([a, b + 1 / 60], [j, j], color=INK2, lw=6, solid_capstyle='butt')
    axes[3].set_yticks(range(len(lanes)), lanes)
    axes[3].set_ylim(len(lanes) - 0.5, -0.5)
    axes[3].grid(axis='y', visible=False)
    axes[3].set_ylabel('State\n(inferred)')
    axes[3].set_xlabel('Recorded time (h)')
    for a, b in audit['residual_faults_h'] + audit['mppt_negative_h']:
        for ax in axes:
            ax.axvspan(a, b, color=SHADE, lw=0, zorder=0)
    for tb in win.t[win.session.diff() > 0] / 3600:
        for ax in axes:
            ax.axvline(tb, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=1)
    suptitle(fig, f'{title}: audit (shaded: residual above {FAULT_RESIDUAL:.0f} A or MPPT negative; dashed: new session)')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- controlled-run tables
def at(est, col, tc, lo, hi):
    """Mean of est[col] within +/- AVG_WIN s of tc, kept inside [lo, hi]."""
    return mean_near(est.t.to_numpy(), est[col].to_numpy(), tc, lo, hi)


def active_blocks(win, min_len=30.0):
    """Contiguous blocks with battery |I| > I_ACTIVE (at least min_len s): start, end, mean current, session."""
    t, i, s = win.t.to_numpy(), win.I_bat.to_numpy(), win.session.to_numpy()
    rows = []
    for sess in np.unique(s):
        m = np.flatnonzero(s == sess)
        for a, b in intervals(np.abs(i[m]) > I_ACTIVE, t[m], min_len):
            k = m[(t[m] >= a) & (t[m] <= b)]
            rows.append({'session': sess, 't_start': a, 't_end': b, 'I_mean': i[k].mean()})
    return pd.DataFrame(rows, columns=['session', 't_start', 't_end', 'I_mean'])


def completeness_table(win, rests, battery):
    """Test completeness: sessions, durations, discharge steps, current range, rests, excluded intervals."""
    blocks = active_blocks(win)
    first = win.groupby('session').agg(file=('file', 'first'), h=('t', 'first'), end=('t', 'last'))
    stamp = first.file.str.extract(r'(\d{8})-(\d{6})').agg(''.join, axis=1)
    starts = pd.to_datetime(stamp, format='%Y%m%d%H%M%S', errors='coerce')
    session_text = '; '.join(f'{s}: {d:%d %b %H:%M}, {(e - h) / 3600:.2f} h' if pd.notna(d) else f'{s}: {(e - h) / 3600:.2f} h'
                             for s, d, h, e in zip(first.index, starts, first.h, first.end))
    below = win.dt[win.V_bat <= V_CUTOFF].sum() / 3600
    length = (rests.t_end - rests.t_disc) / 60
    sessions = BATTERIES[battery]['score_sessions']
    excluded = sorted(set(win.session.unique()) - set(sessions)) if sessions is not None else []
    rows = {
        'sessions': win.session.nunique(),
        'recorded time (h)': win.t.iloc[-1] / 3600,
        'sessions: start of the recording file, recorded length': session_text,
        'discharge steps (battery |I| > 1 A for 30 s or more)': len(blocks),
        'step current range (A)': f'{blocks.I_mean.min():.1f} to {blocks.I_mean.max():.1f}' if len(blocks) else 'n/a',
        'rests (all currents < 0.5 A, at least 5 min)': len(rests),
        'rest length (min): min / median / max': f'{length.min():.0f} / {length.median():.0f} / {length.max():.0f}' if len(rests) else 'n/a',
        'rests where 10 mV/min was reached': f'{int(rests.criterion_met.sum())} of {len(rests)}',
        'time below the cutoff voltage (h), excluded': below,
        'sessions excluded from scoring (numbered from 0)': ', '.join(map(str, excluded)) or 'none',
    }
    return pd.Series(rows, name=battery).to_frame()


def reference_table(win, rests, battery, model):
    """How the characterization SoC is built, with the numbers that set its uncertainty."""
    dt, V, t = win.dt.to_numpy(), win.V_bat.to_numpy(), win.t.to_numpy()
    valid = V > V_CUTOFF
    ah = lambda x: np.sum(np.where(valid, x * dt, 0.0)) / 3600
    ib, il = win.I_bat.to_numpy(), win.I_load.to_numpy()
    ref = BATTERIES[battery]['reference']
    off_b, off_l = [], []
    for r in rests.itertuples():
        k = (t >= r.t0) & (t <= r.t_end)
        off_b.append(ib[k].mean()); off_l.append(il[k].mean())
    rows = {
        'current used': {'average': 'mean of battery and load sensor',
                         'average_clipped': 'mean of battery and load sensor, negatives set to 0'}[ref['current']],
        'anchor': {'end': '0 % at the last sample above the cutoff', 'start': '100 % at the first sample'}[ref['anchor']],
        'Q_total (Ah, from the model)': model['Q_total'],
        'Ah, battery sensor': ah(ib), 'Ah, load sensor': ah(il), 'Ah, mean of the two': ah((ib + il) / 2),
        'sensor disagreement (load vs battery, %)': 100 * (ah(il) - ah(ib)) / ah((ib + il) / 2),
        'battery sensor reading at rest (A): first / last rest': f'{off_b[0]:+.3f} / {off_b[-1]:+.3f}' if off_b else 'n/a',
        'load sensor reading at rest (A): min / max': f'{min(off_l):+.3f} / {max(off_l):+.3f}' if off_l else 'n/a',
    }
    if ref['current'] == 'average_clipped':
        rows['Ah, mean of the two, negatives clipped'] = ah(np.clip((ib + il) / 2, 0, None))
    return pd.Series(rows, name=battery).to_frame()


def rest_points(est, rests):
    """One row per rest: timing, voltages at t0, t1 and t_end, and the characterization SoC (if present)."""
    rows = []
    for r in rests.itertuples():
        g = lambda c, tc: at(est, c, tc, r.t_disc, r.t_end)
        row = {'rest': r.rest, 'session': r.session, 'type': r.type, 'length_min': (r.t_end - r.t_disc) / 60,
               't1_minus_t0_min': (r.t1 - r.t0) / 60, 'criterion_met': r.criterion_met, 'I_before_A': r.I_before,
               'V_t0': g('V', r.t0), 'V_t1': g('V', r.t1), 'V_end': g('V', r.t_end)}
        row['dV_t0_t1_mV'] = 1e3 * (row['V_t1'] - row['V_t0'])
        row['dV_t1_end_mV'] = 1e3 * (row['V_end'] - row['V_t1'])
        if 'soc_ref' in est:
            row['ref_soc_t0_pct'] = 100 * g('soc_ref', r.t0)
            row['ref_soc_end_pct'] = 100 * g('soc_ref', r.t_end)
        rows.append(row)
    return pd.DataFrame(rows).set_index('rest')


def rest_deltas(est, rests, methods=METHODS):
    """Long table: signed SoC change of every method over each rest, t0 -> t1 and t0 -> t_end (pp)."""
    rows = []
    for r in rests.itertuples():
        for col, name in methods.items():
            s0, s1, s_end = (at(est, col, tc, r.t_disc, r.t_end) for tc in (r.t0, r.t1, r.t_end))
            rows.append({'rest': r.rest, 'method': name, 'col': col,
                         'dsoc_t0_t1_pp': 100 * (s1 - s0), 'dsoc_t0_end_pp': 100 * (s_end - s0)})
    return pd.DataFrame(rows)


def rest_delta_table(deltas):
    """Per method: number of rests, median and max |SoC change| over the whole rest and over t0 -> t1."""
    g = deltas.assign(a=deltas.dsoc_t0_end_pp.abs(), b=deltas.dsoc_t0_t1_pp.abs()).groupby('method', sort=False)
    return pd.DataFrame({'rests': g.size(), 'median |ΔSoC| t0→end (pp)': g.a.median(), 'max |ΔSoC| t0→end (pp)': g.a.max(),
                         'median |ΔSoC| t0→t1 (pp)': g.b.median(), 'max |ΔSoC| t0→t1 (pp)': g.b.max()}).round(4)


def divergence(est, rests, methods=METHODS):
    """Long table: method SoC minus characterization SoC at the end of every rest (pp)."""
    rows = []
    for r in rests.itertuples():
        ref = at(est, 'soc_ref', r.t_end, r.t_disc, r.t_end)
        for col, name in methods.items():
            rows.append({'rest': r.rest, 'method': name, 'col': col, 'ref_soc_pct': 100 * ref,
                         'd_pp': 100 * (at(est, col, r.t_end, r.t_disc, r.t_end) - ref)})
    return pd.DataFrame(rows)


def score_table(est, rests, extra=None, methods=METHODS):
    """Per method, difference d from the characterization SoC: RMS and max over the scored window, at the end of the
    scored data, at rest ends (median, max |d|); plus the largest |SoC change| during a rest."""
    s = est[est.scored]
    end = s.index[-1]
    div, dl = divergence(est, rests, methods), rest_deltas(est, rests, methods)
    innov = (extra or {}).get('innov_rms_mV', {})
    rows = []
    for col, name in methods.items():
        e = 100 * (s[col] - s.soc_ref)
        d, ds = div[div.col == col].d_pp.abs(), dl[dl.col == col].dsoc_t0_end_pp.abs()
        rows.append({'method': name, 'RMS d (pp)': np.sqrt(np.mean(e ** 2)), 'max |d| (pp)': e.abs().max(),
                     'd at end of scored data (pp)': 100 * (est.loc[end, col] - est.loc[end, 'soc_ref']),
                     'median |d| at rest ends (pp)': d.median(), 'max |d| at rest ends (pp)': d.max(),
                     'max |ΔSoC| during a rest (pp)': ds.max(), 'voltage innovation RMS (mV)': innov.get(col, np.nan)})
    return pd.DataFrame(rows).set_index('method').round(4)


def spread(extra):
    """Initialization spread per method over time: max - min SoC across the starts (pp)."""
    return {col: 100 * (a.max(0) - a.min(0)) for col, a in extra['by_start'].items()}


# --------------------------------------------------------------------------- controlled-run figures
def _shade_rests(axes, rests):
    for r in rests.itertuples():
        for ax in axes:
            ax.axvspan(r.t_disc / 3600, r.t_end / 3600, color=SHADE, lw=0, zorder=0)


def _session_breaks(axes, est):
    for tb in est.t[est.session.diff() > 0] / 3600:
        for ax in axes:
            ax.axvline(tb, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=1)


def _rest_ticks(ax, points):
    ax.set_xticks(points.index, [f'{i}\n{points.loc[i, "ref_soc_t0_pct"]:.0f}%' for i in points.index])


def plot_whole_run(est, rests, title, methods=METHODS):
    """Battery current, voltage and SoC of every method (with the characterization SoC), rests shaded."""
    h = est.t / 3600
    valid = est.V > V_CUTOFF
    fig, axes = plt.subplots(3, 1, figsize=(10, 7.5), sharex=True, gridspec_kw={'height_ratios': [1, 1, 1.4]})
    axes[0].plot(h, est.I_raw.where(valid), color=INK2, lw=1)
    axes[0].set_ylabel('Battery current (A)\n+ = discharge')
    axes[1].plot(h, est.V.where(valid), color=INK2, lw=1)
    axes[1].set_ylabel('Voltage (V)')
    if 'soc_ref' in est:
        axes[2].plot(h, 100 * est.soc_ref.where(valid), color=INK, ls=(0, (4, 3)), label='Characterization SoC', zorder=5)
    for col, name in methods.items():
        axes[2].plot(h, 100 * est[col], color=COLORS[col], label=name, zorder=2 if col == 'soc_ocv' else 3)
    axes[2].set_ylabel('SoC (%)')
    axes[2].set_xlabel('Recorded time (h), unrecorded gaps removed')
    axes[2].legend(ncol=5, loc='upper center', bbox_to_anchor=(0.5, -0.22))
    _shade_rests(axes, rests)
    axes[1].scatter(rests.t0 / 3600, np.interp(rests.t0, est.t, est.V), s=28, facecolor='white', edgecolor=INK, lw=1.2,
                    zorder=4, label='t₀ (rest verified)')
    met = rests[rests.criterion_met]
    axes[1].scatter(met.t1 / 3600, np.interp(met.t1, est.t, est.V), s=28, color=INK, edgecolor='white', lw=1.2,
                    zorder=4, label='t₁ (10 mV/min reached)')
    axes[1].legend(loc='lower left')
    _session_breaks(axes, est)
    suptitle(fig, f'{title}: rests shaded, dashed lines are unrecorded gaps')
    fig.tight_layout()
    return fig


def representative_rest(points):
    """The median-length rest among the five closest to 50 % characterization SoC."""
    cand = points.assign(dist=(points.ref_soc_t0_pct - 50).abs()).nsmallest(5, 'dist')
    return cand.length_min.sub(cand.length_min.median()).abs().idxmin()


def plot_rest_closeup(est, rests, points, rest_id, title):
    """One rest from 1 min before it starts: voltage, currents, and each method's SoC change from t0."""
    r = rests.set_index('rest').loc[rest_id]
    seg = est[(est.t >= r.t_disc - 60) & (est.t <= r.t_end)]
    minutes = (seg.t - r.t_disc) / 60
    marks = [(0, 'rest starts'), ((r.t0 - r.t_disc) / 60, 't₀'), ((r.t1 - r.t_disc) / 60, 't₁')]
    fig, axes = plt.subplots(4, 1, figsize=(8, 8.5), sharex=True, gridspec_kw={'height_ratios': [1.1, 0.8, 0.9, 1.2]})
    axes[0].plot(minutes, seg.V, color=INK2)
    axes[0].set_ylabel('Voltage (V)')
    axes[1].plot(minutes, seg.I_raw, color=MUTED, label='Raw')
    axes[1].plot(minutes, seg.I_off, color=INK2, ls=(0, (4, 2)), label='Offset-corrected (CC, EKF)')
    axes[1].plot(minutes, seg.I_kcl, color=COLORS['soc_ekf_kcl'], lw=1, label='KCL-corrected (EKF + KCL)')
    after = seg[seg.t >= r.t0]
    lo = min(after[['I_raw', 'I_off', 'I_kcl']].min().min(), 0)
    hi = max(after[['I_raw', 'I_off', 'I_kcl']].max().max(), 0)
    axes[1].set_ylim(lo - 0.2, hi + 0.3)
    axes[1].set_ylabel('Battery current (A)')
    axes[1].legend(loc='upper right', ncol=3, fontsize=8)
    axes[1].annotate(f'Current before the rest: {seg.I_raw[minutes < 0].mean():.1f} A (off scale)', (0, 1),
                     xycoords='axes fraction', xytext=(4, -2), textcoords='offset points', va='top', fontsize=7.5, color=INK2)
    for ax, cols in ((axes[2], ['soc_ocv']), (axes[3], ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])):
        lo, hi = [], []
        for col in cols:
            d = 100 * (seg[col] - at(est, col, r.t0, r.t_disc, r.t_end))
            ax.plot(minutes, d, color=COLORS[col], label=METHODS[col])
            lo.append(d[seg.t >= r.t0].min()); hi.append(d[seg.t >= r.t0].max())
        pad = 0.15 * max(max(hi) - min(lo), 0.02)
        ax.set_ylim(min(lo) - pad, max(hi) + pad)
        ax.set_ylabel('SoC change\nfrom t₀ (pp)')
        ax.legend(loc='upper left', ncol=len(cols))
    axes[3].set_xlabel('Minutes from the start of the rest (y-axes scaled from t₀; earlier values may be clipped)')
    for ax in axes:
        for x, _ in marks:
            ax.axvline(x, color=MUTED, lw=1, ls=(0, (3, 3)))
    span, last, row = np.diff(axes[0].get_xlim())[0], None, 0
    for x, text in marks:                      # stagger labels that sit close together
        row = row + 1 if last is not None and x - last < 0.06 * span else 0
        axes[0].annotate(text, (x, 1), xycoords=('data', 'axes fraction'), xytext=(3, -2 - 11 * row),
                         textcoords='offset points', va='top', fontsize=8, color=INK2)
        last = x
    suptitle(fig, f'{title}: rest {rest_id} (characterization SoC {points.loc[rest_id, "ref_soc_t0_pct"]:.0f} % at t₀)')
    fig.tight_layout()
    return fig


def _dots(ax, df, value, cols):
    for j, col in enumerate(cols):
        g = df[df.col == col]
        x = g.rest + (j - (len(cols) - 1) / 2) * 0.2
        ax.scatter(x, g[value], s=36, marker=MARKERS[col], color=COLORS[col], edgecolor='white', lw=1, zorder=3,
                   label=METHODS[col])
    ax.axhline(0, color=AXIS, lw=1, zorder=1)
    ax.legend(loc='upper right', ncol=len(cols))


def plot_divergence(div, points, title):
    """Method SoC minus characterization SoC at the end of each rest."""
    fig, axes = plt.subplots(2, 1, figsize=(9, 5.5), sharex=True, gridspec_kw={'height_ratios': [1, 1.3]})
    _dots(axes[0], div, 'd_pp', ['soc_ocv'])
    _dots(axes[1], div, 'd_pp', ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])
    for ax in axes:
        ax.set_ylabel('Difference from\ncharacterization (pp)')
    _rest_ticks(axes[1], points)
    axes[1].set_xlabel('Rest number (characterization SoC at t₀)')
    suptitle(fig, f'{title}: difference from the characterization SoC at the end of each rest')
    fig.tight_layout()
    return fig


def plot_rest_summary(deltas, points, title):
    """Signed SoC change over each rest, with that rest's voltage changes and durations."""
    fig, axes = plt.subplots(5, 1, figsize=(9, 9.5), sharex=True, gridspec_kw={'height_ratios': [1, 1.3, 0.7, 0.7, 0.7]})
    _dots(axes[0], deltas, 'dsoc_t0_end_pp', ['soc_ocv'])
    _dots(axes[1], deltas, 'dsoc_t0_end_pp', ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])
    for ax in axes[:2]:
        ax.set_ylabel('Signed ΔSoC\nt₀→end (pp)')
    for ax, col, lab in ((axes[2], 'dV_t0_t1_mV', 'ΔV t₀→t₁\n(mV)'), (axes[3], 'dV_t1_end_mV', 'ΔV t₁→end\n(mV)'),
                         (axes[4], 't1_minus_t0_min', 't₁ − t₀\n(min)')):
        ax.scatter(points.index, points[col], s=30, color=INK2, edgecolor='white', lw=1, zorder=3)
        ax.set_ylabel(lab)
    axes[3].axhline(0, color=AXIS, lw=1, zorder=1)
    flagged = points.index[~points.criterion_met]
    for i in flagged:
        for ax in axes:
            ax.axvspan(i - 0.45, i + 0.45, color=SHADE, lw=0, zorder=0)
    _rest_ticks(axes[4], points)
    axes[4].set_xlabel('Rest number (characterization SoC at t₀)')
    note = ' (shaded: 10 mV/min not reached)' if len(flagged) else ''
    suptitle(fig, f'{title}: change during each rest{note}')
    fig.tight_layout()
    return fig


def plot_rest_ocv(points, model, title):
    """Voltage at the end of each rest against the characterization SoC there, over the model's OCV curve."""
    fig, ax = plt.subplots(figsize=(8, 4.2))
    tab = model['table']
    ax.plot(100 * tab['SoC'], tab['OCV'], color=INK2, lw=1.2, label='Model OCV curve', zorder=2)
    ax.scatter(points.ref_soc_end_pct, points.V_end, s=36, color=INK, edgecolor='white', lw=1, zorder=3,
               label='Voltage at rest end')
    for i, p in points.iterrows():
        ax.annotate(str(i), (p.ref_soc_end_pct, p.V_end), xytext=(4, -9), textcoords='offset points', fontsize=7.5, color=INK2)
    ax.set_xlabel('Characterization SoC at rest end (%)')
    ax.set_ylabel('Voltage (V)')
    ax.legend(loc='lower right')
    suptitle(fig, f'{title}: rest-end voltage against the OCV curve (in-sample: the model was fitted to these rests)')
    fig.tight_layout()
    return fig


def plot_spread(est, extra, title):
    """Initialization spread of each method over time."""
    sp = spread(extra)
    h = est.t / 3600
    fig, ax = plt.subplots(figsize=(9, 3.6))
    for col in ('soc_cc', 'soc_ocv', 'soc_ekf', 'soc_ekf_kcl'):
        ax.plot(h, sp[col], color=COLORS[col], label=METHODS[col], zorder=2 if col == 'soc_ocv' else 3)
    _session_breaks([ax], est)
    ax.set_ylabel('Spread across starts\n(max − min, pp)')
    ax.set_xlabel('Recorded time (h)')
    ax.legend(loc='upper right', ncol=4)
    starts = ', '.join(f'{100 * s:.0f}' for s in extra['starts'])
    suptitle(fig, f'{title}: initialization spread (starts {starts} %; OCV mapping has no memory, so 0 by construction)')
    fig.tight_layout()
    return fig


def plot_kcl(est, extra, rests, title, slot='main'):
    """Current corrections: battery bias (offsets vs gated KCL) with rest readings, the KCL residual before and after
    correction (per-minute medians), and the SoC difference EKF + KCL minus EKF."""
    ch = 2 if slot == 'main' else 3
    h = est.t / 3600
    fig, axes = plt.subplots(3, 1, figsize=(10, 7.5), sharex=True)
    axes[0].plot(h, extra['bias_offsets'][ch], color=INK2, label='Offsets only (CC, EKF input)', zorder=3)
    axes[0].plot(h, extra['bias_kcl'][ch], color=COLORS['soc_ekf_kcl'], label='Offsets + gated KCL (EKF + KCL input)', zorder=3)
    pts = [((r.t0 + r.t_end) / 2 / 3600, est.I_raw[(est.t >= r.t0) & (est.t <= r.t_end)].mean()) for r in rests.itertuples()]
    if pts:
        axes[0].scatter(*zip(*pts), s=30, color=INK, edgecolor='white', lw=1.2, zorder=4, label='Raw reading during each rest')
    axes[0].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[0].set_ylabel('Battery sensor\nbias estimate (A)')
    axes[0].legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=3, borderaxespad=0.2)
    minute = (est.t // 60).astype(int).to_numpy()
    valid = (est.V > V_CUTOFF).to_numpy()          # below the cutoff the battery current is zeroed: no balance
    pm = (pd.DataFrame({'raw': extra['res_raw'], 'off': extra['res_offsets'], 'kcl': extra['res_kcl']})
          .where(np.repeat(valid[:, None], 3, axis=1)).groupby(minute).median())
    hm = pm.index / 60
    axes[1].plot(hm, pm.raw, color=MUTED, lw=1, drawstyle='steps-post', label='Raw')
    axes[1].plot(hm, pm.off, color=INK2, lw=1, drawstyle='steps-post', label='After offsets')
    axes[1].plot(hm, pm.kcl, color=COLORS['soc_ekf_kcl'], lw=1, drawstyle='steps-post', label='After gated KCL')
    axes[1].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[1].set_ylabel('KCL residual (A)\nper-minute median')
    axes[1].legend(loc='lower right', bbox_to_anchor=(1, 1.0), ncol=3, borderaxespad=0.2)
    axes[2].plot(h, 100 * (est.soc_ekf_kcl - est.soc_ekf), color=COLORS['soc_ekf_kcl'])
    axes[2].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[2].set_ylabel('EKF + KCL minus\nEKF (pp)')
    axes[2].set_xlabel('Recorded time (h)')
    _session_breaks(axes, est)
    suptitle(fig, f'{title}: current corrections')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- operational runs (corrections confirmed after the audit)
OPERATIONAL_RUNS = {
    'General Discharge Test': dict(
        battery='LiNMC', slot='main', mppt_latch=False,
        files=[f'data_20260612-153706_part_{i}.csv' for i in range(1, 10)],
        note='12 Jun, charging near full. The load sensor reads -0.22 A when off (learned by offset correction). '
             'The separate 1.4-min recording at 16:37 (79 s gap, 0.2 A trickle charge) is left out.'),
    'General Discharge Test 2': dict(
        battery='LiNMC', slot='main', mppt_latch=False, files=None, note='12 Jun, charging near full.'),
    'LiNMC General Test': dict(
        battery='LiNMC', slot='main', mppt_latch=False, files=None, latch_evidence=True,
        note='29 Jun. MPPT flip latch disabled (one -10.24 A spike at 0.93 h would negate every later MPPT reading). '
             '10.4 min of logger stalls, mostly at rest; 0.24 Ah passed unrecorded (at most 0.34 pp).'),
    'LiFePO4 General Test': dict(
        battery='LiFePO4', slot='alternate', mppt_latch=False, files=None,
        note='22 Jun. LiFePO4 in the alternate slot; the LiNMC in the main slot is idle and not evaluated. '
             'The server restarted during the test (run ids 1-8); the replay runs straight through.'),
}
PAIRS = {'OCV − CC': ('soc_ocv', 'soc_cc'), 'EKF − CC': ('soc_ekf', 'soc_cc'),
         'EKF + KCL − CC': ('soc_ekf_kcl', 'soc_cc'), 'EKF + KCL − EKF': ('soc_ekf_kcl', 'soc_ekf')}


def load_operational(run, mppt_latch=None, window='median'):
    """Median stream of an operational run with its confirmed corrections (mppt_latch overrides the run's setting).
    window='mean' gives the server's charge-preserving stream instead (window_mean)."""
    r = OPERATIONAL_RUNS[run]
    latch = r['mppt_latch'] if mppt_latch is None else mppt_latch
    return WINDOWS[window](load_run(TEST_DATA / FOLDERS[run], r['slot'], r['files'], verbose=False, mppt_latch=latch))


def record_state(win, est, smooth_s=10.0):
    """Inferred operating state at each record, from currents smoothed over smooth_s (net battery current of both
    slots, zero when disconnected)."""
    bat = np.where(win.V_b1 > V_CUTOFF, win.I_b1, 0.0) + np.where(win.V_b2 > V_CUTOFF, win.I_b2, 0.0)
    cur = pd.DataFrame({'bat': bat, 'mppt': win.I_mppt.to_numpy(), 'load': win.I_load.to_numpy()})
    n = max(int(round(smooth_s / max(np.median(win.dt[win.dt > 0]), 1e-6))), 1)
    cur = cur.rolling(n, center=True, min_periods=1).median().to_numpy()
    k = np.searchsorted(win.t.to_numpy(), est.t)
    return infer_state(cur[k, 0], cur[k, 1], cur[k, 2])


def pairwise(est):
    """Pairwise SoC differences over time (pp), NaN below the cutoff."""
    ok = (est.V > V_CUTOFF).to_numpy()
    return pd.DataFrame({name: np.where(ok, 100 * (est[a] - est[b]), np.nan) for name, (a, b) in PAIRS.items()},
                        index=est.index)


def disagreement_table(est):
    d = pairwise(est).dropna()
    return pd.DataFrame({'RMS (pp)': np.sqrt((d ** 2).mean()), 'max |·| (pp)': d.abs().max(),
                         'at end (pp)': d.iloc[-1]}).round(3)


def state_segments(est, state, min_len=60.0):
    """Blocks of one inferred state lasting at least min_len s, with each pairwise difference at the block's start
    and end (means over +/- AVG_WIN s): how the methods move apart or together in each state."""
    t = est.t.to_numpy()
    d = pairwise(est)
    rows = []
    edges = np.flatnonzero(np.r_[True, state[1:] != state[:-1], True])
    for a, b in zip(edges[:-1], edges[1:]):
        t0, t1 = t[a], t[b - 1]
        if t1 - t0 < min_len:
            continue
        row = {'state': state[a], 'start (h)': t0 / 3600, 'end (h)': t1 / 3600, 'minutes': (t1 - t0) / 60}
        for name in PAIRS:
            y = d[name].to_numpy()
            row[f'{name}: start'] = mean_near(t, y, t0, t0, t1)
            row[f'{name}: end'] = mean_near(t, y, t1, t0, t1)
        rows.append(row)
    return pd.DataFrame(rows).round(3)


def end_of_run(est, rests, model):
    """Each method's SoC at the start and end, and a shared-model consistency check: every method against the OCV
    table at the end of the last rest of at least 5 minutes (when there is one)."""
    ok = est.V > V_CUTOFF
    first, last = est.index[ok][0], est.index[ok][-1]
    rows = {METHODS[c]: {'start (%)': 100 * est.loc[first, c], 'end (%)': 100 * est.loc[last, c],
                         'change (pp)': 100 * (est.loc[last, c] - est.loc[first, c])} for c in METHODS}
    out = pd.DataFrame(rows).T
    long = rests[(rests.t_end - rests.t_disc) >= MIN_REST]
    if len(long):
        r = long.iloc[-1]
        v = at(est, 'V', r.t_end, r.t_disc, r.t_end)
        table_soc = ocv_to_soc(v, model)
        out[f'minus OCV table at rest {int(r.rest)} end (pp)'] = [
            100 * (at(est, c, r.t_end, r.t_disc, r.t_end) - table_soc) for c in METHODS]
    return out.round(3)


# --------------------------------------------------------------------------- operational figures
def _state_lanes(ax, h, state):
    lanes = [s for s in STATES if s in set(state)]
    for j, s in enumerate(lanes):
        for a, b in intervals(state == s, h):
            ax.plot([a, b], [j, j], color=INK2, lw=6, solid_capstyle='butt')
    ax.set_yticks(range(len(lanes)), lanes)
    ax.set_ylim(len(lanes) - 0.5, -0.5)
    ax.grid(axis='y', visible=False)
    ax.set_ylabel('State\n(inferred)')


def plot_operational(win, est, rests, state, title, slot):
    """Operating context: currents, the evaluated battery's voltage, inferred state and each method's SoC; rests shaded."""
    r = record_steps(win.t.to_numpy(), 2.0)
    w = win.iloc[r]
    hw, h = w.t / 3600, est.t / 3600
    fig, axes = plt.subplots(4, 1, figsize=(10, 9), sharex=True, gridspec_kw={'height_ratios': [1.2, 0.8, 0.5, 1.4]})
    for c, st in CHANNELS.items():
        x = w[c].where(w[f'V_b{c[-1]}'] > V_CUTOFF, 0.0) if c in ('I_b1', 'I_b2') else w[c]
        if (x.abs() > I_REST).any():
            axes[0].plot(hw, x, lw=1, **st)
    axes[0].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[0].set_ylabel('Current (A)\n+ = discharge / out')
    axes[0].legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=4, borderaxespad=0.2)
    axes[1].plot(h, est.V.where(est.V > V_CUTOFF), color=INK2, lw=1)
    axes[1].set_ylabel(f'Voltage (V)\n{slot} battery')
    _state_lanes(axes[2], h.to_numpy(), state)
    for col, name in METHODS.items():
        axes[3].plot(h, 100 * est[col], color=COLORS[col], label=name, zorder=2 if col == 'soc_ocv' else 3)
    axes[3].set_ylabel('SoC (%)')
    axes[3].set_xlabel('Recorded time (h)')
    axes[3].legend(ncol=4, loc='upper center', bbox_to_anchor=(0.5, -0.25))
    _shade_rests(axes, rests)
    _session_breaks(axes, est)
    suptitle(fig, f'{title}: operating context (rests shaded)')
    fig.tight_layout()
    return fig


def plot_disagreement(est, rests, title):
    """Pairwise differences over time: OCV mapping against CC (own scale), then EKF and EKF + KCL against CC."""
    d = pairwise(est)
    h = est.t / 3600
    fig, axes = plt.subplots(2, 1, figsize=(10, 5.8), sharex=True, gridspec_kw={'height_ratios': [1, 1.3]})
    axes[0].plot(h, d['OCV − CC'], color=COLORS['soc_ocv'], lw=1, label='OCV mapping − CC')
    axes[1].plot(h, d['EKF − CC'], color=COLORS['soc_ekf'], label='EKF − CC')
    axes[1].plot(h, d['EKF + KCL − CC'], color=COLORS['soc_ekf_kcl'], label='EKF + KCL − CC')
    for ax in axes:
        ax.axhline(0, color=AXIS, lw=1, zorder=1)
        ax.set_ylabel('Difference (pp)')
        ax.legend(loc='upper left', ncol=2)
    axes[1].set_xlabel('Recorded time (h)')
    _shade_rests(axes, rests)
    _session_breaks(axes, est)
    suptitle(fig, f'{title}: disagreement between methods (no reference SoC exists for this run)')
    fig.tight_layout()
    return fig


def plot_characterization(divs):
    """Both batteries: difference from the characterization SoC at each rest end, against SoC. divs: {battery: the
    divergence table saved by controlled_evaluation}. OCV mapping on the top row (its own scale)."""
    fig, axes = plt.subplots(2, len(divs), figsize=(5 * len(divs), 6), sharex=True, squeeze=False,
                             gridspec_kw={'height_ratios': [1, 1.3]})
    for j, (battery, div) in enumerate(divs.items()):
        for ax, cols in ((axes[0, j], ['soc_ocv']), (axes[1, j], ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])):
            for col in cols:
                g = div[div.col == col]
                ax.plot(g.ref_soc_pct, g.d_pp, color=COLORS[col], lw=1, alpha=0.6, zorder=2)
                ax.scatter(g.ref_soc_pct, g.d_pp, s=34, marker=MARKERS[col], color=COLORS[col], edgecolor='white', lw=1,
                           zorder=3, label=METHODS[col])
            ax.axhline(0, color=AXIS, lw=1, zorder=1)
        axes[0, j].set_title(battery, loc='left')
        axes[1, j].set_xlabel('Characterization SoC at rest end (%)')
    axes[1, 0].invert_xaxis()                     # shared x: discharge reads left to right in every panel
    for i in range(2):
        axes[i, 0].set_ylabel('Difference from\ncharacterization (pp)')
    axes[0, -1].legend(loc='lower right')
    axes[1, -1].legend(loc='upper left', ncol=1)
    suptitle(fig, 'Difference from the characterization SoC at each rest end (discharge runs left to right)')
    fig.tight_layout()
    return fig


def plot_operational_rests(deltas, rests, title):
    """Signed SoC change over each rest, with the rest's type (after charge or after discharge) under its number."""
    fig, axes = plt.subplots(2, 1, figsize=(8, 5.5), sharex=True, gridspec_kw={'height_ratios': [1, 1.3]})
    _dots(axes[0], deltas, 'dsoc_t0_end_pp', ['soc_ocv'])
    _dots(axes[1], deltas, 'dsoc_t0_end_pp', ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])
    for ax in axes:
        ax.set_ylabel('Signed ΔSoC\nt₀→end (pp)')
    length = (rests.t_end - rests.t_disc) / 60
    axes[1].set_xticks(rests.rest, [f'{r}\n{t.replace("_", " ")}\n{m:.1f} min' for r, t, m in zip(rests.rest, rests.type, length)])
    axes[1].set_xlabel('Rest number, type and length')
    suptitle(fig, f'{title}: SoC change during each rest')
    fig.tight_layout()
    return fig


# =========================================================================== results chapter (results_chapter.ipynb)
# Everything below serves the Results chapter in final_report/results_section/. It only adds functions, so the
# outputs of the controlled, operational and summary notebooks are unchanged.
RESULTS_DIR = REPO_ROOT / 'final_report' / 'analysis' / 'results_section'
CALIBRATION_DIR = REPO_ROOT / 'final_report' / 'Calibration Code'

# Every analysed run in date order. adc_signature() checks the ADC against the logged files: the ADS1115 logged every
# 32 ms with the spare channels written as constants (its readings were re-encoded to ADS8688 codes); the ADS8688
# logs all eight channels at about 1.1 kHz. No run spans the change, which happened between 8 Apr and 25 May 2026.
# 'short' names the run in tables; 'label' names it in figures, which carry no dates or ADC names.
RUNS = {
    'LiNMC controlled': dict(kind='controlled', battery='LiNMC', slot='main', folder=FOLDERS['LiNMC controlled'],
                             date='18 Mar – 8 Apr 2026', adc='ADS1115', short='LiNMC controlled', label='LiNMC controlled'),
    'LiFePO4 controlled': dict(kind='controlled', battery='LiFePO4', slot='main', folder=FOLDERS['LiFePO4 controlled'],
                               date='25 May 2026', adc='ADS8688', short='LiFePO4 controlled', label='LiFePO4 controlled'),
    'General Discharge Test': dict(kind='operational', battery='LiNMC', slot='main', folder=FOLDERS['General Discharge Test'],
                                   date='12 Jun 2026', adc='ADS8688', short='GDT 1 (LiNMC, 12 Jun)', label='GDT 1 (LiNMC)'),
    'General Discharge Test 2': dict(kind='operational', battery='LiNMC', slot='main', folder=FOLDERS['General Discharge Test 2'],
                                     date='12 Jun 2026', adc='ADS8688', short='GDT 2 (LiNMC, 12 Jun)', label='GDT 2 (LiNMC)'),
    'LiFePO4 General Test': dict(kind='operational', battery='LiFePO4', slot='alternate',
                                           folder=FOLDERS['LiFePO4 General Test'], date='22 Jun 2026', adc='ADS8688',
                                           short='LiFePO4 (22 Jun)', label='LiFePO4 discharge test'),
    'LiNMC General Test': dict(kind='operational', battery='LiNMC', slot='main',
                                         folder=FOLDERS['LiNMC General Test'], date='29 Jun 2026', adc='ADS8688',
                                         short='LiNMC (29 Jun)', label='LiNMC discharge test'),
}
RATED_AH = {'LiNMC': 100.0, 'LiFePO4': 50.0}           # Measurement Equipment section of the report
OCV_NOTEBOOKS = {'LiNMC': CALIBRATION_DIR / 'LiNMC Patch Output' / 'notebooks' / '3.ocv-soc-fit.ipynb',
                 'LiFePO4': CALIBRATION_DIR / '3.ocv-soc-fit.ipynb'}
SENSOR_DRAW_AH = 0.081                                 # subtracted from both capacity totals in 3.ocv-soc-fit
INIT_GRID = (0.1, 0.3, 0.5, 0.7, 0.9)                  # fixed starting SoCs of the sensitivity replays
CONVERGED_PP = 1.0                                     # spread threshold, fixed before the replays were run
GAP_MIN = 5.0                                          # s, an unrecorded interval longer than this breaks plotted lines
PROJECTION_H = 12.0                                    # h, a continuous half-day run (Research Gap section)
SENSORS = {'I_b1': 'Battery, main slot', 'I_b2': 'Battery, alternate slot', 'I_load': 'Load', 'I_mppt': 'MPPT output'}
STATE_LANES = ('charging', 'discharging', 'pass-through', 'transition', 'rest')
HATCH = dict(facecolor='none', edgecolor=AXIS, hatch='////', lw=0, zorder=0)


def adc_signature(folder, nrows=50000):
    """Logged time step and the spare channels that never change (ch3-ch5, ch7) in the first file of a run."""
    path = sorted(Path(folder).glob('*.csv'), key=_natural)[0]
    df = pd.read_csv(path, nrows=nrows)
    if 'timediff_us' not in df.columns:
        df = df.rename(columns=DB_EXPORT_COLUMNS)
    step = np.median(df.timediff_us.iloc[1:]) / 1e3
    frozen = [c for c in ('ch3', 'ch4', 'ch5', 'ch7') if df[c].nunique() == 1]
    return {'logged step (ms)': step, 'constant spare channels': ', '.join(frozen) or 'none',
            'ADC from signature': 'ADS1115' if step > 10 and len(frozen) >= 3 else 'ADS8688'}


def load_any(run, window='median'):
    """Median stream (or window='mean') of any run in RUNS, with the confirmed corrections of the operational runs."""
    r = RUNS[run]
    if r['kind'] == 'operational':
        return load_operational(run, window=window)
    return WINDOWS[window](load_run(TEST_DATA / r['folder'], r['slot'], verbose=False))


def _stamp(name):
    m = re.search(r'(\d{8})-(\d{6})', name)
    return pd.to_datetime(m.group(1) + m.group(2), format='%Y%m%d%H%M%S') if m else pd.NaT


def gap_table(run, win):
    """Unrecorded intervals of a run: t (recorded time at which logging resumes, s), length_s and kind.
    - Recording breaks are the session starts of load_run. Their length comes from the file-name start times when a
      new file starts, otherwise from the logged time step.
    - Logger stalls (database exports only): the wall clock advances more than GAP_MIN s between two samples while
      the logged time step does not, as in file_inventory, here also across part files."""
    rows = []
    sess, t = win.session.to_numpy(), win.t.to_numpy()
    first = np.flatnonzero(np.r_[True, sess[1:] != sess[:-1]])
    for a, b in zip(first[:-1], first[1:]):
        start_prev, start_new = _stamp(win.file.iloc[a]), _stamp(win.file.iloc[b])
        if win.file.iloc[b] != win.file.iloc[b - 1] and pd.notna(start_prev) and pd.notna(start_new):
            length = (start_new - start_prev).total_seconds() - (t[b - 1] - t[a])
        else:
            length = win.gap_s.iloc[b]
        rows.append({'t': t[b], 'length_s': length, 'kind': 'recording break'})
    folder = TEST_DATA / RUNS[run]['folder']
    files = OPERATIONAL_RUNS.get(run, {}).get('files')
    paths = [folder / f for f in files] if files is not None else sorted(folder.glob('*.csv'), key=_natural)
    if 'timestamp' in pd.read_csv(paths[0], nrows=0).columns:
        df = pd.concat([pd.read_csv(p, usecols=['timestamp', 'time_diff']) for p in paths], ignore_index=True)
        dt = df.time_diff.to_numpy() / 1e6
        dt[0] = 0.0
        dt[dt > SESSION_GAP] = 0.0
        ts = pd.to_datetime(df.timestamp, format='%Y-%m-%d %H:%M:%S')
        step = np.diff((ts - ts.iloc[0]).dt.total_seconds().to_numpy())
        tt = np.cumsum(dt)
        for j in np.flatnonzero(step > GAP_MIN):
            rows.append({'t': tt[j + 1], 'length_s': step[j] - dt[j + 1], 'kind': 'logger stall'})
    return pd.DataFrame(rows, columns=['t', 'length_s', 'kind']).sort_values('t', ignore_index=True)


def wall_hours(t, gaps):
    """Elapsed wall-clock hours at recorded times t (s), with the unrecorded intervals of gap_table added back."""
    add = np.searchsorted(gaps.t.to_numpy(), t, side='right')
    return (np.asarray(t, float) + np.r_[0.0, np.cumsum(gaps.length_s.to_numpy())][add]) / 3600


def gap_breaks(t, gaps, min_len=GAP_MIN):
    """True at the first record after each unrecorded interval longer than min_len (plotted lines break there)."""
    k = np.searchsorted(t, gaps.t[gaps.length_s > min_len].to_numpy())
    out = np.zeros(len(t), bool)
    out[k[k < len(t)]] = True
    return out


def _line(ax, x, y, brk, **kw):
    """Plot y against x with the line broken before every record where brk is True."""
    k = np.flatnonzero(brk)
    return ax.plot(np.insert(np.asarray(x, float), k, np.nan), np.insert(np.asarray(y, float), k, np.nan), **kw)


def _hatch_gaps(axes, gaps, min_len=GAP_MIN, label=True):
    """Hatch unrecorded intervals on a wall-clock axis (hours)."""
    g = gaps[gaps.length_s > min_len]
    x0 = wall_hours(g.t.to_numpy() - 1e-6, gaps)
    for j, (a, l) in enumerate(zip(x0, g.length_s / 3600)):
        for i, ax in enumerate(axes):
            ax.axvspan(a, a + l, label='unrecorded' if label and i == 0 and j == 0 else None, **HATCH)


def light_est(win, battery=None, model=None, record_dt=1.0):
    """Recorded time, voltage and battery current at about record_dt, plus the characterization SoC when a battery and
    model are given: enough for rest_points() on a run whose estimators are not needed."""
    rec = record_steps(win.t.to_numpy(), record_dt)
    est = pd.DataFrame({'t': win.t.to_numpy()[rec], 'session': win.session.to_numpy()[rec], 'V': win.V_bat.to_numpy()[rec],
                        'I_raw': win.I_bat.to_numpy()[rec]})
    if battery is not None:
        est['soc_ref'] = characterization_soc(win, battery, model)[rec]
    return est


# --------------------------------------------------------------------------- 4.1 battery characterization
def ocv_knots(battery):
    """The knots of the OCV curve (SoC %, V) as 3.ocv-soc-fit.ipynb printed them when it built the model, each
    labelled: a rest-end voltage from points_of_interest.json, the rested start, or constructed (the load-compensated
    last sample, or the extrapolation to 100 %)."""
    nb = json.loads(OCV_NOTEBOOKS[battery].read_text(encoding='utf-8'))
    text = '\n'.join(''.join(o.get('text', '')) for c in nb['cells'] for o in c.get('outputs', []))
    line = re.search(r'OCV knots \(SoC %, V\): (.*)', text).group(1)
    knots = np.array(re.findall(r'np\.float64\(([-\d.eE]+)\)', line), float).reshape(-1, 2)
    poi = json.loads((CALIBRATION_DIR / f'{battery} Patch Output' / 'points_of_interest.json').read_text())
    rested = np.array(poi['before_close']['voltage'])
    soc, v = knots[:, 0], knots[:, 1]
    measured = np.array([np.abs(rested - x).min() < 6e-4 for x in v])      # knots are printed to 1 mV
    kind = np.where(measured, np.where(soc >= 99.5, 'rested start', 'rest end'),
                    np.where(soc < 1, 'end estimate (last loaded sample + I·R)', 'extrapolated to 100 %'))
    return pd.DataFrame({'soc': soc, 'V': v, 'measured': measured, 'kind': kind})


def log_ocv(s, a, b, c, d, e):
    return a + b * s + c * s ** 2 + d * np.log(s) + e * np.log(100 - s)


def ocv_fit_residuals(knots):
    """Descriptive residuals of the short-rest voltages. The OCV curve is a PCHIP interpolant through its knots, so
    its residual at every knot is 0 by construction. Two substitutes, both on the same points (not validation):
    - leave-one-out: each measured interior knot against the PCHIP through all the other knots;
    - log model: a + b s + c s^2 + d ln s + e ln(100 - s), fitted to the knots with 0 < s < 100, as cell 11 of
      3.ocv-soc-fit.ipynb does for visual comparison.
    Returns the knots with both residuals (mV), and the log-model parameters."""
    from scipy.interpolate import PchipInterpolator
    from scipy.optimize import curve_fit
    s, v = knots.soc.to_numpy(), knots.V.to_numpy()
    loo = np.full(len(s), np.nan)
    for k in range(1, len(s) - 1):
        if knots.measured.iloc[k]:
            keep = np.arange(len(s)) != k
            loo[k] = v[k] - PchipInterpolator(s[keep], v[keep])(s[k])
    ok = (s > 0) & (s < 100)
    p, _ = curve_fit(log_ocv, s[ok], v[ok], p0=[0.0, 0.01, -0.0001, 0.1, 0.1], maxfev=20000)
    log = np.where(ok, v - log_ocv(np.clip(s, 1e-6, 100 - 1e-6), *p), np.nan)
    return knots.assign(loo_mV=1e3 * loo, log_mV=1e3 * log), p


def characterization_table(win, rests, battery, model, knots):
    """Characterization run of one battery: endpoints, charge, capacity, steps, rests, the retrospective 10 mV/min
    check on the logged voltage, excluded data and the residuals of the short-rest voltage curve.
    Returns (table, rest_points)."""
    est = light_est(win, battery, model)
    points = rest_points(est, rests)
    blocks = active_blocks(win)
    step_min = (blocks.t_end - blocks.t_start) / 60
    rest_min = (rests.t_end - rests.t_disc) / 60
    dt, V = win.dt.to_numpy(), win.V_bat.to_numpy()
    valid = V > V_CUTOFF
    first, last = np.flatnonzero(valid)[[0, -1]]
    ah = lambda x: np.sum(np.where(valid, x * dt, 0.0)) / 3600
    ib, il = win.I_bat.to_numpy(), win.I_load.to_numpy()
    meas = knots[knots.measured]
    met = points[points.criterion_met]
    rms = lambda x: np.sqrt(np.nanmean(np.asarray(x) ** 2))
    rows = {
        'ADC': RUNS[f'{battery} controlled']['adc'],
        'recorded': f"{RUNS[f'{battery} controlled']['date']}; {win.session.nunique()} sessions, {win.t.iloc[-1] / 3600:.2f} h logged",
        'start of discharge': f'first sample, {_stamp(win.file.iloc[first]):%d %b %H:%M}, {V[first]:.2f} V',
        'end of discharge': f'last sample above {V_CUTOFF} V before the BMS cut-off, {V[last]:.2f} V',
        'charge out, battery sensor (Ah)': ah(ib),
        'charge out, load sensor (Ah)': ah(il),
        'charge out, mean of the two raw sensors (Ah)': ah((ib + il) / 2),
        'usable capacity Q_total (Ah)': model['Q_total'],
        'Q_total as % of rated capacity': 100 * model['Q_total'] / RATED_AH[battery],
        'discharge steps (battery |I| > 1 A, 30 s or more)': len(blocks),
        'step mean current, min – max (A)': f'{blocks.I_mean.min():.1f} – {blocks.I_mean.max():.1f}',
        'step length, min / median / max (min)': f'{step_min.min():.1f} / {step_min.median():.1f} / {step_min.max():.1f}',
        'rests (all currents < 0.5 A, 5 min or more)': len(rests),
        'rest length, min / median / max (min)': f'{rest_min.min():.1f} / {rest_min.median():.1f} / {rest_min.max():.1f}',
        'rest-end voltages in the OCV curve (measured knots)': int((meas.kind == 'rest end').sum()),
        'constructed knots': ', '.join(knots.kind[~knots.measured]) or 'none',
        'logged voltage reached 10 mV/min (rests)': f'{len(met)} of {len(points)}',
        't₁ − t₀ where reached, min – max (min)': f'{met.t1_minus_t0_min.min():.1f} – {met.t1_minus_t0_min.max():.1f}' if len(met) else 'n/a',
        'voltage change after t₁, max (mV)': met.dV_t1_end_mV.max() if len(met) else np.nan,
        'time below the cutoff, excluded (h)': dt[~valid].sum() / 3600,
        'leave-one-out residual, RMS / max |·| (mV)': f'{rms(meas.loo_mV):.0f} / {np.nanmax(np.abs(meas.loo_mV)):.0f}',
        'log-model residual, RMS / max |·| (mV)': f'{rms(meas.log_mV):.0f} / {np.nanmax(np.abs(meas.log_mV)):.0f}',
    }
    return pd.Series(rows, name=battery).to_frame(), points


def plot_char_run(win, rests, gaps, title):
    """Characterization run: battery current and terminal voltage on recorded time (unrecorded gaps removed, lines
    broken there), discharge steps and rests shaded, t1 (10 mV/min reached) marked."""
    r = record_steps(win.t.to_numpy(), 2.0)
    w = win.iloc[r]
    t = w.t.to_numpy()
    h, brk = t / 3600, gap_breaks(t, gaps, 0.0)
    ok = (w.V_bat > V_CUTOFF).to_numpy()
    fig, axes = plt.subplots(2, 1, figsize=(10, 5.4), sharex=True)
    _line(axes[0], h, np.where(ok, w.I_bat, np.nan), brk, color=INK2, lw=0.9)
    axes[0].set_ylabel('Battery current (A)\n+ = discharge')
    _line(axes[1], h, np.where(ok, w.V_bat, np.nan), brk, color=INK2, lw=0.9)
    axes[1].set_ylabel('Terminal voltage (V)')
    for b in active_blocks(win).itertuples():
        for ax in axes:
            ax.axvspan(b.t_start / 3600, b.t_end / 3600, color=STEP_SHADE, lw=0, zorder=0)
    for q in rests.itertuples():
        for ax in axes:
            ax.axvspan(q.t_disc / 3600, q.t_end / 3600, color=SHADE, lw=0, zorder=0)
    for a, e in intervals(~ok, h):
        for ax in axes:
            ax.axvspan(a, e, **HATCH)
    met = rests[rests.criterion_met]
    axes[1].scatter(met.t1 / 3600, np.interp(met.t1, w.t, w.V_bat), s=22, color=INK, edgecolor='white', lw=1, zorder=4)
    for g in gaps.itertuples():
        text = (f'{g.length_s / 86400:.1f} d' if g.length_s > 86400 else f'{g.length_s / 3600:.1f} h' if g.length_s > 3600
                else f'{g.length_s / 60:.0f} min' if g.length_s >= 60 else f'{g.length_s:.0f} s')
        for ax in axes:
            ax.axvline(g.t / 3600, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=1)
        axes[0].annotate(text, (g.t / 3600, 1), xycoords=('data', 'axes fraction'), xytext=(2, -2),
                         textcoords='offset points', va='top', fontsize=7, color=INK2, rotation=90)
    handles = [plt.Rectangle((0, 0), 1, 1, color=STEP_SHADE), plt.Rectangle((0, 0), 1, 1, color=SHADE),
               plt.Rectangle((0, 0), 1, 1, **{**HATCH, 'lw': 0.5}),
               plt.Line2D([], [], marker='o', ls='', color=INK, markeredgecolor='white'),
               plt.Line2D([], [], color=MUTED, ls=(0, (3, 3)))]
    axes[1].legend(handles, ['discharge step', 'rest (5 min or more, all currents < 0.5 A)',
                             f'below the {V_CUTOFF} V cutoff (excluded)', 't₁: logged voltage within 10 mV/min',
                             'unrecorded gap (length at top)'], loc='lower left', ncol=2, fontsize=7.5)
    axes[1].set_xlabel('Recorded time (h); unrecorded gaps removed')
    suptitle(fig, title)
    fig.tight_layout()
    return fig


STEP_SHADE = '#f3e3cf'


def plot_rest_voltage_fit(fits, flags):
    """Short-rest voltage against the characterization SoC for each battery: measured knots, constructed knots, the
    PCHIP curve the estimators use, the log model, and both residuals. fits: {battery: (knots with residuals, log
    parameters)}; flags: {battery: SoC (%) of rests where the logged voltage never reached 10 mV/min}."""
    from scipy.interpolate import PchipInterpolator
    fig, axes = plt.subplots(2, len(fits), figsize=(5.4 * len(fits), 6.8), squeeze=False,
                             gridspec_kw={'height_ratios': [1.6, 1]})
    for j, (battery, (k, p)) in enumerate(fits.items()):
        ax, rx = axes[0, j], axes[1, j]
        s = np.linspace(k.soc.min(), k.soc.max(), 600)
        ax.plot(s, PchipInterpolator(k.soc, k.V)(s), color=INK2, lw=1.2, label='OCV curve used (PCHIP through knots)', zorder=2)
        m = k[k.measured]
        sl = np.linspace(m.soc[m.soc < 99.5].min(), m.soc[m.soc < 99.5].max(), 400)     # only over the fitted points
        ax.plot(sl, log_ocv(sl, *p), color=MUTED, lw=1, ls=(0, (4, 3)), label='log model (descriptive, fitted range)', zorder=2)
        ax.scatter(m.soc, m.V, s=34, color=INK, edgecolor='white', lw=1, zorder=4, label='measured short-rest voltage')
        c = k[~k.measured]
        ax.scatter(c.soc, c.V, s=34, facecolor='white', edgecolor=INK, lw=1.2, zorder=4, label='constructed knot')
        f = np.asarray(flags.get(battery, []), float)
        bad = m[[len(f) > 0 and np.abs(f - x).min() < 1.0 for x in m.soc]]
        if len(bad):
            ax.scatter(bad.soc, bad.V, s=120, facecolor='none', edgecolor=COLORS['soc_ocv'], lw=1.6, zorder=5,
                       label='logged voltage never within 10 mV/min')
        ax.set_title(battery, loc='left')
        ax.set_ylabel('Short-rest voltage (V)')
        ax.legend(loc='lower right', fontsize=7.5)
        rx.axhline(0, color=AXIS, lw=1)
        rx.scatter(m.soc, m.loo_mV, s=30, marker='D', color=INK2, edgecolor='white', lw=1, label='leave-one-out', zorder=3)
        rx.scatter(m.soc, m.log_mV, s=30, marker='o', facecolor='white', edgecolor=INK2, lw=1.2, label='log model', zorder=3)
        rx.set_ylabel('Residual (mV)')
        rx.set_xlabel('Characterization SoC (%), sensor-derived')
        rx.legend(loc='best', fontsize=7.5)
        for a in (ax, rx):
            a.set_xlim(-3, 103)
    suptitle(fig, 'Short-rest voltage against the sensor-derived characterization SoC (in-sample: the curve passes through these points)')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- 4.2 current sensor offset
def idle_windows(win, channels, min_len=20.0):
    """Zero-current windows of each sensor under the idle rule that offset correction implements (OFFSETS): load or
    MPPT reading below idle_th (0.3 A); a battery reading below idle_bat_th (1 A) while load and MPPT are idle and its
    voltage is above the cutoff. A window starts once the rule has held for idle_t (10 s, which also skips the switching
    transient) and is kept if it then lasts min_len s. Per window: start, end, median and SD of the reading (A)."""
    t, s = win.t.to_numpy(), win.session.to_numpy()
    x = {c: win[c].to_numpy() for c in SENSORS}
    th, bat_th = OFFSETS['idle_th'], OFFSETS['idle_bat_th']
    lm = (np.abs(x['I_load']) < th) & (np.abs(x['I_mppt']) < th)
    idle = {'I_load': np.abs(x['I_load']) < th, 'I_mppt': np.abs(x['I_mppt']) < th,
            'I_b1': lm & (np.abs(x['I_b1']) < bat_th) & (win.V_b1.to_numpy() > V_CUTOFF),
            'I_b2': lm & (np.abs(x['I_b2']) < bat_th) & (win.V_b2.to_numpy() > V_CUTOFF)}
    rows = []
    for c in channels:
        for sess in np.unique(s):
            m = np.flatnonzero(s == sess)
            edges = np.flatnonzero(np.diff(np.r_[0, idle[c][m].astype(int), 0]))
            for a, b in zip(edges[::2], edges[1::2]):
                k = m[a:b]
                k = k[t[k] >= t[k[0]] + OFFSETS['idle_t']]
                if not len(k) or t[k[-1]] - t[k[0]] < min_len:
                    continue
                rows.append({'col': c, 'sensor': SENSORS[c], 'session': sess, 't_start': t[k[0]], 't_end': t[k[-1]],
                             'minutes': (t[k[-1]] - t[k[0]]) / 60, 'median_A': np.median(x[c][k]), 'sd_A': np.std(x[c][k]),
                             'idx': k})
    return pd.DataFrame(rows, columns=['col', 'sensor', 'session', 't_start', 't_end', 'minutes', 'median_A', 'sd_A', 'idx'])


def learned_offsets(win, windows, t_rec, bias):
    """Adds to each idle window the offset that offset correction (OFFSETS) had learned at its end, and the median of
    reading minus learned offset inside it (before the 0.3 A output floor, which outputs 0 A). t_rec, bias: record
    times and (4, records) offsets, from extra['bias_offsets'] of run_methods or kcl_batch(win, [OFFSETS])."""
    t = win.t.to_numpy()
    ch = {'I_load': 0, 'I_mppt': 1, 'I_b1': 2, 'I_b2': 3}
    end, after = [], []
    for w in windows.itertuples():
        b = bias[ch[w.col]]
        end.append(np.interp(w.t_end, t_rec, b))
        after.append(np.median(win[w.col].to_numpy()[w.idx] - np.interp(t[w.idx], t_rec, b)))
    return windows.assign(learned_end_A=end, after_A=after)


def offset_table(windows):
    """Per run and sensor: idle windows, the reading there (offset), its spread (noise against change over time), and
    what is left after removing the learned offset."""
    g = windows.groupby(['run', 'sensor'], sort=False)
    return pd.DataFrame({
        'ADC': g.adc.first(), 'windows': g.size(), 'idle time (min)': g.minutes.sum(),
        'offset: median reading (A)': g.median_A.median(),
        'lowest / highest window median (A)': g.median_A.agg(lambda x: f'{x.min():+.3f} / {x.max():+.3f}'),
        'first → last window median (A)': g.median_A.agg(lambda x: f'{x.iloc[0]:+.3f} → {x.iloc[-1]:+.3f}'),
        'noise: median within-window SD (A)': g.sd_A.median(),
        'after removing learned offset: median (A)': g.after_A.median(),
        'after removing learned offset: max |·| (A)': g.after_A.agg(lambda x: x.abs().max()),
    })


def plot_offset_timeline(windows, biases, durations):
    """Zero-current reading of each sensor against recorded time, one column per run in date order. Dots: window medians, bars: within-window SD, line: learned offset.
    biases: {run: (record times s, (4, records) learned offsets, {col: connected mask per record})}."""
    runs = list(durations)
    rows = [('Battery', ('I_b1', 'I_b2')), ('Load', ('I_load',)), ('MPPT output', ('I_mppt',))]
    widths = [min(max(durations[r], 1.0), 3.5) for r in runs]
    fig, axes = plt.subplots(len(rows), len(runs), figsize=(13, 7.4), sharey='row', squeeze=False,
                             gridspec_kw={'width_ratios': widths})
    ch = {'I_load': 0, 'I_mppt': 1, 'I_b1': 2, 'I_b2': 3}
    for j, run in enumerate(runs):
        w = windows[windows.run == run]
        tr, b, connected = biases[run]
        for i, (name, cols) in enumerate(rows):
            ax = axes[i, j]
            ax.axhline(0, color=AXIS, lw=1, zorder=1)
            any_conn = False
            for c in cols:
                if c not in connected:
                    continue
                any_conn = True
                ax.plot(tr / 3600, np.where(connected[c], b[ch[c]], np.nan), color=COLORS['soc_ekf_kcl'], lw=1, zorder=2,
                        label='learned offset')
                g = w[w.col == c]
                if len(g):
                    mid = (g.t_start + g.t_end) / 2 / 3600
                    ax.errorbar(mid, g.median_A, yerr=g.sd_A, fmt='s' if c == 'I_b2' else 'o', ms=4.5, color=INK,
                                mfc='white' if c == 'I_b2' else INK, ecolor=MUTED, elinewidth=1, capsize=0, zorder=3,
                                label=(f'battery, {SENSORS[c].split(", ")[-1]}: window median ± within-window SD'
                                       if c in ('I_b1', 'I_b2') else 'load or MPPT: window median ± within-window SD'))
            if not any_conn:
                ax.text(0.5, 0.5, 'not connected', transform=ax.transAxes, ha='center', va='center', fontsize=7.5, color=MUTED)
            if i == 0:
                ax.set_title(RUNS[run]['label'], loc='left', fontsize=7.5)
            if j == 0:
                ax.set_ylabel(f'{name}\nzero reading (A)')
            if i == len(rows) - 1:
                ax.set_xlabel('Recorded h')
            ax.set_xlim(-0.04 * durations[run], 1.04 * durations[run])
    h, l = [], []
    for ax in axes.flat:
        for hh, ll in zip(*ax.get_legend_handles_labels()):
            if ll not in l:
                h.append(hh); l.append(ll)
    fig.tight_layout()
    fig.subplots_adjust(top=0.9, bottom=0.14)
    fig.legend(h, l, loc='lower center', ncol=len(l), fontsize=7.5, bbox_to_anchor=(0.5, 0.0))
    suptitle(fig, 'Zero-current readings of each current sensor (offset-correction idle rule; no temperature recorded)')
    return fig


# --------------------------------------------------------------------------- 4.3 operational runs
def run_operational(run, model, win=None):
    """Every method on one operational run, started from the OCV table at the first sample (as the server does), plus
    replays from INIT_GRID: extra['by_start'][col][0] is the OCV-table start, [1:] follow INIT_GRID."""
    r = RUNS[run]
    win = load_operational(run) if win is None else win
    soc0 = nearest_ocv_soc(win.V_bat[win.V_bat > V_CUTOFF].iloc[0], model)
    est, extra = run_methods(win, model, settings(r['battery'], model, 'tuned'), slot=r['slot'], soc0=soc0,
                             start_offsets=tuple(np.array(INIT_GRID) - soc0))
    return win, est, extra, soc0


def slot_events(win, est):
    """Record times where a battery slot connects or disconnects (its voltage crosses the cutoff): inferred switching."""
    rec = np.searchsorted(win.t.to_numpy(), est.t.to_numpy())
    out = []
    for slot, vc in (('main', 'V_b1'), ('alternate', 'V_b2')):
        on = win[vc].to_numpy()[rec] > V_CUTOFF
        for k in np.flatnonzero(np.diff(on.astype(int))):
            out.append({'t': est.t.iloc[k + 1], 'slot': slot, 'event': 'connected' if on[k + 1] else 'disconnected'})
    return pd.DataFrame(out, columns=['t', 'slot', 'event'])


def _state_lane_broken(ax, h, state, brk, verified=None):
    """Inferred-state lanes on a wall-clock axis, broken at unrecorded gaps. verified: (start h, end h) of each
    verified rest, drawn on a lane of its own."""
    lanes = [s for s in STATE_LANES if s in set(state)] + (['verified rest'] if verified else [])
    seg = np.cumsum(np.r_[True, (state[1:] != state[:-1]) | brk[1:]])
    for sid in np.unique(seg):
        k = np.flatnonzero(seg == sid)
        j = lanes.index(state[k[0]])
        ax.plot([h[k[0]], h[k[-1]] + 1 / 3600], [j, j], color=INK2, lw=6, solid_capstyle='butt')
    for a, b in (verified or []):
        ax.plot([a, b], [len(lanes) - 1] * 2, color=INK, lw=6, solid_capstyle='butt')
    ax.set_yticks(range(len(lanes)), lanes)
    ax.set_ylim(len(lanes) - 0.5, -0.5)
    ax.grid(axis='y', visible=False)
    ax.set_ylabel('Operating state\n(inferred)')


def plot_operational_panels(win, est, state, rests, gaps, title, slot, soc_ylim=None):
    """(a) measured currents, (b) terminal voltage of the evaluated battery, (c) SoC of the four methods, (d) inferred
    operating state with verified rests, on one wall-clock axis; unrecorded intervals hatched, lines broken there."""
    r = record_steps(win.t.to_numpy(), 2.0)
    w = win.iloc[r]
    hw, bw = wall_hours(w.t.to_numpy(), gaps), gap_breaks(w.t.to_numpy(), gaps)
    t = est.t.to_numpy()
    h, b = wall_hours(t, gaps), gap_breaks(t, gaps)
    fig, axes = plt.subplots(4, 1, figsize=(10, 9.8), sharex=True, gridspec_kw={'height_ratios': [1.2, 0.8, 1.4, 0.8]})
    for c, st in CHANNELS.items():
        x = w[c].where(w[f'V_b{c[-1]}'] > V_CUTOFF) if c in ('I_b1', 'I_b2') else w[c]
        if (x.abs() > I_REST).any():
            _line(axes[0], hw, x, bw, lw=1, **st)
    axes[0].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[0].set_ylabel('(a) Current (A)\nbattery + = discharge')
    _hatch_gaps(axes, gaps)
    axes[0].legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=5, borderaxespad=0.2)
    _line(axes[1], h, est.V.where(est.V > V_CUTOFF), b, color=INK2, lw=1)
    axes[1].set_ylabel(f'(b) Terminal voltage (V)\n{slot} slot')
    for col, name in METHODS.items():
        _line(axes[2], h, 100 * est[col], b, color=COLORS[col], label=name, zorder=2 if col == 'soc_ocv' else 3)
    axes[2].set_ylabel('(c) SoC (%)')
    if soc_ylim is not None:
        axes[2].set_ylim(*soc_ylim)
    axes[2].legend(ncol=4, loc='lower left', bbox_to_anchor=(0, 1.0), borderaxespad=0.2)
    verified = [tuple(wall_hours([q.t_disc, q.t_end], gaps)) for q in rests.itertuples()]
    _state_lane_broken(axes[3], h, state, b, verified=verified)
    for a, e in verified:
        for ax in axes[:3]:
            ax.axvspan(a, e, color=SHADE, lw=0, zorder=0)
    axes[3].set_xlabel('Elapsed wall-clock time (h)')
    suptitle(fig, title)
    fig.tight_layout()
    return fig


def disagreement_by_state(est, state):
    """Net change of each pairwise difference accumulated while the run was in each inferred state (pp). For one run
    the rows add up to the difference at the end minus the difference at the first record."""
    d = pairwise(est).ffill().fillna(0.0)
    inc = d.diff().fillna(0.0)
    dt = pd.Series(np.r_[0.0, np.diff(est.t.to_numpy())], index=est.index)
    out = inc.groupby(state).sum()
    out.insert(0, 'minutes', dt.groupby(state).sum() / 60)
    return out.reindex([s for s in STATE_LANES if s in out.index])


def pairwise_summary(est, state, gaps):
    """Per pair: largest |difference| with its time and state, and the difference at the end (pp)."""
    d = pairwise(est)
    h = wall_hours(est.t.to_numpy(), gaps)
    rows = {}
    for name in PAIRS:
        y = d[name].to_numpy()
        k = np.nanargmax(np.abs(y))
        last = np.flatnonzero(np.isfinite(y))[-1]
        rows[name] = {'max |·| (pp)': abs(y[k]), 'signed value at max (pp)': y[k], 'at (h)': h[k], 'state at max': state[k],
                      'at end (pp)': y[last]}
    return pd.DataFrame(rows).T


def plot_pairwise_all(results, ylims=None):
    """Pairwise method disagreement over time for every operational run (one row each), wall-clock axis, verified
    rests shaded, unrecorded intervals hatched. results: {run: (est, rests, gaps)}."""
    fig, axes = plt.subplots(len(results), 1, figsize=(10, 2.3 * len(results) + 0.8), squeeze=False)
    for ax, (run, (est, rests, gaps)) in zip(axes[:, 0], results.items()):
        d = pairwise(est)
        t = est.t.to_numpy()
        h, b = wall_hours(t, gaps), gap_breaks(t, gaps)
        for name, col in (('OCV − CC', 'soc_ocv'), ('EKF − CC', 'soc_ekf'), ('EKF + KCL − CC', 'soc_ekf_kcl')):
            _line(ax, h, d[name], b, color=COLORS[col], lw=1.2, label=name.replace('OCV', 'OCV mapping'))
        for q in rests.itertuples():
            ax.axvspan(*wall_hours([q.t_disc, q.t_end], gaps), color=SHADE, lw=0, zorder=0)
        _hatch_gaps([ax], gaps, label=False)
        ax.axhline(0, color=AXIS, lw=1, zorder=1)
        ax.set_ylabel('Method\ndisagreement (pp)')
        if ylims and RUNS[run]['battery'] in ylims:
            ax.set_ylim(*ylims[RUNS[run]['battery']])
        ax.set_title(f"{RUNS[run]['label']}, {RUNS[run]['slot']} slot", loc='left', fontsize=9)
    axes[0, 0].legend(loc='lower right', bbox_to_anchor=(1, 1.0), ncol=3, borderaxespad=0.2)
    axes[-1, 0].set_xlabel('Elapsed wall-clock time (h)')
    suptitle(fig, 'Method disagreement relative to coulomb counting (no reference SoC exists for these runs)')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- 4.4 rests
def rest_long(deltas, points, **labels):
    """Signed ΔSoC of every method over every rest, with the rest's type, length and voltage change."""
    p = points[['type', 'length_min', 'criterion_met', 'V_t0', 'V_end']]
    out = deltas.join(p, on='rest')
    out['dV_mV'] = 1e3 * (out.V_end - out.V_t0)
    return out.assign(**labels)


def rest_group_table(long):
    """Per group (source, battery, preceding mode) and method: count, median and max |ΔSoC|, signed min and max, median
    rest length and voltage change."""
    g = long.assign(a=long.dsoc_t0_end_pp.abs()).groupby(['source', 'battery', 'type', 'method'], sort=False)
    return pd.DataFrame({'rests': g.size(), 'median |ΔSoC| (pp)': g.a.median(), 'max |ΔSoC| (pp)': g.a.max(),
                         'signed min (pp)': g.dsoc_t0_end_pp.min(), 'signed max (pp)': g.dsoc_t0_end_pp.max(),
                         'median length (min)': g.length_min.median(), 'median ΔV t₀→end (mV)': g.dV_mV.median()})


def plot_rest_pairs(long, groups):
    """Paired dot plot: signed ΔSoC over each rest, one column per group (source, battery, type), methods on x, each
    rest joined across methods. OCV mapping on the top row (own scale)."""
    fig, axes = plt.subplots(2, len(groups), figsize=(3.2 * len(groups), 6.4), squeeze=False,
                             gridspec_kw={'height_ratios': [1, 1.4]})
    for j, (key, label) in enumerate(groups.items()):
        g = long[(long.source == key[0]) & (long.battery == key[1]) & (long.type == key[2])]
        for ax, cols in ((axes[0, j], ['soc_ocv']), (axes[1, j], ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])):
            if len(cols) > 1:
                for _, rr in g.groupby(['run', 'rest']):
                    rr = rr.set_index('col').reindex(cols)
                    ax.plot(range(len(cols)), rr.dsoc_t0_end_pp, color=AXIS, lw=0.8, zorder=1)
            for x, col in enumerate(cols):
                y = g[g.col == col].dsoc_t0_end_pp.to_numpy()
                jit = (np.arange(len(y)) - (len(y) - 1) / 2) * min(0.03, 0.3 / max(len(y), 1))
                ax.scatter(x + jit, y, s=30, marker=MARKERS[col], color=COLORS[col], edgecolor='white', lw=0.8, zorder=3)
            ax.axhline(0, color=AXIS, lw=1, zorder=0)
            ax.set_xticks(range(len(cols)), [METHODS[c].replace('Coulomb counting', 'CC') for c in cols], fontsize=8)
            ax.set_xlim(-0.6, len(cols) - 0.4)
        n = len(g.drop_duplicates(['run', 'rest']))
        axes[0, j].set_title(f'{label}\nn = {n} rest{"s" if n != 1 else ""}', loc='left', fontsize=8.5)
    axes[0, 0].set_ylabel('OCV mapping\nsigned ΔSoC t₀→end (pp)')
    axes[1, 0].set_ylabel('Signed ΔSoC t₀→end (pp)\n(grey lines join one rest)')
    suptitle(fig, 'SoC change over each verified rest, by data source, battery and preceding operating mode')
    fig.tight_layout()
    return fig


def plot_rest_closeups(cases):
    """One rest per column, from 1 min before it: currents, voltage, and each method's SoC change from t0.
    cases: list of (est, rest row of find_rests, title)."""
    fig, axes = plt.subplots(4, len(cases), figsize=(5.4 * len(cases), 8.8), squeeze=False,
                             gridspec_kw={'height_ratios': [1, 1, 0.9, 1.2]})
    for j, (est, r, title) in enumerate(cases):
        seg = est[(est.t >= r.t_disc - 60) & (est.t <= r.t_end)]
        m = ((seg.t - r.t_disc) / 60).to_numpy()
        ax = axes[0, j]
        ax.plot(m, seg.I_raw, color=MUTED, lw=1, label='battery, raw')
        ax.plot(m, seg.I_off, color=INK2, ls=(0, (4, 2)), lw=1.2, label='battery, offset-corrected')
        ax.plot(m, seg.I_load, color=INK, ls=(0, (1, 1.5)), lw=1, label='load')
        ax.plot(m, seg.I_mppt, color=INK, lw=0.8, label='MPPT')
        after = seg[seg.t >= r.t0][['I_raw', 'I_off', 'I_load', 'I_mppt']]
        ax.set_ylim(min(after.min().min(), 0) - 0.3, max(after.max().max(), 0) + 0.5)
        ax.annotate(f'battery current before the rest: {r.I_before:+.1f} A (off scale)', (0, 1), xycoords='axes fraction',
                    xytext=(4, -2), textcoords='offset points', va='top', fontsize=7.5, color=INK2)
        ax.legend(loc='lower right', fontsize=7, ncol=2)
        axes[1, j].plot(m, seg.V, color=INK2)
        for ax2, cols in ((axes[2, j], ['soc_ocv']), (axes[3, j], ['soc_cc', 'soc_ekf', 'soc_ekf_kcl'])):
            lo, hi = [], []
            for col in cols:
                d = 100 * (seg[col] - at(est, col, r.t0, r.t_disc, r.t_end))
                ax2.plot(m, d, color=COLORS[col], label=METHODS[col])
                lo.append(d[seg.t >= r.t0].min()); hi.append(d[seg.t >= r.t0].max())
            pad = 0.15 * max(max(hi) - min(lo), 0.02)
            ax2.set_ylim(min(lo) - pad, max(hi) + pad)
            ax2.legend(loc='best', fontsize=7.5)
        for ax2 in axes[:, j]:
            for x in (0, (r.t0 - r.t_disc) / 60):
                ax2.axvline(x, color=MUTED, lw=1, ls=(0, (3, 3)))
            if r.criterion_met:
                ax2.axvline((r.t1 - r.t_disc) / 60, color=INK, lw=1, ls=(0, (1, 2)))
        axes[0, j].set_title(title, loc='left', fontsize=9)
        axes[3, j].set_xlabel('Minutes from the start of the rest\n(dashed: start and t₀; dotted: t₁, 10 mV/min reached)')
    axes[0, 0].set_ylabel('Current (A)')
    axes[1, 0].set_ylabel('Terminal voltage (V)')
    axes[2, 0].set_ylabel('SoC change\nfrom t₀ (pp)')
    axes[3, 0].set_ylabel('SoC change\nfrom t₀ (pp)')
    suptitle(fig, 'Representative rests after discharge and after charge')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- 4.5 initialization
def init_spread_table(est, extra, gaps, threshold=CONVERGED_PP):
    """Within-method spread (max - min SoC across the INIT_GRID replays) of each stateful method. OCV mapping has no
    initial state: not applicable."""
    h = wall_hours(est.t.to_numpy(), gaps)
    k_end = np.flatnonzero(est.V > V_CUTOFF)[-1]
    rows = {}
    for col in ('soc_cc', 'soc_ekf', 'soc_ekf_kcl'):
        a = extra['by_start'][col][1:]
        sp = 100 * (a.max(0) - a.min(0))
        below = sp[:k_end + 1] < threshold
        above = np.flatnonzero(~below)
        rows[METHODS[col]] = {
            'initial values (%)': ', '.join(f'{100 * s:.0f}' for s in INIT_GRID),
            'spread at the first record (pp)': sp[0],
            'spread at the end (pp)': sp[k_end],
            f'first below {threshold:g} pp (h)': h[np.argmax(below)] if below.any() else 'not reached',
            f'below {threshold:g} pp from (h) to the end': ('not reached' if not below[-1] else
                                                            h[above[-1] + 1] if len(above) else h[0]),
        }
    rows['OCV mapping'] = {k: 'not applicable' for k in rows[METHODS['soc_cc']]}
    return pd.DataFrame(rows).T


def plot_init(results, threshold=CONVERGED_PP):
    """One column per operational run. Top: CC (dashed) and EKF (solid) replays from INIT_GRID. Bottom: within-method
    spread on a log scale with the threshold. results: {run: (est, extra, gaps)}."""
    fig, axes = plt.subplots(2, len(results), figsize=(3.6 * len(results), 6.4), squeeze=False, sharey='row')
    shades = np.linspace(0.3, 1.0, len(INIT_GRID))
    for j, (run, (est, extra, gaps)) in enumerate(results.items()):
        t = est.t.to_numpy()
        h, b = wall_hours(t, gaps), gap_breaks(t, gaps)
        ax, sx = axes[0, j], axes[1, j]
        for i in range(len(INIT_GRID)):
            _line(ax, h, 100 * extra['by_start']['soc_cc'][i + 1], b, color=COLORS['soc_cc'], lw=1, ls=(0, (3, 2)),
                  alpha=shades[i])
            _line(ax, h, 100 * extra['by_start']['soc_ekf'][i + 1], b, color=COLORS['soc_ekf'], lw=1.3, alpha=shades[i])
        ax.set_title(RUNS[run]['label'], loc='left', fontsize=9)
        for col in ('soc_cc', 'soc_ekf', 'soc_ekf_kcl'):
            a = extra['by_start'][col][1:]
            _line(sx, h, np.maximum(100 * (a.max(0) - a.min(0)), 1e-4), b, color=COLORS[col], lw=1.3,
                  ls=(0, (4, 2)) if col == 'soc_ekf_kcl' else '-', label=METHODS[col])
        sx.axhline(threshold, color=INK, lw=1, ls=(0, (1, 2)))
        sx.set_yscale('log')
        sx.set_xlabel('Elapsed wall-clock time (h)')
        _hatch_gaps([ax, sx], gaps, label=False)
    axes[0, 0].set_ylabel('SoC (%), replays from\n' + ', '.join(f'{100 * s:.0f}' for s in INIT_GRID) + ' %')
    axes[1, 0].set_ylabel(f'Spread within method\n(max − min, pp; dotted: {threshold:g} pp)')
    axes[0, 0].legend([plt.Line2D([], [], color=COLORS['soc_cc'], lw=1, ls=(0, (3, 2))), plt.Line2D([], [], color=COLORS['soc_ekf'], lw=1.3)],
                      ['CC, one line per start (darker = higher start)', 'EKF, one line per start'], loc='center right', fontsize=7.5)
    axes[1, -1].legend(loc='center right', fontsize=7.5)
    suptitle(fig, 'Sensitivity to the initial SoC: replays of each operational run with frozen settings (OCV mapping: not applicable)')
    fig.tight_layout()
    return fig


# --------------------------------------------------------------------------- 4.6 KCL correction
def kcl_state_table(est, extra, state, gaps, excl=T_VERIFY):
    """Per inferred state, leaving out records within excl s after a state change or an unrecorded interval: minutes,
    median |KCL residual| raw, after offsets and after gated KCL (A), and |EKF + KCL - EKF| (pp)."""
    t = est.t.to_numpy()
    mark = np.r_[True, state[1:] != state[:-1]] | gap_breaks(t, gaps)
    since = t - np.maximum.accumulate(np.where(mark, t, -np.inf))
    keep = (since >= excl) & (est.V > V_CUTOFF).to_numpy()
    diff = 100 * (est.soc_ekf_kcl - est.soc_ekf).to_numpy()
    df = pd.DataFrame({'state': state, 'dt': np.r_[0.0, np.diff(t)], 'raw': np.abs(extra['res_raw']),
                       'off': np.abs(extra['res_offsets']), 'kcl': np.abs(extra['res_kcl']), 'd': np.abs(diff),
                       'inc': np.r_[0.0, np.diff(diff)]})[keep]
    g = df.groupby('state')
    out = pd.DataFrame({'minutes': g.dt.sum() / 60, 'median |r| raw (A)': g.raw.median(),
                        'median |r| after offsets (A)': g.off.median(), 'median |r| after gated KCL (A)': g.kcl.median(),
                        'median |EKF+KCL − EKF| (pp)': g.d.median(), 'max |EKF+KCL − EKF| (pp)': g.d.max(),
                        'net change of EKF+KCL − EKF in state (pp)': g.inc.sum()})
    out = out.reindex([s for s in STATE_LANES if s in out.index])
    out.loc['all states'] = [df.dt.sum() / 60, df.raw.median(), df.off.median(), df.kcl.median(), df.d.median(),
                             df.d.max(), df.inc.sum()]
    return out


def plot_kcl_channels(win, est, extra, state, gaps, title, slot):
    """(a) KCL residual per minute: raw, after offsets, after gated KCL; then the offset removed from each connected
    channel by offset correction alone and with the gated KCL update; EKF + KCL minus EKF; inferred state."""
    t = est.t.to_numpy()
    h, b = wall_hours(t, gaps), gap_breaks(t, gaps)
    rec = np.searchsorted(win.t.to_numpy(), t)
    own = ('I_b1', 2, 'Battery, main') if slot == 'main' else ('I_b2', 3, 'Battery, alternate')
    other = ('I_b2', 3, 'Battery, alternate') if slot == 'main' else ('I_b1', 2, 'Battery, main')
    chans = [own, ('I_load', 0, 'Load'), ('I_mppt', 1, 'MPPT output')]
    if (win[f'V_b{other[1] - 1}'].to_numpy() > V_CUTOFF).mean() > 0.05:
        chans.append(other)
    n = len(chans) + 3
    fig, axes = plt.subplots(n, 1, figsize=(10, 1.5 * n + 1.4), sharex=True,
                             gridspec_kw={'height_ratios': [1.3] + [0.8] * len(chans) + [1, 0.8]})
    minute = (t // 60).astype(int)
    valid = (est.V > V_CUTOFF).to_numpy()
    pm = (pd.DataFrame({'raw': extra['res_raw'], 'off': extra['res_offsets'], 'kcl': extra['res_kcl']})
          .where(np.repeat(valid[:, None], 3, axis=1)).groupby(minute).median())
    first_t = pd.Series(t).groupby(minute).first().to_numpy()
    hm, bm = wall_hours(first_t, gaps), gap_breaks(first_t, gaps)
    _line(axes[0], hm, pm.raw, bm, color=MUTED, lw=1.1, drawstyle='steps-post', label='raw')
    _line(axes[0], hm, pm.off, bm, color=INK2, lw=1.1, drawstyle='steps-post', label='after offsets')
    _line(axes[0], hm, pm.kcl, bm, color=COLORS['soc_ekf_kcl'], lw=1.1, drawstyle='steps-post', label='after gated KCL')
    axes[0].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[0].set_ylabel('(a) KCL residual r (A)\nper-minute median')
    axes[0].legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=3, borderaxespad=0.2)
    letters = 'bcdefgh'
    for i, (c, k, name) in enumerate(chans, 1):
        conn = (win[f'V_b{k - 1}'].to_numpy()[rec] > V_CUTOFF) if c in ('I_b1', 'I_b2') else np.ones(len(t), bool)
        _line(axes[i], h, np.where(conn, extra['bias_offsets'][k], np.nan), b, color=INK2, lw=1.2,
              label='offsets only (CC, EKF input)')
        _line(axes[i], h, np.where(conn, extra['bias_kcl'][k], np.nan), b, color=COLORS['soc_ekf_kcl'], lw=1.2,
              label='offsets + gated KCL (EKF + KCL input)')
        axes[i].axhline(0, color=AXIS, lw=1, zorder=1)
        axes[i].set_ylabel(f'({letters[i - 1]}) {name}\noffset removed (A)')
    axes[1].legend(loc='best', fontsize=7.5, ncol=2)
    j = len(chans) + 1
    _line(axes[j], h, 100 * (est.soc_ekf_kcl - est.soc_ekf), b, color=COLORS['soc_ekf_kcl'])
    axes[j].axhline(0, color=AXIS, lw=1, zorder=1)
    axes[j].set_ylabel(f'({letters[j - 1]}) EKF + KCL\nminus EKF (pp)')
    _state_lane_broken(axes[-1], h, state, b)
    ev = slot_events(win, est)
    for e in ev.itertuples():
        for ax in axes:
            ax.axvline(wall_hours([e.t], gaps)[0], color=INK, lw=1, ls=(0, (1, 2)), zorder=2)
    _hatch_gaps(axes, gaps, label=False)
    axes[-1].set_xlabel('Elapsed wall-clock time (h)' + ('; dotted: a battery slot connects or disconnects' if len(ev) else ''))
    suptitle(fig, title)
    fig.tight_layout()
    return fig


def md_table(df, name, floatfmt='.3f', index=True):
    """Save a table as tables/res_<name>.csv and .md; returns the Markdown. Floats inside text columns are formatted
    with floatfmt too."""
    save_table(df, f'res_{name}', index=index)
    shown = df.copy()
    for c in shown.columns[shown.dtypes == object]:
        shown[c] = shown[c].map(lambda v: format(v, floatfmt) if isinstance(v, (float, np.floating)) else v)
    text = shown.to_markdown(floatfmt=floatfmt, index=index)
    (TABLE_DIR / f'res_{name}.md').write_text(text + '\n', encoding='utf-8')
    return text


# =========================================================================== sampling rate (sampling_rate.ipynb)
# The minimum filter rate from three criteria: (1) the fast RC time constant, (2) the load-current bandwidth and
# (3) a sweep of the same EKF over each recording decimated to lower rates. Only adds functions.
SAMPLING_DIR = REPO_ROOT / 'final_report' / 'analysis' / 'sampling_rate_section'
TAU_RATIO = 0.1              # criterion 1: dt <= tau1 / 10 (first-order decay-factor error about 0.5 %)
NYQUIST_SHARE = 0.15         # criterion 2: frequencies of interest <= 15 % of Nyquist (Smyth & Wu): f_s >= f / 0.075
PSD_SEG = 2 ** 17            # samples per Welch segment of the load cycle (about 114 s at 1.15 kHz)
FLOOR_SEG = 2 ** 14          # samples per Welch segment of the rest noise floor (about 14 s)
BANDWIDTH_SHARE = 0.99       # f_I,max holds this share of the load-driven power (above the rest floor)
REF_BLOCK = 10               # sweep reference: block mean of 10 logged samples (the server's window), at most 10 ms
SWEEP_RATES = (20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02)     # Hz
DECIMATION = {'mean': 'block mean', 'median': 'block median', 'point': 'point sample'}
RATE_TOL_PP = 0.05           # SoC change tolerated from the sampling rate alone (max |ΔSoC|, pp)
EVENT_PP = 0.05              # a reference step changing SoC more than this is a discrete filter event (gate opening)
EVENT_WINDOW_S = 10.0        # s (or two filter steps if longer) around such an event, left out of the max |ΔSoC|
SWEEP_RUNS = ('LiNMC controlled', 'LiFePO4 controlled', 'General Discharge Test', 'General Discharge Test 2',
              'LiFePO4 General Test', 'LiNMC General Test')
DECIMATION_STYLE = {'mean': dict(color=INK, ls='-', marker='o'), 'median': dict(color=INK2, ls=(0, (4, 2)), marker='s'),
                    'point': dict(color=MUTED, ls=(0, (1, 1.5)), marker='^')}


def euler_error(ratio):
    """Relative error of the first-order decay factor 1 - dt/tau against the exact exp(-dt/tau)."""
    ratio = np.asarray(ratio, float)
    return np.abs((1 - ratio) - np.exp(-ratio)) / np.exp(-ratio)


def time_constant_table(models):
    """Criterion 1 per battery: tau1 and tau2 over the SoC table, the largest dt = TAU_RATIO * min tau1, its rate."""
    rows = {}
    for b, m in models.items():
        t = m['table']
        tau1, tau2 = t['R1'] * t['C1'], t['R2'] * t['C2']
        dt_max = TAU_RATIO * tau1.min()
        rows[b] = {'τ1 min (s)': tau1.min(), 'τ1 max (s)': tau1.max(), 'τ2 min (s)': tau2.min(), 'τ2 max (s)': tau2.max(),
                   'Δt max (s)': dt_max, 'f_s min (Hz)': 1 / dt_max}
    return pd.DataFrame(rows).T


def load_sweep_run(run):
    """Logged samples of one run in RUNS, with the same corrections as load_any (before the median window)."""
    r = RUNS[run]
    op = OPERATIONAL_RUNS.get(run, {})
    return load_run(TEST_DATA / r['folder'], r['slot'], op.get('files'), verbose=False,
                    mppt_latch=op.get('mppt_latch', True))


def decimate(raw, step=None, n=None):
    """Blocks of step seconds (or of n logged samples) within each session. Returns the block-mean stream (columns as
    window_median) and the battery current and voltage of each decimation in DECIMATION, shape (3, blocks):
    - block mean: the voltage averaged over the connected samples (above V_CUTOFF) and the current as the block's
      connected charge over its length, so the charge is kept and a logger dropout (0 V samples) cannot pull a block
      mean down to a false voltage above the cutoff;
    - block median: the median of the connected samples;
    - point sample: the first sample of the block, as logged, held over the block.
    A block with no connected sample gets 0 V and 0 A."""
    if n is not None:
        block = raw.groupby('session').cumcount().to_numpy() // n
    else:
        t_in = raw.groupby('session').dt.cumsum().to_numpy() - raw.dt.to_numpy()
        block = np.floor(t_in / step + 1e-9).astype(np.int64)
    ok = raw.V_bat.to_numpy() > V_CUTOFF
    x = raw.assign(q=np.where(ok, raw.I_bat * raw.dt, 0.0), Iv=raw.I_bat.where(ok), Vv=raw.V_bat.where(ok))
    g = x.groupby([x.session.to_numpy(), block], sort=True)
    win = g[['I_mppt', 'I_load', 'I_b1', 'I_b2', 'V_b1', 'V_b2']].mean()
    win['dt'] = g.dt.sum()
    win['gap_s'] = g.gap_s.sum()
    iv = g.Iv.mean().fillna(0.0)
    win['I_bat'] = np.where(win.dt > 0, g.q.sum() / win.dt.where(win.dt > 0), iv)
    win['V_bat'] = g.Vv.mean().fillna(0.0)
    win = win.reset_index(level=0, names='session').reset_index(drop=True)
    win['t'] = win.dt.cumsum()
    med, first = g[['Iv', 'Vv']].median().fillna(0.0), g[['I_bat', 'V_bat']].first()
    I = np.vstack([win.I_bat.to_numpy(), med.Iv.to_numpy(), first.I_bat.to_numpy()])
    V = np.vstack([win.V_bat.to_numpy(), med.Vv.to_numpy(), first.V_bat.to_numpy()])
    return win, I, V


def _welch_runs(y, mask, fs, nps):
    """Welch PSD (one-sided, A^2/Hz) averaged over every contiguous run of mask at least nps samples long."""
    from scipy import signal
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(np.int8), 0]))
    f, acc, segs = np.fft.rfftfreq(nps, 1 / fs), 0.0, 0
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a < nps:
            continue
        f, P = signal.welch(y[a:b], fs=fs, nperseg=nps, detrend='constant')
        acc, segs = acc + P * ((b - a) // nps), segs + (b - a) // nps
    return f, (acc / segs if segs else np.full(len(f), np.nan)), segs


def current_psd(raw, col='I_bat'):
    """Criterion 2: PSD of the battery current over the whole load cycle (every connected sample, switching included)
    and its noise floor at rest (every current below I_REST for T_VERIFY s). The load-driven spectrum is the part
    above the floor; f_I,max is the frequency below which BANDWIDTH_SHARE of it lies."""
    fs = 1 / float(np.median(raw.dt[raw.dt > 0]))
    y = raw[col].to_numpy()
    sess = raw.session.to_numpy()
    cont = (raw.V_bat.to_numpy() > V_CUTOFF) & np.r_[True, sess[1:] == sess[:-1]]
    quiet = ((raw.I_bat.abs() < I_REST) & (raw.I_load.abs() < I_REST) & (raw.I_mppt.abs() < I_REST)).astype(np.int8)
    rest = (quiet.rolling(int(T_VERIFY * fs)).min().fillna(0).to_numpy() > 0) & cont
    f, P, segs = _welch_runs(y, cont, fs, PSD_SEG)
    fr, Pr, rest_segs = _welch_runs(y, rest, fs, FLOOR_SEG)
    floor = np.interp(f, fr, Pr)
    excess = np.clip(P - floor, 0.0, None)
    excess[0] = 0.0
    cum = np.cumsum(excess) / excess.sum()
    df = f[1] - f[0]
    return {'f': f, 'P': P, 'floor': floor, 'fs': fs, 'segs': segs, 'rest_segs': rest_segs,
            'f90': f[np.searchsorted(cum, 0.9)], 'f_bw': f[np.searchsorted(cum, BANDWIDTH_SHARE)],
            'excess_A2': excess.sum() * df, 'rms_above_10Hz': np.sqrt(excess[f >= 10].sum() * df),
            'floor_rms': np.sqrt(np.nansum(Pr) * (fr[1] - fr[0]))}


def bandwidth_table(psds):
    rows = {}
    for run, p in psds.items():
        rows[RUNS[run]['short']] = {
            'logged rate (Hz)': p['fs'], 'Welch segments (cycle / rest)': f"{p['segs']} / {p['rest_segs']}",
            'load-driven rms (A)': np.sqrt(p['excess_A2']), 'of which above 10 Hz (A rms)': p['rms_above_10Hz'],
            'rest noise floor (A rms)': p['floor_rms'], 'f90 (Hz)': p['f90'], 'f_I,max = f99 (Hz)': p['f_bw'],
            'f_s ≥ f_I,max / 0.075 (Hz)': p['f_bw'] / (NYQUIST_SHARE / 2)}
    return pd.DataFrame(rows).T


def run_sweep(run, model, raw, rates=SWEEP_RATES):
    """Criterion 3: the tuned EKF (and coulomb counting) on one recording at each rate and decimation, against the
    same EKF on the REF_BLOCK block-mean stream. Both use the battery current as logged (no offset correction), so
    the sweep isolates the sampling. With rate=True the voltage noise is a density (R = r / dt), so the filter's
    weighting per second does not change with the rate.
    Returns one row per rate and decimation: max, RMS and end ΔSoC of the EKF and max |ΔSoC| of CC (pp, connected
    samples only; on a controlled run only over its scored SoC range and sessions), plus, on a controlled run, the
    EKF's RMS error against the characterization SoC over that range."""
    r = RUNS[run]
    battery, b = r['battery'], BATTERIES[r['battery']]
    cfg = settings(battery, model)
    dt_raw = float(np.median(raw.dt[raw.dt > 0]))
    n_ref = max(1, min(REF_BLOCK, int(0.01 // dt_raw)))       # the ADS1115 run is used at its logged 32 ms
    Qn = model['Q_total'] * 3600
    t_raw = raw.t.to_numpy()
    q_raw = np.cumsum(np.where(raw.V_bat.to_numpy() > V_CUTOFF, raw.I_bat.to_numpy() * raw.dt.to_numpy(), 0.0)) / Qn
    controlled = r['kind'] == 'controlled'
    char = characterization_soc(raw, battery, model) if controlled else None

    def ekf3(win, I, V, soc0):
        soc, _, _ = ekf_batch(win, model, [dict(cfg['ekf'], soc0=soc0)] * 3, current=I, voltage=V, record_dt=0,
                              gap_decay=cfg['gap_decay'])
        return soc

    win, I, V = decimate(raw, n=n_ref)
    ok = win.V_bat.to_numpy() > V_CUTOFF
    soc0 = 1.0 if controlled else nearest_ocv_soc(V[1][ok][0], model)     # as run_methods / run_operational
    ref = ekf3(win, I, V, soc0)
    t_ref = win.t.to_numpy()
    jumps = t_ref[1:][np.abs(np.diff(ref[0])) > EVENT_PP / 100]
    rows = []

    def score(win, I, soc, rate, reference=False):
        t, dt = win.t.to_numpy(), win.dt.to_numpy()
        ok = win.V_bat.to_numpy() > V_CUTOFF
        # skip records near a reference jump: the same jump made a little earlier or later is timing, not SoC
        w = max(EVENT_WINDOW_S, 2 / rate)
        near = (np.searchsorted(jumps, t + w, side='right') - np.searchsorted(jumps, t - w - 1 / rate, side='left')) > 0
        abs_rms = np.full(3, np.nan)
        if controlled:     # score over the fitted SoC range, as add_reference (the BMS cut-off and start lie outside)
            ref_c = np.interp(t, t_raw, char)
            ok = ok & (ref_c >= b['score_soc'][0]) & (ref_c <= b['score_soc'][1]) & (t > 300)
            if b['score_sessions'] is not None:
                ok &= win.session.isin(b['score_sessions']).to_numpy()
            abs_rms = np.sqrt(np.mean((100 * (soc - ref_c))[:, ok] ** 2, axis=1))
        e_all = 100 * (soc - np.interp(t, t_ref, ref[0]))
        e = e_all[:, ok]
        e_max = np.abs(e_all[:, ok & ~near]).max(axis=1)
        e_cc = 100 * (np.interp(t, t_raw, q_raw) - np.cumsum(np.where(win.V_bat.to_numpy() > V_CUTOFF, I * dt, 0.0),
                                                             axis=1) / Qn)[:, ok]
        for j, how in enumerate(DECIMATION):
            rows.append({'run': run, 'battery': battery, 'rate_hz': rate, 'step_s': 1 / rate, 'decimation': how,
                         'reference': reference, 'steps': len(t), 'near_jump': int((ok & near).sum()),
                         'ekf_max_pp': e_max[j], 'ekf_rms_pp': np.sqrt(np.mean(e[j] ** 2)),
                         'ekf_end_pp': e[j][-1], 'cc_max_pp': np.abs(e_cc[j]).max(), 'abs_rms_pp': abs_rms[j]})

    score(win, I, ref, 1 / (n_ref * dt_raw), reference=True)
    for rate in rates:
        if 1 / rate < 2 * n_ref * dt_raw:
            continue
        w, I, V = decimate(raw, step=1 / rate)
        score(w, I, ekf3(w, I, V, soc0), rate)
    return pd.DataFrame(rows)


def min_rates(sweep, tol=RATE_TOL_PP):
    """Per decimation: the lowest swept rate at which, on every run, the EKF and CC stay within tol of the reference,
    at that rate and at every higher one."""
    s = sweep[~sweep.reference]
    worst = s.assign(err=np.maximum(s.ekf_max_pp, s.cc_max_pp)).groupby(['decimation', 'rate_hz']).err.max()
    out = {}
    for how in DECIMATION:
        w = worst[how].sort_index(ascending=False)
        bad = np.flatnonzero(w.to_numpy() > tol)
        passing = w.index[:bad[0]] if len(bad) else w.index
        out[DECIMATION[how]] = {
            'minimum rate (Hz)': passing.min() if len(passing) else np.nan,
            'worst max |ΔSoC| there (pp)': w[passing.min()] if len(passing) else np.nan,
            'next lower rate (Hz)': w.index[bad[0]] if len(bad) else np.nan,
            'worst max |ΔSoC| at next lower (pp)': w.iloc[bad[0]] if len(bad) else np.nan}
    return pd.DataFrame(out).T


def plot_current_psd(psds, title):
    n = len(psds)
    fig, axes = plt.subplots((n + 1) // 2, 2, figsize=(10, 3.0 * ((n + 1) // 2) + 0.6), sharex=True, sharey=True,
                             squeeze=False)
    for ax, (run, p), letter in zip(axes.flat, psds.items(), 'abcdef'):
        f = p['f'][1:]
        ax.loglog(f, p['P'][1:], color=INK, lw=0.9, label='load cycle')
        ax.loglog(f, p['floor'][1:], color=MUTED, lw=1.1, ls=(0, (4, 2)), label='rest noise floor')
        ax.axvline(p['f_bw'], color=INK2, lw=1, ls=(0, (1, 1.5)))
        ax.text(p['f_bw'] * 1.15, 0.97, f"f99 = {p['f_bw']:.3g} Hz", transform=ax.get_xaxis_transform(),
                va='top', fontsize=8, color=INK2)
        ax.set_title(f"({letter}) {RUNS[run]['label']}", loc='left')
    for ax in axes[:, 0]:
        ax.set_ylabel('Battery current PSD (A²/Hz)')
    for ax in axes[-1]:
        ax.set_xlabel('Frequency (Hz)')
    for ax in axes.flat[n:]:
        ax.set_visible(False)
    axes.flat[0].legend(loc='lower left')
    suptitle(fig, title)
    fig.tight_layout()
    return fig


def plot_rate_sweep(sweep, tau_rate, nyq_rate, title, tol=RATE_TOL_PP):
    """(a) EKF and (b) CC max |ΔSoC| from the reference per rate: worst run per decimation (bold) and each run
    (thin); (c) the EKF's RMS error against the characterization SoC on the controlled runs (block mean)."""
    s = sweep[~sweep.reference]
    ctrl = sweep[sweep.abs_rms_pp.notna() & (sweep.decimation == 'mean')]
    panels = 3 if len(ctrl) else 2
    fig, axes = plt.subplots(1, panels, figsize=(4.0 * panels, 3.8))
    floor = 1e-5                                    # block-mean CC is exact to rounding; drawn at this floor
    for ax, col, name in zip(axes, ('ekf_max_pp', 'cc_max_pp'), ('(a) EKF', '(b) Coulomb counting')):
        for how, st in DECIMATION_STYLE.items():
            d = s[s.decimation == how]
            for _, x in d.groupby('run'):
                x = x.sort_values('rate_hz')
                ax.plot(x.rate_hz, np.maximum(x[col], floor), color=st['color'], ls=st['ls'], lw=0.6, alpha=0.4)
            w = d.groupby('rate_hz')[col].max()
            ax.plot(w.index, np.maximum(w, floor), lw=1.6, ms=4, label=f'{DECIMATION[how]} (worst run)', **st)
        ax.axhline(tol, color=INK, lw=0.8)
        ax.text(0.02, tol * 1.2, f'tolerance {tol} pp', fontsize=7.5, color=INK2, transform=ax.get_yaxis_transform())
        for x, lab in ((tau_rate, 'Δt = τ₁/10'), (nyq_rate, '15 % of Nyquist')):
            ax.axvline(x, color=AXIS, lw=1.2, ls=(0, (3, 2)))
            ax.text(x * 1.12, 0.6, lab, fontsize=7.5, color=INK2, rotation=90, transform=ax.get_xaxis_transform())
        ax.set(xscale='log', yscale='log', xlabel='Filter rate f_s (Hz)', ylim=(floor * 0.7, None),
               ylabel='max |ΔSoC| from the reference (pp)')
        ax.set_title(name, loc='left')
    axes[1].text(0.98, floor * 1.6, 'block mean: equal to rounding', ha='right', fontsize=7.5, color=INK2,
                 transform=axes[1].get_yaxis_transform())
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='lower center', ncol=3, bbox_to_anchor=(0.5, -0.01))
    if len(ctrl):
        ax = axes[2]
        for (run, x), mk in zip(ctrl.groupby('run'), 'oD'):
            x = x.sort_values('rate_hz')
            ax.plot(x.rate_hz, x.abs_rms_pp, color=INK, lw=1.2, marker=mk, ms=3.5, label=RUNS[run]['label'])
        ax.axvline(tau_rate, color=AXIS, lw=1.2, ls=(0, (3, 2)))
        ax.set(xscale='log', xlabel='Filter rate f_s (Hz)', ylabel='EKF RMS error vs characterization SoC (pp)')
        ax.set_title('(c) Controlled runs, block mean', loc='left')
        ax.legend(loc='center right', fontsize=7.5)
    suptitle(fig, title)
    fig.tight_layout(rect=(0, 0.06, 1, 1))
    return fig
