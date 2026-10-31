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
