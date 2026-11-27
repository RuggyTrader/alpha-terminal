"""Load and validate 1-minute futures OHLCV (CSV). Data is never synthesized, filled or silently substituted."""
from __future__ import annotations

import math
from typing import Dict, Any, List

import pandas as pd

ET = "America/New_York"


def load_csv(path: str, *, ts_col: str = "timestamp", tz: str = ET, symbol: str | None = None) -> pd.DataFrame:
    """CSV with timestamp (bar OPEN), open, high, low, close[, volume][, symbol]. Naive timestamps are interpreted in `tz`."""
    df = pd.read_csv(path)
    if symbol is not None and "symbol" in df.columns:
        df = df[df["symbol"] == symbol]
    ts = pd.to_datetime(df[ts_col])
    ts = ts.dt.tz_localize(tz) if ts.dt.tz is None else ts.dt.tz_convert(tz)
    out = pd.DataFrame({"time": ts, "open": df["open"].astype(float), "high": df["high"].astype(float), "low": df["low"].astype(float), "close": df["close"].astype(float),
                        "volume": df["volume"].astype(float) if "volume" in df.columns else math.nan})
    return out.reset_index(drop=True)


def expected_open(t: pd.Timestamp) -> bool:
    """CME Globex equity-index futures: Sunday 18:00 ET to Friday 17:00 ET, daily halt 17:00-18:00 ET (holidays NOT modelled)."""
    wd, m = t.weekday(), t.hour * 60 + t.minute   # Monday = 0
    if wd == 5:
        return False
    if wd == 6:
        return m >= 18 * 60
    if wd == 4:
        return m < 17 * 60
    return not (17 * 60 <= m < 18 * 60)


def validate(df: pd.DataFrame, tick: float) -> Dict[str, Any]:
    v: Dict[str, Any] = {"rows": int(len(df))}
    if not len(df):
        return v
    t = df["time"]
    v["first"], v["last"] = str(t.iloc[0]), str(t.iloc[-1])
    v["duplicates"] = int(t.duplicated().sum())
    v["non_monotonic"] = int((t.diff().dt.total_seconds() < 0).sum())
    v["misaligned_minute"] = int((t.dt.second != 0).sum())
    bad = (df["low"] > df[["open", "close"]].min(axis=1) + 1e-9) | (df["high"] < df[["open", "close"]].max(axis=1) - 1e-9) | (df["high"] < df["low"])
    v["bad_ohlc"] = int(bad.sum())
    off = ((df[["open", "high", "low", "close"]] / tick - (df[["open", "high", "low", "close"]] / tick).round()).abs() > 1e-6).any(axis=1)
    v["off_tick_share"] = round(float(off.mean()), 4)
    v["price_adjusted_likely"] = v["off_tick_share"] > 0.05
    # missing minutes inside the expected Globex session (no trade in a minute also leaves no bar; holidays not modelled)
    full = pd.date_range(t.iloc[0].floor("min"), t.iloc[-1].floor("min"), freq="min", tz=t.dt.tz)
    exp = [x for x in full if expected_open(x)]
    have = set(t.dt.floor("min"))
    missing = [x for x in exp if x not in have]
    v["expected_session_minutes"], v["missing_session_minutes"] = len(exp), len(missing)
    gaps, run_start, prev = [], None, None
    for x in missing:
        if prev is not None and (x - prev).total_seconds() == 60:
            prev = x; continue
        if run_start is not None:
            gaps.append((run_start, prev))
        run_start = prev = x
    if run_start is not None:
        gaps.append((run_start, prev))
    long_gaps = [(str(a), str(b), int((b - a).total_seconds() // 60) + 1) for a, b in gaps if (b - a).total_seconds() >= 29 * 60]
    v["gaps_30min_plus"] = len(long_gaps)
    v["largest_gaps"] = sorted(long_gaps, key=lambda g: -g[2])[:10]
    # roll / adjustment jumps: bar-to-bar moves far beyond normal
    r = (df["open"] / df["close"].shift(1) - 1).abs()
    med = float(r.median()) if len(r) > 1 else 0.0
    jumps = df.loc[r > max(0.01, 40 * med), "time"]
    v["large_open_jumps"] = [str(x) for x in jumps.head(20)]
    return v


def to_bars(df: pd.DataFrame) -> Dict[str, List[float]]:
    return {"t": list(df["time"]), "o": df["open"].tolist(), "h": df["high"].tolist(), "l": df["low"].tolist(), "c": df["close"].tolist()}
