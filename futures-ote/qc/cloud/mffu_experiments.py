"""Pre-registered MFFU research experiments (fixed before any result was seen; never tuned on results).

Shared by the local demo (run_mffu.py) and the QuantConnect backtests (qc/), so both run exactly the same variants.
Where MFFU is contradictory the stricter reading is used unless both readings are run as separate variants.
"""
from __future__ import annotations

from ote_strategy import Execution
from mffu_evaluate import MffuOverlay
from mffu_instruments import COST_SCENARIOS

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


def config(cid):
    return next(c for c in CONFIGS if c[0] == cid)


def make_overlay(cid, sc, spec, news):
    _, plan, size, choices = config(cid)
    return MffuOverlay(plan, size, choices, COST_SCENARIOS[sc], spec, news, label=cid)
