"""QuantConnect streaming adapter: genuine individual-contract minute bars in, permitted SUMMARY results out.

Stream receives each contract's own unadjusted 1-minute trade bars in time order (from QuantConnect's US Futures data)
and reproduces the local reference exactly (ote_engine.rolls + ote_engine.replay; tests check identical results):
  * front contract chosen each session day from the PREVIOUS day's volume, rolling forward only, never past expiry;
  * each finished roll segment is replayed through the unchanged engine with 10 days of the same contract's warm-up;
  * pre-registered jobs (full cost/sizing grid, or MFFU plan variants x cost scenarios) accumulate across segments.
Bars stay inside the backtest. Only summary statistics, roll dates and data-coverage dates leave it (QuantConnect terms
2.6(e) permit exporting the summary results of your own backtests; raw or derived market data must not be exported).

Also here: the result codec (compressed, checksummed log lines that fit the free tier's 10 KB per backtest), the
deterministic engine self-test, and source-integrity hashing used by main.py and the local importer.
"""
from __future__ import annotations

import base64
import bisect
import datetime as dt
import hashlib
import json
import random
import zlib
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import pandas as pd

from ote_rolls import expiry_key, last_trade_time
from ote_replay import (PeriodAccumulator, WARMUP, ambiguous, full_execution, run_segment, summarize, window, SIZING)
from ote_strategy import Settings, Execution, run
from ote_data import validate
from mffu_experiments import CONFIGS, SCENARIOS, execution_for, make_overlay

ET = "America/New_York"
_ETZ = ZoneInfo(ET)
_UTC = dt.timezone.utc
MONTHS = "FGHJKMNQUVXZ"
SCHEMA = "alpha-terminal.qc-result.v1"
PREFIX = "ATQC1"
LOG_BUDGET = 9000          # characters of result lines per backtest (free tier: 10 KB of logs per backtest)
CHUNK = 3000               # characters per log line (QuantConnect caps a line at 8,192)
PRUNE_DAYS = 12            # non-front contracts keep this much history (warm-up needs 10 days)
VALIDATION_KEYS = ["rows", "duplicates", "bad_ohlc", "off_tick_share", "missing_session_minutes", "gaps_30min_plus"]


def contract_name(root: str, year: int, month: int) -> str:
    return f"{root}{MONTHS[month - 1]}{year % 100:02d}"


def ns_to_et(ns_list) -> List[pd.Timestamp]:
    return list(pd.to_datetime(pd.Series(ns_list, dtype="int64"), unit="ns", utc=True).dt.tz_convert(ET))


def _day_of(ns: int):
    """CME session day of a bar (bars from 18:00 ET belong to the next day) and the UTC ns where the next day starts."""
    t = dt.datetime.fromtimestamp(ns / 1e9, _UTC).astimezone(_ETZ)
    d = (t.replace(tzinfo=None) + dt.timedelta(hours=6)).date()
    nxt = dt.datetime.combine(d, dt.time(18, 0), _ETZ)          # session d ends where session d+1 starts: 18:00 ET of day d
    return d, int(nxt.astimezone(_UTC).timestamp()) * 1_000_000_000


class FullJob:
    """One cell of the cost x sizing grid (TradingView-style diagnostics and realistic futures costs)."""

    def __init__(self, scenario: str, sizing: str):
        self.name, self.ex, self.acc, self.n_amb = f"{scenario}__{sizing}", full_execution(scenario, sizing), PeriodAccumulator(), 0

    def segment(self, bars, seg, lo, hi, st, bar_at):
        r = run_segment(bars, seg, lo, hi, st, self.ex, None, self.acc)
        if r is not None:
            self.n_amb += len(ambiguous(r["trades"], bar_at))

    def result(self, hold_start):
        res, times = self.acc.result()
        return summarize(res, times, self.n_amb)


class MffuJob:
    """One pre-registered MFFU plan variant under one cost scenario (virtual accounts chained across the whole period)."""

    def __init__(self, cid: str, scenario: str, spec, news):
        self.name, self.cid, self.sc = f"{cid}__{scenario}", cid, scenario
        self.ov, self.ex, self.acc = make_overlay(cid, scenario, spec, news), execution_for(scenario, spec), PeriodAccumulator()

    def segment(self, bars, seg, lo, hi, st, bar_at):
        run_segment(bars, seg, lo, hi, st, self.ex, self.ov, self.acc)

    def result(self, hold_start):
        if self.acc.last is None:
            raise SystemExit("no front-contract bars in the period: the data does not cover it")
        self.ov.finish(self.acc.last)
        rep = self.ov.report(hold_start.date() if hold_start is not None else None)
        return {k: v for k, v in rep.items() if k != "attempts"}

    def featured(self, rep):
        from mffu_dashboard import account_view
        return account_view(self.ov, rep)


def make_jobs(mode: str, spec: str, instrument, news) -> List[Any]:
    """mode 'full': spec = comma list of S0..S3 scenarios (each with all 3 sizings); mode 'mffu': comma list of config ids or
    config:scenario items (a bare config id means all 4 pre-registered cost scenarios). Unknown names are refused."""
    from ote_replay import SCEN
    items = [x.strip() for x in spec.split(",") if x.strip()]
    if not items:
        raise ValueError("no jobs given")
    jobs = []
    if mode == "full":
        for sc in items:
            if sc not in SCEN:
                raise ValueError(f"unknown full scenario {sc}")
            jobs += [FullJob(sc, sz) for sz in SIZING]
    elif mode == "mffu":
        ids = {c[0] for c in CONFIGS}
        for it in items:
            cid, _, sc = it.partition(":")
            if cid not in ids or (sc and sc not in SCENARIOS):
                raise ValueError(f"unknown MFFU job {it}")
            jobs += [MffuJob(cid, s, instrument, news) for s in ([sc] if sc else SCENARIOS)]
    else:
        raise ValueError(f"unknown mode {mode}")
    names = [j.name for j in jobs]
    if len(set(names)) != len(names):
        raise ValueError("duplicate jobs")
    return jobs


class Stream:
    """Feed bars with add() in non-decreasing time order (all contracts of one minute together), then call finish()."""

    def __init__(self, root: str, lo: Optional[pd.Timestamp], hi: Optional[pd.Timestamp], jobs: List[Any], st: Optional[Settings] = None, tick: float = 0.25):
        self.root, self.lo, self.hi, self.jobs, self.st, self.tick = root, lo, hi, jobs, st or Settings(), tick
        self.bufs: Dict[str, Dict[str, list]] = {}
        self.day = None
        self.next_day_ns = None
        self.day_vol: Dict[str, float] = {}
        self.cur = None
        self.seg: Optional[Dict[str, Any]] = None
        self.segments: List[Dict[str, Any]] = []
        self.coverage: Dict[str, Dict[str, Any]] = {}
        self.validation: Dict[str, Dict[str, Any]] = {}
        self.first_ns = self.last_ns = None
        self.bars_in = self.bars_ignored = 0
        self.last_t = -1

    # ------------------------------------------------------------ input
    def add(self, sym: str, t_ns: int, o: float, h: float, l: float, c: float, v: float):
        if t_ns < self.last_t:
            raise ValueError("bars must arrive in time order")
        self.last_t = t_ns
        if self.hi is not None and t_ns >= self.hi.value:
            self.bars_ignored += 1
            return
        if self.next_day_ns is None or t_ns >= self.next_day_ns:
            d, self.next_day_ns = _day_of(t_ns)
            if d != self.day:
                self._new_day(d, t_ns)
        if self.first_ns is None:
            self.first_ns = t_ns
            if self.lo is None:
                self.lo = ns_to_et([t_ns])[0]
        self.last_ns = t_ns
        self.bars_in += 1
        self.day_vol[sym] = self.day_vol.get(sym, 0.0) + v
        b = self.bufs.get(sym)
        if b is None:
            b = self.bufs[sym] = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
        b["t"].append(t_ns); b["o"].append(o); b["h"].append(h); b["l"].append(l); b["c"].append(c); b["v"].append(v)
        cv = self.coverage.get(sym)
        if cv is None:
            cv = self.coverage[sym] = {"first": t_ns, "last": t_ns, "days": 0, "_d": None}
        cv["last"] = t_ns
        if cv["_d"] != self.day:
            cv["_d"] = self.day
            cv["days"] += 1

    def _new_day(self, d, t_ns):
        if self.day is not None:                       # schedule row for day d from day d-1's complete volume (rolls.front_schedule)
            prev = self.day_vol
            cand = max(sorted(prev), key=lambda s: prev[s])
            if self.cur is None:
                self.cur = cand
            elif expiry_key(cand, d.year) > expiry_key(self.cur, d.year) and prev[cand] > prev.get(self.cur, 0.0):
                self.cur = cand
            if self.seg is not None and self.seg["symbol"] == self.cur:
                self.seg["last_day"] = d
            else:
                if self.seg is not None:
                    self._close(self.seg)
                self.seg = {"symbol": self.cur, "first_day": d, "last_day": d}
        self.day, self.day_vol = d, {}
        cut = t_ns - PRUNE_DAYS * 86_400_000_000_000
        for sym, b in list(self.bufs.items()):        # only the segment being built needs its full history
            if self.seg is not None and sym == self.seg["symbol"]:
                continue
            k = bisect.bisect_left(b["t"], cut)
            if k:
                for f in b.values():
                    del f[:k]

    def _close(self, s):
        """rolls.segments(): 18:00 ET of the day before first_day to 17:00 ET of last_day, capped at the last trade time."""
        s = dict(s)
        s["start"] = pd.Timestamp(s["first_day"]).tz_localize(ET) - pd.Timedelta(hours=6)
        s["end"] = pd.Timestamp(s["last_day"]).tz_localize(ET) + pd.Timedelta(hours=17)
        y, m = expiry_key(s["symbol"], pd.Timestamp(s["first_day"]).year)
        ltt = last_trade_time(y, m)
        if s["end"] > ltt:
            s["end"] = ltt
            s["capped_at_expiry"] = True
        b = self.bufs.pop(s["symbol"], None)
        if s["start"] >= s["end"] or b is None:
            return
        self.segments.append(s)
        t_all = b["t"]
        lo_ns = s["start"].value
        hi_seg = s["end"] if self.hi is None else min(s["end"], self.hi)
        i0, i1 = bisect.bisect_left(t_all, lo_ns), bisect.bisect_left(t_all, hi_seg.value)
        if i1 > i0:   # data-quality counts for the contract's own window (no prices leave the backtest)
            sub = pd.DataFrame({"time": ns_to_et(t_all[i0:i1]), "open": b["o"][i0:i1], "high": b["h"][i0:i1], "low": b["l"][i0:i1],
                                "close": b["c"][i0:i1], "volume": b["v"][i0:i1]})
            v = validate(sub, self.tick)
            self.validation[s["symbol"]] = {k: v[k] for k in VALIDATION_KEYS}
        w = window(s, self.lo, self.hi) if self.hi is not None else window(s, self.lo, s["end"] + pd.Timedelta(minutes=1))
        if w is None:
            return
        a, bb = w
        j0, j1 = bisect.bisect_left(t_all, (a - WARMUP).value), bisect.bisect_left(t_all, bb.value)
        bars = {"t": ns_to_et(t_all[j0:j1]), "o": b["o"][j0:j1], "h": b["h"][j0:j1], "l": b["l"][j0:j1], "c": b["c"][j0:j1]}
        pos = {tt: k for k, tt in enumerate(bars["t"])}

        def bar_at(contract, t):
            k = pos.get(t)
            return None if k is None or contract != s["symbol"] else (bars["l"][k], bars["h"][k])
        hi_eff = self.hi if self.hi is not None else s["end"] + pd.Timedelta(minutes=1)
        for j in self.jobs:
            j.segment(bars, s, self.lo, hi_eff, self.st, bar_at)

    # ------------------------------------------------------------ output
    def finish(self, hold_start: Optional[pd.Timestamp]) -> Dict[str, Any]:
        if self.seg is not None:
            self._close(self.seg)
            self.seg = None
        runs, featured = {}, None
        for j in self.jobs:
            runs[j.name] = j.result(hold_start)
            if isinstance(j, MffuJob) and j.cid == "builder-50k" and j.sc == "C2_base":
                featured = j.featured(runs[j.name])
        return {"runs": runs, "featured_account": featured}

    def coverage_summary(self) -> Dict[str, Any]:
        fmt = lambda ns: ns_to_et([ns])[0].strftime("%Y-%m-%d %H:%M %Z")
        return {"contracts": {k: {"first_bar_et": fmt(v["first"]), "last_bar_et": fmt(v["last"]), "session_days": v["days"]}
                              for k, v in sorted(self.coverage.items(), key=lambda kv: expiry_key(kv[0], 2020))},
                "first_bar_et": fmt(self.first_ns) if self.first_ns else None, "last_bar_et": fmt(self.last_ns) if self.last_ns else None,
                "front_segments": [{"symbol": s["symbol"], "from": str(s["start"]), "to": str(s["end"]), "capped_at_expiry": bool(s.get("capped_at_expiry"))}
                                   for s in self.segments],
                "bars_used": self.bars_in, "bars_after_period_ignored": self.bars_ignored}


# ---------------------------------------------------------------- holdout boundary (same rule as the local reference)
def holdout_start_for(data_end: pd.Timestamp) -> pd.Timestamp:
    return (data_end - pd.Timedelta(days=365)).normalize()


# ---------------------------------------------------------------- result codec
def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()


def encode(payload: Dict[str, Any]) -> List[str]:
    raw = canonical(payload)
    blob = base64.b64encode(zlib.compress(raw, 9)).decode()
    sha = hashlib.sha256(raw).hexdigest()
    pid = sha[:12]
    parts = [blob[i:i + CHUNK] for i in range(0, len(blob), CHUNK)] or [""]
    lines = [f"{PREFIX} {pid} {i + 1}/{len(parts)} {p}" for i, p in enumerate(parts)]
    lines.append(f"{PREFIX} {pid} END sha256={sha} bytes={len(raw)}")
    return lines


def fits(lines: List[str]) -> bool:
    return sum(len(x) + 1 for x in lines) <= LOG_BUDGET


def decode_lines(text: str) -> Dict[str, Dict[str, Any]]:
    """All complete, checksum-valid payloads found in a QuantConnect log (any line prefix, e.g. timestamps, is ignored)."""
    import re
    chunks: Dict[str, Dict[int, str]] = {}
    totals: Dict[str, int] = {}
    ends: Dict[str, tuple] = {}
    for line in text.splitlines():
        m = re.search(rf"{PREFIX} ([0-9a-f]{{12}}) (\d+)/(\d+) ([A-Za-z0-9+/=]*)\s*$", line)
        if m:
            chunks.setdefault(m.group(1), {})[int(m.group(2))] = m.group(4)
            totals[m.group(1)] = int(m.group(3))
            continue
        m = re.search(rf"{PREFIX} ([0-9a-f]{{12}}) END sha256=([0-9a-f]{{64}}) bytes=(\d+)", line)
        if m:
            ends[m.group(1)] = (m.group(2), int(m.group(3)))
    out = {}
    for pid, (sha, n) in ends.items():
        got = chunks.get(pid, {})
        if totals.get(pid) is None or sorted(got) != list(range(1, totals[pid] + 1)):
            raise ValueError(f"payload {pid}: missing log lines (got {sorted(got)} of {totals.get(pid)})")
        raw = zlib.decompress(base64.b64decode("".join(got[i] for i in sorted(got))))
        if len(raw) != n or hashlib.sha256(raw).hexdigest() != sha or sha[:12] != pid:
            raise ValueError(f"payload {pid}: checksum mismatch")
        out[pid] = json.loads(raw)
    for pid in chunks:
        if pid not in ends:
            raise ValueError(f"payload {pid}: no END line (log truncated?)")
    return out


# ---------------------------------------------------------------- integrity and self-test
def normalized(text: str) -> str:
    """Line endings and trailing spaces normalized, so a copy pasted into the web IDE hashes the same."""
    lines = [x.rstrip() for x in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines) + "\n"


def file_sha(text: str) -> str:
    return hashlib.sha256(normalized(text).encode()).hexdigest()


def bundle_sha(manifest: Dict[str, str]) -> str:
    return hashlib.sha256("".join(f"{k}:{manifest[k]}\n" for k in sorted(manifest)).encode()).hexdigest()


def selftest_bars(n: int = 4000, seed: int = 7) -> Dict[str, list]:
    """Deterministic synthetic walk (Python's own PRNG, no market data) used to prove the cloud engine matches the local one."""
    rnd = random.Random(seed)
    t0 = pd.Timestamp("2024-03-04 18:00", tz=ET)
    t, o, h, l, c = [], [], [], [], []
    px = 18000.0
    for i in range(n):
        op = px
        px = op + rnd.choice((-3, -2, -1, 0, 1, 2, 3)) * 0.25 * rnd.choice((1, 1, 2, 4))
        t.append(t0 + pd.Timedelta(minutes=i)); o.append(op); c.append(px)
        h.append(max(op, px) + rnd.randint(0, 6) * 0.25); l.append(min(op, px) - rnd.randint(0, 6) * 0.25)
    return {"t": t, "o": o, "h": h, "l": l, "c": c}


def selftest() -> str:
    from mffu_calendar import NewsCalendar
    from mffu_instruments import MNQ
    bars = selftest_bars()
    st = Settings()
    a = run(bars, st, full_execution("S2_base", "fixed1"))
    ov = make_overlay("builder-50k", "C2_base", MNQ, NewsCalendar.official("union"))
    b = run(bars, st, execution_for("C2_base", MNQ), overlay=ov)
    ov.finish(bars["t"][-1])
    rep = ov.report(None)
    sig = {"plain": [(x.side, x.qty, str(x.entry_time), str(x.exit_time), round(x.entry, 6), round(x.exit, 6), round(x.net, 6), x.reason) for x in a["trades"]],
           "mffu": [(x.side, x.qty, str(x.entry_time), str(x.exit_time), round(x.net, 6), x.reason) for x in b["trades"]],
           "report": {k: v for k, v in rep.items() if k not in ("attempts",)}}
    return hashlib.sha256(canonical(sig)).hexdigest()


# ---------------------------------------------------------------- run plan (pre-registered boundaries, holdout seal)
def plan(mode: str, period: str, cfg) -> Dict[str, Any]:
    """Backtest dates and the replay period for one run. cfg is at_config. Raises instead of running anything unsealed."""
    if mode not in ("coverage", "full", "mffu"):
        raise ValueError(f"mode must be coverage, full or mffu (got {mode!r})")
    start = tuple(cfg.DATA_START)
    if mode == "coverage":
        return {"start": start, "end": None, "lo": None, "hi": None, "hold_start": None, "period": "coverage"}
    if not cfg.HOLDOUT_START or not cfg.DATA_END:
        raise ValueError("HOLDOUT_START and DATA_END are not frozen yet: run the coverage backtest and commit them in at_config.py first")
    hold = pd.Timestamp(cfg.HOLDOUT_START).tz_localize(ET)
    end_t = pd.Timestamp(cfg.DATA_END).tz_localize(ET)
    if hold != holdout_start_for(end_t):
        raise ValueError("HOLDOUT_START must equal DATA_END - 365 days at midnight ET (pre-registered rule)")
    if period == "dev":
        last = (hold - pd.Timedelta(days=1)).date()
        return {"start": start, "end": (last.year, last.month, last.day), "lo": None, "hi": hold, "hold_start": hold, "period": "dev"}
    if period == "holdout":
        if not cfg.DEV_RESULTS_SHA256:
            raise ValueError("REFUSED: the holdout is sealed until the development results are imported, committed and their SHA-256 is set in at_config.py")
        return {"start": start, "end": (end_t.year, end_t.month, end_t.day), "lo": hold, "hi": end_t + pd.Timedelta(minutes=1), "hold_start": hold, "period": "holdout"}
    raise ValueError(f"period must be dev or holdout (got {period!r})")


def build_payload(*, mode, period, jobs_spec, p, stream, result, bundle, sources, selftest_sha, config_a_sha, news_source, ff_skipped, orders, cfg) -> Dict[str, Any]:
    cov = stream.coverage_summary()
    out = {"schema": SCHEMA, "label": "SIMULATED research results computed inside QuantConnect Cloud. Summary statistics only; no market data.",
           "data": "QuantConnect US Futures (AlgoSeek) MNQ 1-minute trade bars, individual contracts, raw (unadjusted) prices",
           "mode": mode, "period": p["period"], "jobs_spec": jobs_spec, "runs": result["runs"], "featured_account": result["featured_account"],
           "bundle_sha256": bundle, "sources": sources, "selftest_sha256": selftest_sha, "config_a_sha256": config_a_sha,
           "news_calendar": news_source, "data_start": list(cfg.DATA_START), "data_end": cfg.DATA_END, "holdout_start": cfg.HOLDOUT_START,
           "dev_results_sha256": cfg.DEV_RESULTS_SHA256,
           "window": [str(stream.lo) if stream.lo is not None else None, str(p["hi"]) if p["hi"] is not None else None],
           "first_bar_et": cov["first_bar_et"], "last_bar_et": cov["last_bar_et"], "bars_used": cov["bars_used"],
           "fill_forward_bars_skipped": ff_skipped, "orders_placed": orders, "external_execution": "DISABLED"}
    if mode in ("coverage", "full"):
        out["coverage"] = cov
        out["validation_front"] = stream.validation
    if mode == "coverage" and stream.last_ns is not None:
        end = ns_to_et([stream.last_ns])[0]
        out["proposed"] = {"DATA_END": end.strftime("%Y-%m-%d %H:%M"), "HOLDOUT_START": holdout_start_for(end).strftime("%Y-%m-%d")}
    return out


def verify_sources(manifest: Dict[str, str]) -> Dict[str, Any]:
    """Hash every bundled file as it exists in the cloud project. MISMATCH means a paste error or an edit: the run stops."""
    import importlib
    import sys
    bad, missing = [], []
    for name, want in sorted(manifest.items()):
        mod = sys.modules.get(name[:-3])
        try:
            if mod is None:
                mod = importlib.import_module(name[:-3])
            with open(mod.__file__, encoding="utf-8") as f:
                got = file_sha(f.read())
        except Exception as e:   # the platform may not expose source files
            missing.append(f"{name}: {e.__class__.__name__}")
            continue
        if got != want:
            bad.append(name)
    status = "MISMATCH" if bad else "UNVERIFIABLE" if missing else "VERIFIED"
    return {"status": status, "mismatched": bad, "unreadable": missing[:5], "files": len(manifest)}
