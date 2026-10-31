# ALPHA TERMINAL — UI (v1.2, Cloudflare Worker dashboard)

The dashboard is a React + Vite + TypeScript app in `frontend/`, served by the Cloudflare Worker from the same
origin as its API. It reads only `GET /api/dashboard` with a read-only HttpOnly session cookie (see
`worker/README.md`). PAPER / DRY RUN only: there are no browser controls that change execution state.

The visual direction follows the user's reference recording: warm cream background, one premium dark hero card,
rounded white cards, compact coloured pills and a mobile bottom bar with an orange centre item. The reference's
withdraw flow, wallet, confetti, memecoin copy and generated activity were deliberately **not** reproduced. The
orange centre item opens the read-only PAPER engine page.

The v1.1.0 mobile UI for the earlier FastAPI backend (`src/pages`, `src/components`, `src/styles.css`) remains in
the repository for reference but is not routed. Its documentation is in git under the `v1.1.0` tag.

## Structure

```
src/terminal/
  Terminal.tsx          BrowserRouter → DashboardProvider → TerminalRoutes
  store.tsx             one shared refresh loop + sign-out state for every page (useDash)
  AppShell.tsx          compact top bar (ONLINE/STALE/OFFLINE, refresh), banners, bottom nav
  pages/                Home, Trades (Alerts · Risk · Orders · History), Engine, Activity, Settings
  components/           AccountHero, AccountOverview, PositionCard, AlertCard, RiskDecisionCard,
                        OrderIntentCard, TradeCard, ActivityFeed, SafetyCard, ui (StatusBadge, SectionHeader,
                        EmptyState, Expandable, KV, Code, skeletons)
  poller.ts             non-overlapping 7 s refresh, stale handling, 401 → sign-in
  classify.ts / fmt.ts  labels, colours and formatting; missing values → "N/A"
  terminal.css          mobile-first styles
```

## Where every value comes from

| UI | Source (Worker `/api/dashboard`) |
|---|---|
| PAPER EQUITY, cash, buying power, portfolio value | `broker.account` (Alpaca PAPER, read-only) |
| TODAY'S P&L | `broker.account.todays_pnl` (= equity − last_equity); % = P&L ÷ last_equity, hidden when last_equity is missing |
| Market open/closed, next open/close | `broker.clock` |
| Open positions | `broker.positions` |
| Recent alerts, risk decisions, order intents, trades, activity | D1 `alerts`, `risk_decisions`, `orders`, `trades`, `activity_events` via `recent.*` |
| Totals | `counts.*` |
| System mode / engine | `mode`, `execution`, `broker_submission`, `enable_trading`, `engine` |

Nothing is generated client-side. Empty sources show an intentional empty state ("No open PAPER positions",
"No completed PAPER trades yet.", "No recorded activity yet."). While loading, skeletons are shown, never numbers.
When a refresh fails the last snapshot stays visible, dimmed, with "Showing data from hh:mm:ss".

## Colours

Green = dry-run accepted / approved / positive. Red = rejected / error / negative. Orange = duplicate, warning and
risk/strategy activity. Gray = informational. Technical identifiers (alert IDs, client order IDs, risk codes,
timestamps) use monospace inside expandable details only.

## Motion

All motion lives in `src/terminal/motion.css` (tokens + classes) and `src/terminal/motion.tsx` (small hooks). Only
`transform` and `opacity` are animated, except a one-time accordion row height and a one-time background accent on
newly arrived items. No animation library.

| Token | Value |
|---|---|
| `--m-fast` / `--m-normal` / `--m-slow` | 160 / 250 / 480 ms |
| `--m-stagger` | 55 ms between cards |
| `--m-ease`, `--m-ease-out`, `--m-spring` | decelerate, soft settle, small overshoot for taps |

| Where | Behaviour |
|---|---|
| Page change | fade + 8 px rise (250 ms); the bottom-nav bar slides to the new tab; Engine pill keeps its own ring |
| Page entry | cards stagger in once (`.m-stagger`, `AnimatedList`); refreshes with the same records do not replay |
| Lower sections | `Reveal` fades them in once when scrolled into view (never hidden without JS; 2 s safety fallback) |
| PAPER equity, today's P&L, position P&L | `AnimatedNumber` rolls from the previous real value to the new one (480 ms); first view shows the value directly; background tabs and reduced motion update instantly |
| Changed values | `useFlash`: soft green (up), red (down) or orange (other) highlight for 0.9 s |
| New real alerts / order intents / activity / positions | slide in with a brief warm accent; removed positions fade out (`usePresence`) |
| Expandable details | accordion open/close (grid rows + opacity); risk check chips step in |
| Status badges, market status, engine state, connection | crossfade / small scale-in only when the state actually changes |
| Connection | dot pulses briefly after a reconnect only; no permanent blinking |
| Banners | slide in, slide out (`Presence`) |
| Buttons, tabs, nav | press scale ≈ 0.975 with spring back; desktop hover lift on cards |
| α globe | 3 px idle float (9 s); entrance on load; tilt when the account value changes; orbit shift when the market opens/closes or the engine state changes; soft glow after reconnect; squash on tap |
| Loading | subtle shimmer skeletons for hero, overview, positions and alerts; never placeholder numbers |

`prefers-reduced-motion: reduce` collapses all durations to 1 ms, stops the globe float, removes staggers and
reveals, and makes numbers update instantly. State changes still appear.

## Layout

Mobile first at 402 × 874, verified at 390 × 844, 402 × 874 and 430 × 932 with no horizontal scrolling on any page
(including with every card expanded). Safe-area insets pad the top and the fixed bottom nav. From 980 px Home
splits into two columns and the nav becomes a floating pill; content max-width is 1280 px.

Screenshots: `docs/screenshots/v1.2/` (test-fixture data, see the README there).

## Tests

`npm test` covers Home (populated, empty positions, not configured, stale, offline, loading), Trades (rejected and
accepted alerts, collapsed/expanded details, risk check chips, order intents marked dry run, empty history),
Engine (STOPPED, no controls, unsafe-setting warning), Activity (empty, severity), Settings, sign-out, the refresh
loop and the API client timeout.
