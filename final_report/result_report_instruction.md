Write the `\section{Results}` chapter of my Solar Proa II research report using the existing report, raw test data, calibration records, and analysis code. Preserve these subsections:

\subsection{Battery Characterization Result}
\subsection{Current Sensor Offset}
\subsection{SoC Estimates for Operational Test}
\subsection{SoC Behaviour During Rest}
\subsection{Sensitivity to Initial SoC}
\subsection{Effect of KCL Correction}

The study compares coulomb counting, voltage-based SoC estimation, an extended Kalman filter (EKF), and an EKF using KCL-based current correction. Two controlled battery discharge runs, one per battery bank, supplied battery-specific capacity estimates and short-rest voltage–SoC curves. Separate land-based operational runs contain charging, discharging, switching where recorded, and rest. The controlled discharge SoC labels were calculated from the study's current sensor. There is no independent continuous true-SoC reference and no vessel test.

First inspect the methodology, system diagram, sensor positions, sign conventions, actual data files, and implemented algorithms. Establish which battery, ADC configuration, calibration, switch state, and operating mode apply to each data interval. The ADS1115 was replaced with an ADS8688 during data collection; mark the change in relevant plots and check whether it introduces a measurement discontinuity. Do not assume either configuration is more accurate without evidence. Use the definitions and correction order actually implemented in the project.

Do not invent measurements, sample counts, calibration values, test conditions, results, citations, or figures. Do not manufacture a reference SoC by renaming an estimator's output. If required data are missing, leave a clearly identified placeholder and list the exact missing field or file. Keep numerical results in this chapter and reserve broader interpretation for the Discussion chapter. Provide the plotting and calculation code, figure-to-data mapping, and LaTeX figure/table references so the results can be reproduced.

General analysis rules:
- Analyse the main and spare battery banks separately. Use consistent SoC axes where this aids comparison.
- Apply all methods to the same timestamps and the same recorded test run. State any difference in preprocessing that is intrinsic to a method.
- Define zero-current rest using the relevant battery current, a documented zero-current tolerance, and the switch state. Exclude switching transients using a stated rule. A disconnected load does not establish battery rest if the MPPT is still charging it.
- Preserve gaps in recorded data; do not connect lines across missing periods or create smooth data that were not measured.
- Put units on axes and tables. In figure captions, identify the battery, test run, duration, operating conditions, number of analysed intervals, and any relevant ADC change.
- For summaries across rest periods, show individual observations as dots and report their count, median absolute value, and maximum absolute value. Also preserve signed values so opposite changes do not disappear in an average. Use a box plot only if there are enough comparable observations to make it informative.
- State findings quantitatively: identify the relevant figure, report the measured value or difference, and describe what it shows. Avoid unsupported words such as “accurate,” “superior,” or “significant.”

1. Battery Characterization Result

For each battery, report the defined starting and discharge endpoints, total measured charge throughput, calculated usable capacity, number of discharge steps, number and duration of rests, current range, and any missing or excluded data. Show how the <10 mV change over one minute rest criterion was met; call the resulting measurements short-rest voltages rather than equilibrium OCV.

Create a characterization figure with aligned current and terminal-voltage traces over the full discharge, shading discharge and rest periods. Mark any ADC change. Create a separate scatter plot of short-rest voltage against the sensor-derived characterization SoC for each battery, with the fitted curve overlaid. Show the measured points, not only the fitted equation. Report a suitable descriptive fit residual and identify irregular points; fitting the same points is not independent validation.

If estimator traces are plotted over the controlled discharge, label the coulomb-counted line “sensor-derived characterization SoC.” Any difference between another method and that line must be called a difference from the characterization estimate, not an absolute SoC error. Coulomb counting must not be scored against the labels it generated. The voltage mapping and EKF also use parameters obtained from these runs, so do not rank their accuracy using in-sample agreement.

2. Current Sensor Offset

Show the actual readings recorded under verified zero-current conditions, identified by sensor and time. Plot zero-current reading versus elapsed time, marking calibration events, ADC changes, and temperature only if temperature was recorded. Distinguish the observed zero offset from noise and from a demonstrated change in offset over time.

Report the offset before and after correction for each sensor and test period, with units. If supported by the data, calculate how an observed persistent offset would affect integrated charge over a specified duration and battery capacity. Do not attribute a change to temperature without temperature measurements and an appropriate comparison. State when no independent current reference was available.

3. SoC Estimates for Operational Test

Use the separate operational runs as the principal comparison. Create a time-aligned figure for each relevant battery/run with:
(a) measured battery, MPPT, and load currents that are available;
(b) battery terminal voltage;
(c) SoC estimates from the four methods; and
(d) clearly marked charging, discharging, verified rest, and switching intervals.
Use panels with a common time axis rather than putting quantities with different units on one axis.

Describe the starting SoC assumption for each method and how it was set. Report where the trajectories separate, the maximum and end-of-run pairwise differences where meaningful, and the operating states in which these occur. Label a difference from coulomb counting as “method disagreement,” not “error.” Explain in the caption or text when the voltage-based method applies a short-rest voltage curve to terminal voltage during current flow.

4. SoC Behaviour During Rest

For each verified zero-current interval j and method m, calculate:
\(\Delta\mathrm{SoC}_{m,j}
=\widehat{\mathrm{SoC}}_m(t_{\mathrm{end},j})
-\widehat{\mathrm{SoC}}_m(t_{\mathrm{start},j})\).
Use identical interval boundaries for all methods. Define the start after the recorded transition has ended and the end immediately before the next charging, loading, or switching event. Record each interval's duration and voltage change.

Separate rests following discharge from rests following charge. Provide one representative close-up of current, voltage, and SoC during each type if available. Show all rest-period \(\Delta\mathrm{SoC}\) observations as a paired dot plot grouped by method, battery, and preceding operating mode; accompany it with a compact summary table. A flat coulomb-counting trace is expected when corrected input current is zero. A change in EKF SoC during relaxation is an estimator update; neither flatness nor change alone establishes accuracy.

5. Sensitivity to Initial SoC

Replay the same operational run through each applicable stateful method from several explicitly stated initial SoC values. Do not retune its parameters between replays. Plot the resulting trajectories or the spread between initializations over time. Calculate spread *within each method* as the maximum minus minimum SoC across its initializations at each timestamp. If reporting a convergence time, define its spread threshold before calculating it and state when the threshold is never reached.

Coulomb counting has no measurement-based mechanism to remove an initial offset unless the implementation explicitly resets it. A direct voltage-mapping method may not have an initial-state parameter; mark it “not applicable” rather than forcing an initialization test. Convergence among EKF trajectories demonstrates reduced sensitivity to the starting guess, not convergence to known true SoC.

6. Effect of KCL Correction

Define the current-balance residual using the actual circuit junction, sensor directions, and switch configuration. State which branches were measured and whether any were omitted. Compare EKF and EKF + KCL on the same operational data with otherwise identical settings.

Plot the raw and corrected KCL residual over time, the correction applied to each measured current, and the difference between the two EKF SoC estimates. Mark switching events and exclude transient intervals according to the methodology. Summarize residual magnitude and SoC difference by battery and operating state. If the algorithm explicitly enforces current balance, acknowledge that a reduced corrected residual follows partly from the correction rule and does not independently prove that the corrected current is closer to the physical current. Report a small or absent effect directly if that is what the data show.

End the Results chapter with a short factual summary that answers what was observed for rest variation, initialization sensitivity, and KCL correction. Do not claim absolute SoC accuracy or performance at sea. Place supplementary full-run or per-rest plots in the appendix while keeping the principal evidence and numerical comparisons in the main report.