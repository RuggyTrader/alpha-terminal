"""Pre-registered QuantConnect run boundaries for the MNQ research backtests.

Filled ONCE from the coverage backtest (its 'proposed' values), committed, then frozen. Development runs end before
HOLDOUT_START and never load holdout bars. The holdout refuses to run until the development results have been imported
(qc/qc_import.py), committed, and their SHA-256 written to DEV_RESULTS_SHA256 below.
"""
ROOT = "MNQ"                  # CME Micro E-mini Nasdaq-100 (first session 2019-05-06)
DATA_START = (2019, 5, 5)     # backtest start date: the first MNQ session opens on the evening of 2019-05-05
DATA_END = None               # "YYYY-MM-DD HH:MM" (ET): last minute bar seen by the coverage backtest
HOLDOUT_START = None          # "YYYY-MM-DD": DATA_END - 365 days at midnight ET (the same rule as the local reference)
DEV_RESULTS_SHA256 = None     # printed by qc_import.py for the committed development results
NEWS_VARIANT = "union"        # T1 calendar variant (mffu/t1_calendar.py): official releases plus MFFU's own 2026 list
