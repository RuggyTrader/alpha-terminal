# ALPHA TERMINAL command center (UI redesign, 2026-11-16)

A presentation-layer redesign of the existing app. Trading logic, the ledger, wallets, positions, risk controls, fees, strict fill timing, the engine and the BTC trend trial are unchanged.

## Navigation: four tabs

| Tab | Contents |
|---|---|
| **Home** | Fixed one-screen command center: header, compact hero with the talking globe, Closed trades, ALPHA Activity |
| **Bots** | The fleet, grouped by market; search, market and status filters; compact tiles; each tile opens the bot's own terminal |
| **Trades** | Trades & Performance: Performance · Completed · Open · Pending · Rejected / Cancelled · Activity · Signals & records |
| **Settings** | Account & wallets (with the capital overview), Bots & risk, Notifications, Appearance (theme, animations, talking globe), Security, Advanced |

**Old links keep working:**
- `/performance` → `/trades?view=performance`, and `/activity` → `/trades?view=activity`. Query parameters such as `?bot=` are carried over.
- `/trades?bot=…` and `/trades?signal=…` open the records they filter.

**Research trial:** the BTC daily trend forward trial (shown as **BTC Titan** in research) has its own page, `/research/trial`. It is reached from Settings → Advanced, not from the tabs or Home. Its panel, data, authentication and controls are unchanged.

## Home (one screen)

**Layout:** `.shell-fixed` uses `100dvh` with a `100vh` fallback, plus safe-area insets. The header, hero and Closed trades take their content height; ALPHA Activity takes the rest (`flex: 1; min-height: 0`) and is the only part that scrolls.

**Viewport adjustments:**
- Below 820 px of height, the globe and spacing shrink.
- Below 780 px, Closed trades shows 2 cards instead of 4.
- Below 560 px (very large text or a tiny window), the fixed layout is released, so nothing is clipped.

**Measured at 402 × 874** (local preview): header 46 px, hero 251, Closed trades 177, activity 302, navigation 64. Page scroll height equals the viewport, and there is no horizontal overflow.

### Hero and talking globe

**Figures:** the hero uses the same figures and sources as before (`lifetimeMetrics` over the verified funded trade set): verified P&L, total return, closed trades, win rate and profit factor.

**Speech bubble:** `companion.ts` builds the bubble's lines from records only.

| Source | Used for |
|---|---|
| Shared fleet snapshot | Engine status, open positions, recorded stop management, engine-reported pending limits |
| Verified lifetime metrics | Performance lines |
| Latest closed funded trades | "Just closed" lines (net after fees) |
| Dashboard feed state | Data age; failures |

**Ranking:**
1. issues, such as stale data or an offline bot;
2. a trade that just closed;
3. positions and stop moves;
4. pending orders;
5. performance;
6. calm scanning status.

**Rotation:** every 8 s, with a 90 s cooldown per line.

**Rules it follows:**
- A pending order is never described as filled.
- A loss is never described as profit.
- Nothing sounds live when the data is stale.

**Tapping the globe** opens the read-only ALPHA Assistant (`assistant.ts`, deterministic). It answers new portfolio questions: why the portfolio is down (gross, fees, net), open positions, which bot performed best, what the bots are doing, total fees and the most recent trade. When the data is missing, it says so.

### Closed trades

**Source:** the latest completed funded PAPER trades from the shared bot-trades snapshot (the same rows as Trades → Completed).

**Excluded:** anything without a recorded net result, open positions, pending orders, refusals, Strategy Mirror and research.

**Ordering:** newest close first, with a tie-break on the stable trade id.

**Return:** net ÷ entry notional, from the recorded quantity and price.

**Animation:** a trade that closes while Home is open slides into the first slot, with a brief green or red highlight. The other cards move to their new slots (FLIP: transform and opacity only), and the oldest leaves.

### ALPHA Activity

The recorded event history (`GET /api/dashboard/events`) shown as a chat-style stream: oldest at the top, newest at the bottom.

**Behaviour:**
- It opens at the newest event.
- It follows new events only while the reader is at the bottom. Otherwise it keeps their place and shows "N new updates ↓".
- Scrolling to the top loads older history through the new `before` cursor, and the content does not jump.
- Items are deduplicated by their recorded id. The newest page is authoritative for its time span, so an accepted order is shown once, as its fill.
- Strategy Mirror items stay on the Mirror pages.

**Polling:** every 20 s, only while the page is visible.

## Display names (presentation only)

| Bot id (unchanged) | Display name | Market |
|---|---|---|
| ALPHA-01 | SOL Flare | SOL/USD 1m |
| ALPHA-02 | SOL Orbit | SOL/USD 5m |
| ALPHA-03 | BTC Hash | BTC/USD 1m |
| ALPHA-04 | BTC Atlas | BTC/USD 5m |

**Registry:** `frontend/src/terminal/botNames.ts`.
- Names are applied where the fleet snapshot is read, and to bot references in Worker-written event text.
- They are never applied inside an order, trade or signal id.
- A bot without an entry keeps its reported name, or its id.

## Backend change (minimal, backward compatible)

**`GET /api/dashboard/events?before=<time>`** returns older history, bounded by `limit` (at most 50).
- Each source returns its newest rows recorded at or before the cursor.
- Without `before`, the queries and the response are exactly as before.
- No migration and no new endpoint.

## Preferences (this device)

Settings → Appearance adds two preferences, stored as non-sensitive localStorage keys:
- **Animations:** Full / Reduced. Reduced is also applied automatically when the device asks for reduced motion.
- **Talking globe:** On / Off.

## Local preview

`tools/ui-preview/preview-backend.mjs` runs the real Worker on a temporary local D1, with labelled TEST quotes and a generated passphrase. It creates TEST trades through the Worker's own webhooks. Nothing in it touches production.
