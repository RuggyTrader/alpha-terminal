"""Historical MFFU evaluation: the locked OTE strategy (Configuration A) traded through virtual MFFU accounts.

MffuOverlay plugs into ote_engine.strategy.run(overlay=...). It keeps a chain of SIMULATED accounts:
  evaluation attempt -> (passed) sim funded -> (documented promotion) hypothetical live -> ... and after any breach or
  inactivity a NEW evaluation attempt starts on the next trading day (after the documented 21-day cooldown following a
  live breach). Every attempt, including every failed one, is kept. A stage whose rules were not read is not simulated:
  the chain records "stage rules unresolved" and starts a new evaluation.

The strategy's inputs and logic are unchanged. The overlay only refuses orders (compliance gate) and flattens positions
where an account rule requires it, and every refusal and flatten is counted. A historical simulated pass does not mean
an actual evaluation would pass.
"""
from __future__ import annotations

import datetime as dt
import math
from typing import Any, Dict, List, Optional

import mffu_rules as R
from mffu_account import VirtualAccount, ACTIVE, PAUSED_DLL, BREACHED, PASSED, INACTIVE, ENDED
from mffu_calendar import session_day, mffu_flat_time, NewsCalendar
from mffu_compliance import ComplianceEngine, OrderIntent, MarketState
from mffu_instruments import FuturesSpec, MNQ, CostScenario

ONE_MIN = dt.timedelta(minutes=1)
EVAL_PRICE = {("builder", "50k"): (153.0, "S12"), ("builder", "50k_addon"): (125.0, "S12")}   # prices shown at retrieval; others not read


class MffuOverlay:
    def __init__(self, plan: str, size: str, choices: Dict[str, Dict[str, Any]], scenario: CostScenario, spec: FuturesSpec = MNQ,
                 news: Optional[NewsCalendar] = None, label: str = ""):
        self.plan, self.size, self.spec, self.scenario, self.label = plan, size, spec, scenario, label
        self.cfgs: Dict[str, Optional[Dict[str, Any]]] = {}
        self.unresolved_stage: Dict[str, str] = {}
        for stg in R.STAGES:
            try:
                self.cfgs[stg] = R.resolve(plan, size, stg, choices.get(stg, {}), require=R.REQUIRED)
            except R.UnresolvedRule as e:
                self.cfgs[stg] = None
                self.unresolved_stage[stg] = str(e)
        if self.cfgs["evaluation"] is None:
            raise R.UnresolvedRule(self.unresolved_stage["evaluation"])
        self.compliance = ComplianceEngine(scenario, news)
        self.acct: Optional[VirtualAccount] = None
        self.next_stage, self.wait_until = "evaluation", None
        self.day: Optional[dt.date] = None
        self.attempt = 0
        self.history: List[Dict[str, Any]] = []
        self._trades: List[tuple] = []
        self.last_eq_close = 0.0
        self._pending_eod = None      # day-end deferred until a session-end flatten has been booked
        self.c = dict(session_flattens=0, news_flattens=0, breach_flattens=0, dll_flattens=0, held_across_session_rule_unresolved=0,
                      orphan_trades=0, stage_unresolved_skips=0)

    # ------------------------------------------------------------ chain management
    def _open(self, day: dt.date, t):
        stg = self.next_stage
        cfg = self.cfgs.get(stg)
        if cfg is None:
            self.c["stage_unresolved_skips"] += 1
            stg, cfg = "evaluation", self.cfgs["evaluation"]
        if stg == "evaluation":
            self.attempt += 1
        self.acct = VirtualAccount(cfg, f"{self.plan}/{self.size}#{self.attempt}:{stg}", day)
        self.acct.start_day(day, t)

    def _close(self, t):
        a = self.acct
        if a is None:
            return
        s = a.summary()
        s["attempt"] = self.attempt
        nxt, wait = "evaluation", (a.closed_day or self.day) + dt.timedelta(days=1)
        if a.status == PASSED:
            nxt = "sim_funded"
            if self.cfgs["sim_funded"] is None:
                s["next"] = "sim-funded rules unresolved: " + self.unresolved_stage.get("sim_funded", "")
                nxt = "evaluation"
        elif a.status == "PROMOTED_TO_LIVE":
            nxt = "live_hypothetical"
            if self.cfgs["live_hypothetical"] is None:
                s["next"] = "live rules unresolved"
                nxt = "evaluation"
        elif a.status == BREACHED and a.stage == "live_hypothetical":
            cd = (a.cfg.get("cooldown_after_live_breach_days") or 0)
            wait = (a.closed_day or self.day) + dt.timedelta(days=int(cd) + 1)
        self.history.append(s)
        self.acct, self.next_stage, self.wait_until = None, nxt, wait

    def _promotion_due(self) -> bool:
        a = self.acct
        p = a.cfg.get("payout") or {}
        if a.stage != "sim_funded":
            return False
        need = p.get("to_live_after_payouts") or p.get("live_after_consecutive_payouts")
        return bool(need) and len(a.payouts) >= int(need)

    def _end_day(self, t, flat: bool):
        a = self.acct
        if a is None or self.day is None:
            return
        a.end_day(self.day, t, self.last_eq_close, flat)
        if a.status == ACTIVE and a.stage == "sim_funded" and flat:
            lim = a.cfg.get("to_live_session_profit")
            if lim and a.daily.get(self.day.isoformat(), 0.0) >= float(lim):
                a.status, a.closed_day, a.end_reason = "PROMOTED_TO_LIVE", self.day, f"net profit >= ${lim:,.0f} in one session (S23; excess forfeited, not simulated)"
            else:
                a.try_payout(self.day, t)
                if self._promotion_due():
                    a.status, a.closed_day, a.end_reason = "PROMOTED_TO_LIVE", self.day, "documented payout count reached"
        if a.status not in (ACTIVE, PAUSED_DLL):
            self._close(t)

    # ------------------------------------------------------------ engine hooks
    def _eq(self, pos, px):
        a = self.acct
        if pos is None:
            return a.balance
        return a.balance + pos.side * (px - pos.entry) * pos.qty * self.spec.multiplier - self.scenario.commission_per_side * pos.qty

    def on_bar(self, k, t, o, h, l, c, pos):
        d = session_day(t)
        if d != self.day:
            if self._pending_eod is not None:
                self.last_eq_close = self.acct.balance if self.acct else 0.0
                self._end_day(self._pending_eod, flat=True)
                self._pending_eod = None
            self.day = d
            if self.acct is None and (self.wait_until is None or d >= self.wait_until):
                self._open(d, t)
            elif self.acct is not None:
                self.acct.start_day(d, t)
        a = self.acct
        if a is None:
            return None
        if pos is None:
            lo = cl = hi = a.balance
        else:
            worst, best = (l, h) if pos.side > 0 else (h, l)
            lo, cl, hi = self._eq(pos, worst), self._eq(pos, c), self._eq(pos, best)
        self.last_eq_close = cl
        act = a.mark(t, lo, cl, hi)
        if act is None:
            return None
        kind, thr = act
        if kind == "ACCT_BREACH":
            a.breach(t, f"equity {lo:.2f} below minimum balance {a.floor:.2f} intrabar", lo)
            self.c["breach_flattens"] += pos is not None
        else:
            a.pause(t, lo)
            self.c["dll_flattens"] += pos is not None
        if pos is None:
            if kind == "ACCT_BREACH":
                self._close(t)
            return None
        tick, mult, s = self.spec.tick, self.spec.multiplier, pos.side
        px = pos.entry + s * (thr - a.balance + self.scenario.commission_per_side * pos.qty) / (pos.qty * mult)
        px = (math.floor(px / tick + 1e-9) if s > 0 else math.ceil(px / tick - 1e-9)) * tick
        px = (o if px > o else max(px, l)) if s > 0 else (o if px < o else min(px, h))
        return (kind, px)

    def on_closed(self, tr, t):
        a = self.acct
        if a is None:
            self.c["orphan_trades"] += 1
            return
        before = a.balance
        a.on_trade(tr, self.day)
        self._trades.append((a.id, a.stage, tr))   # materialized later: the engine classifies the exit reason after this hook
        if a.status == ACTIVE and a.cfg["breach_basis"] == "intraday_equity":
            low = before - tr.mae_points * tr.qty * self.spec.multiplier - self.scenario.commission_per_side * tr.qty
            if low < a.floor:   # adverse excursion inside the exit bar that the per-bar mark could not see
                a.breach(t, f"trade low equity {low:.2f} below minimum balance {a.floor:.2f}", low)
        if a.status == BREACHED:
            self._close(t)

    def admit(self, ctx) -> bool:
        a = self.acct
        t = ctx["t"]
        intent = OrderIntent(client_id=f"{a.id if a else 'NONE'}:{ctx['setup']}:{ctx['k']}", account_id=a.id if a else "", symbol=self.spec.root,
                             side=ctx["side"], qty=ctx["qty"], order_type="LIMIT", price=ctx["price"], stop_loss=ctx["stop"],
                             take_profit=ctx["tp"], source="STRATEGY", created_at=str(t))
        m = MarketState(now=t + ONE_MIN, last_bar_time=t, last_price=ctx["last"], live_from=t + ONE_MIN)
        return self.compliance.check(intent, a, m, None).accepted

    def end_of_bar(self, k, t, t_next, pos) -> Optional[str]:
        a = self.acct
        new_day = t_next is None or session_day(t_next) != session_day(t)
        why = None
        if a is not None and pos is not None:
            f = a.cfg.get("flat_by_session_end")
            flat_t = mffu_flat_time(t)
            due = new_day or t + ONE_MIN >= flat_t or (t_next is not None and t_next >= flat_t)
            if f and due:
                why = "ACCT_SESSION_END"; self.c["session_flattens"] += 1      # S17: auto-close at 4:10 PM ET / before a holiday close
            elif f is None and new_day:
                self.c["held_across_session_rule_unresolved"] += 1
            if why is None and a.cfg.get("t1_news_allowed") is False and self.compliance.news.covers(t, t + ONE_MIN):
                if self.compliance.news.in_window(t + ONE_MIN, (t_next or t) + ONE_MIN):
                    why = "ACCT_NEWS_FLAT"; self.c["news_flattens"] += 1
        if new_day and a is not None:
            if why is not None:
                self._pending_eod = t + ONE_MIN   # flatten first; day-end runs on the flat account at the next bar or finish()
                return why
            self._end_day(t + ONE_MIN, flat=pos is None)
            if self.acct is None:
                return "ACCT_CLOSED"   # cancel any pending entry admitted under the closed account
        return why

    def finish(self, t_last):
        if self._pending_eod is not None and self.acct is not None:
            self.last_eq_close = self.acct.balance
            self._end_day(self._pending_eod, flat=True)
            self._pending_eod = None
        if self.acct is not None:
            a = self.acct
            if a.status in (ACTIVE, PAUSED_DLL):
                a.status, a.closed_day, a.end_reason = ENDED, self.day, "end of data (still open)"
            self._close(t_last)

    @property
    def trades(self) -> List[Dict[str, Any]]:
        return [{"account": aid, "stage": stg, "entry_time": str(tr.entry_time), "exit_time": str(tr.exit_time), "side": tr.side, "qty": tr.qty,
                 "entry": tr.entry, "exit": tr.exit, "reason": tr.reason, "net": round(tr.net, 2), "commission": round(tr.commission, 2),
                 "slippage": round(tr.slippage_usd, 2), "contract": tr.contract} for aid, stg, tr in self._trades]

    # ------------------------------------------------------------ report
    def report(self, holdout_start: Optional[dt.date] = None) -> Dict[str, Any]:
        H = self.history
        def agg(rows):
            ev = [r for r in rows if r["stage"] == "evaluation"]
            done = [r for r in ev if r["status"] in (PASSED, BREACHED, INACTIVE)]
            passed = [r for r in ev if r["status"] == PASSED]
            reasons: Dict[str, int] = {}
            for r in ev:
                if r["status"] in (BREACHED, INACTIVE):
                    key = r["status"] + ": " + ("intrabar minimum balance" if "intrabar" in r["reason"] else "trade low below minimum" if "trade low" in r["reason"]
                                                else "end-of-day equity" if "end-of-day" in r["reason"] else r["reason"])
                    reasons[key] = reasons.get(key, 0) + 1
            med = lambda xs: (sorted(xs)[len(xs) // 2] if xs else None)
            sim = [r for r in rows if r["stage"] == "sim_funded"]
            live = [r for r in rows if r["stage"] == "live_hypothetical"]
            pays = [p for r in rows for p in r["payouts"]]
            price = EVAL_PRICE.get((self.plan, self.size))
            return {
                "evaluation_attempts": len(ev), "completed": len(done), "passed": len(passed), "breached": sum(r["status"] == BREACHED for r in ev),
                "inactive": sum(r["status"] == INACTIVE for r in ev), "open_at_end": sum(r["status"] == ENDED for r in ev),
                "pass_rate_pct": round(100 * len(passed) / len(done), 1) if done else None,
                "median_calendar_days_to_pass": med([r["calendar_days"] for r in passed]), "median_trading_days_to_pass": med([r["trading_days"] for r in passed]),
                "median_trading_days_to_fail": med([r["trading_days"] for r in ev if r["status"] == BREACHED]),
                "failure_reasons": reasons, "consistency_delays": sum(1 for r in ev for e in r["events"] if e["kind"] == "TARGET_REACHED_CONSISTENCY_PENDING"),
                "sim_funded_accounts": len(sim), "sim_breached": sum(r["status"] == BREACHED for r in sim), "promoted_to_live": sum(r["status"] == "PROMOTED_TO_LIVE" for r in sim),
                "live_accounts": len(live), "live_breached": sum(r["status"] == BREACHED for r in live),
                "simulated_payouts": len(pays), "payouts_gross": round(sum(p["gross"] for p in pays), 2), "payouts_trader_share": round(sum(p["trader_share"] for p in pays), 2),
                "evaluation_fees_if_documented": (round(price[0] * len(ev), 2), price[1]) if price else "price not read",
                "net_pnl_all_accounts": round(sum(r["net_pnl"] for r in rows), 2),
                "trades": sum(r["trades"] for r in rows), "commissions": round(sum(r["commissions"] for r in rows), 2), "slippage": round(sum(r["slippage"] for r in rows), 2),
                "dll_soft_pauses": sum(r["dll_pauses"] for r in rows), "worst_attempt_drawdown": max([r["max_drawdown"] for r in rows] or [0]),
            }
        T = self.trades
        wins = [x["net"] for x in T if x["net"] > 0]; losses = [-x["net"] for x in T if x["net"] < 0]
        out = {
            "label": "SIMULATED MFFU accounts (historical research). Not an MFFU account, not a guarantee of evaluation results.",
            "plan": f"{self.plan}/{self.size}", "run_label": self.label, "scenario": self.scenario.name, "scenario_label": self.scenario.label,
            "choices": {k: (v or {}).get("_choices") for k, v in self.cfgs.items()}, "unresolved_stages": self.unresolved_stage,
            "unresolved_fields": {k: (v or {}).get("_unresolved") for k, v in self.cfgs.items()},
            "rules_hash": {k: (v or {}).get("_rules_hash") for k, v in self.cfgs.items()},
            "all": agg(H),
            "pooled_trades": {"trades": len(T), "win_rate_pct": round(100 * len(wins) / len(T), 2) if T else None,
                              "profit_factor": round(sum(wins) / sum(losses), 3) if losses else None,
                              "expectancy": round(sum(x["net"] for x in T) / len(T), 2) if T else None,
                              "net": round(sum(x["net"] for x in T), 2), "exit_reasons": _count(T, "reason")},
            "overlay_counters": self.c, "compliance_counts": dict(sorted(self.compliance.counts.items())),
            "attempts": H,
        }
        if holdout_start is not None:
            out["development"] = agg([r for r in H if r["opened"] < holdout_start.isoformat()])
            out["holdout"] = agg([r for r in H if r["opened"] >= holdout_start.isoformat()])
        dev = [r for r in H if holdout_start is None or r["opened"] < holdout_start.isoformat()]
        if dev:
            mid = dev[len(dev) // 2]["opened"]
            out["chronological"] = {"split_at": mid, "first_half": agg([r for r in dev if r["opened"] < mid]), "second_half": agg([r for r in dev if r["opened"] >= mid])}
        return out


def _count(rows, key):
    d: Dict[str, int] = {}
    for r in rows:
        d[r[key]] = d.get(r[key], 0) + 1
    return d
