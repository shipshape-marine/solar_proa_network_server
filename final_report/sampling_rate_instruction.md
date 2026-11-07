Write the filter sampling-rate section of my Solar Proa II research report using the existing report, raw test data, identified battery models, firmware settings, and analysis code. The section sets the minimum rate at which the SoC filter must run and shows how that rate is calculated. Preserve these subsections:

\subsection{Criterion 1: Fast RC Time Constant}
\subsection{Criterion 2: Load-Current Bandwidth}
\subsection{Criterion 3: Rate-Sensitivity Sweep}
\subsection{Minimum Filter Rate}

The filter is the tuned EKF on the 2RC battery model, run alongside coulomb counting (CC). The data are the two controlled discharge runs (one per battery bank) and the separate land-based operational runs. There is no independent continuous true-SoC reference and no vessel test. The sweep therefore measures how much the filter changes with rate, not how close it is to true SoC.

First inspect the methodology, the identified 2RC tables, the implemented filter (discretization, noise scaling, voltage gate, gap handling), the server's sample-reduction window, and the logged `time_diff` of every run. Establish which battery, ADC (ADS1115 or ADS8688), logged rate, and operating mode apply to each run. Take the logged rate from the data, not from a datasheet or a stated scan rate. The firmware sets `SAMPLING_RATE 1200` per channel on the ADS8688; its benchmarks give 258 kSPS over 8 channels without serial output and 163 kSPS while streaming. Use the definitions and correction order actually implemented in the project.

Do not invent measurements, sample counts, time constants, rates, results, citations, or figures. Do not manufacture a reference SoC by renaming an estimator's output. If required data are missing, leave a clearly identified placeholder and list the exact missing field or file. Keep numerical results in this section and reserve broader interpretation for the Discussion chapter. Provide the plotting and calculation code (a manually run Python notebook calling `final_report/soc_eval.py`), the figure-to-data mapping, and LaTeX figure/table references so the results can be reproduced.

Sources (bibliography in `final_report/analysis/sampling_rate_section/references.bib`):
- `zhu2024asynchronous`: exact zero-order-hold discretization, Eqs. (9)–(10); Taylor-truncation convergence test, Fig. 4; rate sweeps, Fig. 10 and Fig. B2; down-sampling a 10 kHz record to test rates, §4.1.
- `smyth2007multirate`: keep frequencies of interest at or below about 15 % of Nyquist, §2.1 and Fig. 1; noise amplification in that range, §2.2; measurement noise R_d = R/T_a, Eq. (22); single-rate sweep, Table 2.
Both papers are from structural health monitoring. State that the section adopts their sampling methods, not their numerical results. The 15 % rule was derived for the third-order corrector, trapezoidal, Simpson's and Tick's integration rules; say it is adopted as a rule of thumb for the zero-order-hold (rectangular) integral used here.

General analysis rules:
- Analyse the two battery banks separately. Take the minimum rate as the strictest result over both.
- Apply every rate and decimation method to the same recorded run and the same filter settings. Do not retune between rates; scale the voltage noise as a density (R = r/Δt) and the process noise with Δt so the weighting per second is unchanged.
- Simulate lower rates only by grouping the logged samples of one high-rate record: assign samples to blocks by elapsed time within each session, take each block's Δt as the sum of its `time_diff`, and never let a block cross a session boundary or a recorded gap.
- Preserve gaps in recorded data; do not connect lines across missing periods or create smooth data that were not measured.
- Mark the ADC of each run in tables and captions. Do not assume either ADC configuration is more accurate without evidence.
- Put units on axes and tables. In figure captions, identify the battery, test run, logged rate, reference rate, swept rates, and any excluded records.
- State findings quantitatively: identify the relevant figure or table, report the measured value or difference, and describe what it shows. Avoid unsupported words such as "accurate," "superior," or "significant."
- Call a difference between a reduced-rate filter and the full-rate filter a "difference from the full-rate reference," not an error.

1. Criterion 1: Fast RC Time Constant

Read τ₁ = R₁C₁ from each battery's identified 2RC table and use its smallest value over SoC. Require Δt ≤ τ₁/10 and report the resulting rate for each battery. State that the filter propagates the RC voltages with the exact factor exp(−Δt/τ) under a zero-order hold, so the bound limits the hold error of the current within a step, not the propagation. Tabulate the per-step relative error of the first-order factor 1 − Δt/τ against the exact factor at several Δt/τ values as the comparison to the Taylor-truncation test of Zhu and Zhu.

2. Criterion 2: Load-Current Bandwidth

Estimate the highest significant current frequency f_I,max from the logged battery current of the operational runs. Use a Welch PSD over connected samples (battery voltage above the cutoff), switching included, and a noise floor from verified rests in which every measured current stays below a documented tolerance for a stated time. Define f_I,max as the frequency below which a stated share of the load-driven power (load-cycle PSD minus noise floor) lies, and state the segment length and resolution. Apply f_s ≥ f_I,max/0.075.

State that this rule applies when one sample stands for the whole step (point sampling). If each step averages the logged samples, the current integral is kept exactly and the criterion does not bound the rate. Report separately any run whose bandwidth is set by tonal components rather than load changes, give their rms amplitude, and state whether their source was identified. Compare the rate the rule would require with both the logged rate and the hardware capacity; cite the ADC hardware details to the ADC selection section rather than repeating them.

3. Criterion 3: Rate-Sensitivity Sweep

Run the same tuned EKF and CC on each recording reduced to a stated list of rates. The reference is the same filter on the block mean of the server's window (10 logged samples); where the logged rate is too slow for that, use the logged samples and say so. Compare three ways of reducing a block to one value:
- block mean: voltage averaged over connected samples only; current as the block's connected charge divided by its length;
- block median: as the server's window;
- point sample: the first logged sample, held over the step.

Average only samples above the voltage cutoff, so that a logger dropout (0 V samples) cannot produce a false voltage above the cutoff. Fix the tolerance before scoring and state it. For each run, rate and method, report the maximum, RMS and end-of-run SoC difference from the reference, and the maximum CC difference, in percentage points.

Scoring rules, each stated with the number of records it affects:
- Controlled runs are scored only over the SoC range and sessions used to fit the model; the BMS cut-off and the first update lie outside it.
- Records within a stated window of a discrete filter event in the reference (a step larger than the tolerance, such as a voltage gate switching on) are excluded from the maximum, because the same event shifted by one step is timing, not SoC. Report how many records this removes on each run.
- On controlled runs, also report the RMS difference from the sensor-derived characterization SoC at each rate, labelled as a difference from the characterization estimate, not an absolute error. The filter's parameters come from these runs, so this is in-sample agreement and must not rank methods.

Create a figure of the worst-run maximum difference against rate for each method, with the tolerance and the criterion 1 and criterion 2 rates marked, and a figure of the current PSDs. The minimum sweep rate for a method is the lowest swept rate at which every run stays within tolerance at that rate and at every higher one. If a method never meets the tolerance, report that directly with its smallest difference.

4. Minimum Filter Rate

Combine the three criteria in one table and state the minimum filter rate and step, the criterion that sets it, and the reduction method it assumes. State that the minimum is per channel: each channel the filter reads must deliver an averaged value at that rate, and a multiplexed ADC's total rate is the per-channel rate times the number of channels scanned. Distinguish the filter rate from the ADC rate needed to form the averages, and state that only the logged rate was tested for the latter.

Report the implemented rates (server window on the ADS8688; the ADS1115 run) as multiples of the minimum. Report the median-versus-mean charge difference of the server's window at its operating rate. Fill in the methodology paragraph with these values and cite the sources above.

End the section with a short factual summary of the minimum rate, the criterion that sets it, and the margin of the implemented rates. Do not claim absolute SoC accuracy or performance at sea. Place per-run sweep tables and plots in the appendix while keeping the combined minimum-rate table and the sweep figure in the main report.
