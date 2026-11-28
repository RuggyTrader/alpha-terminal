"""SYNTHETIC Databento-format test fixture. Never market data, never evidence, never written under results/.

Builds a cache directory laid out exactly like fetch_databento.py writes it
(<cache>/GLBX.MDP3/ohlcv-1m/<ROOT>.FUT/<year>.dbn.zst), with real DBN encoding (header, symbology mappings, OHLCV-1m
records), so the offline rehearsal exercises the same reader, roll selection, spread filter and runners as real data.

* Quarterly outrights (H, M, U, Z) with the front and next contract printing, plus a thin calendar spread.
* Globex hours only: Sunday 18:00 ET to Friday 17:00 ET, with the daily 17:00-18:00 ET break.
* Random walk on the 0.25 tick grid. Volume moves to the next contract 8 days before expiry, and each contract stops
  printing at its last trade time (9:30 ET, 3rd Friday). One file per calendar year, like the fetcher.
"""
from __future__ import annotations

import datetime as dt
import os
from types import SimpleNamespace as N

import numpy as np
import pandas as pd

from ote_engine.rolls import last_trade_time

ET = "America/New_York"
SCALE = 1_000_000_000   # DBN fixed-point price scale
QUARTERS = {3: "H", 6: "M", 9: "U", 12: "Z"}
MARKER = "SYNTHETIC-NOT-MARKET-DATA.txt"


def _globex_minutes(start: str, end: str) -> pd.DatetimeIndex:
    t = pd.date_range(pd.Timestamp(start, tz=ET), pd.Timestamp(end, tz=ET), freq="1min", inclusive="left")
    wd, h = t.weekday, t.hour
    open_ = ~((wd == 5) | ((wd == 6) & (h < 18)) | ((wd == 4) & (h >= 17)) | (h == 17))
    return t[open_]


def _contracts(start: pd.Timestamp, end: pd.Timestamp):
    out, y, m = [], start.year, start.month
    while True:
        m = next(q for q in (3, 6, 9, 12, 15) if q >= m)
        if m == 15:
            y, m = y + 1, 3
        ltt = last_trade_time(y, m)
        out.append((f"{QUARTERS[m]}{y % 10}", ltt))
        if ltt > end:
            break
        m += 1
    return out


def build_cache(cache: str, root: str = "MNQ", start: str = "2023-11-01", end: str = "2025-02-01", seed: int = 7) -> str:
    import databento_dbn as d
    import zstandard

    rng = np.random.default_rng(seed)
    t = _globex_minutes(start, end)
    n = len(t)
    base = 17000.0 + rng.choice([-2, -1, 0, 1, 2], size=n, p=[0.15, 0.25, 0.2, 0.25, 0.15]).cumsum() * 0.25
    ns = t.tz_convert("UTC").as_unit("ns").asi8
    cons = _contracts(t[0], t[-1])
    records, syms = [], {}
    prev_ltt = None
    for k, (code, ltt) in enumerate(cons):
        iid = 101 + k
        syms[iid] = f"{root}{code}"
        lo = prev_ltt - pd.Timedelta(days=100) if prev_ltt is not None else t[0]
        live = (t >= lo) & (t < ltt)
        front = t < ltt - pd.Timedelta(days=8)
        if prev_ltt is not None:
            front &= t >= prev_ltt - pd.Timedelta(days=8)
        vol = np.where(front, rng.integers(200, 600, n), rng.integers(5, 60, n))
        records.append((iid, live, base + 40.0 * k, vol))
        if prev_ltt is not None:   # thin calendar spread between the previous and this contract
            sid = 901 + k
            syms[sid] = f"{syms[iid - 1]}-{syms[iid]}"
            records.append((sid, (t >= lo) & (t < prev_ltt) & (rng.random(n) < 0.05), np.full(n, -40.0), np.full(n, 3)))
        prev_ltt = ltt
    cols = []
    for iid, live, px, vol in records:
        idx = np.flatnonzero(live)
        o = px[idx]
        c = o + rng.integers(-1, 2, len(idx)) * 0.25
        hi = np.maximum(o, c) + rng.integers(0, 6, len(idx)) * 0.25
        lo_ = np.minimum(o, c) - rng.integers(0, 6, len(idx)) * 0.25
        cols.append(pd.DataFrame({"ts": ns[idx], "iid": iid, "o": o, "h": hi, "l": lo_, "c": c, "v": vol[idx]}))
    df = pd.concat(cols).sort_values(["ts", "iid"])
    out = os.path.join(cache, "GLBX.MDP3", "ohlcv-1m", f"{root}.FUT")
    os.makedirs(out, exist_ok=True)
    years = pd.to_datetime(df["ts"], utc=True).dt.year
    day0, day1 = dt.date.fromisoformat(start), dt.date.fromisoformat(end) + dt.timedelta(days=1)
    maps = [N(raw_symbol=s, intervals=[N(start_date=day0, end_date=day1, symbol=str(i))]) for i, s in syms.items()]
    for y, part in df.groupby(years):
        meta = d.Metadata(dataset="GLBX.MDP3", start=int(part["ts"].iloc[0]), end=int(part["ts"].iloc[-1]) + 60 * SCALE,
                          stype_in=d.SType.PARENT, stype_out=d.SType.INSTRUMENT_ID, schema=d.Schema.OHLCV_1M,
                          symbols=[f"{root}.FUT"], mappings=maps)
        buf = bytearray(bytes(meta))
        for ts, iid, o, h, l, c, v in part.itertuples(index=False):
            buf += bytes(d.OHLCVMsg(rtype=d.RType.OHLCV_1M, publisher_id=1, instrument_id=int(iid), ts_event=int(ts), open=round(o * SCALE),
                                    high=round(h * SCALE), low=round(l * SCALE), close=round(c * SCALE), volume=int(v)))
        with open(os.path.join(out, f"{y}.dbn.zst"), "wb") as f:
            f.write(zstandard.ZstdCompressor().compress(bytes(buf)))
    with open(os.path.join(cache, MARKER), "w") as f:
        f.write("Synthetic test fixture written by tests/synthetic_dbn.py. Not market data. Never evidence.\n")
    return out
