"""Contract rolls without artificial signals.

Each MNQ contract is traded only while it is the front month, chosen by the PREVIOUS trading day's volume (known before
the day starts; never rolls back to an earlier expiry). The strategy runs on that contract's own unadjusted prices, with
indicators warmed up on the same contract's earlier bars, and any position is flattened at the end of the window.
No back-adjusted or stitched series is ever used, so a roll gap can never create a pivot, FVG or ATR jump.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

import pandas as pd

ET = "America/New_York"
MONTHS = "FGHJKMNQUVXZ"
OUTRIGHT = re.compile(r"^MNQ([FGHJKMNQUVXZ])(\d{1,2})$")


def expiry_key(sym: str, ref_year: int) -> Tuple[int, int]:
    """(year, month) of a raw symbol like MNQM9 / MNQZ24; a 1-digit year is resolved to the decade nearest ref_year."""
    m = OUTRIGHT.match(sym)
    if not m:
        raise ValueError(sym)
    mon, yy = MONTHS.index(m.group(1)) + 1, m.group(2)
    if len(yy) == 2:
        y = 2000 + int(yy)
    else:
        base = ref_year - ref_year % 10 + int(yy)
        y = min((base - 10, base, base + 10), key=lambda c: abs(c - ref_year - 0.5))
    return y, mon


def trading_day(ts_et: pd.Series) -> pd.Series:
    """CME session date: bars from 18:00 ET belong to the next day's session."""
    return (ts_et + pd.Timedelta(hours=6)).dt.normalize().dt.date


def front_schedule(df: pd.DataFrame) -> pd.DataFrame:
    """df: per-contract 1m bars with columns time (ET), symbol, volume. Returns one row per session day: day, front."""
    out = df[df["symbol"].str.match(OUTRIGHT)].copy()
    out["day"] = trading_day(out["time"])
    vol = out.groupby(["day", "symbol"])["volume"].sum().unstack(fill_value=0).sort_index()
    days = list(vol.index)
    rows, cur = [], None
    for i, d in enumerate(days):
        if i == 0:
            continue
        prev = vol.iloc[i - 1]
        cand = prev.idxmax()
        if cur is None:
            cur = cand
        else:
            ry = pd.Timestamp(d).year
            if expiry_key(cand, ry) > expiry_key(cur, ry) and prev[cand] > prev[cur]:
                cur = cand                      # roll forward only, decided from yesterday's volume
        rows.append({"day": d, "front": cur})
    return pd.DataFrame(rows)


def segments(schedule: pd.DataFrame) -> List[Dict]:
    """Contiguous runs of the same front contract -> [{symbol, first_day, last_day, start (ET), end (ET)}]."""
    segs, run = [], None
    for _, r in schedule.iterrows():
        if run and r["front"] == run["symbol"]:
            run["last_day"] = r["day"]
        else:
            if run:
                segs.append(run)
            run = {"symbol": r["front"], "first_day": r["day"], "last_day": r["day"]}
    if run:
        segs.append(run)
    for s in segs:   # session of day D runs from 18:00 ET of D-1 to 17:00 ET of D
        s["start"] = pd.Timestamp(s["first_day"]).tz_localize(ET) - pd.Timedelta(hours=6)
        s["end"] = pd.Timestamp(s["last_day"]).tz_localize(ET) + pd.Timedelta(hours=17)
    return segs
