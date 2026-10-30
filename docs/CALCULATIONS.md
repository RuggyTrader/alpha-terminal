# ALPHA TERMINAL — how every number is calculated

All values are **Alpaca PAPER** (simulated) or derived from records this app persisted. When a source is
unavailable the API returns `null` and the dashboard shows `N/A` / `UNAVAILABLE` / `NOT CONFIGURED`. Nothing
is estimated, interpolated or filled in.

## Sources

| Source | What it provides |
|---|---|
| Alpaca PAPER `GET /v2/account` | `equity`, `last_equity`, `buying_power`, `cash`, `status`, account `id` |
| Alpaca PAPER `GET /v2/positions` | open positions: `qty`, `avg_entry_price`, `market_value`, `cost_basis`, `unrealized_pl`, `unrealized_plpc` |
| Alpaca market data `GET /v2/stocks/{sym}/trades/latest?feed=iex` | latest IEX trade price + timestamp (used for "CURRENT" price and risk notional) |
| Local `orders` table | every PAPER order ALPHA TERMINAL submitted, with Alpaca's status and aggregate fill (`filled_qty`, `filled_avg_price`, `filled_at`) |
| Local `trades` table | round trips rebuilt from the `orders` table (see below) |

## Trade ledger (realized P&L, closed trades, win rate)

`backend/alpha_terminal/ledger.py` rebuilds the `trades` table **from scratch** from every order with
`filled_qty > 0`, sorted by fill time. Because it is a full rebuild, a fill can never be counted twice.

* Per symbol, a trade **opens** when the ledger position leaves 0 and **closes** when it returns to 0.
* Lots are matched **FIFO**. For each closing fill: `realized += (exit_price − lot_entry_price) × qty`
  (× −1 for a short). `closed_cost_basis += lot_entry_price × qty`.
* Only orders submitted by ALPHA TERMINAL (webhook alerts and the dashboard's explicit CLOSE buttons) are in the
  ledger. Orders you place manually in the Alpaca web dashboard are **not** — the positions view flags such positions as
  `NOT FULLY TRACKED BY TERMINAL`.
* Fills are Alpaca's per-order aggregates (`filled_avg_price`). Alpaca PAPER stock trades are commission-free,
  so no fees are subtracted.

| Field | Formula |
|---|---|
| **REALIZED PAPER P&L** | Σ `realized` over all ledger trades (includes partial exits of still-open trades). Never includes unrealized P&L. |
| **CLOSED TRADES** | count of ledger trades whose position returned to 0 |
| **WIN RATE** | closed trades with realized P&L **> 0** ÷ closed trades × 100. Break-even counts as not a win. `N/A` when there are no closed trades. |
| **RETURN** (hero) | Σ realized of closed trades ÷ Σ closed_cost_basis of closed trades × 100. `N/A` with no closed trades. |
| Trade **PERCENT RETURN** | trade realized ÷ trade closed_cost_basis × 100 |

## Account-level numbers (from Alpaca PAPER)

| Field | Formula |
|---|---|
| **PAPER EQUITY / BUYING POWER** | Alpaca `equity` / `buying_power` as returned |
| **UNREALIZED PAPER P&L** | Σ Alpaca `unrealized_pl` over all open positions (Alpaca's own mark) |
| **TOTAL PAPER P&L** | REALIZED (ledger) + UNREALIZED (Alpaca). `N/A` if positions are unavailable. |
| **TODAY'S PAPER P&L** | Alpaca `equity − last_equity` (`last_equity` = equity at the previous trading day's close) |
| **VERIFIED P&L** (hero) | Alpaca `equity − baseline_equity` |
| **TOTAL RETURN / ACCOUNT RETURN %** | `(equity − baseline_equity) ÷ baseline_equity × 100` |
| **OPEN PAPER EXPOSURE** | Σ \|`market_value`\| over open positions |
| **OPEN POSITIONS** | number of Alpaca positions |

### Baseline equity, resets and deposits

* If `PAPER_STARTING_EQUITY` is set, it is the baseline.
* Otherwise the equity seen at the **first successful connection** is stored (`app_meta.baseline_equity`) together
  with the Alpaca account `id`. The dashboard shows the baseline and how it was set.
* If the Alpaca account `id` changes (new paper account / reset), the baseline is re-captured and an activity event
  is logged. Paper accounts have no deposits or withdrawals, so no cash-flow adjustment is needed. If you change the
  paper balance in Alpaca without a new account id, set `PAPER_STARTING_EQUITY` to the new starting amount.

VERIFIED P&L (account-level, includes everything in the paper account) and TOTAL PAPER P&L (ledger realized +
Alpaca unrealized) can differ when positions exist that ALPHA TERMINAL did not open. Both are shown, labelled.

## Current price freshness (positions)

`CURRENT` = latest IEX trade no older than `MARKET_DATA_MAX_AGE_SECONDS` (default 900). Older → `STALE` with the trade
time shown. Request failure → `N/A` + `MARKET DATA UNAVAILABLE`. Market value and unrealized P&L are Alpaca's figures
and are labelled as such.

## Risk notional

BUY (and short SELL, only if enabled) notional = `qty × latest IEX trade price`. If no price is available the order
is rejected (`MARKET_DATA_UNAVAILABLE`) rather than guessed. The price and its timestamp are stored on the risk
decision so you can see what the check used.
