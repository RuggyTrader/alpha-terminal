# ALPHA TERMINAL — UI architecture (v1.1.0)

The dashboard is a React + Vite + TypeScript PWA in `frontend/`. It talks only to the ALPHA TERMINAL backend
(never to Alpaca) and holds no credentials; authentication is the backend's HttpOnly session cookie.

The visual direction follows the supplied reference recording: a light warm app background, **one** dark hero,
a thin performance bar, small 3-column trade tiles, a white chat-style activity panel, iOS-style top banners and a
slim white bottom bar with an orange centre pill. The reference's mascot, names, crypto-sniping copy and
"Withdraw" action were deliberately **not** reproduced: the hero uses an original white sphere with an engraved
alpha, and the centre pill opens the PAPER engine (there are no withdrawals).

Screenshots in `docs/screenshots/` were taken against a local preview backend that uses the automated tests'
fake Alpaca broker. **The numbers in them are test fixtures, not real PAPER results.**

## Structure

```
src/
  App.tsx                 auth gate → ToastProvider → DataProvider → AppShell → routes
  store/DataProvider.tsx  single polling store shared by every page (no loaders between tabs)
  components/
    AppShell.tsx          TopStatus (compact identity + engine/PAPER badges), route transition, BottomNav, Celebration
    BottomNav.tsx         Home · Trades · [Engine] · Activity · Settings
    ToastManager.tsx      top banners
    motion.tsx            CountUpValue, useFlip (FLIP list moves), Celebration (milestone particles)
    trading.tsx           HeroPnL, StrategyPerformance, TradeTile/TradeGrid, PositionRow, ActivityPanel, ActivityRow
    ui.tsx                Badge/StatusBadge, Section, SegmentControl, Chips, SettingsGroup/SRow, ConfirmSheet,
                          EmptyState, LoadingRows/Skeleton, ErrorState, StaleNote
    icons.tsx             line icons, ALPHA mark, hero sphere (all original)
  pages/                  Home, Trades, TradeDetail, AlertDetail, Engine, Activity, Settings, Login
  lib/derive.ts           pure derivations from API data (strategy stats, toasts, milestones, alert stage)
  lib/format.ts           number/time formatting; missing values → "N/A"
```

## Data and freshness

| Resource | Endpoint | Poll |
|---|---|---|
| summary (hero, account) | `/api/summary` | 8 s |
| engine overview + health | `/api/engine` | 8 s |
| trades (ledger) | `/api/trades?limit=500` | 10 s |
| alerts & orders | `/api/alerts?limit=200` | 12 s |
| positions | `/api/positions` | 12 s |
| activity | `/api/activity?after_id=…` | 4 s (incremental) |
| settings | `/api/settings` | 60 s |

* Polling pauses while the tab is hidden and refreshes everything when it becomes visible.
* No service worker and no offline cache: data is never served from a cache.
* If the latest request for a resource fails, the last real value is kept **but marked**: the hero switches to
  `STALE DATA`, dims its numbers and shows `STALE · last update hh:mm:ss`; sections show `… UNAVAILABLE` /
  `CONNECTION ERROR`; the top badge switches to `OFFLINE` / `DATA ERROR` instead of the last engine state.
* While loading for the first time, skeletons are shown — never placeholder numbers.

## What each Home value shows

| UI | Source |
|---|---|
| PAPER P&L (hero, large) | `account.verified_pnl` = Alpaca equity − baseline (see CALCULATIONS.md) |
| TODAY | `account.todays_pnl` = equity − last_equity |
| white pill | `account.account_return_pct` |
| `n closed · w% win · k open` | ledger closed trades, ledger win rate (N/A without closed trades), Alpaca position count |
| EQUITY / BUYING POWER / OPEN EXPOSURE | Alpaca account and positions |
| Strategy performance | derived from `/api/trades` closed trades per `strategy`: bar width ∝ closed-trade count, label = realized P&L and win %. Only strategies present in persisted trades appear. With no closed trades: `INSUFFICIENT DATA`. |
| Closed trades tiles | latest 9 closed ledger trades: symbol, return %, realized $ |
| Open positions | Alpaca PAPER positions; CURRENT from latest IEX trade (`N/A` + `MARKET DATA UNAVAILABLE` on failure, `STALE` with time when old) |
| Alpha Engine panel | latest 5 persisted activity events, excluding routine "alert received/authenticated" plumbing (all events remain on the Activity page) |

No hero progress bar is shown: the backend has no configured PAPER goal, and progress is never invented.

## Status meanings

| Status | Meaning |
|---|---|
| DATA CONNECTED | latest summary request succeeded and Alpaca PAPER account data is available |
| ALPACA UNAVAILABLE / NOT CONFIGURED | backend reachable, Alpaca account data missing |
| STALE DATA | latest request failed; values shown are from the last success (time shown) |
| CONNECTION ERROR / OFFLINE | backend unreachable |
| RUNNING / PAUSED / STOPPED | persisted engine state |
| HEALTHY · READY · CONNECTED · ACTIVE | component check passed (Engine page uses friendlier words for HEALTHY only) |
| DEGRADED · OFFLINE · ERROR · STALE · NOT CONFIGURED | shown exactly as reported by `/api/engine` health |

## Motion

| Element | Behaviour | Timing |
|---|---|---|
| Tab change | fade + 6 px rise | 220 ms |
| Cards / panels enter | fade + 8 px rise | 360–420 ms |
| Numbers (P&L, today, return, equity, counts, win rate) | count from the **previous** value to the new one; first view shows the value directly; last value is remembered across tab switches | 650 ms ease-out |
| Number change pulse | soft green/red glow, no flashing | 900 ms |
| New closed trade | tile fades/scales in at the top-left; existing tiles slide to their new slots (FLIP); new tile gets a green/red ring that fades | 480–520 ms, ring 2.2 s |
| Strategy bar | segment widths transition | 600 ms |
| Activity bubbles / rows | new rows slide up and fade in; existing rows shift smoothly | 420 ms |
| Segmented control | sliding selected pill | 230 ms |
| Buttons | press scale 0.97 | 120 ms |
| Toasts | slide down + fade, stay 3.4 s, slide up; bursts fold into "+N more" | 320 ms in / 300 ms out |
| Milestone | ~40 small particles fall once, plus a banner | 1.9 s |

Toasts come only from real persisted events that arrive after the dashboard opened: PAPER fills, broker errors,
risk blocks, engine state changes and the kill switch. Milestones are only real ledger facts (first profitable
closed PAPER trade; 10/25/50/100/250/500 closed trades). On the first visit from a device, existing milestones are
recorded silently (in `localStorage`) so history is never "celebrated" again. `prefers-reduced-motion` disables
motion.

## Mobile layout

* Designed at 402 × 874; verified at 390 × 844, 402 × 874 and 430 × 932 with no horizontal scrolling on any page.
* `viewport-fit=cover` + `env(safe-area-inset-*)` padding; the nav bar sits above the home indicator.
* Tap targets ≥ 36 px; primary buttons 44 px.
* Desktop (≥ 900 px): Home splits into two columns (hero/strategy/trades | activity/positions), Engine and Settings
  into two columns, and the nav becomes a floating rounded bar.

## Testing

`npm test` runs vitest on `src/lib/derive.test.ts`: strategy stats count only closed trades, toasts only map
important events, milestones are silent on first visit, alert stages come from stored codes, and formatting
returns `N/A` for missing values.
