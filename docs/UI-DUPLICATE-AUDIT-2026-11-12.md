# UI duplicate-section audit — 2026-11-12 (branch `v1.2.0-cloudflare`, NOT deployed)

**Rule:** each kind of record has one home page. Other pages keep a summary card or a shortcut, never a second full copy.

## Page responsibilities

| Page | Owns | Summary or shortcut only |
|---|---|---|
| Home | Account hero; Performance selector (Funded / Mirror / By bot); pipelines | Activity (3 latest, link "All activity"); recent signals (3, link to Trades); portfolio summary; open positions |
| Bots | Each bot's controls, balances, sizing decision, shortfall | Links: Trades `?bot=`, Performance `?bot=`, chart |
| Trades | Every signal, order, risk decision and trade; `?bot=` and `?signal=` filters; links to proofs | — |
| Activity | The event history (fills, lifecycle, mirror, system), each linked to its proof or record | — |
| Performance | Verified metrics, cost breakdown, equity curve, the ledger's realized / unrealized / total P&L; `?bot=` view | — |
| Engine | The legacy single-engine card (ALPHA-02's engine report and ledger reconciliation) | — |
| Proof pages | `/trades/:id` (legacy ledger), `/bots/trade/:id` (bot ledger), `/mirror/trade/:id` (hypothetical) | — |

## Changes

| Section | Before | After | Why |
|---|---|---|---|
| "ALPHA PAPER performance" (realized / unrealized / total) | Home | **Moved** to Performance | It repeated the hero and selector on Home. Its unrealized and total figures exist nowhere else, so it was moved rather than deleted |
| OTE engine card (single engine) | Home side column + Engine page | **Engine page only** | The Home bot pipeline shows every bot's state; the card describes only ALPHA-02's legacy engine |
| Activity list | Home showed 8 full rows | **3 rows** plus "All activity →" | The Activity page is the event history |
| Recent signals | Home showed 5 | **3** plus "View all" | Trades is the record of signals |
| Funded P&L on Home | Hero and Funded tab read the legacy ledger only, so they showed $0.00 while bot-ledger trades existed | **One funded set** (`fundedTrades.ts`): legacy ledger + bot ledger, never counted twice | The same net appears everywhere: hero, Funded tab, Performance `?bot=` |
| Portfolio card "Realized P&L" | Gross before fees, beside a net hero | **"Realized net P&L"** with gross and fees beneath (when the Worker reports fees) | Two different numbers both called "realized P&L" read as a contradiction |
| Legacy engine wording ("The Kraken engine has not reported") | Read as if every engine were stopped | Names the legacy ALPHA 02 engine and points to Bots | Fleet bots can be online while the legacy engine is not |
| Bot data polling | Bots, Home pipeline, Home selector, chart and Assistant each polled `/api/dashboard/bots` | **One shared store** (`fleetStore.ts`) | Removes duplicate requests; one snapshot everywhere |

## Unchanged by design

- Strategy Mirror stays on its own pages and is labelled hypothetical; it is never merged with funded figures.
- No financial record was deleted. Only the presentation moved.

Evidence: `docs/screenshots/2026-11-12/` (LOCAL TEST data, 402 px, light and dark) and `frontend/src/terminal/terminal.test.tsx`, `filters.test.tsx` and `bots.test.tsx`.
