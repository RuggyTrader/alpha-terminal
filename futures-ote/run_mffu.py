"""Local PIPELINE DEMONSTRATION of the MFFU research simulator on one sample CSV (NOT evidence).

  python run_mffu.py <out> --csv <1m csv> --demo [--jobs N]

Genuine multi-year MNQ results are produced in QuantConnect Cloud (qc/, see QUANTCONNECT.md) and imported with
qc/qc_import.py. The plan variants and cost scenarios (mffu/experiments.py) are PRE-REGISTERED and identical in both.
"""
import argparse
import csv
import json
import os
import sys

from ote_engine.strategy import Settings, run
from mffu.experiments import CONFIGS, SCENARIOS, run_one
from mffu.instruments import COST_SCENARIOS, INSTRUMENTS
from mffu.calendar import NewsCalendar
from mffu import dashboard

_W = {}   # per-process state (each worker process loads its own copy)


def _prepare(a):
    from ote_engine.data import load_csv, to_bars
    bars = to_bars(load_csv(a.csv))
    st = Settings()

    def runner(ex, ov):
        run(bars, st, ex, overlay=ov)
        return bars["t"][-1]
    _W.update(spec=INSTRUMENTS[a.root], news=NewsCalendar(None) if a.news == "none" else NewsCalendar.official(a.news), runner=runner,
              data_note=f"DEMO ONLY: {os.path.basename(a.csv)} (one sample file; not genuine unadjusted multi-year data; not evidence)")


def _job(cid, sc):
    cfg = next(c for c in CONFIGS if c[0] == cid)
    ov, rep = run_one(cfg, sc, _W["spec"], _W["runner"], _W["news"], None)
    featured = dashboard.account_view(ov, rep) if (cid == "builder-50k" and sc == "C2_base") else None
    return f"{cid}__{sc}", rep, ov.trades, featured


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--root", default="MNQ", choices=sorted(INSTRUMENTS))
    ap.add_argument("--news", default="union", choices=["union", "official", "mffu_image", "none"])
    ap.add_argument("--configs", default="all")
    ap.add_argument("--scenarios", default=",".join(SCENARIOS))
    ap.add_argument("--jobs", type=int, default=1)
    a = ap.parse_args()
    if not a.demo:
        sys.exit("a single CSV is only accepted with --demo (pipeline demonstration, not evidence); genuine runs use qc/ (QUANTCONNECT.md)")
    _prepare(a)
    cfgs = CONFIGS if a.configs == "all" else [c for c in CONFIGS if c[0] in a.configs.split(",")]
    jobs = [(c[0], sc) for c in cfgs for sc in a.scenarios.split(",")]
    out = os.path.join(a.out, "demo")
    os.makedirs(out, exist_ok=True)
    news = _W["news"]
    summary = {"label": "SIMULATED MFFU research accounts. Historical simulated results do not guarantee evaluation success.",
               "period": "demo", "data": _W["data_note"], "instrument": a.root, "strategy": "OTE + PD Array, Configuration A (locked), 1 contract",
               "news_calendar": news.source or "NONE (stages that prohibit T1 news are blocked)", "holdout_start": None,
               "preregistered_configs": [c[0] for c in CONFIGS], "scenarios": {s: COST_SCENARIOS[s].label for s in SCENARIOS}, "runs": {}}
    if a.jobs > 1 and len(jobs) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(a.jobs, len(jobs)), initializer=_prepare, initargs=(a,)) as pool:
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
    with open(os.path.join(out, "mffu-dashboard.json"), "w") as f:
        json.dump(dashboard.snapshot(summary, last, _W["data_note"], demo=True), f, indent=1, default=str)
    print("wrote", out)


if __name__ == "__main__":
    main()
