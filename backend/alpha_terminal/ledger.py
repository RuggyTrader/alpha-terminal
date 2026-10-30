"""Trade ledger and PAPER P&L calculations.

See docs/CALCULATIONS.md for the exact definitions. Summary:

* Trades are rebuilt from scratch from filled PAPER orders that ALPHA TERMINAL
  submitted (webhook + manual close). Rebuilding from the order table each time
  means a fill can never be counted twice.
* A trade opens when a symbol's ledger position leaves zero and closes when it
  returns to zero. Lots are matched FIFO.
* Realized P&L is the sum of (exit price - FIFO entry price) * qty over every
  closing fill (sign flipped for shorts). Unrealized P&L is never mixed in.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models import Order, Trade

ZERO = Decimal("0")


@dataclass
class _OpenTrade:
    symbol: str
    direction: int  # +1 long, -1 short
    opened_at: datetime
    strategy: str | None
    open_alert_id: str | None
    open_order_id: str | None
    lots: list[list[Decimal]] = field(default_factory=list)  # [qty, price]
    entry_qty: Decimal = ZERO
    entry_cost: Decimal = ZERO
    exit_qty: Decimal = ZERO
    exit_value: Decimal = ZERO
    closed_cost: Decimal = ZERO
    realized: Decimal = ZERO
    legs: list[int] = field(default_factory=list)
    close_order_id: str | None = None
    closed_at: datetime | None = None

    @property
    def open_qty(self) -> Decimal:
        return sum((lot[0] for lot in self.lots), ZERO)


def _to_trade(t: _OpenTrade) -> Trade:
    closed = t.open_qty == 0
    ret = None
    if t.closed_cost > 0:
        ret = (t.realized / t.closed_cost * 100).quantize(Decimal("0.0001"))
    return Trade(
        symbol=t.symbol,
        direction="long" if t.direction > 0 else "short",
        status="closed" if closed else "open",
        strategy=t.strategy,
        open_alert_id=t.open_alert_id,
        open_order_id=t.open_order_id,
        close_order_id=t.close_order_id if closed else None,
        entry_qty=t.entry_qty,
        entry_avg_price=(t.entry_cost / t.entry_qty).quantize(Decimal("0.000001")),
        exit_qty=t.exit_qty,
        exit_avg_price=(t.exit_value / t.exit_qty).quantize(Decimal("0.000001")) if t.exit_qty > 0 else None,
        open_qty=t.open_qty,
        closed_cost_basis=t.closed_cost,
        realized_pnl=t.realized.quantize(Decimal("0.01")),
        return_pct=ret,
        opened_at=t.opened_at,
        closed_at=t.closed_at if closed else None,
        leg_order_ids_json=json.dumps(t.legs),
    )


def build_trades(orders: list[Order]) -> list[Trade]:
    fills = [o for o in orders if o.filled_qty and o.filled_qty > 0 and o.filled_avg_price is not None]
    fills.sort(key=lambda o: (o.filled_at or o.submitted_at, o.id))
    open_by_symbol: dict[str, _OpenTrade] = {}
    done: list[_OpenTrade] = []
    for o in fills:
        qty, price = Decimal(o.filled_qty), Decimal(o.filled_avg_price)  # type: ignore[arg-type]
        sign = 1 if o.side == "buy" else -1
        ts = o.filled_at or o.submitted_at
        alert = o.alert
        remaining = qty
        trade = open_by_symbol.get(o.symbol)
        if trade is not None and trade.direction != sign:
            trade.legs.append(o.id)
            closing = min(remaining, trade.open_qty)
            left = closing
            while left > 0 and trade.lots:
                lot = trade.lots[0]
                take = min(left, lot[0])
                trade.realized += (price - lot[1]) * take * trade.direction
                trade.closed_cost += lot[1] * take
                lot[0] -= take
                left -= take
                if lot[0] == 0:
                    trade.lots.pop(0)
            trade.exit_qty += closing
            trade.exit_value += closing * price
            remaining -= closing
            if trade.open_qty == 0:
                trade.close_order_id = o.alpaca_order_id
                trade.closed_at = ts
                done.append(trade)
                del open_by_symbol[o.symbol]
                trade = None
        if remaining > 0:
            if trade is None:
                trade = _OpenTrade(
                    symbol=o.symbol, direction=sign, opened_at=ts,
                    strategy=alert.strategy if alert else ("MANUAL" if o.source != "webhook" else None),
                    open_alert_id=alert.alert_id if alert else None, open_order_id=o.alpaca_order_id,
                )
                open_by_symbol[o.symbol] = trade
            if not trade.legs or trade.legs[-1] != o.id:
                trade.legs.append(o.id)
            trade.lots.append([remaining, price])
            trade.entry_qty += remaining
            trade.entry_cost += remaining * price
    return [_to_trade(t) for t in done + list(open_by_symbol.values())]


def rebuild_trades(db: Session) -> None:
    orders = list(db.scalars(select(Order)).all())
    trades = build_trades(orders)
    db.execute(delete(Trade))
    db.add_all(trades)
    db.commit()


def ledger_stats(db: Session) -> dict[str, object]:
    trades = list(db.scalars(select(Trade)).all())
    closed = [t for t in trades if t.status == "closed"]
    realized_all = sum((t.realized_pnl for t in trades), ZERO)  # includes partial exits of open trades
    realized_closed = sum((t.realized_pnl for t in closed), ZERO)
    closed_cost = sum((t.closed_cost_basis for t in closed), ZERO)
    wins = len([t for t in closed if t.realized_pnl > 0])
    by_symbol: dict[str, Trade] = {}
    for t in trades:
        if t.status == "open":
            by_symbol[t.symbol] = t
    return {
        "realized_pnl": realized_all.quantize(Decimal("0.01")),
        "realized_pnl_closed_trades": realized_closed.quantize(Decimal("0.01")),
        "closed_trades": len(closed),
        "winning_trades": wins,
        "win_rate_pct": (Decimal(wins) / Decimal(len(closed)) * 100).quantize(Decimal("0.01")) if closed else None,
        "closed_trade_return_pct": (realized_closed / closed_cost * 100).quantize(Decimal("0.01")) if closed_cost > 0 else None,
        "open_trades": len(trades) - len(closed),
        "open_trade_by_symbol": by_symbol,
    }
