"""Historical evaluation of the locked OTE strategy (Configuration A, 1 contract) against virtual MFFU accounts.

  python run_mffu.py --cache <databento cache> <out>              development period (everything before the last 12 months)
  python run_mffu.py --cache <databento cache> <out> --holdout    last 12 months; refused until <out>/dev/MFFU-SUMMARY.json is committed
  python run_mffu.py --csv <1m csv> <out> --demo                  pipeline demonstration on a sample file (NOT evidence)

The plan variants and cost scenarios below are fixed before any result is seen (PRE-REGISTERED). They are never tuned on
these results; no strategy input is changed. Every attempt, passed or failed, is written out.
"""
import argparse
import csv
import json
import os
import subprocess
import sys

import pandas as pd

from ote_engine.strategy import Settings, Execution, run
from mffu.evaluate import MffuOverlay
from mffu.instruments import COST_SCENARIOS, INSTRUMENTS
from mffu.calendar import NewsCalendar
from mffu import dashboard

STRICT = {"breach_basis": "intraday_equity"}
CONFIGS = [   # (id, plan, size, choices per stage). Where MFFU is contradictory the stricter reading is used unless both are run.
    ("builder-50k", "builder", "50k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": {**STRICT, "lock_offset": 100.0}}),
    ("builder-50k-eodbreach", "builder", "50k", {"evaluation": {"breach_basis": "eod_equity"}, "sim_funded": {"breach_basis": "eod_equity"},
                                                  "live_hypothetical": {"breach_basis": "eod_equity", "lock_offset": 100.0}}),
    ("builder-50k-addon", "builder", "50k_addon", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": {**STRICT, "lock_offset": 100.0}}),
    ("builder-100k", "builder", "100k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": STRICT}),
    ("rapid-50k-evalEOD", "rapid", "50k", {"evaluation": {**STRICT, "drawdown_type": "eod_trailing"}, "sim_funded": {"max_minis": 2, "max_micros": 20}}),
    ("rapid-50k-evalIntraday", "rapid", "50k", {"evaluation": {**STRICT, "drawdown_type": "intraday_trailing"}, "sim_funded": {"max_minis": 2, "max_micros": 20}}),
    ("rapid-eod-50k", "rapid_eod", "50k", {"evaluation": STRICT, "sim_funded": STRICT}),
    ("pro-50k", "pro", "50k", {"evaluation": STRICT, "sim_funded": {**STRICT, "max_micros": 3}, "live_hypothetical": STRICT}),
    ("pro-50k-one-day", "pro", "50k_one_day", {"evaluation": STRICT}),
]
SCENARIOS = ["C2_base", "C3_conservative", "C4_stress", "C1_optimistic"]


def execution_for(sc, spec):
    s = COST_SCENARIOS[sc]
    return Execution(name=sc, path=s.path, sizing="fixed1", tick=spec.tick, point_value=spec.multiplier, commission_per_side=s.commission_per_side,
                     stop_slip_ticks=s.stop_slip_ticks, limit_through_ticks=s.limit_through_ticks)


def run_one(cfg, sc, spec, runner, news, hold_start):
    cid, plan, size, choices = cfg
    ov = MffuOverlay(plan, size, choices, COST_SCENARIOS[sc], spec, news, label=cid)
    t_last = runner(execution_for(sc, spec), ov)
    ov.finish(t_last)
    return ov, ov.report(hold_start.date() if hold_start is not None else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--cache")
    ap.add_argument("--csv")
    ap.add_argument("--root", default="MNQ", choices=sorted(INSTRUMENTS))
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--news-csv", help="T1 calendar CSV (time_et,event); without it, stages that prohibit T1 news cannot trade")
    ap.add_argument("--configs", default="all")
    ap.add_argument("--scenarios", default=",".join(SCENARIOS))
    a = ap.parse_args()
    spec = INSTRUMENTS[a.root]
    news = NewsCalendar.from_csv(a.news_csv) if a.news_csv else NewsCalendar(None)
    st = Settings()
    hold_start = None
    if a.csv:
        if not a.demo:
            sys.exit("a single CSV is only accepted with --demo (pipeline demonstration, not evidence)")
        from ote_engine.data import load_csv, to_bars
        df = load_csv(a.csv)
        bars = to_bars(df)
        tag, data_note = "demo", f"DEMO ONLY: {os.path.basename(a.csv)} (one sample file; not genuine unadjusted multi-year data; not evidence)"

        def runner(ex, ov):
            run(bars, st, ex, overlay=ov)
            return bars["t"][-1]
    else:
        from run_full import load_cache, run_period
        from ote_engine.rolls import front_schedule, segments
        df = load_cache(a.cache, a.root)
        data_end = df["time"].max()
        hold_start = (data_end - pd.Timedelta(days=365)).normalize()
        if a.holdout:
            dev = os.path.join(a.out, "dev", "MFFU-SUMMARY.json")
            try:
                subprocess.run(["git", "ls-files", "--error-unmatch", dev], check=True, capture_output=True)
                subprocess.run(["git", "diff", "--quiet", "HEAD", "--", dev], check=True)
            except Exception:
                print("REFUSED: the holdout is sealed until dev/MFFU-SUMMARY.json is committed unchanged"); sys.exit(4)
        segs = segments(front_schedule(df, a.root))
        lo, hi = (hold_start, data_end + pd.Timedelta(minutes=1)) if a.holdout else (df["time"].min(), hold_start)
        tag = "holdout" if a.holdout else "dev"
        data_note = f"Databento GLBX.MDP3 ohlcv-1m {a.root}.FUT, unadjusted per contract, {lo} to {hi}"

        def runner(ex, ov):
            res, times = run_period(df, segs, lo, hi, st, ex, overlay=ov)
            return times[-1]
    cfgs = CONFIGS if a.configs == "all" else [c for c in CONFIGS if c[0] in a.configs.split(",")]
    out = os.path.join(a.out, tag)
    os.makedirs(out, exist_ok=True)
    summary = {"label": "SIMULATED MFFU research accounts. Historical simulated results do not guarantee evaluation success.",
               "period": tag, "data": data_note, "instrument": a.root, "strategy": "OTE + PD Array, Configuration A (locked), 1 contract",
               "news_calendar": news.source or "NONE (stages that prohibit T1 news are blocked)", "holdout_start": str(hold_start) if hold_start is not None else None,
               "preregistered_configs": [c[0] for c in CONFIGS], "scenarios": {s: COST_SCENARIOS[s].label for s in SCENARIOS}, "runs": {}}
    last = None
    for cfg in cfgs:
        for sc in a.scenarios.split(","):
            ov, rep = run_one(cfg, sc, spec, runner, news, hold_start)
            name = f"{cfg[0]}__{sc}"
            d = os.path.join(out, name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "report.json"), "w") as f:
                json.dump(rep, f, indent=1, default=str)
            with open(os.path.join(d, "trades.csv"), "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(ov.trades[0].keys()) if ov.trades else ["account"])
                w.writeheader(); w.writerows(ov.trades)
            summary["runs"][name] = {k: v for k, v in rep.items() if k not in ("attempts",)}
            a_ = rep["all"]
            print(name, json.dumps({k: a_[k] for k in ["evaluation_attempts", "passed", "breached", "pass_rate_pct", "net_pnl_all_accounts", "simulated_payouts"]}))
            if cfg[0] == "builder-50k" and sc == "C2_base":
                last = (ov, rep)
    with open(os.path.join(out, "MFFU-SUMMARY.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)
    snap = dashboard.snapshot(summary, last, data_note, demo=a.demo)
    with open(os.path.join(out, "mffu-dashboard.json"), "w") as f:
        json.dump(snap, f, indent=1, default=str)
    print("wrote", out)


if __name__ == "__main__":
    main()
