"""Bar-by-bar translation of `alpha-terminal/tradingview/ote_pd_array_strategy.pine` (OTE + PD Array Strategy (Auto))
with a TradingView-style broker emulator. Research / historical simulation only: no broker connection of any kind.

Execution model (documented assumptions):
  * The script runs once at each bar's CLOSE (TradingView default: no calc on every tick, no "fill on bar close").
  * Orders placed / modified / cancelled at bar k's close are live from bar k+1's open (no retroactive effect).
  * Inside a bar the price path is unknown. Two models:
      - "tv":           TradingView's broker-emulator rule: if the high is closer to the open than the low,
                        open -> high -> low -> close; otherwise open -> low -> high -> close.
      - "conservative": adverse first for the position (or the pending entry): a long sees open -> low -> high -> close,
                        a short sees open -> high -> low -> close. An entry can fill and be stopped out in the same bar.
  * Limit orders fill at the limit price when touched (or `limit_through_ticks` beyond it), or at the open if the bar
    opens through them. Stops fill at the stop price minus/plus `stop_slip_ticks`, or at the open if gapped through.
  * Once an entry fills, its bracket (TP2 limit + stop) is live for the rest of the same bar.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any

from .indicators import atr as _atr, pivot_high, pivot_low, lowest, highest, round_to_mintick


@dataclass
class Settings:
    swing_len: int = 5
    min_leg_atr: float = 3.5
    max_age: int = 32
    entry_mode: str = "Limit @ 0.705"
    sl_mode: str = "Swing origin (1.0)"
    sl_buf: float = 0.1
    tp2_ext: float = 0.25
    min_score: int = 1
    use_fvg: bool = True
    use_ob: bool = True
    use_rb: bool = True
    fvg_min_atr: float = 0.1
    disp_atr: float = 1.0
    rb_wick: float = 0.5
    rb_min_atr: float = 0.8
    rb_look: int = 8
    max_zones: int = 70
    allow_long: bool = True
    allow_short: bool = True
    risk_usd: float = 10.0
    use_be: bool = True
    be_frac: float = 0.45
    use_trail: bool = True
    trail_frac: float = 0.05
    trail_len: int = 3
    trail_buf: float = 0.05
    use_hours: bool = False   # trading-hours rules disabled (owner settings)
    use_sleep: bool = False   # sleep window disabled
    weekend_flat: bool = False


@dataclass
class Execution:
    name: str = "A_tradingview"
    path: str = "tv"                 # "tv" | "conservative"
    sizing: str = "fractional"       # "fractional" (TradingView, NON-EXECUTABLE) | "whole" (floor, skip < 1) | "fixed1"
    tick: float = 0.25
    point_value: float = 2.0         # MNQ $2 per point (NQ $20)
    commission_per_side: float = 0.0 # USD per contract per side
    stop_slip_ticks: float = 0.0
    limit_through_ticks: float = 0.0
    strict_pivots: bool = False


@dataclass
class Trade:
    side: int
    qty: float
    entry_bar: int
    entry_time: Any
    entry: float
    init_stop: float
    tp2: float
    exit_bar: int = -1
    exit_time: Any = None
    exit: float = math.nan
    reason: str = ""
    gross: float = 0.0
    commission: float = 0.0
    slippage_usd: float = 0.0
    net: float = 0.0
    risk_usd: float = 0.0
    r_multiple: float = 0.0
    be_moved: bool = False
    trail_moved: bool = False
    same_bar: bool = False
    mae_points: float = 0.0
    mfe_points: float = 0.0


class Broker:
    """TradingView-style emulator for: one limit entry (pending), one bracket exit (TP limit + stop), one position."""

    def __init__(self, ex: Execution):
        self.ex = ex
        self.pending: Optional[Dict[str, Any]] = None   # {side, qty, limit}
        self.bracket: Optional[Dict[str, float]] = None  # {tp, stop}
        self.pos: Optional[Trade] = None
        self.closed: List[Trade] = []

    def cancel_all(self):
        self.pending = None
        if self.pos is None:
            self.bracket = None

    def place_entry(self, side: int, qty: float, limit: float):
        self.pending = {"side": side, "qty": qty, "limit": limit}

    def set_exit(self, tp: float, stop: float):
        self.bracket = {"tp": tp, "stop": stop}

    def _path(self, o, h, l, c, side):
        if self.ex.path == "conservative" and side:
            return [o, l, h, c] if side > 0 else [o, h, l, c]
        return [o, h, l, c] if abs(h - o) < abs(l - o) else [o, l, h, c]

    def process_bar(self, k, t, o, h, l, c, plan_ctx):
        """Simulate fills during bar k for orders that were live at its open. plan_ctx: dict with init_stop/tp2 for a new entry."""
        tick = self.ex.tick
        side = self.pos.side if self.pos else (self.pending["side"] if self.pending else 0)
        if not side:
            return
        pts = self._path(o, h, l, c, side)
        filled_this_bar = False
        thr = self.ex.limit_through_ticks * tick
        slip = self.ex.stop_slip_ticks * tick
        for i in range(3):
            a, b = pts[i], pts[i + 1]
            seg = [(a, b)]
            # within a monotone segment: first entry (if any), then exits on the remaining piece
            while seg:
                a, b = seg.pop()
                if self.pos is None and self.pending:
                    L, s = self.pending["limit"], self.pending["side"]
                    trig = (L - thr) if s > 0 else (L + thr)
                    hit_at_start = (a <= trig) if s > 0 else (a >= trig)
                    crosses = (min(a, b) <= trig) if s > 0 else (max(a, b) >= trig)
                    if (i == 0 and a == o and hit_at_start) or crosses:
                        px = a if (i == 0 and a == o and hit_at_start) else L
                        if i == 0 and a == o and hit_at_start:
                            px = min(o, L) if s > 0 else max(o, L)
                        self.pos = Trade(side=s, qty=self.pending["qty"], entry_bar=k, entry_time=t, entry=px,
                                         init_stop=plan_ctx["init_stop"], tp2=plan_ctx["tp2"])
                        self.pending = None
                        filled_this_bar = True
                        seg.append((px, b))   # the rest of this segment after the fill
                        continue
                if self.pos is not None and self.bracket:
                    p, S, T = self.pos, self.bracket["stop"], self.bracket["tp"]
                    lo, hi = min(a, b), max(a, b)
                    p.mae_points = max(p.mae_points, (p.entry - lo) if p.side > 0 else (hi - p.entry))
                    p.mfe_points = max(p.mfe_points, (hi - p.entry) if p.side > 0 else (p.entry - lo))
                    at_open = (i == 0 and a == o and not filled_this_bar)
                    if p.side > 0:
                        if at_open and a <= S:
                            return self._close(k, t, a - slip, "STOP", slip, filled_this_bar)
                        if at_open and a >= T + thr:
                            return self._close(k, t, a, "TP", 0.0, filled_this_bar)
                        if b < a and lo <= S:
                            return self._close(k, t, S - slip, "STOP", slip, filled_this_bar)
                        if b > a and hi >= T + thr:
                            return self._close(k, t, T, "TP", 0.0, filled_this_bar)
                    else:
                        if at_open and a >= S:
                            return self._close(k, t, a + slip, "STOP", slip, filled_this_bar)
                        if at_open and a <= T - thr:
                            return self._close(k, t, a, "TP", 0.0, filled_this_bar)
                        if b > a and hi >= S:
                            return self._close(k, t, S + slip, "STOP", slip, filled_this_bar)
                        if b < a and lo <= T - thr:
                            return self._close(k, t, T, "TP", 0.0, filled_this_bar)

    def _close(self, k, t, px, kind, slip_px, same_bar):
        p = self.pos
        p.exit_bar, p.exit_time, p.exit = k, t, px
        p.reason = kind
        p.same_bar = same_bar
        pv, q = self.ex.point_value, p.qty
        p.gross = p.side * (px - p.entry) * q * pv
        p.commission = 2 * self.ex.commission_per_side * (q if self.ex.sizing != "fractional" else q)
        p.slippage_usd = slip_px * q * pv
        p.net = p.gross - p.commission
        risk_pts = abs(p.entry - p.init_stop)
        p.risk_usd = risk_pts * q * pv
        p.r_multiple = (p.side * (px - p.entry) / risk_pts) if risk_pts > 0 else 0.0
        self.closed.append(p)
        self.pos = None
        self.bracket = None
        self.pending = None


def run(bars: Dict[str, List[float]], st: Settings, ex: Execution) -> Dict[str, Any]:
    """bars: dict of lists t, o, h, l, c (chronological, one instrument). Returns trades, equity, diagnostics."""
    t, O, Hh, Ll, C = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    n = len(C)
    A = _atr(Hh, Ll, C, 14)
    PH = pivot_high(Hh, st.swing_len, st.swing_len, strict_left=ex.strict_pivots)
    PL = pivot_low(Ll, st.swing_len, st.swing_len, strict_left=ex.strict_pivots)
    LOW = lowest(Ll, st.rb_look)
    HIGH = highest(Hh, st.rb_look)
    TPL = pivot_low(Ll, st.trail_len, st.trail_len, strict_left=ex.strict_pivots)
    TPH = pivot_high(Hh, st.trail_len, st.trail_len, strict_left=ex.strict_pivots)
    tick, pv = ex.tick, ex.point_value
    br = Broker(ex)

    zones: List[Dict[str, Any]] = []
    S = dict(dir=0, legStart=None, legEnd=None, legStartBar=None, legEndBar=None, lastHigh=None, lastLow=None, lastHighBar=None,
             lastLowBar=None, armed=False, triggered=False, trigBar=None, entryP=None, slP=None, tp2P=None, beLevel=None,
             beDone=False, trailLevel=None, trailOn=False, trailMoved=False, curStop=None, planSL=None, planTP2=None,
             lastClosed=0, tSwingLow=None, tSwingHigh=None, forced=False)
    diag = dict(setups=0, orders_placed_bars=0, rejected_setups=set(), rejected_bars=0, be_moves=0, trail_moves=0, same_bar_trades=0)
    eq_close, eq_low = [], []
    realized = 0.0
    setup_id = 0

    def lvl(r):
        return S["legEnd"] + (S["legStart"] - S["legEnd"]) * r

    for k in range(n):
        o, h, l, c = O[k], Hh[k], Ll[k], C[k]
        a = A[k]
        # ---- 0) broker: fills during this bar for orders live at its open ----
        # the order's (tick-rounded) stop and TP2 are what the broker holds; Pine keeps the unrounded plan separately
        br.process_bar(k, t[k], o, h, l, c, {"init_stop": S.get("ordSL"), "tp2": S.get("ordTP2")})
        if br.closed and br.closed[-1].exit_bar == k and not getattr(br.closed[-1], "_booked", False):
            tr = br.closed[-1]   # one position at a time: at most one trade can close per bar
            tr._booked = True
            realized += tr.net
            if tr.same_bar:
                diag["same_bar_trades"] += 1
        if a is None:
            eq_close.append(realized); eq_low.append(realized)
            continue
        # trailing swings (global scope in Pine)
        if TPL[k] is not None:
            S["tSwingLow"] = TPL[k]
        if TPH[k] is not None:
            S["tSwingHigh"] = TPH[k]
        # ---- 1) PD arrays: mitigate, then detect ----
        zones[:] = [z for z in zones if not (c < z["bot"] if z["side"] == 1 else c > z["top"])]
        body, rng = abs(c - o), h - l
        loW, upW = min(o, c) - l, h - max(o, c)
        h1, l1, o1, c1 = (Hh[k - 1], Ll[k - 1], O[k - 1], C[k - 1]) if k >= 1 else (None,) * 4
        h2, l2 = (Hh[k - 2], Ll[k - 2]) if k >= 2 else (None, None)

        def add(top, bot, kind, side):
            zones.append(dict(top=top, bot=bot, idx=k, kind=kind, side=side))
            if len(zones) > st.max_zones:
                zones.pop(0)
        if h2 is not None:
            if st.use_fvg and l > h2 and (l - h2) >= a * st.fvg_min_atr:
                add(l, h2, 1, 1)
            if st.use_fvg and h < l2 and (l2 - h) >= a * st.fvg_min_atr:
                add(l2, h, 1, -1)
        if h1 is not None:
            if st.use_ob and c > o and body >= a * st.disp_atr and c > h1 and c1 < o1:
                add(h1, l1, 2, 1)
            if st.use_ob and c < o and body >= a * st.disp_atr and c < l1 and c1 > o1:
                add(h1, l1, 2, -1)
        if LOW[k] is not None:
            if st.use_rb and rng >= a * st.rb_min_atr and loW >= rng * st.rb_wick and l <= LOW[k]:
                add(min(o, c), l, 3, 1)
            if st.use_rb and rng >= a * st.rb_min_atr and upW >= rng * st.rb_wick and h >= HIGH[k]:
                add(h, max(o, c), 3, -1)
        # ---- 2) position sync ----
        closedNow = len(br.closed)
        justClosed = closedNow > S["lastClosed"]
        S["lastClosed"] = closedNow
        inPos = br.pos is not None
        if inPos and not S["triggered"] and S["dir"] != 0:
            S.update(triggered=True, trigBar=k, entryP=br.pos.entry, slP=S["planSL"], tp2P=S["planTP2"], curStop=S["planSL"], beDone=False, trailOn=False, trailMoved=False)
            S["beLevel"] = S["entryP"] + (S["tp2P"] - S["entryP"]) * st.be_frac
            S["trailLevel"] = S["entryP"] + (S["tp2P"] - S["entryP"]) * st.trail_frac
        if not inPos and S["triggered"]:
            tr = br.closed[-1]
            tol = tick * 2
            won = (tr.exit >= S["tp2P"] - tol) if S["dir"] == 1 else (tr.exit <= S["tp2P"] + tol)
            trail_exit = S["trailMoved"] and not won
            at_be = S["beDone"] and not won and not trail_exit and abs(tr.exit - S["entryP"]) <= tol
            tr.reason = "TP2" if won else ("TRAIL" if trail_exit else ("BE" if at_be else "SL"))
            tr.be_moved, tr.trail_moved = S["beDone"], S["trailMoved"]
            br.cancel_all()
            S.update(triggered=False, trailOn=False, dir=0)
        elif not inPos and justClosed and S["dir"] != 0 and not S["triggered"]:
            tr = br.closed[-1]
            tr.reason = "TP2" if tr.reason == "TP" else "SL"
            br.cancel_all()
            S["dir"] = 0
        # ---- 3) market structure ----
        legChanged = False
        ph, pl = PH[k], PL[k]
        if ph is not None:
            S["lastHigh"], S["lastHighBar"] = ph, k - st.swing_len
            if S["dir"] == 0 and S["lastLow"] is not None and S["lastLowBar"] < S["lastHighBar"] and (S["lastHigh"] - S["lastLow"]) >= a * st.min_leg_atr:
                S.update(dir=1, legStart=S["lastLow"], legStartBar=S["lastLowBar"], legEnd=S["lastHigh"], legEndBar=S["lastHighBar"], triggered=False)
                legChanged = True; setup_id += 1; diag["setups"] += 1
            elif S["dir"] == 1 and not S["triggered"] and ph > S["legEnd"]:
                S["legEnd"], S["legEndBar"] = ph, k - st.swing_len
                legChanged = True
        if pl is not None:
            S["lastLow"], S["lastLowBar"] = pl, k - st.swing_len
            if S["dir"] == 0 and S["lastHigh"] is not None and S["lastHighBar"] < S["lastLowBar"] and (S["lastHigh"] - S["lastLow"]) >= a * st.min_leg_atr:
                S.update(dir=-1, legStart=S["lastHigh"], legStartBar=S["lastHighBar"], legEnd=S["lastLow"], legEndBar=S["lastLowBar"], triggered=False)
                legChanged = True; setup_id += 1; diag["setups"] += 1
            elif S["dir"] == -1 and not S["triggered"] and pl < S["legEnd"]:
                S["legEnd"], S["legEndBar"] = pl, k - st.swing_len
                legChanged = True
        if legChanged:
            S["armed"] = False
        if S["dir"] != 0 and not S["triggered"]:
            broken = (l < S["legStart"]) if S["dir"] == 1 else (h > S["legStart"])
            expired = k - S["legEndBar"] > st.max_age
            if broken or expired:
                br.cancel_all()
                S["dir"] = 0
        # ---- 4) trade plan + order placement ----
        if S["dir"] != 0 and not S["triggered"]:
            d = S["dir"]
            l618, l705, l786 = lvl(0.618), lvl(0.705), lvl(0.786)
            zHi, zLo = max(l618, l786), min(l618, l786)
            f = ob = rb = False
            for z in zones:
                if z["side"] == d and z["idx"] >= S["legStartBar"] and z["bot"] <= zHi and z["top"] >= zLo:
                    if z["kind"] == 1: f = True
                    elif z["kind"] == 2: ob = True
                    else: rb = True
            sc = int(f) + int(ob) + int(rb)
            slBase = S["legStart"] if st.sl_mode == "Swing origin (1.0)" else l786
            slPlan = slBase - a * st.sl_buf if d == 1 else slBase + a * st.sl_buf
            tp2v = lvl(st.tp2_ext)
            S["planSL"], S["planTP2"] = slPlan, tp2v
            armedNow = S["armed"] or ((l > l618) if d == 1 else (h < l618))
            priceSide = (c > l705) if d == 1 else (c < l705)
            ep = l705
            timing = armedNow and priceSide
            valid = (tp2v > ep > slPlan) if d == 1 else (tp2v < ep < slPlan)
            dirOk = st.allow_long if d == 1 else st.allow_short
            place = timing and valid and dirOk and sc >= st.min_score
            S["armed"] = armedNow
            if place:
                qty = st.risk_usd / (abs(ep - slPlan) * pv)
                if ex.sizing == "whole":
                    qty = math.floor(qty + 1e-12)
                elif ex.sizing == "fixed1":
                    qty = 1.0
                if qty > 0:
                    br.place_entry(d, qty, round_to_mintick(l705, tick))
                    br.set_exit(round_to_mintick(tp2v, tick), round_to_mintick(slPlan, tick))
                    S["ordSL"], S["ordTP2"] = round_to_mintick(slPlan, tick), round_to_mintick(tp2v, tick)
                    diag["orders_placed_bars"] += 1
                else:
                    # whole-contract sizing: one contract would exceed the $ risk budget -> no order (skip; recorded)
                    br.cancel_all()
                    diag["rejected_bars"] += 1
                    diag["rejected_setups"].add(setup_id)
            else:
                br.cancel_all()
        # ---- 5) trade management (break-even, trailing) from the bar AFTER the fill ----
        if S["triggered"] and br.pos is not None and k > S["trigBar"]:
            d = S["dir"]
            newStop = S["curStop"]; beNow = trailNow = False
            if st.use_be and not S["beDone"] and ((h >= S["beLevel"]) if d == 1 else (l <= S["beLevel"])):
                S["beDone"] = True
                if (S["entryP"] > newStop) if d == 1 else (S["entryP"] < newStop):
                    newStop = S["entryP"]; beNow = True
            if st.use_trail and not S["trailOn"] and ((h >= S["trailLevel"]) if d == 1 else (l <= S["trailLevel"])):
                S["trailOn"] = True
            if S["trailOn"]:
                cand = (S["tSwingLow"] - a * st.trail_buf) if (d == 1 and S["tSwingLow"] is not None) else ((S["tSwingHigh"] + a * st.trail_buf) if (d == -1 and S["tSwingHigh"] is not None) else None)
                if cand is not None and ((cand > newStop and cand < c) if d == 1 else (cand < newStop and cand > c)):
                    newStop = cand; trailNow = True
            newStop = round_to_mintick(newStop, tick)
            if newStop != S["curStop"]:
                S["curStop"] = newStop
                if trailNow:
                    S["trailMoved"] = True; diag["trail_moves"] += 1
                if beNow and not trailNow:
                    diag["be_moves"] += 1
                br.set_exit(round_to_mintick(S["tp2P"], tick), S["curStop"])   # live from the next bar
        # ---- 6) marks ----
        ur = ul = 0.0
        if br.pos is not None:
            p = br.pos
            ur = p.side * (c - p.entry) * p.qty * pv
            worst = l if p.side > 0 else h
            ul = p.side * (worst - p.entry) * p.qty * pv
        eq_close.append(realized + ur); eq_low.append(realized + ul)

    diag["rejected_setups"] = len(diag["rejected_setups"])
    return {"trades": br.closed, "open": br.pos, "eq_close": eq_close, "eq_low": eq_low, "diag": diag, "settings": asdict(st), "execution": asdict(ex)}
