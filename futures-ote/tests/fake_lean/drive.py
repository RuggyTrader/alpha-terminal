"""Drive qc/cloud/main.py locally with the fake AlgorithmImports and SYNTHETIC bars (tests only).

  python -I -B drive.py <cloud dir> <params.json> <config_overrides.json> <bars.pkl> <out.json>

Feeds one Slice per minute like LEAN (contract TradeBars keyed by contract Symbols, only contracts 0-200 days from
expiry), plus a canonical-symbol bar, an equity bar and fill-forward bars of a ghost contract that must all be ignored.
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
cloud, params_p, over_p, bars_p, out_p = sys.argv[1:6]
sys.path[:0] = [HERE, cloud]

import pandas as pd  # noqa: E402

import AlgorithmImports as L  # noqa: E402
import at_config  # noqa: E402

for k, v in json.load(open(over_p)).items():
    setattr(at_config, k, tuple(v) if k == "DATA_START" else v)

import main  # noqa: E402
from ote_rolls import expiry_key, last_trade_time  # noqa: E402

df = pd.read_pickle(bars_p)
algo = main.AlphaTerminalMffuResearch()
algo._params = json.load(open(params_p))
algo.initialize()
start = pd.Timestamp(algo.start).tz_localize("America/New_York")
end = pd.Timestamp(algo.end).tz_localize("America/New_York") + pd.Timedelta(days=1) if algo.end else None
lo_d, hi_d = algo.futures[0].filter

sel = df[(df["time"] >= start) & ((df["time"] < end) if end is not None else True)]
syms = {}
for s in sel["symbol"].unique():
    y, m = expiry_key(s, 2024)
    syms[s] = L.Symbol(s, last_trade_time(y, m).tz_localize(None).to_pydatetime())
canon = L.Symbol("/MNQ")
equity = L.Symbol("SPY", security_type=L.SecurityType.EQUITY)
ghost = L.Symbol("GHOST", dt.datetime(2026, 12, 18, 9, 30))
T = sel["time"].to_numpy()
S, O, H, Lw, C, V = (sel[c].to_numpy() for c in ("symbol", "open", "high", "low", "close", "volume"))
i, n, minute = 0, len(sel), 0
while i < n:
    j = i
    while j < n and T[j] == T[i]:
        j += 1
    t = pd.Timestamp(T[i]).tz_convert("America/New_York")
    bars = {}
    for k in range(i, j):
        sym = syms[S[k]]
        days = (sym.id.date.date() - t.date()).days
        if lo_d <= days <= hi_d:
            bars[sym] = L.TradeBar(O[k], H[k], Lw[k], C[k], V[k])
    bars[canon] = L.TradeBar(1.0, 1.0, 1.0, 1.0, 10 ** 9)
    if minute % 997 == 0:
        bars[ghost] = L.TradeBar(1.0, 1.0, 1.0, 1.0, 10 ** 9, ff=True)
        bars[equity] = L.TradeBar(1.0, 1.0, 1.0, 1.0, 10 ** 9)
    algo.utc_time = (t + pd.Timedelta(minutes=1)).tz_convert("UTC").tz_localize(None).to_pydatetime()
    algo.on_data(L.Slice(bars))
    i, minute = j, minute + 1
algo.on_end_of_algorithm()
json.dump({"logs": algo.logs, "runtime": algo.runtime, "start": str(algo.start), "end": str(algo.end), "ff": algo._ff,
           "universe": {"fill_forward": algo.universe_settings.fill_forward, "extended": algo.universe_settings.extended_market_hours},
           "add_future": {k: str(v) for k, v in algo.add_future_kwargs.items()}, "filter": list(algo.futures[0].filter)}, open(out_p, "w"))
