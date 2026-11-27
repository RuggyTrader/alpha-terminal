"""OTE engine tests: Pine built-ins, broker-emulator fills, no lookahead, sizing rules, data validation."""
import math
import random

import pandas as pd
import pytest

from ote_engine.indicators import atr, pivot_high, pivot_low, lowest, round_to_mintick, rma
from ote_engine.strategy import Broker, Execution, Settings, run
from ote_engine.data import validate, expected_open


# ---------------- Pine built-ins ----------------
def test_rma_and_atr_seed_with_sma():
    x = [1, 2, 3, 4, 5, 6]
    r = rma(x, 3)
    assert r[:2] == [None, None] and r[2] == 2.0 and r[3] == pytest.approx((2 * 2 + 4) / 3)
    a = atr([10, 11, 12], [9, 10, 11], [9.5, 10.5, 11.5], 2)
    assert a[1] == pytest.approx((1 + 1.5) / 2)      # TR0 = h-l = 1; TR1 = max(1, |11-9.5|, |10-9.5|) = 1.5


def test_pivots_confirm_after_right_bars_and_tie_rule():
    h = [1, 2, 5, 3, 2, 1, 1]
    p = pivot_high(h, 2, 2)
    assert p[4] == 5 and all(v is None for i, v in enumerate(p) if i != 4)   # known only 2 bars after the pivot
    assert pivot_high([1, 5, 5, 1, 1], 1, 1)[2] is None                     # equal bar on the RIGHT: not a pivot
    assert pivot_high([1, 5, 5, 1, 1], 1, 1)[3] == 5                        # equal on the LEFT allowed (default)
    assert pivot_high([1, 5, 5, 1, 1], 1, 1, strict_left=True)[3] is None
    assert pivot_low([5, 4, 1, 3, 4], 2, 2)[4] == 1


def test_lowest_includes_current_bar_and_tick_rounding():
    assert lowest([5, 4, 3], 2) == [None, 4, 3]
    assert round_to_mintick(100.12, 0.25) == 100.0 and round_to_mintick(100.125, 0.25) == 100.25 and round_to_mintick(100.13, 0.25) == 100.25


# ---------------- broker emulator ----------------
def _broker(path="tv", **kw):
    return Broker(Execution(path=path, **kw))


def test_limit_fills_at_limit_when_touched_and_at_open_on_a_gap():
    b = _broker(); b.place_entry(1, 1.0, 100.0); b.set_exit(110.0, 95.0)
    b.process_bar(0, "t0", 102, 103, 99.5, 101, {"init_stop": 95.0, "tp2": 110.0})
    assert b.pos and b.pos.entry == 100.0
    g = _broker(); g.place_entry(1, 1.0, 100.0); g.set_exit(110.0, 95.0)
    g.process_bar(0, "t0", 98, 99, 97, 98.5, {"init_stop": 95.0, "tp2": 110.0})
    assert g.pos.entry == 98                                               # opened through the limit: fills at the open


def test_entry_and_stop_in_the_same_bar_and_path_models():
    # bar: open 102, low 94 (through entry 100 and stop 95), high 111 (TP 110)
    tv = _broker("tv"); tv.place_entry(1, 1.0, 100.0); tv.set_exit(110.0, 95.0)
    tv.process_bar(0, "t", 102, 111, 94, 105, {"init_stop": 95.0, "tp2": 110.0})
    assert tv.closed[0].reason == "STOP" and tv.closed[0].same_bar          # low is closer to the open: open->low first
    cons = _broker("conservative"); cons.place_entry(1, 1.0, 100.0); cons.set_exit(110.0, 95.0)
    cons.process_bar(0, "t", 102, 111, 94, 105, {"init_stop": 95.0, "tp2": 110.0})
    assert cons.closed[0].reason == "STOP"
    # high closer to the open: tv path open->high->low; the long entry only fills on the way down, then the stop
    tv2 = _broker("tv"); tv2.place_entry(1, 1.0, 100.0); tv2.set_exit(110.0, 95.0)
    tv2.process_bar(0, "t", 101, 102, 94, 96, {"init_stop": 95.0, "tp2": 110.0})
    assert tv2.closed[0].reason == "STOP"


def test_stop_gap_slippage_and_no_retroactive_stop_change():
    b = _broker(stop_slip_ticks=1); b.place_entry(1, 1.0, 100.0); b.set_exit(110.0, 95.0)
    b.process_bar(0, "t0", 100.5, 101, 99.75, 100.5, {"init_stop": 95.0, "tp2": 110.0})
    b.set_exit(110.0, 99.0)                                                # moved at bar 0's close: live from bar 1 only
    b.process_bar(1, "t1", 94, 94.5, 93, 94, {"init_stop": 95.0, "tp2": 110.0})
    assert b.closed[0].exit == 94 - 0.25                                   # gapped below the stop: open minus 1 tick


# ---------------- strategy ----------------
def _walk(n, seed=1, start=20000.0):
    rnd = random.Random(seed); t0 = pd.Timestamp("2025-01-06 09:30", tz="America/New_York")
    t, o, h, l, c = [], [], [], [], []
    p = start
    for i in range(n):
        op = p; p = round_to_mintick(p + rnd.gauss(0, 6) + (25 if i % 400 in range(100, 110) else 0) - (25 if i % 400 in range(300, 310) else 0), 0.25)
        hi = round_to_mintick(max(op, p) + abs(rnd.gauss(0, 2)), 0.25); lo = round_to_mintick(min(op, p) - abs(rnd.gauss(0, 2)), 0.25)
        t.append(t0 + pd.Timedelta(minutes=i)); o.append(op); h.append(hi); l.append(lo); c.append(p)
    return {"t": t, "o": o, "h": h, "l": l, "c": c}


def test_no_lookahead_truncation_invariance():
    bars = _walk(6000)
    full = run(bars, Settings(), Execution())
    cut = 4000
    part = run({k: v[:cut] for k, v in bars.items()}, Settings(), Execution())
    a = [(x.entry_bar, x.exit_bar, x.entry, x.exit) for x in full["trades"] if x.exit_bar < cut]
    b = [(x.entry_bar, x.exit_bar, x.entry, x.exit) for x in part["trades"]]
    assert len(a) >= 3, "fixture must produce trades"
    assert a == b


def test_sizing_modes_risk_budget_and_tick_grid():
    bars = _walk(6000)
    fr = run(bars, Settings(), Execution(sizing="fractional"))["trades"]
    wh = run(bars, Settings(), Execution(sizing="whole"))
    f1 = run(bars, Settings(), Execution(sizing="fixed1"))["trades"]
    assert fr and any(not float(x.qty).is_integer() for x in fr)                    # TradingView-style sizing is fractional (non-executable)
    assert all(abs(x.risk_usd - 10) < 3 for x in fr if x.exit_bar > x.entry_bar)   # ~ $10 (rounding / gaps move it a little)
    assert all(float(x.qty).is_integer() and x.qty >= 1 for x in wh["trades"])
    assert wh["diag"]["rejected_setups"] >= 1
    assert all(x.qty == 1 for x in f1)
    assert all(abs(x.entry / 0.25 - round(x.entry / 0.25)) < 1e-9 for x in f1)


def test_ledger_identity_net_equals_gross_minus_commission():
    r = run(_walk(6000), Settings(), Execution(sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1))
    for x in r["trades"]:
        assert x.net == pytest.approx(x.gross - 2 * 0.74)
        assert x.gross == pytest.approx(x.side * (x.exit - x.entry) * 2.0)
    bars = _walk(6000)
    unreal = 0.0 if r["open"] is None else r["open"].side * (bars["c"][-1] - r["open"].entry) * r["open"].qty * 2.0
    assert r["eq_close"][-1] == pytest.approx(sum(x.net for x in r["trades"]) + unreal)   # equity = realized + open mark


# ---------------- data validation ----------------
def test_validation_flags_duplicates_offtick_and_session():
    t = pd.to_datetime(["2026-04-06 10:00", "2026-04-06 10:01", "2026-04-06 10:01", "2026-04-06 10:05"]).tz_localize("America/New_York")
    df = pd.DataFrame({"time": t, "open": [1.0, 1.25, 1.25, 1.1], "high": [1.5, 1.5, 1.5, 1.2], "low": [1.0, 1.0, 1.0, 1.0], "close": [1.25, 1.0, 1.0, 1.1], "volume": 1})
    v = validate(df, 0.25)
    assert v["duplicates"] == 1 and v["off_tick_share"] > 0 and v["missing_session_minutes"] == 3
    assert expected_open(pd.Timestamp("2026-04-05 18:00", tz="America/New_York")) and not expected_open(pd.Timestamp("2026-04-06 17:30", tz="America/New_York"))
    assert not expected_open(pd.Timestamp("2026-04-04 12:00", tz="America/New_York"))
