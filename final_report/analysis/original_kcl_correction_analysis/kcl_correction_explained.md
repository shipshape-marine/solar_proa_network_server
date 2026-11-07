# Current-sensor correction (KCL): what went wrong and what replaced it

This note answers three questions:

1. What was wrong with the server's current-sensor corrector (`kcl_corrector.js`)?
2. What does the offset-only replacement (**K3**) do?
3. What does the gated version (**K3k**) add, and why is it judged harmful?

**Outcome.** Offset correction becomes a separate, default step on the current used by coulomb counting and the EKF. The KCL balance update stays in the report as an evaluated method ("EKF + KCL"), and is concluded to be harmful as a corrector (Section 5).

Every number comes from re-running the correctors on the recorded test data with a Python replica of the server code. With the original settings, the replica reproduces the server's output exactly.

## Terms

- **KCL (Kirchhoff's current law).** Every amp the load draws comes from the MPPT or a battery: load = MPPT + battery 1 + battery 2. Battery current is positive when discharging.
- **Residual.** load − MPPT − battery 1 − battery 2. It is zero if every sensor is perfect.
- **Offset.** What a sensor reads when the true current is zero.
- **Bias estimate.** The corrector's estimate of a sensor's error. Corrected current = reading − bias estimate.
- **Active / idle.** A channel is active when its reading is above a threshold, and idle otherwise.
- **pp.** Percentage points of SoC.
- **EKF RMS error.** The RMS difference between the EKF's SoC and the characterization SoC on the LiNMC controlled run, over 3.4–92% SoC, excluding the 8 Apr session. The EKF starts from the characterization SoC, as in `controlled_evaluation.ipynb` (Appendix C there reproduces the original-settings numbers).

Runs used:

| Run | What it is | Why it matters here |
|---|---|---|
| LiNMC controlled discharge (`LiNMC Controlled Discharge`, Mar–Apr 2026) | Stepped discharge with rests | Battery and load sensors measure the same current; MPPT idle |
| LiFePO4 capacity test (`LiFePO4 Controlled Discharge`, 25 May 2026) | Clean full discharge | Clean data: a good corrector should change little |
| General Discharge Tests 1 and 2 | Operational, LiNMC | Short runs with MPPT charging |
| LiNMC General Test (29 Jun) | Operational, LiNMC | Contains a 26-minute MPPT sign error, introduced by the server's flip handling (Section 2.7) |

## Short answers

- **The original corrector** tries to find four sensor errors from one equation per sample: "the residual is zero". One equation cannot say which sensor is wrong, and several implementation details make this worse. On the LiNMC controlled run it moved the battery's charge total outside the range of both sensors, and it made the EKF worse: RMS error 1.25 pp, against 0.57 pp with no correction at all.
- **Offsets only (K3)** stops using the KCL equation. It learns each sensor's zero offset only while that sensor is idle, where the true current is known to be zero. Each offset is then measured on its own. The learned offsets match the rest readings on every run, and the 29 Jun MPPT sign error does not affect them. It is now the default input step for coulomb counting and the EKF.
- **Gated KCL (K3k)** is K3 plus the KCL equation while current flows, with a gate that rejects spikes. On clean data its EKF results match K3 to within 0.03 pp. But it brings back the original weakness: while current flows, the settings decide which sensor gets blamed, not the data. A sustained error on one channel also gets through the gate. On the 29 Jun run it credited the battery with 2.46 Ah of charge, against 3.11 Ah for K3, and it blamed the battery sensor for an error on the MPPT channel. **Conclusion: the KCL balance update is harmful as a corrector** (evidence in Section 5). The KCL residual is still useful, as a fault detector.

## 1. What the original corrector does

`kcl_corrector.js` is a small Kalman filter, configured from `kalman_filter.js`:

- **State.** Four bias estimates (load, MPPT, battery 1, battery 2), each allowed to drift as a random walk.
- **Measurement.** One per sample: the residual of the corrected currents should be zero.
- **Active channels.** Load active if its reading > 0.05 A, MPPT if > 0.05 A, a battery if |reading| > 0.05 A. Inactive channels get no process noise, take no part in the update, and are output as 0 A.
- **Settings:**
  - Measurement noise R = `sigma_kcl` from `battery_constants.json`: 0.034 for LiNMC, 0.057 for LiFePO4.
  - Process noise 1e-12 A²/s for load and MPPT, 1e-18 A²/s for the batteries.
  - Starting variance 1e-4 A² for load and MPPT, 1e-5 A² for the batteries.
- **Guard.** If the corrected residual is greater than the raw residual, the raw currents are output instead. The filter's internal bias estimates are kept.
- The corrected battery current is what the battery EKF integrates.

## 2. What went wrong

### 2.1 One equation cannot say which sensor is wrong

In the controlled tests, the battery and load sensors measure the same current and the MPPT is idle. The residual then shows only the difference between their two errors. A shared error, where both read 0.5 A high, leaves the residual unchanged, so the data cannot pin it down.

That is what happened. On the LiNMC controlled run the internal bias estimates ended at +1.53 A (load) and +0.93 A (battery). Their difference, 0.60 A, is close to the typical residual under load (about 0.55–0.6 A). Their shared level is not supported by any measurement. During rests, the true current is zero, and the sensors read only −0.17 to −0.09 A (battery) and −0.05 to +0.07 A (load).

On the LiFePO4 capacity test the same drift reached +5.3 A (load) and +4.0 A (battery).

![Estimated sensor bias on the LiNMC controlled run](figures/kcl_bias_controlled.png)

*Figure 1. LiNMC controlled discharge. Black dots: each sensor's reading during each rest, where the true current is about zero. The repo corrector (orange) drifts away from them. Offsets only (blue) passes through every dot. Offsets + gated KCL (green) follows the dots at rest and steps away from them during each discharge step (Section 4). Dashed lines: session breaks.*

### 2.2 The guard compares signed values, not sizes

The guard reverts when `correctedKcl > rawKcl`. If the raw residual is −0.3 A, any correction that brings it closer to zero (say −0.1 A) counts as "greater" and is thrown away. If the raw residual is positive, an overshoot to a large negative value is kept. The guard therefore discards useful corrections and keeps harmful ones.

It reverted on:

- 59% of samples on the LiNMC controlled run;
- 54% on the LiFePO4 capacity test;
- 61% on the 29 Jun run;
- 100% on General Discharge Tests 1 and 2, where the corrector therefore did nothing.

The output also jumps between raw and corrected values from one sample to the next.

### 2.3 The residual and the update disagree about inactive channels

The residual uses every channel's raw reading, including inactive ones. But an inactive channel's bias is never updated. So an idle sensor's offset sits in the residual, and the filter can only explain it by shifting the other sensors' biases.

The activity test also treats channels differently. Load and MPPT are tested on their signed reading, the batteries on the magnitude. A load sensor with a negative offset therefore always counts as inactive. On 12 Jun (General Discharge Test 1) the load sensor read −0.22 A while switched off. Only the MPPT and battery biases can explain that offset, so it is pushed into them.

### 2.4 The 0.05 A threshold sits inside the idle noise

At rest the load sensor reads between −0.05 and +0.07 A. With a 0.05 A threshold it flipped between active and inactive on 15% of idle samples, and each flip changes the equation the filter is solving. During rests, the corrected battery current was −0.27 A, against −0.16 A raw. The correction made the rest reading worse.

### 2.5 The noise settings do not describe the sensors

- `sigma_kcl` is a standard deviation (in A), but it is used as a variance (in A²). The server's own log line prints it in A².
- R is applied per sample. On the 29 Jun run the filter sees about 115 samples per second, so the total weight given to the KCL equation depends on the logging rate.
- Process noise of 1e-12 A²/s allows about 0.2 mA of drift over 8 hours, and 1e-18 effectively none. Starting variances of 1e-4 and 1e-5 A² mean "within about ±10 mA and ±3 mA".
- The real offsets are 0.04–0.22 A, and they move. The battery sensor's rest reading went from −0.17 to −0.09 A over the LiNMC controlled test (Figure 1). In the 29 Jun run, its reading with load and MPPT off went from about 0 to +0.5 A.

The filter is told that offsets are tiny and fixed. Over millions of samples it still adds up whatever the residual contains, including the things in 2.6–2.8 that are not offsets.

### 2.6 Spikes move the biases

Switching events and the BMS cutoff produce residuals of 10 A or more for short moments. Nothing rejects them, so each spike shifts the bias estimates.

### 2.7 A sustained channel error moves them further

From 0.98 h to 1.42 h of the 29 Jun run, the MPPT current fed to the corrector is negative (median −2 A) while the battery charges. The residual stays near 3.9 A (median) for 26 minutes.

The sensor is not at fault. The recorded MPPT current is positive throughout. The error comes from the server's flip handling in `kalman_filter.js`:

- In `detectAndCorrectFlips`, a single raw sample below −5 A sets `is_mppt_flipped`.
- From then on, every MPPT reading is negated (line 117), for as long as the server runs.

In this run, one sample of −10.24 A at 0.93 h set the flag; the samples on either side read about 0 A. The reversal shows from 0.98 h, when the MPPT starts delivering current. The correctors see the stream exactly as the server produced it.

The repo corrector absorbed the error into its biases: +4.5 A on the MPPT and −6.0 A on the battery (Figure 2, orange). The corrected battery charge for the run was 1.40 Ah, against 2.85 Ah raw.

### 2.8 A bias cannot represent a gain error

Under load, the load sensor reads about 2% more than the battery sensor (about 0.6 A at 28 A). Over the controlled run the load sensor totals 72.34 Ah against 69.84 Ah for the battery sensor. Offsets explain part of that gap; the rest grows with current. An error that grows with current is not an offset. A bias-only model absorbs it under load, and the result is then wrong at rest.

### 2.9 Net effect

On the LiNMC controlled run:

| | No correction | Repo corrector |
|---|---|---|
| Battery charge total (Ah) | 69.84 | 67.76 |
| Coulomb counting error at end of discharge (pp) | +2.2 | +5.1 |
| EKF RMS error, original EKF settings (pp) | 0.57 | 1.25 |

The corrected total, 67.76 Ah, is below both sensors (battery 69.84 Ah, load 72.34 Ah). At rest the battery sensor reads 0.09–0.17 A low and the load sensor about zero, so the true total should be at or above the battery sensor's 69.84 Ah, not below it.

### 2.10 Changing values alone made it worse

- Larger noise values, a larger threshold and a larger starting variance (values only) sent the biases to 69 A on the controlled run.
- A 0.3 A threshold on its own still let the biases reach 43 A on the LiFePO4 capacity test.
- Fixing the guard and the inactive-channel mismatch (logic) still let them drift to 10–13 A.
- Adding a spike gate on top kept them at about 0.5 A or less on clean data. But it still had only one equation, so it still could not say which sensor was wrong.

The problem is what the filter measures, not how it is tuned.

## 3. Offsets only (K3)

**Idea.** An idle sensor's true current is zero, so whatever it reads is its offset. That gives one measurement per idle sensor, and each measurement involves only that sensor's own bias. Each offset is then measured on its own, which fixes 2.1.

**Rules:**

- **Load and MPPT** count as idle when their own reading has stayed below 0.3 A for at least 10 s.
- **A battery** counts as idle when, for at least 10 s:
  - load and MPPT are both idle;
  - its own reading is below 1 A;
  - the voltage is above the cutoff. Below the cutoff the server sets battery current to zero, so a zero there is not a measurement.

  With load and MPPT off, KCL says the battery current is zero, so up to 1 A of reading is treated as offset.
- **The update.** While a sensor is idle: bias ← bias + K × (reading − bias). The noise is R_idle = 1e-3 A²·s ÷ dt, so the weight per second does not depend on the logging rate.
- **Process noise** of 1e-7 A²/s on every channel at all times, so an offset can be learned again at every idle period. This gives a time constant of about 100 s (√(R_idle/q)).
- **No KCL update.** The residual is still computed, as a diagnostic.
- **Output.** While a channel is active (above 0.3 A), corrected = reading − bias. Below 0.3 A it is output as 0 A, as the original does below 0.05 A. The signed guard is removed.

**Results:**

- The learned offsets match the rest readings (Figure 1: the blue line passes through every dot):
  - LiNMC controlled: battery −0.17 → −0.10 A, load −0.05 to +0.06 A.
  - LiFePO4 capacity test: −0.04 A on both, against rest readings of −0.04 A (battery) and −0.06 A (load).
- **LiNMC controlled run.** The battery charge total is 71.19 Ah. That lies between the two sensors and within 0.1 Ah of their average (71.09 Ah), even though K3 never uses the load sensor while current flows. The coulomb counting error at end of discharge is +0.3 pp (+2.2 raw). The EKF RMS error is 0.17 pp with the original EKF settings (0.57 raw), and 0.25 pp with the tuned EKF (0.62 raw).
- **Clean data stays clean.** The LiFePO4 battery charge total moves from 37.00 to 37.09 Ah.
- **The 29 Jun MPPT sign error has no effect.** The MPPT bias stays at 0 throughout (Figure 2, blue), and the battery bias does not move during the error, because the battery is not idle then.

**Limits:**

- A real current below the idle thresholds is treated as offset. That covers a load below 0.3 A, or a draw under 1 A that bypasses the load sensor, such as a logger powered straight from the battery. Two operational runs show this:
  - **29 Jun.** For about 2 minutes the battery sensor reads +0.53 A with the load and MPPT off. At the other rests it reads about 0 A. K3 learned the +0.53 A as offset, adding 0.25 Ah (0.35 pp) of charge to the run. It is not clear that this is wrong:
    - During charging, the MPPT sensor reports about 0.3 A more current than the battery sensor.
    - The EKF's voltage predictions fit better with the extra charge: 15.0 mV RMS, against 17.7 mV without it.

    So the battery sensor may under-read charge that day. A battery idle threshold of 0.3 A would stop the offset being learned, and would change nothing on the other runs. The data cannot say which is right, so the threshold stays at 1 A.
  - **12 Jun.** In quiet periods the MPPT reads +0.05 to +0.15 A and the battery −0.14 to −0.16 A, so they cancel to within 0.04 A. On 22 and 29 Jun the same battery sensor reads about 0 A at rest. This points to a real trickle charge, not two offsets. K3 removes it: about 0.05–0.1 Ah per run, under 0.15 pp.
- Battery currents below 0.3 A are output as zero.
- It corrects offsets only. The 2% gain difference remains.
- Drift during a long active period is corrected only at the next idle period.

**In the report** this is not one of the compared methods. It is the default input step: coulomb counting, the EKF and EKF + KCL all integrate the offset-corrected battery current. A separate table compares raw and offset-corrected input, so the offsets' effect is shown on its own and is not credited to any method.

## 4. Offsets + gated KCL (K3k)

**What it adds.** K3k is K3 plus the KCL equation while current flows, with three changes from the original:

- The residual uses only active channels, matching the update (fixes 2.3).
- R = 2.5e-3 A²·s ÷ dt, scaled by the logging rate like R_idle.
- A 4σ gate skips any sample whose residual is larger than 4 times its expected spread. At the 29 Jun logging rate that is about 2.1 A. This rejects switching spikes (2.6).

The idle updates are the same as in K3. There is no signed guard.

**On clean data it is as good as K3, and no better:**

| LiNMC controlled run | K3 | K3k |
|---|---|---|
| EKF RMS error, original EKF settings (pp) | 0.17 | 0.17 |
| EKF RMS error, tuned EKF (pp) | 0.25 | 0.25 |
| Battery charge total (Ah) | 71.19 | 71.28 |
| Coulomb counting error at end of discharge (pp) | +0.3 | +0.2 |

**Issues:**

1. **It is still one equation.** While current flows, K3k splits the residual between the active sensors in proportion to their current uncertainty. That uncertainty comes from the noise settings and from how long ago each sensor was last idle, not from the data. In Figure 1, the green lines step apart during every discharge step (battery bias down about 0.1 A, load bias up about 0.1 A) and snap back at the next rest. The controlled run cannot show whether that split is right: the characterization SoC is built from the average of the two sensors, so an even split lands close to it by construction.
2. **A lasting error is not a spike.** The gate rejects residuals above about 2.1 A, but during the 29 Jun error the residual ranges from 0.2 to 8 A (5th to 95th percentile), and 33% of its samples are under 2 A. Those samples pass the gate, and each one moves the biases toward explaining the error. The next residuals shrink, so more samples pass. The biases reached −2.6 A on the battery and +0.6 A on the MPPT (Figure 2, green), so most of the blame went to the battery sensor, although the error was on the MPPT channel (issue 1 again). The effects:
   - Over the run, the battery is credited with 2.46 Ah of charge, against 3.11 Ah for K3 (2.85 Ah raw).
   - With the tuned EKF, EKF + KCL ends 0.51 pp below the EKF. With the MPPT sign as recorded it ends 0.06 pp above.
   - The voltage prediction error of EKF + KCL rises to 23.0 mV RMS, against 14.5 mV with the sign as recorded. The EKF alone stays at 15.0 mV in both cases.

   These numbers are reproduced by `operational_evaluation.ipynb`, Section 2.8.

   The biases recover at the next idle period (1.42 h). The SoC lost during the error stays lost.
3. **The gain difference is absorbed as offset.** Under load, the 2% gain difference shows up as a residual. The KCL update treats it as offset, and the idle update pulls it back at rest. The biases therefore move with the load level, which is the stepping in Figure 1.
4. **The benefit is small.** On clean data the EKF results of K3 and K3k differ by at most 0.03 pp of SoC. Coulomb counting at end of discharge is 0.13 pp closer with K3k. But the characterization SoC is built from the sensor average, and an even split moves toward that average by construction (issue 1).

![Estimated sensor bias around the 29 Jun MPPT sign error](figures/kcl_bias_mppt_fault.png)

*Figure 2. LiNMC General Test, 29 Jun. Top: the currents as the server passes them to the corrector, with a rolling median over about 3.5 s for readability. Shaded: the MPPT sign error introduced by the server's flip latch (the recorded MPPT current is positive). Middle and bottom: the MPPT and battery bias estimates. Offsets only (blue) ignores the error. Gated KCL (green) takes in part of it and blames mostly the battery sensor. The repo corrector (orange) takes in all of it.*

## 5. Conclusion: the KCL balance update is harmful

In every version tested, the balance update never improved SoC by a measurable amount. Every version made SoC worse when one current channel was wrong.

| Evidence | Run | Without the balance update | With it |
|---|---|---|---|
| EKF RMS error, original EKF settings | LiNMC controlled | 0.57 pp (raw current) | 1.25 pp (repo corrector) |
| Coulomb counting error at end of discharge | LiNMC controlled | +2.2 pp (raw) | +5.1 pp (repo) |
| Battery charge total | LiNMC controlled | 69.84 Ah (raw) | 67.76 Ah (repo), below both sensors |
| Largest bias estimate | LiFePO4 capacity test | 0.10 A (K3) | 5.3 A (repo) |
| Largest bias estimate | 29 Jun, MPPT sign error | 0.51 A (K3) | 6.0 A (repo), 2.6 A (K3k) |
| Battery charge over the run | 29 Jun | 3.11 Ah (K3); 2.85 Ah raw | 1.40 Ah (repo), 2.46 Ah (K3k) |
| EKF + KCL minus EKF at end, tuned EKF | 29 Jun | +0.06 pp (MPPT sign as recorded) | −0.51 pp (as the server processed it) |
| Voltage prediction error RMS, tuned EKF | 29 Jun | 15.0 mV (EKF) | 23.0 mV (EKF + KCL) |
| Minutes with a per-minute residual above 2 A | 29 Jun | 0 (sign as recorded) | 18 (as the server processed it) |
| EKF RMS error (original / tuned EKF) | LiNMC controlled | 0.17 / 0.25 pp (K3) | 0.17 / 0.25 pp (K3k): no gain |
| Battery charge, change from K3 | General Discharge Tests 1 and 2, LiFePO4 capacity test | – | about 0.04 Ah each (about 0.1 pp or less); which is closer to the truth cannot be checked |

**Why this is structural, not a tuning problem:**

- **One equation, several sensors.** The data cannot say which sensor is wrong. While current flows, the split comes from the settings. In the 29 Jun run, most of the blame went to the battery sensor although the error was on the MPPT channel.
- **A sustained error is not an outlier.** No gate can tell a 26-minute error from a real offset change, because both look like a lasting residual.
- **Its only measurable effect on clean data is balancing the currents.** On General Discharge Tests 1 and 2 the residual spread was 0.03 A with K3k, against 0.05–0.15 A with offsets only. That is what the update is built to do, and it says nothing about which sensor is right.
- **Retuning did not fix it** (Section 2.10). Values-only changes, logic fixes and a spike gate each either drifted or misattributed the error.

**What KCL is still good for: fault detection.** During the 29 Jun error, the per-minute median residual was 3.8 A on average and never below 1.4 A. Outside it, the residual never went above 1.7 A on any run (0.9 A on the controlled run). A flag on a sustained residual above about 2 A would have caught the error the server's own flip handling introduced, with no false alarms on these runs. It would catch sensor faults the same way. More data is needed to set the threshold.

**How the report and the server use this:**

- **Report.**
  - Offset correction is the default input for coulomb counting, the EKF and EKF + KCL.
  - EKF + KCL (K3k) is evaluated on every run, so this evidence can be checked on all of them.
  - Operational runs are evaluated after the audit's corrections. The 29 Jun run is evaluated with the MPPT sign as recorded (flip latch disabled), and also as the server processed it, which is the evidence above.
- **Server (later, when asked).**
  - Offset correction and the KCL corrector become separate toggles: offsets on by default, KCL off by default, with a note in the code that it is harmful and a pointer to this document.
  - The MPPT flip latch must be fixed. Today one raw sample below −5 A negates every later MPPT reading. It should require a sustained reversal (for example, on the median stream for several seconds) and should not stay latched for the rest of the run.

## 6. What changed: values or logic

| Change | Values or logic |
|---|---|
| Activity threshold 0.05 → 0.3 A | Values |
| Process noise 1e-12 / 1e-18 → 1e-7 A²/s | Values |
| R for the KCL equation: `sigma_kcl` per sample → 2.5e-3 A²·s ÷ dt | Values, plus a rate-scaling formula (logic) |
| Starting variance | Unchanged (1e-4 / 1e-5 A²) |
| Process noise on every channel, not only active ones | Logic |
| Zero-current updates for idle sensors (with the 10 s, 0.3 A, 1 A and cutoff-voltage rules) | Logic |
| Residual uses only active channels | Logic |
| Signed guard removed | Logic |
| K3: KCL update turned off | Logic |
| Offset-corrected current used by coulomb counting and the EKF, as a step separate from the KCL corrector | Logic |
| K3k: 4σ gate on the KCL update | Logic |

Nothing has been ported to the server yet.
