"""Run Test A (TradingView-style) and Test B (realistic futures) on a 1-minute CSV and export everything.

  python run_backtests.py <csv> <SYMBOL MNQ|NQ> <out dir> [--symbol-col-filter SYMBOL]

Cost assumptions (no broker selected yet; labelled assumptions, not quotes):
  base:          $0.74 per contract per side all-in (broker + exchange + NFA), stop slippage 1 tick
  conservative:  $1.50 per side, stop slippage 2 ticks, limit orders need 1 tick trade-through, adverse-first intrabar path
"""
import json
import os
import sys

from ote_engine.data import load_csv, validate, to_bars
from ote_engine.strategy import Settings, Execution, run
from ote_engine.report import metrics, export

SPEC = {"MNQ": {"tick": 0.25, "point_value": 2.0}, "NQ": {"tick": 0.25, "point_value": 20.0}}


def main():
    path, sym, out = sys.argv[1], sys.argv[2], sys.argv[3]
    filt = sys.argv[sys.argv.index("--symbol-col-filter") + 1] if "--symbol-col-filter" in sys.argv else None
    df = load_csv(path, symbol=filt)
    spec = SPEC[sym]
    v = validate(df, spec["tick"])
    bars, times = to_bars(df), list(df["time"])
    st = Settings()
    runs = {
        "A_tradingview_fractional": Execution(name="A_tradingview_fractional", path="tv", sizing="fractional", **spec),
        "A_conservative_path_fractional": Execution(name="A_conservative_path_fractional", path="conservative", sizing="fractional", **spec),
        "A_strict_pivots_fractional": Execution(name="A_strict_pivots_fractional", path="tv", sizing="fractional", strict_pivots=True, **spec),
        "B_whole_base": Execution(name="B_whole_base", path="tv", sizing="whole", commission_per_side=0.74, stop_slip_ticks=1, **spec),
        "B_whole_conservative": Execution(name="B_whole_conservative", path="conservative", sizing="whole", commission_per_side=1.50, stop_slip_ticks=2, limit_through_ticks=1, **spec),
        "B_fixed1_base": Execution(name="B_fixed1_base", path="tv", sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1, **spec),
        "B_fixed1_conservative": Execution(name="B_fixed1_conservative", path="conservative", sizing="fixed1", commission_per_side=1.50, stop_slip_ticks=2, limit_through_ticks=1, **spec),
    }
    summary = {"data": {"file": os.path.basename(path), "symbol": sym, "validation": v}, "runs": {}}
    for name, ex in runs.items():
        res = run(bars, st, ex)
        m = metrics(res, times)
        export(res, m, os.path.join(out, name), times)
        summary["runs"][name] = {k: m.get(k) for k in ["trades", "net_profit", "profit_factor", "win_rate_pct", "max_drawdown_intraday", "avg_trade", "commissions", "exit_reasons", "risk_per_trade_usd", "weekly_median", "chronological"]} | {"rejected_setups": m["diag"]["rejected_setups"], "same_bar_trades": m["same_bar_trades"]}
        print(name, json.dumps(summary["runs"][name], default=str))
    with open(os.path.join(out, "SUMMARY.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)


if __name__ == "__main__":
    main()
