"""SYNTHETIC quarterly-contract minute bars for tests. Never market data, never evidence.

* Quarterly outrights (H, M, U, Z) named like the QuantConnect adapter names them (MNQH24); front and next both print.
* Globex hours only: Sunday 18:00 ET to Friday 17:00 ET, with the daily 17:00-18:00 ET break.
* Random walk on the 0.25 tick grid. Volume moves to the next contract 8 days before expiry, and each contract stops
  printing at its last trade time (9:30 ET, 3rd Friday), like the real contracts.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ote_engine.rolls import last_trade_time

ET = "America/New_York"
QUARTERS = {3: "H", 6: "M", 9: "U", 12: "Z"}


def globex_minutes(start: str, end: str) -> pd.DatetimeIndex:
    t = pd.date_range(pd.Timestamp(start, tz=ET), pd.Timestamp(end, tz=ET), freq="1min", inclusive="left").as_unit("ns")
    wd, h = t.weekday, t.hour
    return t[~((wd == 5) | ((wd == 6) & (h < 18)) | ((wd == 4) & (h >= 17)) | (h == 17))]


def contracts(t0: pd.Timestamp, t1: pd.Timestamp, root: str = "MNQ"):
    out, y, m = [], t0.year, t0.month
    while True:
        m = next(q for q in (3, 6, 9, 12, 15) if q >= m)
        if m == 15:
            y, m = y + 1, 3
        ltt = last_trade_time(y, m)
        out.append((f"{root}{QUARTERS[m]}{y % 100:02d}", ltt))
        if ltt > t1:
            return out
        m += 1


def bars(start: str = "2023-11-01", end: str = "2024-12-20", seed: int = 7, root: str = "MNQ") -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    t = globex_minutes(start, end)
    n = len(t)
    base = 17000.0 + rng.choice([-2, -1, 0, 1, 2], size=n, p=[0.15, 0.25, 0.2, 0.25, 0.15]).cumsum() * 0.25
    cols, prev = [], None
    for k, (sym, ltt) in enumerate(contracts(t[0], t[-1], root)):
        lo = prev - pd.Timedelta(days=100) if prev is not None else t[0]
        idx = np.flatnonzero((t >= lo) & (t < ltt))
        front = t[idx] < ltt - pd.Timedelta(days=8)
        if prev is not None:
            front &= t[idx] >= prev - pd.Timedelta(days=8)
        o = base[idx] + 40.0 * k
        c = o + rng.integers(-1, 2, len(idx)) * 0.25
        cols.append(pd.DataFrame({"symbol": sym, "time": t[idx], "open": o, "high": np.maximum(o, c) + rng.integers(0, 6, len(idx)) * 0.25,
                                  "low": np.minimum(o, c) - rng.integers(0, 6, len(idx)) * 0.25, "close": c,
                                  "volume": np.where(front, rng.integers(200, 600, len(idx)), rng.integers(5, 60, len(idx))).astype(float)}))
        prev = ltt
    return pd.concat(cols).sort_values(["time", "symbol"]).reset_index(drop=True)
