// Shapes returned by the Cloudflare Worker's GET /api/dashboard (PAPER, DRY RUN).
// D1 stores many numbers as TEXT, so numeric fields may arrive as strings.

export type NumLike = number | string | null;

export interface EngineRow {
  state: "STOPPED" | "RUNNING" | "PAUSED" | string;
  kill_switch: number;
  killed_at: string | null;
  reason: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface BrokerError {
  source: string;
  code: string;
  message: string;
}

export interface PaperAccount {
  id: string;
  status: string;
  currency: string;
  cash: number;
  equity: number;
  last_equity: number;
  portfolio_value: number;
  buying_power: number;
  long_market_value: number;
  short_market_value: number;
  trading_blocked: boolean;
  account_blocked: boolean;
  pattern_day_trader: boolean;
  daytrade_count: number;
  todays_pnl: number;
}

export interface PaperPosition {
  symbol: string;
  side: string;
  qty: number;
  qty_available: number;
  avg_entry_price: number;
  market_value: number;
  cost_basis: number;
  current_price: number;
  lastday_price: number;
  unrealized_pl: number;
  unrealized_plpc: number; // fraction (0.012 = 1.2 %)
  change_today: number; // fraction
}

export interface MarketClock {
  timestamp: string | null;
  is_open: boolean;
  next_open: string | null;
  next_close: string | null;
}

export interface BrokerSnapshot {
  mode: "PAPER";
  read_only: true;
  errors: BrokerError[];
  account: PaperAccount | null;
  positions: PaperPosition[];
  clock: MarketClock | null;
}

export interface AlertRow {
  id: number;
  alert_id: string;
  received_at: string;
  processed_at: string | null;
  symbol: string | null;
  action: string | null;
  strategy: string | null;
  order_type: string | null;
  requested_qty: NumLike;
  accepted_qty: NumLike;
  status: string;
  validation_result: string | null;
  response_code: string | null;
  http_status: number | null;
  rejection_reason: string | null;
  duplicate_count: number;
  last_duplicate_at: string | null;
}

export interface RiskCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface RiskRow {
  id: number;
  alert_fk: number | null;
  alert_id: string | null;
  symbol: string | null;
  action: string | null;
  strategy: string | null;
  decided_at: string;
  approved: boolean;
  code: string;
  reason: string;
  side: string | null;
  final_qty: NumLike;
  reference_price: NumLike;
  reference_price_time: string | null;
  estimated_notional: NumLike;
  checks: RiskCheck[] | unknown;
}

export interface OrderRow {
  id: number;
  alert_id: string | null;
  strategy: string | null;
  source: string;
  client_order_id: string;
  alpaca_order_id: string | null;
  symbol: string;
  side: string;
  qty: NumLike;
  order_type: string;
  time_in_force: string;
  status: string;
  submitted_at: string;
  updated_at: string;
  error_detail: string | null;
  broker_request_sent: false;
}

export interface TradeRow {
  id: number;
  symbol: string;
  direction: string;
  status: string;
  strategy: string | null;
  entry_qty: NumLike;
  entry_avg_price: NumLike;
  exit_qty: NumLike;
  exit_avg_price: NumLike;
  open_qty: NumLike;
  realized_pnl: NumLike;
  return_pct: NumLike;
  opened_at: string;
  closed_at: string | null;
  // ALPHA PAPER ledger trades (simulated, not broker-executed).
  source?: string | null;
  open_alert_id?: string | null;
  open_order_id?: string | null;
  close_order_id?: string | null;
  close_alert_id?: string | null;
  price_sources?: string | null;
}

/** Internal simulated position from the ALPHA PAPER ledger. Never a broker position. */
export interface AlphaPaperPosition {
  id: number;
  label: "ALPHA PAPER" | string;
  symbol: string;
  side: string;
  qty: number;
  avg_entry_price: number;
  multiplier: number;
  cost_basis: number;
  mark_price: number | null;
  mark_at: string | null;
  mark_source: string | null;
  mark_age_seconds: number | null;
  /** FRESH: recent mark. STALE: last refresh failed or the mark is old. UNAVAILABLE: no mark at all. */
  mark_status: "FRESH" | "STALE" | "UNAVAILABLE" | string;
  mark_error: string | null;
  market_value: number | null;
  unrealized_pnl: number | null;
  unrealized_pct: number | null; // percent (1.5 = 1.5 %)
  realized_pnl: number;
  strategy: string | null;
  opened_at: string;
  open_alert_id: string;
  open_order_id: string;
}

/** Heartbeat from the OTE engine; `state` is decided by the Worker from the heartbeat's age. */
export interface EngineBot {
  state: "ONLINE" | "STALE" | "OFFLINE" | "NOT_RUNNING";
  age_seconds: number | null;
  status: {
    symbol: string | null;
    timeframe: string | null;
    status_text: string | null;
    profile?: string | null;
    risk_usd?: number | null;
    last_candle_time: string | null;
    last_candle_close: number | null;
    position: {
      side: string | null; qty: number | null; entry: number | null; stop: number | null; tp2: number | null; unrealized_at_last_close: number | null;
      /** Whether this engine position also exists in the ALPHA PAPER ledger, and if not, why. */
      ledger?: { status: "MIRRORED" | "PENDING" | "NOT_IN_LEDGER" | string; reason: string | null } | null;
    } | null;
    trades: { closed: number | null; wins: number | null; losses: number | null; net_pnl: number | null } | null;
    outbox: { pending: number | null; accepted?: number | null; rejected: number | null; skipped?: number | null; late: number | null } | null;
    last_rejection?: { id: string | null; action: string | null; status: string | null; code: string | null; reason: string | null } | null;
    /** The engine's check of its position against the ALPHA PAPER ledger in D1. */
    ledger_check?: { status: "OK" | "DIVERGED" | "UNVERIFIED" | string; at: string | null; issues: string[] } | null;
    last_error: { at: string | null; where: string | null; message: string | null } | null;
  } | null;
}

export interface AlphaPaperSection {
  label: "ALPHA PAPER" | string;
  simulated: true;
  broker_positions: false;
  positions: AlphaPaperPosition[];
  performance: {
    realized_pnl: number;
    unrealized_pnl: number | null;
    total_pnl: number | null;
    marks_stale: boolean;
    open_positions: number;
    closed_trades: number;
  };
}

export interface ActivityRow {
  id: number;
  ts: string;
  category: string;
  level: string;
  message: string;
  alert_id: string | null;
  symbol: string | null;
  action: string | null;
  error_detail: string | null;
}

export interface DashboardCounts {
  alerts: { total: number; dry_run: number; rejected: number; processing: number; duplicates: number };
  risk: { total: number; approved: number; rejected: number };
  orders: { total: number; dry_run_accepted: number; unknown: number; failed: number };
  trades: { total: number; open: number; closed: number; realized_pnl: number };
}

export interface DashboardData {
  generated_at: string;
  mode: "PAPER" | string;
  execution: "DRY_RUN_ONLY" | string;
  broker_submission: boolean;
  enable_trading: boolean;
  engine: EngineRow | null;
  broker: BrokerSnapshot;
  /** Internal simulated ledger, separate from the broker account. Absent on older Workers. */
  paper?: AlphaPaperSection;
  /** OTE engine heartbeat (engine/). Absent on older Workers. */
  bot?: EngineBot;
  counts: DashboardCounts;
  recent: {
    alerts: AlertRow[];
    risk: RiskRow[];
    orders: OrderRow[];
    trades: TradeRow[];
    activity: ActivityRow[];
  };
}

export interface DashboardEnvelope {
  ok: boolean;
  data?: DashboardData;
  code?: string;
  message?: string;
}
