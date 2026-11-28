"""Virtual MFFU account rules, with provenance for every field.

Every value is one of:
  DOCUMENTED  stated on a cited MFFU page (sources.py)
  ASSUMPTION  not stated; a labelled modelling choice the report repeats
  UNRESOLVED  missing or contradictory; the simulator refuses to use it unless the caller picks one of `candidates`
              explicitly (that choice is then recorded in every result)

Nothing here selects, prices or purchases a real evaluation. Unknown plan/size/stage combinations are UNRESOLVED.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple


@dataclass(frozen=True)
class Rule:
    value: Any
    status: str                     # DOCUMENTED | ASSUMPTION | UNRESOLVED
    src: Tuple[str, ...] = ()
    note: str = ""
    candidates: Tuple[Any, ...] = ()


def D(v, *src, note=""):
    return Rule(v, "DOCUMENTED", tuple(src), note)


def A(v, note):
    return Rule(v, "ASSUMPTION", (), note)


def U(note, *src, candidates=()):
    return Rule(None, "UNRESOLVED", tuple(src), note, tuple(candidates))


class UnresolvedRule(Exception):
    pass


STAGES = ("evaluation", "sim_funded", "live_hypothetical")

# Shared rules and assumptions (repeated in every report)
FLAT_1610 = D("16:10", "S17", note="'Core Rules': trades may be placed from 6:00 PM (Globex open) and remain open until 4:10 PM; open "
              "positions are auto-closed at 4:10 PM on regular days. Times read as New York wall clock ('EST' in the text; a literal "
              "EST 4:10 PM in summer would fall after the CME close). Holiday half days: no auto-close; the trader must close before the market closes.")
A_DAY = A("16:10 ET flat; day-end after the flatten", "S17 fixes the 4:10 PM flat time; the EOD snapshot time itself is not stated")
A_TRADING_DAY = A("day with at least one closed trade", "minimum-day counts: MFFU does not define a trading day beyond 'traded'")
A_DLL_BASIS = A("equity", "MFFU does not say whether the soft DLL uses realized or open P&L; open equity (stricter) used")
A_PASS_CHECK = A("end of trading day, flat", "S18: passing is notified once the end-of-day balance reflects it")
A_EOD_HIGH = A("closed balance at day end", "S4 does not say whether unrealized P&L raises the EOD high")
QUAL_DAY = D("day with at least one trade", "S26", "S27", note="'You must have traded on at least 2 trading days in the current cycle'")
BREACH_OPEN = U("Whether an intraday open-equity dip below the minimum balance breaches an EOD-trailing account (X4)", "S4", "S12",
                candidates=("intraday_equity", "eod_equity"))
LOCK_100 = D(100.0, "S4", "S8", "S12", "S18", note="the trail locks at start + $100 once the balance high reaches start + MLL + $100 (S18; resolves X3)")
INACT_7 = D(7, "S19", note="7 consecutive calendar days without a trade: 'the account could be closed'; sim funded forfeits profits. "
            "S19 is written for the one-time payment model; which plans use it is not stated")
LIVE_NEWS_U = U("Live-account T1 news rule not addressed (S7)", "S7", candidates=(True, False))
PRICE_LIMIT = D("prohibited within 2% of a CME price limit", "S14")


def _eval(target, mll, dll, minis, micros, consistency, min_days, dd_type, inactivity=INACT_7, extra=None):
    r = {
        "start_balance": A(0.0, "balances are tracked as P&L relative to the account size (e.g. $50,000 -> 0)"),
        "profit_target": target, "max_loss": mll, "drawdown_type": dd_type, "lock_offset": LOCK_100,
        "breach_basis": BREACH_OPEN, "eod_high_basis": A_EOD_HIGH,
        "daily_loss_limit": dll, "dll_basis": A_DLL_BASIS,
        "consistency_pct": consistency, "min_trading_days": min_days,
        "max_minis": minis, "max_micros": micros,
        "t1_news_allowed": D(True, "S1", "S7", note="all evaluations may trade T1 news"), "inactivity_days": inactivity,
        "flat_by_session_end": FLAT_1610, "day_boundary": A_DAY, "trading_day_def": A_TRADING_DAY, "pass_check": A_PASS_CHECK,
        "hedging_allowed": D(False, "S5", "S30"), "price_limit_2pct": D("not applicable in evaluation", "S14", note="S14 names sim funded and live"),
    }
    r.update(extra or {})
    return r


NO_DLL = D(None, "S1")
NO_CONS = D(None, "S1", "S3")
RAPID_DD = U("Rapid evaluation drawdown (X1): 'Maximum Loss Limit (EOD)' in S1, S9, S20, S21, S22 vs 'intraday drawdown (Rapid Plans)' in S2. "
             "The plan articles favour EOD; both are simulated", "S1", "S2", "S9", "S20", "S21", "S22", candidates=("eod_trailing", "intraday_trailing"))

PLANS: Dict[Tuple[str, str], Dict[str, Dict[str, Rule]]] = {}


def _add(plan, size, evaluation, sim=None, live=None):
    PLANS[(plan, size)] = {"evaluation": evaluation, "sim_funded": sim, "live_hypothetical": live}


def _sim(base: Dict[str, Rule], **over) -> Dict[str, Rule]:
    r = dict(base)
    r.update({"profit_target": D(None, "S8", "S9", "S10", "S12", "S13", note="the sim-funded parameter tables list no profit target"),
              "min_trading_days": A(0, "no minimum-day rule stated for this stage; payout day rules are modelled separately"),
              "price_limit_2pct": PRICE_LIMIT, "start_balance": D(0.0, "S9", "S12", "S13", "S20", note="sim funded starts at $0")})
    r.update(over)
    return r


# ---------------------------------------------------------------- Builder (S1; S26 25k, S12 50k / add-on, S8 100k, S27 150k)
BUILDER = {  # size: target, mll, dll, minis, micros, src, buffer, pay_min, pay_max, first/next profit, live (minis, micros, dll, lock)
    "25k": (1500, 1000, 600, 2, 20, "S26", 1100, 250, 1000, 250, (None, None, 600, None)),
    "50k": (3000, 2000, 1000, 4, 40, "S12", 2100, 500, 2000, 500, (None, None, 1000, None)),
    "50k_addon": (3000, 1500, 1000, 4, 40, "S12", 1600, 500, 2000, 500, (None, None, 1000, None)),
    "100k": (6000, 3000, 1750, 6, 60, "S8", 3100, 1000, 3000, 1000, (3, 30, None, 100.0)),
    "150k": (9000, 4500, 2500, 9, 90, "S27", 4600, 1500, 4500, 1500, (4, 40, None, 100.0)),
}
for size, (tgt, mll, dll, mi, mc, src, buf, pmin, pmax, prof, (lmi, lmc, ldll, llock)) in BUILDER.items():
    ev = _eval(D(tgt, "S1", src), D(mll, "S1", src), D(dll, "S1", src, note="soft pause: not a breach; pauses for the rest of the session"),
               D(mi, "S1", src), D(mc, "S1", src), NO_CONS, D(1, "S1", src), D("eod_trailing", "S1", src))
    sim = _sim(ev, max_loss=D(mll, src), daily_loss_limit=D(dll, src, note="soft pause"), drawdown_type=D("eod_trailing", src),
               consistency_pct=D(None, src, note="no stage rule; the payout cycle has a 50% consistency rule"),
               max_minis=D(mi, src), max_micros=D(mc, src), inactivity_days=D(7, src, "S19"), t1_news_allowed=D(True, src, "S7"),
               payout=D({"split": 0.80, "consistency_pct": 0.50, "min_qualifying_days": 2, "qualifying_day": QUAL_DAY.value, "buffer": buf,
                         "first_profit_above_buffer": prof, "next_profit_since_last": prof, "min": pmin, "max_per_cycle": pmax,
                         "max_payouts_sim": 5, "to_live_after_payouts": 5}, src, "S29"),
               cooldown_after_live_breach_days=D(21, src))
    live = _sim(sim, max_loss=D(mll, src), daily_loss_limit=D(ldll, src),
                lock_offset=D(llock, src) if llock is not None else U("Builder live lock (X5): live table 'static once MLL reaches $0' vs account "
                                                                       "rules 'locks at $100 above the starting balance'", src, candidates=(0.0, 100.0)),
                max_minis=D(lmi, src) if lmi else U(f"Builder {size} live contract limit not stated", src),
                max_micros=D(lmc, src) if lmc else U(f"Builder {size} live contract limit not stated", src),
                inactivity_days=D(None, src, note="no inactivity rule on live"), payout=D({"split": 0.80, "min": 250, "frequency": "daily"}, src),
                t1_news_allowed=LIVE_NEWS_U)
    _add("builder", size, ev, sim, live)

# ---------------------------------------------------------------- Rapid, intraday sim (S1; S20 25k, S9 50k, S21 100k, S22 150k; live S23)
RAPID = {"25k": (1500, 1000, 3, 30, "S20", 1100, (2, 20)), "50k": (3000, 2000, 5, 50, "S9", 2100, (3, 30)),
         "100k": (6000, 3000, 8, 80, "S21", 3100, (6, 60)), "150k": (9000, 4500, 10, 100, "S22", 4600, (8, 80))}
for size, (tgt, mll, mi, mc, src, buf, (lmi, lmc)) in RAPID.items():
    ev = _eval(D(tgt, "S1", src), D(mll, "S1", src), NO_DLL, D(mi, "S1", src), D(mc, "S1", src), D(0.50, "S1", "S3", src),
               D(2, "S1", "S2", src), RAPID_DD)
    sim = _sim(ev, max_loss=D(mll, src), drawdown_type=D("intraday_trailing", src, "S11"),
               lock_offset=D(100.0, src, "S20", "S21", "S22", note="'Once your trailing Max Loss reaches $100, it locks there' (resolves X6)"),
               breach_basis=D("intraday_equity", "S11"), consistency_pct=D(None, src), daily_loss_limit=D(None, src),
               max_minis=D(mi, src) if size != "50k" else U("5 minis (S9) vs a 2-contract scaling start (S15) (X8)", "S9", "S15", candidates=(5, 2)),
               max_micros=D(mc, src) if size != "50k" else U("50 micros (S9) vs 20 under scaling (S15) (X8); no other Rapid size has a scaling plan",
                                                               "S9", "S15", "S20", "S21", "S22", candidates=(50, 20)),
               t1_news_allowed=D(False, src, "S7"), inactivity_days=D(7, "S20", "S19"),
               payout=D({"split": 0.90, "buffer": buf, "min": 500, "frequency": "daily", "consistency_pct": None, "first_after_hours": 24}, src, "S29"),
               to_live_session_profit=D(10000, "S23", note="automatic live transition after $10,000 net profit in one session; otherwise risk-team approval (not simulated)"))
    live = _sim(sim, max_loss=D(mll, "S23"), drawdown_type=D("eod_trailing", "S23"), lock_offset=D(0.0, "S23", note="'Max Loss threshold stops at $0'"),
                breach_basis=BREACH_OPEN, max_minis=D(lmi, "S23"), max_micros=D(lmc, "S23"), daily_loss_limit=U("Rapid live DLL not stated", "S23"),
                inactivity_days=D(None, "S23", note="not stated for live"), payout=D({"split": 0.90, "frequency": "daily", "buffer": 0}, "S23"),
                t1_news_allowed=LIVE_NEWS_U)
    _add("rapid", size, ev, sim, live)

# ---------------------------------------------------------------- Rapid EOD (S1; S24 25k, S13 50k) and Rapid EOD with DLL (S25)
for plan, dlls in (("rapid_eod", {"25k": None, "50k": None}), ("rapid_eod_dll", {"25k": 500, "50k": 1000})):
    for size, (tgt, mll, mi, mc, src, buf, nxt, (lmi, lmc)) in {"25k": (1500, 1000, 2, 20, "S24", 1100, 250, (2, 20)),
                                                                "50k": (3000, 2000, 3, 30, "S13", 2100, 500, (3, 30))}.items():
        s2 = "S25" if plan == "rapid_eod_dll" else src
        dll = D(dlls[size], s2, note="soft pause, not a breach; resets daily at 6:00 PM ET (S25)") if dlls[size] else NO_DLL
        ev = _eval(D(tgt, "S1", s2), D(mll, "S1", s2), dll, D(mi, "S1", s2), D(mc, "S1", s2), D(0.30, "S1", "S3", s2),
                   D(4, "S1", s2, note="plan articles say 4 days; S2's generic '2 days for Rapid' does not apply (resolves X2)"),
                   D("eod_trailing", "S1", s2), inactivity=D(7, s2, "S19"))
        sim = _sim(ev, max_loss=D(mll, s2), drawdown_type=D("eod_trailing", s2), consistency_pct=D(None, s2), daily_loss_limit=dll,
                   max_minis=D(mi, s2), max_micros=D(mc, s2), t1_news_allowed=D(False, s2, "S7"), inactivity_days=D(7, s2, "S19"),
                   payout=D({"split": 0.90, "buffer": buf, "min": 500, "next_profit_since_last": nxt, "frequency": "daily", "consistency_pct": None,
                             "max_per_cycle": None}, s2, "S29"),
                   to_live_session_profit=D(10000, "S23", note="Rapid live transition rules (S13/S24 refer to standard Rapid)"))
        live = _sim(sim, max_loss=D(mll, "S23"), drawdown_type=D("eod_trailing", "S23"), lock_offset=D(0.0, "S23"), breach_basis=BREACH_OPEN,
                    max_minis=D(lmi, "S23", note=f"S24 says live follows standard Rapid {size}"), max_micros=D(lmc, "S23"),
                    daily_loss_limit=U("Rapid live DLL not stated", "S23"), inactivity_days=D(None, "S23"),
                    payout=D({"split": 0.90, "frequency": "daily", "buffer": 0}, "S23"), t1_news_allowed=LIVE_NEWS_U)
        _add(plan, size, ev, sim, live)

# ---------------------------------------------------------------- Pro (S1, S10 redesigned plan effective 2026-11-23; S28 legacy)
for size, tgt, mll, mi, mc, cons, days in [("50k", 3000, 2000, 3, 30, 0.5, 2), ("100k", 6000, 3000, 6, 60, 0.5, 2), ("150k", 9000, 4500, 9, 90, 0.5, 2),
                                           ("50k_one_day", 4000, 2000, 3, 30, None, 1)]:
    ev = _eval(D(tgt, "S1", "S10"), D(mll, "S1", "S10"), NO_DLL, D(mi, "S1", "S10"), D(mc, "S1", "S10"),
               D(cons, "S3", "S10"), D(days, "S1", "S10"), D("eod_trailing", "S1", "S10"))
    _add("pro", size, ev)
for size, mll, buf, live_c, minis, legacy in [("50k", 2000, 2100, 2, 3, 5), ("100k", 3000, 3100, 3, 6, 10), ("150k", 4500, 4600, 4, 9, 15)]:
    ev = PLANS[("pro", size)]["evaluation"]
    sim = _sim(ev, start_balance=A(0.0, "S10 implies a $50,000-based balance; P&L relative to start used"),
               max_loss=D(mll, "S10"), drawdown_type=D("eod_trailing", "S10"), consistency_pct=D(None, "S10"), daily_loss_limit=D(None, "S10"),
               max_minis=D(minis, "S10"),
               max_micros=U(f"X7: S10 (redesign) lists '{minis} mini / {minis} micro' for sim funded while its evaluation allows {minis * 10} micros; "
                            f"legacy S28 lists '{legacy} mini / {legacy} micro'", "S10", "S28", candidates=(minis, minis * 10)),
               t1_news_allowed=D(False, "S10", "S7"), inactivity_days=D(7, "S19", "S29", note="'Subject to inactivity rule' (S29)"),
               payout=D({"split": 0.80, "buffer": buf, "min": 1000, "qualify_calendar_days": 14, "static_mll_after_first_payout": True,
                         "live_after_consecutive_payouts": 3, "max_total_per_user": 100000}, "S10", "S29"))
    live = _sim(sim, max_loss=D(mll, "S10"), drawdown_type=D("eod_trailing", "S10"), lock_offset=U("Pro live lock not stated", "S10"),
                breach_basis=BREACH_OPEN, max_minis=D(live_c, "S10", note="unit not stated (assumed minis)"),
                max_micros=U("Pro live micro limit not stated", "S10"), inactivity_days=D(None, "S10"),
                payout=D({"split": 0.80, "min": 250}, "S10"), t1_news_allowed=LIVE_NEWS_U)
    PLANS[("pro", size)]["sim_funded"], PLANS[("pro", size)]["live_hypothetical"] = sim, live


def plan_ids():
    return sorted(f"{p}/{s}" for p, s in PLANS)


def stage_rules(plan: str, size: str, stage: str) -> Optional[Dict[str, Rule]]:
    if stage not in STAGES:
        raise ValueError(stage)
    if (plan, size) not in PLANS:
        raise KeyError(f"unknown plan {plan}/{size}; known: {plan_ids()}")
    return PLANS[(plan, size)][stage]


def resolve(plan: str, size: str, stage: str, choices: Optional[Dict[str, Any]] = None, *, require=None) -> Dict[str, Any]:
    """Concrete values for the simulator. UNRESOLVED fields must be chosen from `candidates` via `choices`; fields with no
    candidates cannot be used at all (their checks report UNRESOLVED). Raises UnresolvedRule when a required field is open."""
    rules = stage_rules(plan, size, stage)
    if rules is None:
        raise UnresolvedRule(f"{plan}/{size} {stage}: no MFFU article for this stage was read; parameters unresolved")
    choices = choices or {}
    out, used, open_ = {}, {}, []
    for k, r in rules.items():
        if r.status == "UNRESOLVED":
            if k in choices:
                c = choices[k]
                if r.candidates and c not in r.candidates:
                    raise UnresolvedRule(f"{k}={c!r} is not one of the documented candidates {r.candidates}")
                out[k] = c; used[k] = c
            else:
                out[k] = None; open_.append(k)
        else:
            out[k] = r.value
    for k in (require or ()):
        if k in open_:
            raise UnresolvedRule(f"{plan}/{size} {stage}: '{k}' is UNRESOLVED ({rules[k].note}); pass an explicit choice from {rules[k].candidates}")
    out["_plan"], out["_size"], out["_stage"], out["_choices"], out["_unresolved"] = plan, size, stage, used, open_
    out["_rules_hash"] = rules_hash(plan, size, stage)
    return out


REQUIRED = ("max_loss", "drawdown_type", "lock_offset", "breach_basis", "max_micros")


def rules_hash(plan, size, stage) -> str:
    r = stage_rules(plan, size, stage) or {}
    blob = json.dumps({k: [repr(v.value), v.status, v.src, v.candidates] for k, v in sorted(r.items())}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def catalogue() -> Dict[str, Any]:
    """Serializable catalogue for reports and the dashboard."""
    out = {}
    for (p, s), stages in sorted(PLANS.items()):
        out[f"{p}/{s}"] = {st: (None if r is None else {k: {"value": v.value, "status": v.status, "src": list(v.src), "note": v.note,
                                                                "candidates": list(v.candidates)} for k, v in r.items()})
                           for st, r in stages.items()}
    return out
