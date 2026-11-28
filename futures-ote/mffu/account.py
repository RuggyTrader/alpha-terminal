"""Virtual MFFU account (one stage of one attempt). SIMULATED: no real account, no money, no external connection.

Balances are P&L relative to the account size (a $50,000 account starts at 0). Rules come from rules.resolve(), so every
value is DOCUMENTED, a labelled ASSUMPTION or an explicit caller choice for an UNRESOLVED rule.

Drawdown (minimum balance = "floor"):
  eod_trailing       floor = min(highest end-of-day closed balance - MLL, start + lock_offset); moves only at day end.
  intraday_trailing  floor = min(highest equity incl. unrealized - MLL, start + lock_offset); moves intrabar (S11).
  static             fixed (Pro after the first payout, S10).
Breach: equity (incl. open P&L) below the floor. With breach_basis "intraday_equity" this is tested on every bar's
worst price; with "eod_equity" only at day end. Inside a bar the high is applied before the low (stricter for trailing).
Soft daily loss limit: a day's equity P&L at or below -DLL flattens and pauses until the next trading day; not a breach.
"""
from __future__ import annotations

import datetime as dt
from typing import Any, Dict, List, Optional, Tuple

ACTIVE, PAUSED_DLL, BREACHED, PASSED, INACTIVE, ENDED, TO_LIVE = "ACTIVE", "PAUSED_DLL", "BREACHED", "PASSED", "INACTIVE", "ENDED", "PROMOTED_TO_LIVE"


class VirtualAccount:
    def __init__(self, cfg: Dict[str, Any], account_id: str, opened_day: dt.date):
        self.cfg = cfg
        self.id = account_id
        self.stage = cfg["_stage"]
        s = float(cfg["start_balance"] or 0.0)
        self.start = s
        self.balance = s
        self.eod_high = s
        self.peak_equity = s
        self.floor = s - float(cfg["max_loss"])
        self.static_floor: Optional[float] = None
        self.status = ACTIVE
        self.opened_day, self.closed_day = opened_day, None
        self.day: Optional[dt.date] = None
        self.day_start_balance = s
        self.daily: Dict[str, float] = {}
        self.trading_days: List[str] = []
        self.events: List[Dict[str, Any]] = []
        self.last_activity_day = opened_day
        self.stats = dict(trades=0, wins=0, losses=0, gross_profit=0.0, gross_loss=0.0, commissions=0.0, slippage=0.0, net=0.0)
        self.max_equity, self.min_equity, self.max_dd = s, s, 0.0
        self.payouts: List[Dict[str, Any]] = []
        self.cycle_start_balance, self.cycle_start_day = s, opened_day
        self.first_trade_day: Optional[dt.date] = None
        self.end_reason = ""

    # ------------------------------------------------------------------ helpers
    def ev(self, t, kind, **kw):
        self.events.append({"t": str(t), "kind": kind, **kw})

    def _recompute_floor(self):
        if self.static_floor is not None:
            self.floor = self.static_floor
            return
        base = self.eod_high if self.cfg["drawdown_type"] == "eod_trailing" else self.peak_equity
        cand = min(base - float(self.cfg["max_loss"]), self.start + float(self.cfg["lock_offset"]))
        self.floor = max(self.floor, cand)   # never moves down

    def remaining_drawdown(self, equity: float) -> float:
        return equity - self.floor

    def remaining_daily(self, equity: float) -> Optional[float]:
        dll = self.cfg.get("daily_loss_limit")
        return None if not dll else float(dll) + (equity - self.day_start_balance)

    def accepting(self) -> bool:
        return self.status == ACTIVE

    # ------------------------------------------------------------------ day handling
    def start_day(self, day: dt.date, t):
        self.day = day
        self.day_start_balance = self.balance
        if self.status == PAUSED_DLL:
            self.status = ACTIVE
            self.ev(t, "DLL_PAUSE_LIFTED")

    def end_day(self, day: dt.date, t, equity_close: float, flat: bool):
        """Day-end processing: EOD breach test (if chosen), EOD high and floor, target / consistency, inactivity."""
        if self.status not in (ACTIVE, PAUSED_DLL):
            return
        if self.cfg["breach_basis"] == "eod_equity" and equity_close < self.floor:
            return self.breach(t, f"end-of-day equity {equity_close:.2f} below minimum balance {self.floor:.2f}", equity_close)
        self.eod_high = max(self.eod_high, self.balance)           # A_EOD_HIGH: closed balance
        self._recompute_floor()
        inact = self.cfg.get("inactivity_days")
        if inact and (day - self.last_activity_day).days >= int(inact):
            self.status, self.closed_day, self.end_reason = INACTIVE, day, f"no trade for {inact} calendar days (consequence not stated by MFFU)"
            self.ev(t, "INACTIVITY", days=inact)
            return
        if self.stage == "evaluation":
            self._check_pass(day, t, flat)

    def consistency(self) -> Dict[str, Any]:
        pct = self.cfg.get("consistency_pct")
        total = self.balance - self.start
        best = max([v for v in self.daily.values()] or [0.0])
        if pct is None:
            return {"rule": None, "ok": True, "best_day": best, "total": total}
        ok = total > 0 and best <= pct * total + 1e-9
        return {"rule": pct, "ok": ok, "best_day": best, "total": total, "cap_now": pct * total}

    def _check_pass(self, day, t, flat):
        tgt = self.cfg.get("profit_target")
        if tgt is None or self.balance - self.start < float(tgt):
            return
        days_ok = len(self.trading_days) >= int(self.cfg.get("min_trading_days") or 0)
        cons = self.consistency()
        if not flat:
            self.ev(t, "TARGET_REACHED_POSITION_OPEN"); return
        if not days_ok:
            self.ev(t, "TARGET_REACHED_MIN_DAYS_PENDING", days=len(self.trading_days)); return
        if not cons["ok"]:
            self.ev(t, "TARGET_REACHED_CONSISTENCY_PENDING", best_day=round(cons["best_day"], 2), total=round(cons["total"], 2)); return
        self.status, self.closed_day, self.end_reason = PASSED, day, "profit target, minimum days and consistency met"
        self.ev(t, "PASSED", balance=round(self.balance, 2))

    # ------------------------------------------------------------------ marks and fills
    def mark(self, t, eq_low: float, eq_close: float, eq_high: float) -> Optional[Tuple[str, float]]:
        """Per-bar check with equity at the bar's best, close and worst prices. Returns (action, threshold equity)."""
        if self.status != ACTIVE:
            return None
        if self.cfg["drawdown_type"] == "intraday_trailing" and self.static_floor is None:
            self.peak_equity = max(self.peak_equity, eq_high)
            self._recompute_floor()
        self.max_equity = max(self.max_equity, eq_high)
        self.min_equity = min(self.min_equity, eq_low)
        self.max_dd = max(self.max_dd, self.max_equity - eq_low)
        if self.cfg["breach_basis"] == "intraday_equity" and eq_low < self.floor:
            return ("ACCT_BREACH", self.floor)
        dll = self.cfg.get("daily_loss_limit")
        if dll and eq_low - self.day_start_balance <= -float(dll):
            return ("ACCT_DLL_PAUSE", self.day_start_balance - float(dll))
        return None

    def on_trade(self, tr, day: dt.date):
        net = float(tr.net)
        self.balance += net
        k = day.isoformat()
        self.daily[k] = self.daily.get(k, 0.0) + net
        if k not in self.trading_days:
            self.trading_days.append(k)
        self.last_activity_day = day
        self.first_trade_day = self.first_trade_day or day
        s = self.stats
        s["trades"] += 1; s["net"] += net; s["commissions"] += tr.commission; s["slippage"] += tr.slippage_usd
        if net > 0:
            s["wins"] += 1; s["gross_profit"] += net
        elif net < 0:
            s["losses"] += 1; s["gross_loss"] += -net

    def breach(self, t, why: str, equity: float):
        self.status, self.closed_day, self.end_reason = BREACHED, self.day, why
        self.ev(t, "BREACH", why=why, equity=round(equity, 2), floor=round(self.floor, 2))

    def pause(self, t, equity: float):
        self.status = PAUSED_DLL
        self.ev(t, "DLL_SOFT_PAUSE", equity=round(equity, 2), day_start=round(self.day_start_balance, 2))

    # ------------------------------------------------------------------ payouts (sim funded, simulated withdrawals)
    def try_payout(self, day: dt.date, t) -> Optional[Dict[str, Any]]:
        """Request the largest documented payout as soon as eligible (ASSUMPTION: withdrawal policy). Returns the payout."""
        p = self.cfg.get("payout") or {}
        if self.status != ACTIVE or "buffer" not in p:
            return None
        buf_level = self.start + float(p["buffer"])
        above = self.balance - buf_level
        n = len(self.payouts)
        if "qualify_calendar_days" in p:      # Pro (S10)
            if self.first_trade_day is None or (day - self.first_trade_day).days < int(p["qualify_calendar_days"]) or above < float(p["min"]):
                return None
            amount = above
        else:
            need = float(p.get("first_profit_above_buffer", p["min"])) if n == 0 else float(p.get("next_profit_since_last", p["min"]))
            since = self.balance - self.cycle_start_balance if n else above
            if above < float(p["min"]) or since < need:
                return None
            if p.get("min_qualifying_days"):
                cyc = [v for d, v in self.daily.items() if d >= self.cycle_start_day.isoformat()]
                if sum(1 for v in cyc if v > 0) < int(p["min_qualifying_days"]):
                    return None
                cp = p.get("consistency_pct")
                prof = sum(cyc)
                if cp and (prof <= 0 or max(cyc) > cp * prof + 1e-9):
                    return None
            amount = above if not p.get("max_per_cycle") else min(above, float(p["max_per_cycle"]))
        amount = round(amount, 2)
        self.balance -= amount
        po = {"day": day.isoformat(), "gross": amount, "trader_share": round(amount * float(p["split"]), 2), "n": n + 1}
        self.payouts.append(po)
        self.cycle_start_balance, self.cycle_start_day = self.balance, day + dt.timedelta(days=1)
        if p.get("static_mll_after_first_payout") and n == 0:
            self.static_floor = self.start + 100.0       # S10: MLL moves to start + $100 and stays static
            self._recompute_floor()
        self.ev(t, "PAYOUT_SIMULATED", **po)
        return po

    # ------------------------------------------------------------------ persistence
    def to_state(self) -> Dict[str, Any]:
        d = {k: v for k, v in self.__dict__.items() if k != "cfg"}
        for k in ("opened_day", "closed_day", "day", "last_activity_day", "cycle_start_day", "first_trade_day"):
            d[k] = d[k].isoformat() if d[k] else None
        return {"cfg": {k: v for k, v in self.cfg.items()}, "state": d}

    @classmethod
    def from_state(cls, blob: Dict[str, Any]) -> "VirtualAccount":
        st = dict(blob["state"])
        a = cls(blob["cfg"], st["id"], dt.date.fromisoformat(st["opened_day"]))
        for k in ("opened_day", "closed_day", "day", "last_activity_day", "cycle_start_day", "first_trade_day"):
            st[k] = dt.date.fromisoformat(st[k]) if st[k] else None
        a.__dict__.update(st)
        return a

    def summary(self) -> Dict[str, Any]:
        s = self.stats
        pf = (s["gross_profit"] / s["gross_loss"]) if s["gross_loss"] > 0 else None
        return {"account_id": self.id, "stage": self.stage, "plan": f'{self.cfg["_plan"]}/{self.cfg["_size"]}', "status": self.status,
                "opened": self.opened_day.isoformat(), "closed": self.closed_day.isoformat() if self.closed_day else None, "reason": self.end_reason,
                "calendar_days": ((self.closed_day or self.day or self.opened_day) - self.opened_day).days + 1, "trading_days": len(self.trading_days),
                "net_pnl": round(self.balance - self.start + sum(p["gross"] for p in self.payouts), 2), "balance": round(self.balance, 2),
                "floor": round(self.floor, 2), "max_drawdown": round(self.max_dd, 2), "trades": s["trades"],
                "win_rate_pct": round(100 * s["wins"] / s["trades"], 2) if s["trades"] else None, "profit_factor": round(pf, 3) if pf else None,
                "expectancy": round(s["net"] / s["trades"], 2) if s["trades"] else None, "commissions": round(s["commissions"], 2),
                "slippage": round(s["slippage"], 2), "consistency": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in self.consistency().items()},
                "payouts": self.payouts, "events": [e for e in self.events if e["kind"] not in ("DLL_PAUSE_LIFTED",)][-30:],
                "dll_pauses": sum(1 for e in self.events if e["kind"] == "DLL_SOFT_PAUSE"), "choices": self.cfg["_choices"],
                "unresolved": self.cfg["_unresolved"], "rules_hash": self.cfg["_rules_hash"]}
