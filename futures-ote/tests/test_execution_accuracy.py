"""Execution accuracy on futures: expiry-capped rolls, tick grid, whole contracts, commission and slippage accounting,
and account-forced exits. Synthetic fixtures only."""
import pandas as pd

from mffu.evaluate import MffuOverlay
from mffu.instruments import COST_SCENARIOS, MNQ, last_trade_time as spec_ltt, FuturesSpec
from ote_engine.rolls import front_schedule, segments, last_trade_time
from ote_engine.strategy import Settings, Execution, run
from tests.test_engine import _walk

ET = "America/New_York"


def _on_tick(x, tick=0.25):
    return abs(x / tick - round(x / tick)) < 1e-9


def test_roll_windows_never_pass_the_contract_expiry():
    rows = []
    for d in pd.date_range("2024-03-04", "2024-03-29", freq="B"):
        rows += [{"time": pd.Timestamp(d.date().isoformat() + " 10:00", tz=ET), "symbol": "MNQH4", "volume": 1000},
                 {"time": pd.Timestamp(d.date().isoformat() + " 10:00", tz=ET), "symbol": "MNQM4", "volume": 10}]   # volume never moves
    segs = segments(front_schedule(pd.DataFrame(rows)))
    assert segs[0]["symbol"] == "MNQH4" and segs[0]["end"] == pd.Timestamp("2024-03-15 09:30", tz=ET) and segs[0].get("capped_at_expiry")
    assert last_trade_time(2026, 12) == pd.Timestamp(spec_ltt(2026, 12))
    assert last_trade_time(2019, 6) == pd.Timestamp("2019-06-21 09:30", tz=ET)


def test_fills_are_on_tick_quantities_whole_and_costs_add_up():
    for name in ("C2_base", "C3_conservative", "C4_stress"):
        sc = COST_SCENARIOS[name]
        ex = Execution(path=sc.path, sizing="fixed1", tick=0.25, point_value=2.0, commission_per_side=sc.commission_per_side,
                       stop_slip_ticks=sc.stop_slip_ticks, limit_through_ticks=sc.limit_through_ticks)
        r = run(_walk(6000, seed=4), Settings(), ex)
        assert r["trades"]
        for x in r["trades"]:
            assert _on_tick(x.entry) and _on_tick(x.exit) and x.qty == int(x.qty) == 1
            assert abs(x.gross - x.side * (x.exit - x.entry) * x.qty * 2.0) < 1e-9
            assert abs(x.commission - 2 * sc.commission_per_side * x.qty) < 1e-9          # per contract per side, both sides
            assert abs(x.net - (x.gross - x.commission)) < 1e-9                          # slippage is inside the fill price
            if x.slippage_usd:
                assert abs(x.slippage_usd - sc.stop_slip_ticks * 0.25 * x.qty * 2.0) < 1e-9
    w = run(_walk(6000, seed=4), Settings(risk_usd=60.0), Execution(sizing="whole", commission_per_side=0.74))
    assert w["trades"] and all(x.qty == int(x.qty) and x.qty >= 1 for x in w["trades"])
    assert all(x.risk_usd <= 60.0 + 1e-9 for x in w["trades"])                            # floor(), never rounded up


BIG = FuturesSpec("MNQ", "test-only scaled MNQ", "NQ", 200.0, 0.25, 50.0, 0.1, "HMUZ", "", "test")


def test_account_forced_exits_are_on_tick_and_pay_slippage():
    sc = COST_SCENARIOS["C3_conservative"]
    ov = MffuOverlay("builder", "50k", {"evaluation": {"breach_basis": "intraday_equity"}}, sc, spec=BIG)
    r = run(_walk(8000, seed=5), Settings(), Execution(path=sc.path, sizing="fixed1", point_value=200.0, commission_per_side=sc.commission_per_side,
                                                         stop_slip_ticks=sc.stop_slip_ticks, limit_through_ticks=sc.limit_through_ticks), overlay=ov)
    forced = [x for x in r["trades"] if x.reason.startswith("ACCT_")]
    assert forced
    for x in forced:
        assert _on_tick(x.exit) and abs(x.slippage_usd - sc.stop_slip_ticks * 0.25 * 200.0) < 1e-9
