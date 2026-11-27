"""Performance metrics and exports for a strategy run (historical simulation only)."""
from __future__ import annotations

import json
import math
import os
from dataclasses import asdict
from typing import Dict, Any, List

import pandas as pd


def _r(x, d=2):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), d)


def metrics(res: Dict[str, Any], times: List[pd.Timestamp]) -> Dict[str, Any]:
    tr = res["trades"]
    eqc, eql = res["eq_close"], res["eq_low"]
    m: Dict[str, Any] = {"execution": res["execution"]["name"], "trades": len(tr)}
    nets = [x.net for x in tr]
    wins, losses = [x for x in nets if x > 0], [x for x in nets if x <= 0]
    m["gross_profit"] = _r(sum(x.gross for x in tr if x.gross > 0)); m["gross_loss"] = _r(sum(x.gross for x in tr if x.gross <= 0))
    m["net_profit"] = _r(sum(nets)); m["commissions"] = _r(sum(x.commission for x in tr)); m["slippage_usd"] = _r(sum(x.slippage_usd for x in tr))
    gw, gl = sum(wins), -sum(losses)
    m["profit_factor"] = _r(gw / gl) if gl > 0 else (None if not wins else float("inf"))
    m["win_rate_pct"] = _r(100 * len(wins) / len(tr)) if tr else None
    m["avg_trade"] = _r(sum(nets) / len(tr)) if tr else None
    m["median_trade"] = _r(sorted(nets)[len(nets) // 2]) if tr else None
    # consecutive losses
    run = best = 0
    for x in nets:
        run = run + 1 if x <= 0 else 0; best = max(best, run)
    m["max_consecutive_losses"] = best
    # drawdowns: realized (trade-close equity) and intraday (bar extremes while in a position)
    peak = dd = 0.0; cum = 0.0
    for x in nets:
        cum += x; peak = max(peak, cum); dd = max(dd, peak - cum)
    m["max_drawdown_realized"] = _r(dd)
    peak = ddi = 0.0
    for c, lo in zip(eqc, eql):
        ddi = max(ddi, peak - lo); peak = max(peak, c)
    m["max_drawdown_intraday"] = _r(ddi)
    # by side / exit reason
    for s, nm in ((1, "long"), (-1, "short")):
        z = [x for x in tr if x.side == s]
        m[f"{nm}_trades"] = len(z); m[f"{nm}_net"] = _r(sum(x.net for x in z)); m[f"{nm}_win_rate_pct"] = _r(100 * sum(1 for x in z if x.net > 0) / len(z)) if z else None
    m["exit_reasons"] = {r: {"n": sum(1 for x in tr if x.reason == r), "net": _r(sum(x.net for x in tr if x.reason == r))} for r in sorted({x.reason for x in tr})}
    m["same_bar_trades"] = sum(1 for x in tr if x.same_bar)
    m["diag"] = res["diag"]
    if tr:
        rk = [x.risk_usd for x in tr]; rk.sort()
        m["risk_per_trade_usd"] = {"min": _r(rk[0]), "median": _r(rk[len(rk) // 2]), "p90": _r(rk[int(0.9 * (len(rk) - 1))]), "max": _r(rk[-1])}
    # calendar (America/New_York): every week / month of the data span counts, including no-trade ones
    if times:
        idx = pd.DatetimeIndex(times)
        span_w = pd.period_range(idx[0].tz_localize(None).to_period("W-SUN"), idx[-1].tz_localize(None).to_period("W-SUN"), freq="W-SUN")
        span_m = pd.period_range(idx[0].tz_localize(None).to_period("M"), idx[-1].tz_localize(None).to_period("M"), freq="M")
        wk = pd.Series(0.0, index=span_w); mo = pd.Series(0.0, index=span_m); dy: Dict[str, float] = {}
        for x in tr:
            et = pd.Timestamp(x.exit_time).tz_localize(None)
            wk[et.to_period("W-SUN")] += x.net; mo[et.to_period("M")] += x.net
            dy[str(et.date())] = dy.get(str(et.date()), 0.0) + x.net
        m["weeks"] = len(wk); m["weekly_avg"] = _r(wk.mean()); m["weekly_median"] = _r(wk.median()); m["weeks_positive"] = int((wk > 0).sum()); m["weeks_no_trade_or_zero"] = int((wk == 0).sum())
        m["best_week"] = [str(wk.idxmax()), _r(wk.max())]; m["worst_week"] = [str(wk.idxmin()), _r(wk.min())]
        m["monthly"] = {str(k): _r(v) for k, v in mo.items()}; m["months_positive"] = int((mo > 0).sum()); m["months"] = len(mo)
        if dy:
            b = max(dy, key=dy.get); w = min(dy, key=dy.get); m["best_day"] = [b, _r(dy[b])]; m["worst_day"] = [w, _r(dy[w])]
        # chronological split (no parameters were fitted; this shows stability, not a true out-of-sample test)
        cut = idx[0] + (idx[-1] - idx[0]) * 0.7
        first = [x for x in tr if pd.Timestamp(x.exit_time) < cut]; last = [x for x in tr if pd.Timestamp(x.exit_time) >= cut]
        def pf(z):
            g = sum(x.net for x in z if x.net > 0); l_ = -sum(x.net for x in z if x.net <= 0)
            return _r(g / l_) if l_ > 0 else None
        m["chronological"] = {"first_70pct": {"trades": len(first), "net": _r(sum(x.net for x in first)), "pf": pf(first)}, "last_30pct": {"trades": len(last), "net": _r(sum(x.net for x in last)), "pf": pf(last)}}
    return m


def export(res: Dict[str, Any], m: Dict[str, Any], out_dir: str, times: List[pd.Timestamp]):
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for x in res["trades"]:
        d = {k: v for k, v in asdict(x).items()}
        d["entry_time"], d["exit_time"] = str(x.entry_time), str(x.exit_time)
        rows.append(d)
    pd.DataFrame(rows).to_csv(os.path.join(out_dir, "trades.csv"), index=False)
    pd.DataFrame({"time": [str(t) for t in times], "equity_close": res["eq_close"], "equity_low": res["eq_low"]}).iloc[::15].to_csv(os.path.join(out_dir, "equity_15min.csv"), index=False)
    with open(os.path.join(out_dir, "config.json"), "w") as f:
        json.dump({"settings": res["settings"], "execution": res["execution"]}, f, indent=1)
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(m, f, indent=1, default=str)
