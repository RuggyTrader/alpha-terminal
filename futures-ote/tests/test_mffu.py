"""MFFU research foundation: rules provenance, virtual-account maths, compliance gate, local-only execution, restart
recovery and the historical overlay. Fixture data is synthetic and exists only in tests."""
import ast
import dataclasses
import datetime as dt
import glob
import os
import socket
from types import SimpleNamespace

import pytest

from mffu import rules as R
from mffu.account import VirtualAccount, ACTIVE, PAUSED_DLL, BREACHED, PASSED
from mffu.calendar import session_day, is_open, NewsCalendar, minutes_to_session_end, ET
from mffu.compliance import ComplianceEngine, OrderIntent, MarketState, Position, EXTERNAL_EXECUTION
from mffu.execution import MockAdapter, PaperSimAdapter, OrderRouter, NinjaTraderAdapter, TradovateAdapter, ExternalExecutionDisabled, INTEGRATION_STATUS
from mffu.evaluate import MffuOverlay
from mffu.instruments import MNQ, MES, COST_SCENARIOS, validate_qty, last_trade_time, FuturesSpec
from mffu.sources import SOURCES
from mffu import store
from ote_engine.strategy import Settings, Execution, run
from tests.test_engine import _walk

D0 = dt.date(2026, 3, 2)
T0 = dt.datetime(2026, 3, 2, 10, 0, tzinfo=ET)          # a Monday, market open
BASE = COST_SCENARIOS["C2_base"]


def cfg(plan="builder", size="50k", stage="evaluation", **choice):
    ch = {"breach_basis": "intraday_equity", **choice}
    rules = R.stage_rules(plan, size, stage)
    ch = {k: v for k, v in ch.items() if rules[k].status == "UNRESOLVED"}
    return R.resolve(plan, size, stage, ch, require=R.REQUIRED)


def trade(net, comm=1.48, mae=0.0, qty=1):
    return SimpleNamespace(net=net, commission=comm, slippage_usd=0.0, mae_points=mae, qty=qty)


# ---------------------------------------------------------------- rules provenance
def test_every_rule_has_a_status_and_documented_rules_cite_real_sources():
    for (p, s), stages in R.PLANS.items():
        for stg, rules in stages.items():
            for k, r in (rules or {}).items():
                assert r.status in ("DOCUMENTED", "ASSUMPTION", "UNRESOLVED"), (p, s, stg, k)
                if r.status == "DOCUMENTED":
                    assert r.src and all(x in SOURCES for x in r.src), (p, s, stg, k)
                if r.status == "UNRESOLVED":
                    assert r.value is None and r.note


def test_documented_values_match_the_sources():
    b = R.PLANS[("builder", "50k")]["evaluation"]
    assert (b["profit_target"].value, b["max_loss"].value, b["daily_loss_limit"].value, b["max_micros"].value) == (3000, 2000, 1000, 40)
    assert R.PLANS[("rapid_eod", "50k")]["evaluation"]["consistency_pct"].value == 0.30
    assert R.PLANS[("pro", "50k_one_day")]["evaluation"]["profit_target"].value == 4000
    assert R.PLANS[("rapid", "25k")]["sim_funded"] is None          # article not read -> no invented sim rules


def test_unresolved_rules_cannot_be_used_silently():
    with pytest.raises(R.UnresolvedRule):
        R.resolve("builder", "50k", "evaluation", {}, require=R.REQUIRED)          # breach basis is contradictory (X4)
    with pytest.raises(R.UnresolvedRule):
        R.resolve("builder", "50k", "evaluation", {"breach_basis": "whatever"})    # not a documented candidate
    with pytest.raises(R.UnresolvedRule):
        R.resolve("rapid", "50k", "evaluation", {"breach_basis": "intraday_equity"}, require=R.REQUIRED)   # drawdown type X1
    c = cfg("rapid", "50k", drawdown_type="eod_trailing")
    assert c["_choices"] == {"breach_basis": "intraday_equity", "drawdown_type": "eod_trailing"}
    with pytest.raises(R.UnresolvedRule):
        R.resolve("builder", "50k", "live_hypothetical", {"breach_basis": "intraday_equity", "lock_offset": 100.0}, require=R.REQUIRED)  # micros not stated


# ---------------------------------------------------------------- drawdown maths
def test_eod_trailing_moves_only_at_day_end_locks_at_start_plus_100_and_never_falls():
    a = VirtualAccount(cfg(), "A", D0); a.start_day(D0, T0)
    assert a.floor == -2000
    a.on_trade(trade(900), D0)
    assert a.mark(T0, 900, 900, 1500) is None and a.floor == -2000        # intraday highs do not move an EOD floor
    a.end_day(D0, T0, 900, True); assert a.floor == -1100
    d1 = D0 + dt.timedelta(days=1); a.start_day(d1, T0)
    a.on_trade(trade(-400), d1); a.end_day(d1, T0, 500, True); assert a.floor == -1100   # never moves down
    d2 = d1 + dt.timedelta(days=1); a.start_day(d2, T0)
    a.on_trade(trade(3000), d2); a.end_day(d2, T0, 3500, True)
    assert a.floor == 100.0                                                # locked at start + $100 (S4/S8/S12)


def test_unrealized_loss_breaches_intraday_basis_but_not_eod_basis_if_it_recovers():
    strict = VirtualAccount(cfg("pro", "50k"), "S", D0); strict.start_day(D0, T0)      # Pro: no daily loss limit
    assert strict.mark(T0, -2000.5, -100, 0) == ("ACCT_BREACH", -2000)     # open equity below the floor
    loose = VirtualAccount(cfg("pro", "50k", breach_basis="eod_equity"), "L", D0); loose.start_day(D0, T0)
    assert loose.mark(T0, -2000.5, -100, 0) is None
    loose.end_day(D0, T0, -100, True); assert loose.status == ACTIVE
    loose.start_day(D0 + dt.timedelta(days=1), T0); loose.end_day(D0 + dt.timedelta(days=1), T0, -2001, False)
    assert loose.status == BREACHED


def test_intraday_trailing_uses_unrealized_peaks_s11_example_and_locks():
    a = VirtualAccount(cfg("rapid", "50k", drawdown_type="intraday_trailing"), "R", D0); a.start_day(D0, T0)
    a.mark(T0, 0, 500, 1000)                    # S11: a $1,000 equity high moves a $2,000 trail from -2,000 to -1,000
    assert a.floor == -1000
    a.mark(T0, -500, -500, -400); assert a.floor == -1000                  # does not move down
    assert a.mark(T0, -1000.01, -900, -900) == ("ACCT_BREACH", -1000)
    b = VirtualAccount(cfg("rapid", "50k", drawdown_type="intraday_trailing"), "R2", D0); b.start_day(D0, T0)
    b.mark(T0, 0, 0, 9999); assert b.floor == 100.0


def test_soft_daily_loss_pause_is_not_a_breach_and_lifts_next_day():
    a = VirtualAccount(cfg(), "P", D0); a.start_day(D0, T0)
    assert a.mark(T0, -1000, -900, -800) == ("ACCT_DLL_PAUSE", -1000)
    a.pause(T0, -1000); assert a.status == PAUSED_DLL and not a.accepting()
    a.end_day(D0, T0, -1000, True); assert a.status == PAUSED_DLL
    a.start_day(D0 + dt.timedelta(days=1), T0); assert a.status == ACTIVE


def test_consistency_delays_but_does_not_fail_and_minimum_days_apply():
    a = VirtualAccount(cfg("pro", "50k"), "C", D0); a.start_day(D0, T0)
    a.on_trade(trade(2500), D0); a.end_day(D0, T0, 2500, True)
    d1 = D0 + dt.timedelta(days=1); a.start_day(d1, T0); a.on_trade(trade(600), d1); a.end_day(d1, T0, 3100, True)
    assert a.status == ACTIVE and any(e["kind"] == "TARGET_REACHED_CONSISTENCY_PENDING" for e in a.events)   # 2500 > 50% of 3100
    for i in range(2, 6):
        d = D0 + dt.timedelta(days=i); a.start_day(d, T0); a.on_trade(trade(600), d); a.end_day(d, T0, a.balance, True)
        if a.status == PASSED:
            break
    assert a.status == PASSED and a.consistency()["ok"]                     # 2500 <= 50% of 5500
    one = VirtualAccount(cfg("builder", "50k"), "M", D0); one.start_day(D0, T0); one.on_trade(trade(3200), D0)
    one.end_day(D0, T0, 3200, False); assert one.status == ACTIVE           # target with an open position: not yet
    one.end_day(D0, T0, 3200, True); assert one.status == PASSED            # Builder: 1 day, no consistency


def test_session_day_boundary_and_cme_calendar():
    assert session_day(dt.datetime(2026, 3, 2, 16, 59, tzinfo=ET)) == dt.date(2026, 3, 2)
    assert session_day(dt.datetime(2026, 3, 2, 18, 0, tzinfo=ET)) == dt.date(2026, 3, 3)
    assert not is_open(dt.datetime(2026, 3, 2, 17, 30, tzinfo=ET)) and not is_open(dt.datetime(2026, 3, 7, 12, 0, tzinfo=ET))
    assert is_open(dt.datetime(2026, 3, 8, 18, 0, tzinfo=ET))
    assert not is_open(dt.datetime(2026, 11, 26, 14, 0, tzinfo=ET)) and not is_open(dt.datetime(2026, 11, 27, 13, 30, tzinfo=ET))  # C3
    assert minutes_to_session_end(dt.datetime(2026, 11, 27, 13, 0, tzinfo=ET)) == 15


def test_instrument_specs_quantities_and_expiry():
    assert (MNQ.multiplier, MNQ.tick, MNQ.tick_value) == (2.0, 0.25, 0.50) and (MES.multiplier, MES.tick_value) == (5.0, 1.25)
    assert MNQ.pnl(1, 20000, 20010, 2) == 40.0 and MES.pnl(-1, 6000, 5990, 1) == 50.0
    for bad in (0, -1, 1.5, 0.999, "1", True, None):
        with pytest.raises(ValueError):
            validate_qty(bad)
    assert validate_qty(3.0) == 3
    assert last_trade_time(2026, 12) == dt.datetime(2026, 12, 18, 9, 30, tzinfo=ET)


# ---------------------------------------------------------------- compliance gate
def intent(**kw):
    base = dict(client_id="c1", account_id="A", symbol="MNQ", side=1, qty=1, order_type="LIMIT", price=20000.0, stop_loss=19990.0, take_profit=20010.0)
    base.update(kw)
    return OrderIntent(**base)


def mkt(**kw):
    base = dict(now=T0 + dt.timedelta(minutes=1), last_bar_time=T0, last_price=20001.0, live_from=T0 + dt.timedelta(minutes=1))
    base.update(kw)
    return MarketState(**base)


def acct(c=None):
    a = VirtualAccount(c or cfg(), "A", D0); a.start_day(D0, T0)
    return a


def test_gate_accepts_a_clean_order_and_rejects_each_violation():
    ce = ComplianceEngine(BASE)
    assert ce.check(intent(), acct(), mkt()).accepted
    cases = [
        (dict(i=intent(client_id="c1")), "DUPLICATE_ORDER_ID"),
        (dict(m=mkt(last_bar_time=T0 - dt.timedelta(minutes=10))), "STALE_MARKET_DATA"),
        (dict(m=mkt(last_price=None)), "MISSING_MARKET_DATA"),
        (dict(i=intent(qty=0.5)), "INVALID_QUANTITY"),
        (dict(i=intent(qty=41)), "CONTRACT_LIMIT"),
        (dict(i=intent(stop_loss=None)), "NO_PROTECTIVE_STOP"),
        (dict(i=intent(route="tradovate")), "EXTERNAL_EXECUTION_DISABLED"),
        (dict(m=mkt(live_from=dt.datetime(2026, 3, 7, 12, 0, tzinfo=ET))), "MARKET_CLOSED"),
        (dict(i=intent(stop_loss=19000.0)), "WOULD_RISK_DAILY_LOSS_LIMIT"),       # $2,000 risk vs $1,000 soft DLL
        (dict(i=intent(stop_loss=18900.0)), "WOULD_RISK_ACCOUNT_BREACH"),         # $2,200 risk vs $2,000 allowance
        (dict(p=Position("MNQ", -1, 1, 20010.0, 20020.0)), "HEDGING_PROHIBITED"),
        (dict(i=intent(symbol="BTC")), "UNSUPPORTED_INSTRUMENT"),
    ]
    for n, (kw, reason) in enumerate(cases):
        i = kw.get("i") or intent(client_id=f"x{n}")
        if "i" in kw and kw["i"].client_id == "c1" and reason != "DUPLICATE_ORDER_ID":
            i = dataclasses.replace(kw["i"], client_id=f"x{n}")
        d = ce.check(i, acct(), kw.get("m") or mkt(), kw.get("p"))
        assert not d.accepted and reason in d.reasons, (reason, d.reasons)


def test_gate_blocks_paused_breached_and_emergency_and_needs_owner_to_resume():
    ce = ComplianceEngine(BASE)
    a = acct(); a.pause(T0, -1000)
    assert "ACCOUNT_PAUSED_DLL" in ce.check(intent(client_id="p"), a, mkt()).reasons
    b = acct(); b.breach(T0, "x", -2001)
    assert "ACCOUNT_BREACHED" in ce.check(intent(client_id="b"), b, mkt()).reasons
    assert "NO_ACTIVE_ACCOUNT" in ce.check(intent(client_id="n"), None, mkt()).reasons
    ce.emergency_pause("owner test", "now")
    assert "EMERGENCY_PAUSE" in ce.check(intent(client_id="e"), acct(), mkt()).reasons
    with pytest.raises(PermissionError):
        ce.resume(by="AI_SUGGESTION")
    ce.resume(by="owner")
    assert ce.check(intent(client_id="e2"), acct(), mkt()).accepted


def test_news_rules_block_restricted_stages_without_a_calendar_and_inside_windows():
    sim = cfg("rapid_eod", "50k", "sim_funded")
    assert sim["t1_news_allowed"] is False
    ce = ComplianceEngine(BASE)
    assert "NEWS_CALENDAR_UNAVAILABLE" in ce.check(intent(client_id="n1"), acct(sim), mkt()).reasons
    cpi = dt.datetime(2026, 3, 11, 8, 30, tzinfo=ET)
    ce2 = ComplianceEngine(BASE, NewsCalendar([(cpi, "CPI"), (dt.datetime(2026, 5, 1, 8, 30, tzinfo=ET), "Employment")], "test"))
    at = cpi - dt.timedelta(minutes=2)
    assert "NEWS_WINDOW" in ce2.check(intent(client_id="n2"), acct(sim), mkt(now=at, last_bar_time=at - dt.timedelta(minutes=1), live_from=at)).reasons
    ok_t = cpi + dt.timedelta(minutes=5)
    assert ce2.check(intent(client_id="n3"), acct(sim), mkt(now=ok_t, last_bar_time=ok_t - dt.timedelta(minutes=1), live_from=ok_t)).accepted
    assert ce.check(intent(client_id="n4"), acct(cfg("builder", "50k")), mkt()).accepted   # evaluations allow T1 (S7)


def test_ai_suggestions_get_no_override_and_the_same_verdict():
    ce = ComplianceEngine(BASE)
    with pytest.raises(TypeError):
        ce.check(intent(), acct(), mkt(), None, override=True)
    bad = dict(stop_loss=18000.0)
    d1 = ce.check(intent(client_id="s", **bad), acct(), mkt())
    d2 = ce.check(intent(client_id="ai", source="AI_SUGGESTION", **bad), acct(), mkt())
    assert not d1.accepted and d1.reasons == d2.reasons
    with pytest.raises(dataclasses.FrozenInstanceError):
        d2.accepted = True


# ---------------------------------------------------------------- execution: local only
def test_external_adapters_cannot_be_created_and_router_is_local_only():
    assert EXTERNAL_EXECUTION == "DISABLED" and INTEGRATION_STATUS["selected"] is None
    for cls in (NinjaTraderAdapter, TradovateAdapter):
        with pytest.raises(ExternalExecutionDisabled):
            cls()
    ce = ComplianceEngine(BASE)
    with pytest.raises(ExternalExecutionDisabled):
        OrderRouter(ce, SimpleNamespace(kind="external", name="X"))


def test_adapters_only_accept_decisions_issued_for_that_exact_order_once():
    ce = ComplianceEngine(BASE)
    ad = MockAdapter(ce)
    i = intent(client_id="r1")
    d = ce.check(i, acct(), mkt())
    assert ad.submit(dataclasses.replace(i, qty=40), d).accepted is False     # decision bound to the intent digest
    assert ad.submit(i, d).accepted is True
    assert ad.submit(i, d).accepted is False                                  # cannot be replayed
    rej = ce.check(intent(client_id="r2", stop_loss=None), acct(), mkt())
    assert ad.submit(intent(client_id="r2", stop_loss=None), rej).accepted is False
    paper = PaperSimAdapter(ce)
    r = OrderRouter(ce, paper)
    assert r.submit(intent(client_id="r3"), acct(), mkt()).accepted
    paper.on_bar("MNQ", T0, 20002, 20003, 19999, 20001)
    assert paper.fills and paper.positions()[0].qty == 1
    assert not r.submit(intent(client_id="r3"), acct(), mkt()).accepted       # duplicate id


def test_no_network_code_in_the_mffu_package_and_none_used_at_runtime(monkeypatch):
    banned = {"socket", "requests", "urllib", "http", "httpx", "aiohttp", "websocket", "websockets", "ssl", "ftplib", "smtplib"}
    for p in glob.glob(os.path.join(os.path.dirname(R.__file__), "*.py")):
        tree = ast.parse(open(p).read())
        for node in ast.walk(tree):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else ([node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            assert not any(n.split(".")[0] in banned for n in names), (p, names)

    def boom(*a, **k):
        raise AssertionError("network access attempted")
    monkeypatch.setattr(socket, "socket", boom)
    monkeypatch.setattr(socket, "create_connection", boom)
    ov = MffuOverlay("builder", "50k", {"evaluation": {"breach_basis": "intraday_equity"}, "sim_funded": {"breach_basis": "intraday_equity"}}, BASE)
    run(_walk(3000), Settings(), Execution(sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1), overlay=ov)
    ov.finish(None)
    assert ov.report()["all"]["evaluation_attempts"] >= 1


# ---------------------------------------------------------------- restart recovery
def test_restart_recovery_resumes_identically(tmp_path):
    def script(a, days):
        for i in days:
            d = D0 + dt.timedelta(days=i); a.start_day(d, T0)
            a.on_trade(trade(150 if i % 3 else -90, mae=4), d); a.mark(T0, a.balance - 50, a.balance, a.balance + 20)
            a.end_day(d, T0, a.balance, True)
    ref = acct(); script(ref, range(10))
    a = acct(); script(a, range(5))
    p = str(tmp_path / "acct.json"); store.save(p, a.to_state())
    b = VirtualAccount.from_state(store.load(p)); script(b, range(5, 10))
    assert b.summary() == ref.summary()
    ce = ComplianceEngine(BASE); ce.check(intent(client_id="dup"), acct(), mkt()); ce.emergency_pause("halt")
    store.save(str(tmp_path / "ce.json"), ce.to_state())
    ce2 = ComplianceEngine(BASE); ce2.load_state(store.load(str(tmp_path / "ce.json")))
    r = ce2.check(intent(client_id="dup"), acct(), mkt()).reasons
    assert "DUPLICATE_ORDER_ID" in r and "EMERGENCY_PAUSE" in r


# ---------------------------------------------------------------- historical overlay (engine integration)
class _PassThrough:
    def on_closed(self, tr, t): pass
    def on_bar(self, *a): return None
    def admit(self, ctx): return True
    def end_of_bar(self, *a): return None


def test_a_permissive_overlay_changes_nothing():
    bars = _walk(6000)
    ex = Execution(sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1)
    a = run(bars, Settings(), ex)["trades"]; b = run(bars, Settings(), ex, overlay=_PassThrough())["trades"]
    assert [(x.entry_bar, x.exit_bar, x.entry, x.exit, x.reason) for x in a] == [(x.entry_bar, x.exit_bar, x.entry, x.exit, x.reason) for x in b] and a


STRICT_ = {"breach_basis": "intraday_equity"}
BIG = FuturesSpec("MNQ", "test-only scaled MNQ", "NQ", 200.0, 0.25, 50.0, 0.1, "HMUZ", "", "test")


def test_breaches_end_attempts_new_attempts_start_next_day_and_failures_are_kept():
    ov = MffuOverlay("builder", "50k", {"evaluation": {"breach_basis": "intraday_equity"}}, BASE, spec=BIG)
    run(_walk(8000, seed=5), Settings(), Execution(sizing="fixed1", point_value=200.0, commission_per_side=0.74, stop_slip_ticks=1), overlay=ov)
    ov.finish(None)
    rep = ov.report()
    ev = [h for h in ov.history if h["stage"] == "evaluation"]
    assert rep["all"]["breached"] >= 1 and len(ev) >= 2
    for prev, nxt in zip(ev, ev[1:]):
        if prev["status"] == BREACHED:
            assert nxt["opened"] > prev["closed"]                          # next attempt on a later trading day
    for h in ev:
        if h["status"] == BREACHED:
            assert h["balance"] >= h["floor"] - 300 and h["reason"]          # liquidated near the threshold, reason kept
    assert rep["overlay_counters"]["orphan_trades"] == 0
    assert any(t["reason"].startswith("ACCT_BREACH") for t in ov.trades)


def test_session_end_rule_flattens_builder_only_and_the_engine_books_it():
    t1659, t1800 = dt.datetime(2026, 3, 2, 16, 59, tzinfo=ET), dt.datetime(2026, 3, 2, 18, 0, tzinfo=ET)
    pos = SimpleNamespace(side=1, qty=1, entry=20000.0)
    b = MffuOverlay("builder", "50k", {"evaluation": STRICT_}, BASE); b.on_bar(0, t1659, 20000, 20001, 19999, 20000, None)
    assert b.end_of_bar(0, t1659, t1800, pos) == "ACCT_SESSION_END" and b.c["session_flattens"] == 1
    assert b.end_of_bar(0, t1659, t1659 + dt.timedelta(minutes=1), pos) is None          # same session: no flatten
    p = MffuOverlay("pro", "50k", {"evaluation": STRICT_}, BASE); p.on_bar(0, t1659, 20000, 20001, 19999, 20000, None)
    assert p.end_of_bar(0, t1659, t1800, pos) is None and p.c["held_across_session_rule_unresolved"] == 1   # rule not stated: counted, not invented

    class SessionOnly(_PassThrough):   # admits everything; applies only the session-end flatten
        def end_of_bar(self, k, t, t_next, pos):
            return "ACCT_SESSION_END" if pos is not None and (t_next is None or session_day(t_next) != session_day(t)) else None
    st = Settings(sl_buf=30.0, use_be=False, use_trail=False, tp2_ext=-3.0)   # test-only: long-lived positions
    ex = Execution(sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1)
    free = run(_walk(6000, seed=2), st, ex)["trades"]
    assert any(session_day(x.entry_time) != session_day(x.exit_time) for x in free), "fixture must hold across a session"
    flat = run(_walk(6000, seed=2), st, ex, overlay=SessionOnly())
    assert any(x.reason == "ACCT_SESSION_END" for x in flat["trades"])
    assert all(session_day(x.entry_time) == session_day(x.exit_time) for x in flat["trades"])


def test_overlay_never_enters_while_cme_is_closed():
    ov = MffuOverlay("builder", "50k", {"evaluation": STRICT_, "sim_funded": STRICT_}, BASE)
    res = run(_walk(6000, seed=2), Settings(), Execution(sizing="fixed1", commission_per_side=0.74, stop_slip_ticks=1), overlay=ov)
    assert res["trades"] and ov.compliance.counts.get("MARKET_CLOSED", 0) > 0
    assert all(is_open(x.entry_time) for x in res["trades"])


def test_payouts_follow_builder_rules_and_pro_mll_turns_static():
    def builder(days):
        x = VirtualAccount(cfg("builder", "50k", "sim_funded"), "B", D0)
        for i, pnl in enumerate(days):
            d = D0 + dt.timedelta(days=i); x.start_day(d, T0); x.on_trade(trade(pnl), d); x.end_day(d, T0, x.balance, True)
        return x, d
    x, d = builder([2500])
    assert x.try_payout(d, T0) is None                          # buffer $2,100 + $500 not reached, 1 qualifying day
    x, d = builder([2500, 2400])
    assert x.try_payout(d, T0) is None                          # cycle consistency: $2,500 > 50% of $4,900
    a, d = builder([1700, 1700, 1700])
    po = a.try_payout(d, T0)
    assert po and po["gross"] == 2000.0 and po["trader_share"] == 1600.0 and a.balance == 3100.0   # capped at $2,000, 80/20
    assert a.floor == 100.0
    p = VirtualAccount(cfg("pro", "50k", "sim_funded", max_micros=3), "P", D0); p.start_day(D0, T0)
    p.on_trade(trade(3500), D0); p.end_day(D0, T0, p.balance, True)
    assert p.try_payout(D0 + dt.timedelta(days=13), T0) is None   # 14 calendar days from the first trade (S10)
    po = p.try_payout(D0 + dt.timedelta(days=14), T0)
    assert po and po["gross"] == 1400.0 and p.floor == 100.0 and p.static_floor == 100.0


def test_pro_one_day_contract_limit_rejects_oversized_orders_through_the_engine():
    ov = MffuOverlay("pro", "50k_one_day", {"evaluation": {"breach_basis": "intraday_equity"}}, BASE)
    ex = Execution(sizing="whole", commission_per_side=0.74, stop_slip_ticks=1)
    st = Settings(risk_usd=100000.0)          # test-only: forces quantities far above the 30-micro cap
    r = run(_walk(4000), st, ex, overlay=ov)
    assert not r["trades"] and r["diag"]["account_refused_bars"] > 0
    assert ov.compliance.counts.get("CONTRACT_LIMIT", 0) > 0
