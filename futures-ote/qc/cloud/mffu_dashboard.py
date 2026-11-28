"""Dashboard snapshot for the ALPHA TERMINAL "MFFU research" page. Static JSON, SIMULATED values only."""
from __future__ import annotations

import datetime as dt
from typing import Any, Dict, Optional

import mffu_rules as R
from mffu_execution import INTEGRATION_STATUS
from mffu_sources import SOURCES, CONTRADICTIONS, NOT_STATED, RETRIEVED

SCHEMA = "alpha-terminal.mffu-research.v1"
KEY_FIELDS = ["profit_target", "max_loss", "drawdown_type", "daily_loss_limit", "consistency_pct", "min_trading_days", "max_minis", "max_micros",
              "t1_news_allowed", "inactivity_days", "flat_by_session_end", "breach_basis", "lock_offset"]


def account_view(ov, acct_summary: Dict[str, Any]) -> Dict[str, Any]:
    """The simulated account at the end of the historical replay (the last account in the chain)."""
    a = ov.history[-1] if ov.history else None
    if a is None:
        return {}
    cfg = ov.cfgs.get(a["stage"]) or {}
    tgt = cfg.get("profit_target")
    pnl = a["balance"]
    dll = cfg.get("daily_loss_limit")
    return {
        "account_id": a["account_id"], "stage": a["stage"], "status": a["status"], "reason": a["reason"], "opened": a["opened"], "closed": a["closed"],
        "equity_simulated": pnl, "minimum_balance": a["floor"], "remaining_drawdown": round(pnl - a["floor"], 2),
        "profit_target": tgt, "target_progress_pct": round(100 * pnl / tgt, 1) if tgt else None,
        "daily_loss_limit": dll, "daily_allowance_note": "soft pause (not a breach)" if dll else "no daily loss limit on this stage",
        "consistency": a["consistency"], "trading_days": a["trading_days"], "min_trading_days": cfg.get("min_trading_days"),
        "violations": [e for e in a["events"] if e["kind"] in ("BREACH", "DLL_SOFT_PAUSE", "INACTIVITY", "TARGET_REACHED_CONSISTENCY_PENDING")][-10:],
        "configuration": {k: cfg.get(k) for k in KEY_FIELDS}, "choices": a["choices"], "unresolved": a["unresolved"],
    }


def snapshot(summary: Dict[str, Any], featured: Optional[tuple], data_note: str, demo: bool) -> Dict[str, Any]:
    runs = []
    for name, r in summary["runs"].items():
        x = r["all"]
        runs.append({"run": name, "evidence": not demo, "data": data_note, "plan": r["plan"], "scenario": r["scenario"], "attempts": x["evaluation_attempts"], "passed": x["passed"],
                     "breached": x["breached"], "open_at_end": x["open_at_end"], "pass_rate_pct": x["pass_rate_pct"],
                     "median_trading_days_to_pass": x["median_trading_days_to_pass"], "failure_reasons": x["failure_reasons"],
                     "net_pnl": x["net_pnl_all_accounts"], "payouts_trader_share": x["payouts_trader_share"], "trades": x["trades"],
                     "commissions": x["commissions"], "slippage": x["slippage"], "worst_drawdown": x["worst_attempt_drawdown"],
                     "profit_factor": r["pooled_trades"]["profit_factor"], "win_rate_pct": r["pooled_trades"]["win_rate_pct"],
                     "expectancy": r["pooled_trades"]["expectancy"], "consistency_delays": x["consistency_delays"],
                     "refusals": {k: v for k, v in r["compliance_counts"].items() if k != "ACCEPTED"}})
    plans = []
    for (p, s), stages in sorted(R.PLANS.items()):
        ev = stages["evaluation"]
        plans.append({"plan": f"{p}/{s}", "stages_documented": [k for k, v in stages.items() if v is not None],
                      "evaluation": {k: {"value": ev[k].value, "status": ev[k].status} for k in KEY_FIELDS if k in ev}})
    return {
        "schema": SCHEMA, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "simulated": True,
        "label": "SIMULATED — virtual MFFU research accounts. Not an MFFU account. Not approved by MFFU. Historical simulated passes do not guarantee real results.",
        "demo": demo, "data": data_note, "strategy": summary["strategy"], "period": summary["period"], "news_calendar": summary["news_calendar"],
        "external_execution": INTEGRATION_STATUS["external_execution"], "integration": INTEGRATION_STATUS,
        "account": (featured if isinstance(featured, dict) else account_view(*featured)) if featured else {}, "results": runs, "plans": plans,
        "sources": [{"id": k, "title": v[0], "url": v[1], "page_date": v[2]} for k, v in SOURCES.items()], "retrieved": RETRIEVED,
        "contradictions": CONTRADICTIONS, "not_stated": NOT_STATED,
    }
