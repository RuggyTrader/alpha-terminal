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
LIVE = {**STRICT, "t1_news_allowed": False}   # live news rule unresolved: the stricter reading
CONFIGS = [   # (id, plan, size, choices per stage). Where MFFU is contradictory the stricter reading is used unless both are run.
    ("builder-50k", "builder", "50k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": {**LIVE, "lock_offset": 100.0}}),
    ("builder-50k-eodbreach", "builder", "50k", {"evaluation": {"breach_basis": "eod_equity"}, "sim_funded": {"breach_basis": "eod_equity"},
                                                  "live_hypothetical": {"breach_basis": "eod_equity", "t1_news_allowed": False, "lock_offset": 100.0}}),
    ("builder-50k-addon", "builder", "50k_addon", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": {**LIVE, "lock_offset": 100.0}}),
    ("builder-100k", "builder", "100k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": LIVE}),
    ("rapid-50k-evalEOD", "rapid", "50k", {"evaluation": {**STRICT, "drawdown_type": "eod_trailing"}, "sim_funded": {"max_minis": 2, "max_micros": 20},
                                           "live_hypothetical": LIVE}),
    ("rapid-50k-evalIntraday", "rapid", "50k", {"evaluation": {**STRICT, "drawdown_type": "intraday_trailing"}, "sim_funded": {"max_minis": 2, "max_micros": 20},
                                                "live_hypothetical": LIVE}),
    ("rapid-eod-50k", "rapid_eod", "50k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": LIVE}),
    ("rapid-eod-dll-50k", "rapid_eod_dll", "50k", {"evaluation": STRICT, "sim_funded": STRICT, "live_hypothetical": LIVE}),
    ("pro-50k", "pro", "50k", {"evaluation": STRICT, "sim_funded": {**STRICT, "max_micros": 3}, "live_hypothetical": LIVE}),
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


SYNTHETIC_MARKER = "SYNTHETIC-NOT-MARKET-DATA.txt"   # written by tests/synthetic_dbn.py next to a rehearsal cache
_W = {}   # per-process state: data, roll segments, runner (filled by _prepare; each worker process loads its own copy)


def _prepare(a):
    spec = INSTRUMENTS[a.root]
    news = NewsCalendar(None) if a.news == "none" else NewsCalendar.official(a.news)
    st = Settings()
    hold_start = None
    if a.csv:
        if not a.demo:
            sys.exit("a single CSV is only accepted with --demo (pipeline demonstration, not evidence)")
        from ote_engine.data import load_csv, to_bars
        bars = to_bars(load_csv(a.csv))
        tag, data_note, synthetic = "demo", f"DEMO ONLY: {os.path.basename(a.csv)} (one sample file; not genuine unadjusted multi-year data; not evidence)", False

        def runner(ex, ov):
            run(bars, st, ex, overlay=ov)
            return bars["t"][-1]
    else:
        from run_full import load_cache, run_period
        from ote_engine.rolls import front_schedule, segments
        synthetic = os.path.exists(os.path.join(a.cache, SYNTHETIC_MARKER))
        df = load_cache(a.cache, a.root)
        data_end = df["time"].max()
        hold_start = (data_end - pd.Timedelta(days=365)).normalize()
        segs = segments(front_schedule(df, a.root))
        lo, hi = (hold_start, data_end + pd.Timedelta(minutes=1)) if a.holdout else (df["time"].min(), hold_start)
        tag = "holdout" if a.holdout else "dev"
        data_note = (f"SYNTHETIC REHEARSAL FIXTURE (not market data, not evidence), {lo} to {hi}" if synthetic else
                     f"Databento GLBX.MDP3 ohlcv-1m {a.root}.FUT, unadjusted per contract, {lo} to {hi}")

        def runner(ex, ov):
            res, times = run_period(df, segs, lo, hi, st, ex, overlay=ov)
            return times[-1]
    _W.update(spec=spec, news=news, hold_start=hold_start, tag=tag, data_note=data_note, synthetic=synthetic, runner=runner)


def _job(cid, sc):
    """One pre-registered (config, scenario) run. Returns only plain data, so it can come back from a worker process."""
    cfg = next(c for c in CONFIGS if c[0] == cid)
    ov, rep = run_one(cfg, sc, _W["spec"], _W["runner"], _W["news"], _W["hold_start"])
    featured = dashboard.account_view(ov, rep) if (cid == "builder-50k" and sc == "C2_base") else None
    return f"{cid}__{sc}", rep, ov.trades, featured


def _init_worker(a):
    _prepare(a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--cache")
    ap.add_argument("--csv")
    ap.add_argument("--root", default="MNQ", choices=sorted(INSTRUMENTS))
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--news", default="union", choices=["union", "official", "mffu_image", "none"],
                    help="T1 calendar variant (mffu/t1_calendar.py). 'none' blocks every stage that prohibits T1 news")
    ap.add_argument("--configs", default="all")
    ap.add_argument("--scenarios", default=",".join(SCENARIOS))
    ap.add_argument("--jobs", type=int, default=1, help="worker processes (each loads its own copy of the data); results are identical to --jobs 1")
    a = ap.parse_args()
    if a.holdout:
        dev = os.path.join(a.out, "dev", "MFFU-SUMMARY.json")
        try:
            subprocess.run(["git", "ls-files", "--error-unmatch", dev], check=True, capture_output=True)
            subprocess.run(["git", "diff", "--quiet", "HEAD", "--", dev], check=True)
        except Exception:
            print("REFUSED: the holdout is sealed until dev/MFFU-SUMMARY.json is committed unchanged"); sys.exit(4)
    _prepare(a)
    if _W["synthetic"] and os.path.abspath(a.out).startswith(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"))):
        sys.exit("REFUSED: a synthetic rehearsal cache must not write under results/ (it is not evidence)")
    news, hold_start, tag, data_note = _W["news"], _W["hold_start"], _W["tag"], _W["data_note"]
    cfgs = CONFIGS if a.configs == "all" else [c for c in CONFIGS if c[0] in a.configs.split(",")]
    jobs = [(c[0], sc) for c in cfgs for sc in a.scenarios.split(",")]
    out = os.path.join(a.out, tag)
    os.makedirs(out, exist_ok=True)
    summary = {"label": "SIMULATED MFFU research accounts. Historical simulated results do not guarantee evaluation success.",
               "period": tag, "data": data_note, "synthetic": _W["synthetic"], "instrument": a.root, "strategy": "OTE + PD Array, Configuration A (locked), 1 contract",
               "news_calendar": news.source or "NONE (stages that prohibit T1 news are blocked)", "holdout_start": str(hold_start) if hold_start is not None else None,
               "preregistered_configs": [c[0] for c in CONFIGS], "scenarios": {s: COST_SCENARIOS[s].label for s in SCENARIOS}, "runs": {}}
    if a.jobs > 1 and len(jobs) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(a.jobs, len(jobs)), initializer=_init_worker, initargs=(a,)) as pool:
            results = list(pool.map(_job, *zip(*jobs)))
    else:
        results = [_job(cid, sc) for cid, sc in jobs]
    last = None
    for name, rep, trades, featured in results:   # written in the pre-registered order, whatever the worker count
        d = os.path.join(out, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "report.json"), "w") as f:
            json.dump(rep, f, indent=1, default=str)
        with open(os.path.join(d, "trades.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(trades[0].keys()) if trades else ["account"])
            w.writeheader(); w.writerows(trades)
        summary["runs"][name] = {k: v for k, v in rep.items() if k not in ("attempts",)}
        a_ = rep["all"]
        print(name, json.dumps({k: a_[k] for k in ["evaluation_attempts", "passed", "breached", "pass_rate_pct", "net_pnl_all_accounts", "simulated_payouts"]}))
        if featured is not None:
            last = featured
    with open(os.path.join(out, "MFFU-SUMMARY.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)
    snap = dashboard.snapshot(summary, last, data_note, demo=a.demo or _W["synthetic"])
    with open(os.path.join(out, "mffu-dashboard.json"), "w") as f:
        json.dump(snap, f, indent=1, default=str)
    print("wrote", out)


if __name__ == "__main__":
    main()
