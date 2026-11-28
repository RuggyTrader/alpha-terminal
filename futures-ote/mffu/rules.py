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

# Shared assumptions (repeated in every report)
A_DAY = A("17:00 ET", "MFFU states no day-end time; CME equity session end used")
A_TRADING_DAY = A("day with at least one closed trade", "MFFU does not define a trading day for minimum-day counts")
A_DLL_BASIS = A("equity", "MFFU does not say whether the soft DLL uses realized or open P&L; open equity (stricter) used")
A_PASS_CHECK = A("end of trading day, flat", "MFFU does not say when the target is checked; closed balance at day end used")
A_EOD_HIGH = A("closed balance at day end", "S4 does not say whether unrealized P&L raises the EOD high")
A_QUAL_DAY = A("day with positive net P&L", "MFFU does not define a payout 'qualifying day'")
BREACH_OPEN = U("Whether an intraday open-equity dip below the minimum balance breaches an EOD-trailing account (X4)", "S4", "S8", "S12",
                candidates=("intraday_equity", "eod_equity"))

# ---------------------------------------------------------------- evaluation (S1, confirmed per plan in S8 S9 S10 S12 S13)
def _eval(target, mll, dll, minis, micros, consistency, min_days, dd_type, inactivity, flat, news_ok=True, extra=None):
    r = {
        "start_balance": A(0.0, "balances are tracked as P&L relative to the account size (e.g. $50,000 -> 0)"),
        "profit_target": target, "max_loss": mll, "drawdown_type": dd_type,
        "lock_offset": D(100.0, "S4", "S8", "S12", note="trail stops at starting balance + $100 (S4 examples contradict: X3)"),
        "breach_basis": BREACH_OPEN, "eod_high_basis": A_EOD_HIGH,
        "daily_loss_limit": dll, "dll_basis": A_DLL_BASIS,
        "consistency_pct": consistency, "min_trading_days": min_days,
        "max_minis": minis, "max_micros": micros,
        "t1_news_allowed": D(news_ok, "S1", "S7"), "inactivity_days": inactivity,
        "flat_by_session_end": flat, "day_boundary": A_DAY, "trading_day_def": A_TRADING_DAY, "pass_check": A_PASS_CHECK,
        "hedging_allowed": D(False, "S5"), "price_limit_2pct": D("not applicable in evaluation", "S14", note="S14 names sim funded and live"),
    }
    r.update(extra or {})
    return r


EOD = D("eod_trailing", "S1")
NO_DLL = D(None, "S1")
NO_CONS = D(None, "S1", "S3")
INACT_U = U("Evaluation inactivity rule not stated for this plan", "S1")
FLAT_BUILDER = D(True, "S12", note="'All positions must be closed before the end of the trading session'; time not stated")
FLAT_U = U("Flat-by-session-end not stated for this plan", "S1", candidates=(True, False))
RAPID_DD = U("Rapid evaluation drawdown: EOD (S1, S9) vs intraday trailing (S2) (X1)", "S1", "S2", "S9",
             candidates=("eod_trailing", "intraday_trailing"))

PLANS: Dict[Tuple[str, str], Dict[str, Dict[str, Rule]]] = {}


def _add(plan, size, evaluation, sim=None, live=None):
    PLANS[(plan, size)] = {"evaluation": evaluation, "sim_funded": sim, "live_hypothetical": live}


for size, tgt, mll, dll, mi, mc in [("25k", 1500, 1000, 600, 2, 20), ("50k", 3000, 2000, 1000, 4, 40), ("50k_addon", 3000, 1500, 1000, 4, 40),
                                    ("100k", 6000, 3000, 1750, 6, 60), ("150k", 9000, 4500, 2500, 9, 90)]:
    src = {"50k": ("S1", "S12"), "50k_addon": ("S1", "S12"), "100k": ("S1", "S8")}.get(size, ("S1",))
    _add("builder", size, _eval(D(tgt, *src), D(mll, *src), D(dll, *src, note="soft pause: does not breach, pauses for the rest of the session (S8, S12)"),
                                D(mi, *src), D(mc, *src), NO_CONS, D(1, *src), D("eod_trailing", *src), INACT_U,
                                FLAT_BUILDER if size == "50k" or size == "50k_addon" else A(True, "Builder 50k FAQ (S12) applied to the same plan family")))

for size, tgt, mll, mi, mc in [("25k", 1500, 1000, 3, 30), ("50k", 3000, 2000, 5, 50), ("100k", 6000, 3000, 8, 80), ("150k", 9000, 4500, 10, 100)]:
    src = ("S1", "S9") if size == "50k" else ("S1",)
    _add("rapid", size, _eval(D(tgt, *src), D(mll, *src), NO_DLL, D(mi, *src), D(mc, *src), D(0.50, "S1", "S3"),
                              D(2, "S1", "S2"), RAPID_DD, INACT_U, FLAT_U))

for size, tgt, mll, mi, mc in [("25k", 1500, 1000, 2, 20), ("50k", 3000, 2000, 3, 30)]:
    src = ("S1", "S13") if size == "50k" else ("S1",)
    _add("rapid_eod", size, _eval(D(tgt, *src), D(mll, *src), NO_DLL, D(mi, *src), D(mc, *src), D(0.30, "S1", "S3", *src[1:]),
                                  D(4, *src, note="S2 says 2 days for Rapid (X2)"), D("eod_trailing", *src), D(7, *src), FLAT_U))

for size, tgt, mll, mi, mc, cons, days in [("50k", 3000, 2000, 3, 30, 0.5, 2), ("100k", 6000, 3000, 6, 60, 0.5, 2), ("150k", 9000, 4500, 9, 90, 0.5, 2),
                                           ("50k_one_day", 4000, 2000, 3, 30, None, 1)]:
    _add("pro", size, _eval(D(tgt, "S1", "S10"), D(mll, "S1", "S10"), NO_DLL, D(mi, "S1", "S10"), D(mc, "S1", "S10"),
                            D(cons, "S3", "S10"), D(days, "S1", "S10"), D("eod_trailing", "S1", "S10"), INACT_U, FLAT_U))

# ---------------------------------------------------------------- simulated funded (only the articles that were read)
def _sim(base: Dict[str, Rule], **over) -> Dict[str, Rule]:
    r = dict(base)
    r.update({"profit_target": D(None, "S8", "S9", "S10", "S12", "S13", note="the sim-funded parameter tables list no profit target"),
              "min_trading_days": A(0, "no minimum-day rule stated for this stage; payout day rules are modelled separately")})
    r.update(over)
    return r


def _builder_sim(size, mll, dll, mi, mc, buf, pay_min, pay_max, first_profit, src):
    ev = PLANS[("builder", size)]["evaluation"]
    return _sim(ev, start_balance=D(0.0, src), max_loss=D(mll, src), daily_loss_limit=D(dll, src, note="soft pause"),
                drawdown_type=D("eod_trailing", src), lock_offset=D(100.0, src, note="locks at $100 above the $0 start"),
                consistency_pct=D(None, src, note="evaluation-stage rule none; payout cycle consistency 50% applies"),
                max_minis=D(mi, src), max_micros=D(mc, src), inactivity_days=D(7, src, note="consequence not stated"),
                t1_news_allowed=D(True, src, "S7"), price_limit_2pct=D("prohibited within 2% of a CME price limit", "S14"),
                payout=D({"split": 0.80, "consistency_pct": 0.50, "min_qualifying_days": 2, "buffer": buf, "first_profit_above_buffer": first_profit,
                          "next_profit_since_last": first_profit, "min": pay_min, "max_per_cycle": pay_max, "max_payouts_sim": 5,
                          "to_live_after_payouts": 5, "qualifying_day": A_QUAL_DAY.value}, src),
                cooldown_after_live_breach_days=D(21, src))


PLANS[("builder", "50k")]["sim_funded"] = _builder_sim("50k", 2000, 1000, 4, 40, 2100, 500, 2000, 500, "S12")
PLANS[("builder", "50k_addon")]["sim_funded"] = _builder_sim("50k_addon", 1500, 1000, 4, 40, 1600, 500, 2000, 500, "S12")
PLANS[("builder", "100k")]["sim_funded"] = _builder_sim("100k", 3000, 1750, 6, 60, 3100, 1000, 3000, 1000, "S8")
PLANS[("builder", "50k")]["live_hypothetical"] = _sim(PLANS[("builder", "50k")]["sim_funded"], max_loss=D(2000, "S12"), daily_loss_limit=D(1000, "S12"),
    lock_offset=U("Builder live lock: $0 vs $100 above start (X5)", "S12", candidates=(0.0, 100.0)),
    max_minis=U("Builder 50k live contract limit not stated", "S12"), max_micros=U("Builder 50k live contract limit not stated", "S12"),
    inactivity_days=D(None, "S12", note="no inactivity rule on live"), payout=D({"split": 0.80, "min": 250, "frequency": "daily"}, "S12"),
    t1_news_allowed=U("Live news rule not addressed", "S7", "S12", candidates=(True, False)))
PLANS[("builder", "100k")]["live_hypothetical"] = _sim(PLANS[("builder", "100k")]["sim_funded"], max_loss=D(3000, "S8"), daily_loss_limit=D(None, "S8"),
    lock_offset=D(100.0, "S8"), max_minis=D(3, "S8"), max_micros=D(30, "S8"), inactivity_days=D(None, "S8"),
    payout=D({"split": 0.80, "min": 250, "frequency": "daily"}, "S8"), t1_news_allowed=U("Live news rule not addressed", "S7", candidates=(True, False)))

PLANS[("rapid", "50k")]["sim_funded"] = _sim(PLANS[("rapid", "50k")]["evaluation"], start_balance=D(0.0, "S9"), max_loss=D(2000, "S9"),
    drawdown_type=D("intraday_trailing", "S9", "S11"), lock_offset=D(100.0, "S9", note="S11: 'will not exceed the starting balance' (X6)"),
    breach_basis=D("intraday_equity", "S11"), consistency_pct=D(None, "S9"), daily_loss_limit=D(None, "S9"),
    max_minis=U("5 minis (S9) vs a 2-contract scaling start (S15) (X8)", "S9", "S15", candidates=(5, 2)),
    max_micros=U("50 micros (S9) vs 20 under scaling (S15) (X8)", "S9", "S15", candidates=(50, 20)),
    t1_news_allowed=D(False, "S9", "S7"), inactivity_days=U("Rapid sim inactivity not stated", "S9"), flat_by_session_end=FLAT_U,
    price_limit_2pct=D("prohibited within 2% of a CME price limit", "S14"),
    payout=D({"split": 0.90, "buffer": 2100, "min": 500, "frequency": "daily", "consistency_pct": None, "first_after_hours": 24}, "S9"))

PLANS[("rapid_eod", "50k")]["sim_funded"] = _sim(PLANS[("rapid_eod", "50k")]["evaluation"], start_balance=D(0.0, "S13"), max_loss=D(2000, "S13"),
    drawdown_type=D("eod_trailing", "S13"), lock_offset=D(100.0, "S13"), consistency_pct=D(None, "S13"), daily_loss_limit=D(None, "S13"),
    max_minis=D(3, "S13"), max_micros=D(30, "S13"), t1_news_allowed=D(False, "S13", "S7"), inactivity_days=D(7, "S13"),
    price_limit_2pct=D("prohibited within 2% of a CME price limit", "S14"),
    payout=D({"split": 0.90, "buffer": 2100, "min": 500, "next_profit_since_last": 500, "frequency": "daily", "consistency_pct": None, "max_per_cycle": None}, "S13"))

for size, mll, buf, live_c, minis in [("50k", 2000, 2100, 2, 3), ("100k", 3000, 3100, 3, 6), ("150k", 4500, 4600, 4, 9)]:
    ev = PLANS[("pro", size)]["evaluation"]
    PLANS[("pro", size)]["sim_funded"] = _sim(ev, start_balance=A(0.0, "S10 implies a $50,000-based balance; P&L relative to start used"),
        max_loss=D(mll, "S10"), drawdown_type=D("eod_trailing", "S10"), consistency_pct=D(None, "S10"), daily_loss_limit=D(None, "S10"),
        max_minis=D(minis, "S10"),
        max_micros=U(f"S10 lists '{minis} micro' for sim funded; evaluation allows {minis * 10} (X7)", "S10", candidates=(minis, minis * 10)),
        t1_news_allowed=D(False, "S10", "S7"), inactivity_days=U("Pro sim inactivity not stated", "S10"),
        price_limit_2pct=D("prohibited within 2% of a CME price limit", "S14"),
        payout=D({"split": 0.80, "buffer": buf, "min": 1000, "qualify_calendar_days": 14, "static_mll_after_first_payout": True,
                  "live_after_consecutive_payouts": 3, "max_total_per_user": 100000}, "S10"))
    PLANS[("pro", size)]["live_hypothetical"] = _sim(PLANS[("pro", size)]["sim_funded"], start_balance=D(0.0, "S10"), max_loss=D(mll, "S10"),
        drawdown_type=D("eod_trailing", "S10"), lock_offset=U("Pro live lock not stated", "S10"),
        max_minis=D(live_c, "S10", note="unit not stated (assumed minis)"), max_micros=U("Pro live micro limit not stated", "S10"),
        payout=D({"split": 0.80, "min": 250}, "S10"), t1_news_allowed=U("Live news rule not addressed", "S7", candidates=(True, False)))


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
