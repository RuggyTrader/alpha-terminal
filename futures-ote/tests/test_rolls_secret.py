"""Roll selection without lookahead, trade windows (no orders outside, flat at the end), and API-key hygiene."""
import io
import contextlib

import pandas as pd
import pytest

from ote_engine.rolls import front_schedule, segments, expiry_key, trading_day
from ote_engine.strategy import Settings, Execution, run
from ote_engine import secret
from tests.test_engine import _walk

ET = "America/New_York"


def _vol_df():
    rows = []
    for d, vols in [("2024-03-10", {"MNQH4": 100, "MNQM4": 10}), ("2024-03-11", {"MNQH4": 100, "MNQM4": 10}),
                    ("2024-03-12", {"MNQH4": 50, "MNQM4": 200}), ("2024-03-13", {"MNQH4": 5, "MNQM4": 300}), ("2024-03-14", {"MNQH4": 900, "MNQM4": 300})]:
        for s, v in vols.items():
            rows.append({"time": pd.Timestamp(d + " 10:00", tz=ET), "symbol": s, "volume": v})
    rows.append({"time": pd.Timestamp("2024-03-12 10:00", tz=ET), "symbol": "MNQH4-MNQM4", "volume": 10 ** 6})   # a spread: ignored
    return pd.DataFrame(rows)


def test_front_uses_previous_day_volume_and_never_rolls_back():
    s = front_schedule(_vol_df())
    front = dict(zip(s["day"].astype(str), s["front"]))
    assert front["2024-03-12"] == "MNQH4"        # on 03-12 only 03-11's volume is known: H4 still front
    assert front["2024-03-13"] == "MNQM4"        # 03-12's volume favours M4 -> roll
    assert front["2024-03-14"] == "MNQM4"
    assert "MNQH4-MNQM4" not in set(s["front"])
    segs = segments(s); assert [x["symbol"] for x in segs] == ["MNQH4", "MNQM4"]
    assert segs[1]["start"] == pd.Timestamp("2024-03-12 18:00", tz=ET)


def test_expiry_key_and_trading_day():
    assert expiry_key("MNQZ9", 2019) == (2019, 12) and expiry_key("MNQH0", 2019) == (2020, 3) and expiry_key("MNQM24", 2024) == (2024, 6)
    assert str(trading_day(pd.Series([pd.Timestamp("2024-03-11 18:05", tz=ET)])).iloc[0]) == "2024-03-12"


def test_window_blocks_orders_outside_and_flattens_at_the_end():
    bars = _walk(6000)
    a, b = bars["t"][1500], bars["t"][4500]
    r = run(bars, Settings(), Execution(sizing="fixed1"), window=(a, b))
    assert r["trades"], "fixture must trade"
    assert all(a <= x.entry_time < b for x in r["trades"])
    assert all(x.exit_time < b for x in r["trades"])
    assert r["open"] is None
    # same contract, no window: the trades inside the window are the same until the forced exit
    full = run(bars, Settings(), Execution(sizing="fixed1"))
    first_inside = [x for x in full["trades"] if x.entry_time >= a]
    assert first_inside and r["trades"][0].entry_time >= first_inside[0].entry_time


def test_secret_never_echoed(monkeypatch):
    k = "db-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4P"
    monkeypatch.setenv(secret.ENV, k)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        got = secret.get_key()
    assert got == k and buf.getvalue() == ""
    assert k not in secret.redact(f"401 for key {k}", k) and "REDACTED" in secret.redact(f"x {k}", None)
    monkeypatch.setenv(secret.ENV, "not-a-key")
    with pytest.raises(RuntimeError) as e:
        secret.get_key()
    assert "not-a-key" not in str(e.value)


def test_roll_gap_cannot_create_trades_and_each_contract_uses_its_own_prices():
    from run_full import run_period
    a = _walk(6000, seed=3, start=20000.0); b = _walk(6000, seed=3, start=21000.0)   # identical shape, +1000 points (a roll gap)
    rows = [{"symbol": "MNQH4", "time": t, "open": o, "high": h, "low": l, "close": c, "volume": 1} for t, o, h, l, c in zip(a["t"], a["o"], a["h"], a["l"], a["c"])]
    rows += [{"symbol": "MNQM4", "time": t, "open": o, "high": h, "low": l, "close": c, "volume": 1} for t, o, h, l, c in zip(b["t"], b["o"], b["h"], b["l"], b["c"])]
    df = pd.DataFrame(rows)
    mid = a["t"][3000]
    segs = [{"symbol": "MNQH4", "start": a["t"][0], "end": mid}, {"symbol": "MNQM4", "start": mid, "end": a["t"][-1]}]
    res, times = run_period(df, segs, a["t"][0], a["t"][-1], Settings(), Execution(sizing="fixed1"))
    assert res["trades"]
    for x in res["trades"]:
        if x.contract == "MNQH4":
            assert x.entry < 20000 + 2000 and x.exit_time < mid
        else:
            assert x.entry > 21000 - 2000 and x.entry_time >= mid
    assert times == sorted(times) and len(times) == len(set(times))
