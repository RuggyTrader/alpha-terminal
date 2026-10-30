// Shapes returned by the ALPHA TERMINAL backend. Money values are decimal
// strings; null always means "not available" and is rendered as N/A.

export type Num = string | null;

export interface EngineSnapshot {
  state: "STOPPED" | "RUNNING" | "PAUSED";
  kill_switch: boolean;
  killed_at: string | null;
  updated_at: string;
  updated_by: string | null;
  reason: string | null;
}

export interface Summary {
  mode: "PAPER";
  engine: EngineSnapshot;
  account: {
    available: boolean;
    error: string | null;
    broker?: string;
    account_number?: string;
    status?: string;
    equity?: Num;
    buying_power?: Num;
    cash?: Num;
    last_equity?: Num;
    todays_pnl?: Num;
    baseline_equity?: Num;
    baseline_source?: string;
    baseline_set_at?: string | null;
    verified_pnl?: Num;
    account_return_pct?: Num;
  };
  positions_available: boolean;
  positions_error: string | null;
  open_positions: number | null;
  open_exposure: Num;
  realized_pnl: Num;
  unrealized_pnl: Num;
  total_pnl: Num;
  closed_trades: number;
  winning_trades: number;
  win_rate_pct: Num;
  closed_trade_return_pct: Num;
  markets: Record<"stocks" | "crypto", { provider: string; status: string }>;
  as_of: string;
}

export interface Position {
  symbol: string;
  market: string;
  direction: "LONG" | "SHORT";
  qty: Num;
  qty_available: Num;
  avg_entry_price: Num;
  current: { status: "CURRENT" | "STALE" | "UNAVAILABLE"; price: Num; as_of: string | null; age_seconds?: number; detail: string };
  alpaca_current_price: Num;
  market_value: Num;
  cost_basis: Num;
  unrealized_pnl: Num;
  unrealized_pct: Num;
  strategy: string | null;
  opened_at: string | null;
  alert_id: string | null;
  tracked_by_terminal: boolean;
}

export interface PositionsResponse {
  available: boolean;
  error: string | null;
  positions: Position[];
  as_of?: string;
}

export interface TradeRow {
  id: number;
  symbol: string;
  market: string;
  strategy: string | null;
  direction: string;
  side: string;
  status: "OPEN" | "CLOSED";
  qty: Num;
  open_qty: Num;
  order_type: string;
  entry_price: Num;
  exit_price: Num;
  exit_qty: Num;
  realized_pnl: Num;
  return_pct: Num;
  opened_at: string;
  closed_at: string | null;
  alert_id: string | null;
  alpaca_order_id: string | null;
  close_order_id: string | null;
  order_status: string | null;
  badge: "VERIFIED PAPER" | "PAPER ORDER";
  leg_count: number;
}

export interface OrderRow {
  id: number;
  source: string;
  symbol: string;
  market: string;
  side: string;
  qty: Num;
  order_type: string;
  time_in_force: string;
  status: string;
  alpaca_order_id: string | null;
  client_order_id: string;
  submitted_at: string;
  alpaca_created_at: string | null;
  filled_qty: Num;
  filled_avg_price: Num;
  filled_at: string | null;
  canceled_at: string | null;
  market_open_at_submit: boolean | null;
  last_synced_at: string | null;
  error_detail: string | null;
  alert_id: string | null;
  verified: boolean;
}

export interface RiskDecision {
  id: number;
  decided_at: string;
  approved: boolean;
  code: string;
  reason: string;
  side: string | null;
  final_qty: Num;
  reference_price: Num;
  reference_price_time: string | null;
  estimated_notional: Num;
  checks: { check: string; passed: boolean; detail: string }[];
}

export interface AlertBrief {
  id: number;
  alert_id: string;
  received_at: string;
  symbol: string | null;
  action: string | null;
  strategy: string | null;
  status: string;
  code: string | null;
  rejection_reason: string | null;
  requested_qty: Num;
  accepted_qty: Num;
  duplicate_count: number;
  order?: OrderRow | null;
}

export interface AlertDetail extends AlertBrief {
  database_record_id: number;
  processed_at: string | null;
  order_type: string | null;
  validation_result: string | null;
  http_status: number | null;
  last_duplicate_at: string | null;
  payload: Record<string, unknown> | null;
  risk_decisions: RiskDecision[];
  orders: OrderRow[];
}

export interface TradeDetail extends TradeRow {
  database_record_id: number;
  closed_cost_basis: Num;
  legs: { order: OrderRow; alert: AlertDetail | null }[];
  unrealized: { available: boolean; pnl?: Num; source?: string; detail?: string } | null;
}

export interface ActivityEvent {
  id: number;
  ts: string;
  category: string;
  level: "success" | "decision" | "error" | "info";
  message: string;
  alert_id: string | null;
  symbol: string | null;
  action: string | null;
  strategy: string | null;
  qty: string | null;
  validation_result: string | null;
  risk_result: string | null;
  rejection_reason: string | null;
  alpaca_order_id: string | null;
  alpaca_status: string | null;
  error_detail: string | null;
}

export interface HealthComponent {
  status: string;
  detail?: string;
  [k: string]: unknown;
}

export interface SystemHealth {
  components: Record<string, HealthComponent>;
  system_health: "HEALTHY" | "DEGRADED";
  engine_state: string;
  kill_switch: boolean | null;
  last_webhook_at: string | null;
  last_accepted_alert_at: string | null;
  last_successful_order_at: string | null;
  version: string;
}

export interface PublicHealth {
  server: string;
  version: string;
  engine_state: string;
  database: string;
  alpaca_paper: string;
  system_health: string;
  last_webhook_at: string | null;
}

export interface EngineOverview {
  engine: EngineSnapshot;
  enable_trading: boolean;
  counters: { alerts_received: number; alerts_accepted: number; alerts_rejected: number; duplicates_blocked: number };
  last_alert: AlertBrief | null;
  last_accepted_alert: AlertBrief | null;
  last_rejected_alert: AlertBrief | null;
  last_order: OrderRow | null;
  last_webhook_at: string | null;
  open_positions: number | null;
  health: SystemHealth;
}

export interface SettingsView {
  broker: { name: string; configured: boolean; trading_host: string; market_data_host: string };
  tradingview: { webhook_url: string; webhook_secret_configured: boolean; rate_limit_per_minute: number; ip_allowlist_enabled: boolean };
  markets: Record<"stocks" | "crypto", { provider: string; status: string }>;
  execution: { enable_trading: boolean; allowed_order_types: string[]; time_in_force: string[]; short_selling_enabled: boolean; fractional_qty_enabled: boolean };
  risk: {
    max_order_qty: Num; max_order_notional: Num; max_position_exposure: Num; max_total_exposure: Num;
    max_open_positions: number; short_selling_protection: boolean; duplicate_protection: boolean;
    allowed_symbols: string[]; daily_loss_limit: Num;
  };
  security: { session_auth: boolean; auth_method: string; admin_secret_configured: boolean; cookie_secure: boolean;
    csrf_header_required: boolean; frontend_origins: string[]; api_docs_enabled: boolean };
  system: { version: string; database: string; started_at: string; order_sync_interval_seconds: number };
}

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  status: string;
  code: string;
  message: string;
  alert_id: string | null;
  data: T;
}
