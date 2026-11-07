"""Shared settings for the *_patch calibration notebooks.

Pick the dataset with DATASET below, or set the CALIBRATION_DATASET environment variable before starting Jupyter.
"""
import os
from pathlib import Path

DATASET = os.environ.get("CALIBRATION_DATASET", "LiFePO4")

_HERE = Path(__file__).resolve().parent
_TEST_DATA = _HERE.parent.parent / "proa_advisor" / "model" / "battery_model" / "test_data"

DATASETS = {
    # Channels specified here due to wiring mismatches during testing
    "LiFePO4": {
        # 25 May 2026 capacity test, ~1 ms per row. ch0 and ch1 both measure the battery current (ch1 is wired the other way)
        "raw_data_dir": _TEST_DATA / "LiFePO4 Controlled Discharge" / "original",
        "current_channels": ("ch0", "ch1"),
        "voltage_channel": "ch6",
        "sample_period_s": 0.001,
        # The first reading (52.42 V) is lower than rests taken after 6 Ah and 11 Ah were drawn, so it is not a rested OCV
        "start_is_rested_ocv": False,
        # Off: the rest across the 31 min gap between 121722 and 130002 is one ~45 min rest. Its end-of-file reading
        # (52.37 V, ~12 min in) would contradict the neighbouring rests, so the reading at the next load (52.83 V) is kept
        "rest_end_at_previous_file": False,
        # Rest 0 (~84% SoC) spans the 31 min recording gap between files 121722 and 130002. The cleaner joins the files end
        # to end, so the relaxation curve jumps 52.37 -> 52.83 V mid-rest and the fit is poor (R-squared 0.91, tau2 at the bound)
        "rc_interval_drop": [0],
    },
    "LiNMC": {
        # Four sessions a week apart (18 Mar - 8 Apr 2026), 32 ms per row. After remap_linmc.js ch0 is unused (fixed at 0 A),
        # ch2 is the battery current and ch1 the load current on the same path. The 8 Apr session continues after the
        # 1 Apr BMS cutoff and is included in the capacity
        "raw_data_dir": _TEST_DATA / "LiNMC Controlled Discharge",
        "current_channels": ("ch2", "ch1"),
        "voltage_channel": "ch6",
        "sample_period_s": 0.032,
        "start_is_rested_ocv": True,
        # On: the sessions are a week apart. The last rest on 1 Apr (31 min, 46.73 V at 3.28%) otherwise only "ends" at the
        # first load on 8 Apr, so it was read after a week of rest (48.24 V), unlike the other 17-36 min rests
        "rest_end_at_previous_file": True,
        "rc_interval_drop": [],
    },
}

SETTINGS = DATASETS[DATASET]
OUTPUT_DIR = _HERE / f"{DATASET} Patch Output"
CUTOFF_VOLTAGE = 30  # Same as BATT_CUTOFF_VOLTAGE in kalman_filter.js. Data below it is after the BMS cutoff


def rows(seconds):
    """Convert a time window to a row count. The original notebooks counted rows, assuming ~1 ms per row."""
    return max(1, round(seconds / SETTINGS["sample_period_s"]))
