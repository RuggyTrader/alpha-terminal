"""Full MNQ validation on cached Databento data (Configuration A unchanged).

  python run_full.py <cache dir> <out dir>              DEVELOPMENT period only (everything before the holdout)
  python run_full.py <cache dir> <out dir> --holdout    the most recent 12 months; refused until dev results are committed

Scenarios (labelled ASSUMPTIONS; no broker selected):
  S0 none:          no commission, no slippage, TradingView path             (diagnostic)
  S1 optimistic:    $0.50 / contract / side, no slippage, TradingView path
  S2 base:          $0.74 / side, stop / market slippage 1 tick, TradingView path
  S3 conservative:  $1.50 / side, 2 ticks, limits need a 1-tick trade-through, adverse-first intrabar path
Sizing: fractional ($10 risk, NON-EXECUTABLE diagnostic), whole (floor; skip if < 1 contract), fixed1 (always 1 contract).
"""
import glob
import json
import os
import subprocess
import sys

import pandas as pd

from ote_engine.strategy import Settings, Execution, run
from ote_engine.rolls import front_schedule, segments, outright
from ote_engine.report import metrics, export
from ote_engine.data import validate

ET = "America/New_York"
SCEN = {"S0_none": dict(path="tv", commission_per_side=0.0, stop_slip_ticks=0),
        "S1_optimistic": dict(path="tv", commission_per_side=0.50, stop_slip_ticks=0),
        "S2_base": dict(path="tv", commission_per_side=0.74, stop_slip_ticks=1),
        "S3_conservative": dict(path="conservative", commission_per_side=1.50, stop_slip_ticks=2, limit_through_ticks=1)}
SIZING = ["fractional", "whole", "fixed1"]
WARMUP = pd.Timedelta(days=10)


def load_cache(cache, root="MNQ"):
    import databento as db   # reading local DBN files needs no API key
    frames, unmapped = [], 0
    pat = outright(root)
    for p in sorted(glob.glob(os.path.join(cache, "GLBX.MDP3", "ohlcv-1m", f"{root}.FUT", "*.dbn.zst"))):
        d = db.DBNStore.from_file(p).to_df().reset_index()[["ts_event", "symbol", "open", "high", "low", "close", "volume"]]
        unmapped += int(d["symbol"].isna().sum())
        frames.append(d[d["symbol"].str.match(pat, na=False)])   # outright contracts only: spreads are dropped per file, before they use memory
    if not frames:
        raise SystemExit(f"no cached {root} DBN files under {cache} (run fetch_databento.py first)")
    if unmapped:   # records whose instrument id has no symbology mapping are dropped, never guessed
        print(f"WARNING: {unmapped} records without a symbol mapping were dropped")
    df = pd.concat(frames, ignore_index=True)
    df["time"] = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(ET)
    return df.drop(columns=["ts_event"]).sort_values(["symbol", "time"]).drop_duplicates(["symbol", "time"]).reset_index(drop=True)


def run_period(df, segs, lo, hi, st, ex, overlay=None):
    trades, eqc, eql, times, offset = [], [], [], [], 0.0
    diag = {}
    for s in segs:
        a, b = max(s["start"], lo), min(s["end"], hi)
        if a >= b:
            continue
        sub = df[(df["symbol"] == s["symbol"]) & (df["time"] >= a - WARMUP) & (df["time"] < b)]
        bars = {"t": list(sub["time"]), "o": sub["open"].tolist(), "h": sub["high"].tolist(), "l": sub["low"].tolist(), "c": sub["close"].tolist()}
        r = run(bars, st, ex, window=(a, b), overlay=overlay)
        for x in r["trades"]:
            x.contract = s["symbol"]
        trades += r["trades"]
        mask = [a <= t < b for t in bars["t"]]
        for m, t, c, l in zip(mask, bars["t"], r["eq_close"], r["eq_low"]):
            if m:
                times.append(t); eqc.append(offset + c); eql.append(offset + l)
        offset += sum(x.net for x in r["trades"])
        for k, v in r["diag"].items():
            diag[k] = diag.get(k, 0) + v
    if not times:
        raise SystemExit(f"no front-contract bars between {lo} and {hi}: the cache does not cover this period")
    return {"trades": trades, "eq_close": eqc, "eq_low": eql, "diag": diag, "settings": r["settings"], "execution": r["execution"]}, times


def ambiguous(df, trades):
    """Trades whose outcome depends on the unknown order of prices inside one minute."""
    out = []
    idx = df.set_index(["symbol", "time"])
    for x in trades:
        if x.same_bar:
            out.append((x.contract, str(x.exit_time), "entry and exit in the same minute")); continue
        try:
            bar = idx.loc[(x.contract, x.exit_time)]
        except KeyError:
            continue
        s, tp = getattr(x, "exit_stop", None), getattr(x, "exit_tp", None)
        if s is not None and tp is not None and bar["low"] <= min(s, tp) and bar["high"] >= max(s, tp):
            out.append((x.contract, str(x.exit_time), "stop and TP2 both inside the exit minute"))
    return out


def main():
    cache, out = sys.argv[1], sys.argv[2]
    holdout = "--holdout" in sys.argv
    synthetic = os.path.exists(os.path.join(cache, "SYNTHETIC-NOT-MARKET-DATA.txt"))   # tests/synthetic_dbn.py rehearsal cache
    if synthetic and os.path.abspath(out).startswith(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"))):
        sys.exit("REFUSED: a synthetic rehearsal cache must not write under results/ (it is not evidence)")
    df = load_cache(cache)
    data_end = df["time"].max()
    hold_start = (data_end - pd.Timedelta(days=365)).normalize()
    if holdout:
        dev = os.path.join(out, "dev", "SUMMARY.json")
        try:
            subprocess.run(["git", "ls-files", "--error-unmatch", dev], check=True, capture_output=True)
            subprocess.run(["git", "diff", "--quiet", "HEAD", "--", dev], check=True)
        except Exception:
            print("REFUSED: the holdout is sealed until dev/SUMMARY.json is committed unchanged"); sys.exit(4)
    sched = front_schedule(df)
    segs = segments(sched)
    lo, hi = (hold_start, data_end + pd.Timedelta(minutes=1)) if holdout else (df["time"].min(), hold_start)
    tag = "holdout" if holdout else "dev"
    st = Settings()
    summary = {"period": tag, "synthetic": synthetic,
               "data": "SYNTHETIC REHEARSAL FIXTURE (not market data, not evidence)" if synthetic else "Databento GLBX.MDP3 ohlcv-1m MNQ.FUT, unadjusted per contract", "from": str(lo), "to": str(hi), "holdout_start": str(hold_start), "data_end": str(data_end),
               "contracts": sorted(df["symbol"].unique().tolist()), "rolls": [{k: str(v) for k, v in s.items()} for s in segs],
               "validation_front": {}, "runs": {}}
    for s in segs:   # validate each contract's bars inside its window
        sub = df[(df["symbol"] == s["symbol"]) & (df["time"] >= s["start"]) & (df["time"] < s["end"])][["time", "open", "high", "low", "close", "volume"]]
        if len(sub):
            v = validate(sub.reset_index(drop=True), 0.25)
            summary["validation_front"][s["symbol"]] = {k: v[k] for k in ["rows", "duplicates", "bad_ohlc", "off_tick_share", "missing_session_minutes", "gaps_30min_plus"]}
    for sc, kw in SCEN.items():
        for sz in SIZING:
            ex = Execution(name=f"{sc}__{sz}", sizing=sz, tick=0.25, point_value=2.0, **kw)
            res, times = run_period(df, segs, lo, hi, st, ex)
            m = metrics(res, times)
            m["ambiguous_trades"] = len(ambiguous(df, res["trades"]))
            m["roll_exits"] = sum(1 for x in res["trades"] if x.reason == "ROLL")
            m["trades_per_week"] = round(m["trades"] / max(1, m.get("weeks", 1)), 2)
            export(res, m, os.path.join(out, tag, ex.name), times)
            summary["runs"][ex.name] = {k: m.get(k) for k in ["trades", "trades_per_week", "net_profit", "profit_factor", "win_rate_pct", "avg_trade", "max_drawdown_realized", "max_drawdown_intraday",
                                                               "weekly_avg", "weekly_median", "weeks_positive", "weeks", "months_positive", "months", "best_week", "worst_week", "best_day", "worst_day",
                                                               "max_consecutive_losses", "long_net", "short_net", "exit_reasons", "commissions", "slippage_usd", "risk_per_trade_usd", "chronological",
                                                               "ambiguous_trades", "roll_exits", "same_bar_trades"]} | {"rejected_setups": m["diag"].get("rejected_setups", 0)}
            print(ex.name, json.dumps({k: summary["runs"][ex.name][k] for k in ["trades", "net_profit", "profit_factor", "win_rate_pct", "max_drawdown_intraday", "weekly_median"]}))
    os.makedirs(os.path.join(out, tag), exist_ok=True)
    with open(os.path.join(out, tag, "SUMMARY.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)


if __name__ == "__main__":
    main()
