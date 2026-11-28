"""Pine Script v5 built-ins used by the OTE + PD Array strategy, reproduced bar by bar.

Every function returns a list aligned with the input bars; element k uses only bars 0..k (no lookahead).
"""
from __future__ import annotations

import math
from typing import List, Optional, Sequence

NA = None


def true_range(h: Sequence[float], l: Sequence[float], c: Sequence[float]) -> List[float]:
    """ta.tr(true): the first bar (no previous close) uses high - low."""
    out = []
    for k in range(len(h)):
        if k == 0:
            out.append(h[k] - l[k])
        else:
            out.append(max(h[k] - l[k], abs(h[k] - c[k - 1]), abs(l[k] - c[k - 1])))
    return out


def rma(x: Sequence[float], n: int) -> List[Optional[float]]:
    """ta.rma: Wilder's moving average, seeded with the simple average of the first n values."""
    out: List[Optional[float]] = []
    prev = None
    for k, v in enumerate(x):
        if k < n - 1:
            out.append(NA)
        elif k == n - 1:
            prev = sum(x[:n]) / n
            out.append(prev)
        else:
            prev = (prev * (n - 1) + v) / n
            out.append(prev)
    return out


def atr(h, l, c, n: int = 14) -> List[Optional[float]]:
    """ta.atr(n) = ta.rma(ta.tr(true), n)."""
    return rma(true_range(h, l, c), n)


def pivot_high(src: Sequence[float], left: int, right: int, *, strict_left: bool = False) -> List[Optional[float]]:
    """ta.pivothigh(src, left, right): value at bar k is src[k - right] if that bar is a pivot, else NA.

    TradingView's tie rule is not documented. Default (documented assumption): the pivot must be strictly greater
    than every bar to its RIGHT and greater than or equal to every bar to its LEFT. `strict_left=True` tests the
    alternative (strict on both sides) as a sensitivity.
    """
    out: List[Optional[float]] = [NA] * len(src)
    for k in range(left + right, len(src)):
        p = k - right
        v = src[p]
        ok = all(src[p + j] < v for j in range(1, right + 1))
        if ok:
            ok = all((src[p - j] < v) if strict_left else (src[p - j] <= v) for j in range(1, left + 1))
        if ok:
            out[k] = v
    return out


def pivot_low(src: Sequence[float], left: int, right: int, *, strict_left: bool = False) -> List[Optional[float]]:
    out: List[Optional[float]] = [NA] * len(src)
    for k in range(left + right, len(src)):
        p = k - right
        v = src[p]
        ok = all(src[p + j] > v for j in range(1, right + 1))
        if ok:
            ok = all((src[p - j] > v) if strict_left else (src[p - j] >= v) for j in range(1, left + 1))
        if ok:
            out[k] = v
    return out


def lowest(src: Sequence[float], n: int) -> List[Optional[float]]:
    """ta.lowest(src, n): includes the current bar; NA until n bars exist."""
    return [NA if k < n - 1 else min(src[k - n + 1 : k + 1]) for k in range(len(src))]


def highest(src: Sequence[float], n: int) -> List[Optional[float]]:
    return [NA if k < n - 1 else max(src[k - n + 1 : k + 1]) for k in range(len(src))]


def round_to_mintick(x: float, tick: float) -> float:
    """math.round_to_mintick: nearest tick, ties rounded up (away from zero for positive prices)."""
    return math.floor(x / tick + 0.5 + 1e-9) * tick
