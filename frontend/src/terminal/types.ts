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
  // Simulated execution costs (null on trades closed before cost accounting, whose realized_pnl is gross).
  gross_pnl?: NumLike;
  fees_usd?: NumLike;
  slippage_usd?: NumLike;
  cost_profile?: string | null;
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
    /** Live entries the PAPER portfolio refused; each simulated position was dropped. Newer engines only. */
    refused_entries?: number | null;
    /** Position sizing reported by the engine. Newer engines only. */
    sizing?: EngineSizing | null;
  } | null;
}

export interface EngineSizing {
  mode: "fixed" | "percent";
  risk_pct: number | null;
  risk_usd_fixed: number | null;
  /** Percent mode: the most one trade may risk (the risk setting, $10 by default). Newer engines only. */
  max_risk_usd?: number | null;
  /** Fixed mode on a funded engine: the recorded research reason. */
  fixed_reason?: string | null;
  symbol?: string | null;
  fee_pct: number | null;
  price_buffer_pct: number | null;
  min_qty: number | null;
  min_cost: number | null;
  /** Available strategy PAPER balance the engine sizes from (percent mode). */
  capital_usd: number | null;
  last: {
    status: "SIZED" | "SKIPPED" | null;
    code: string | null;
    reason: string | null;
    side: "LONG" | "SHORT" | null;
    entry: number | null;
    stop: number | null;
    qty: number | null;
    risk_target_usd: number | null;
    risk_actual_usd: number | null;
    notional_usd: number | null;
    required_capital_usd: number | null;
    capped: boolean;
    capped_by: "BALANCE" | "ORDER_LIMIT" | "POSITION_LIMIT" | "TOTAL_EXPOSURE" | null;
    fee_estimate_usd: number | null;
    current: boolean;
    /** Newer engines only (universal sizing). */
    risk_capped_by_max?: boolean;
    spend_limit_usd?: number | null;
    min_order_cost_usd?: number | null;
    checks?: { min_qty: boolean; min_cost: boolean; buying_power: boolean } | null;
    outcome?: "FULL_RISK" | "REDUCED_TO_FIT" | null;
    /** The engine's authoritative plain-language explanation (src/sizing.mjs OUTCOMES). */
    explanation?: string | null;
  } | null;
}

export interface AlphaPaperSection {
  label: "ALPHA PAPER" | string;
  simulated: true;
  broker_positions: false;
  positions: AlphaPaperPosition[];
  performance: {
    /** Net of simulated fees. */
    realized_pnl: number;
    /** Absent on Workers without cost accounting. */
    fees_usd?: number;
    slippage_usd?: number;
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
  /** ALPHA PAPER portfolio (migration 0003). Absent on older Workers. */
  portfolio?: PaperPortfolio;
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

// ---- ALPHA PAPER portfolio (simulated balances; never broker money) ----

export interface PaperWallet {
  wallet: string;
  kind: "MAIN" | "STRATEGY";
  available_usd: number;
  reserved_usd: number;
  realized_pnl_usd: number;
  /** Simulated fees paid from this balance; absent on Workers without cost accounting. */
  fees_usd?: number;
  net_realized_pnl_usd?: number;
  net_funding_usd: number;
  unrealized_pnl_usd: number | null;
  book_balance_usd: number;
  equity_usd: number | null;
  open_positions: number;
  updated_at: string;
}

export interface RiskSettingRow {
  version: number;
  risk_usd: number;
  status: "PENDING" | "APPLIED" | "SUPERSEDED";
  requested_at: string;
  applied_at: string | null;
  note: string | null;
}

export interface StrategySettings {
  strategy: string;
  applied: RiskSettingRow | null;
  pending: RiskSettingRow | null;
  history: RiskSettingRow[];
  compounding: false;
}

export interface PortfolioEntry {
  id: number;
  at: string;
  kind: "DEPOSIT" | "WITHDRAW" | "TRANSFER_OUT" | "TRANSFER_IN" | "RESERVE" | "RELEASE" | "REALIZED_PNL" | "FEE";
  wallet: string;
  counterparty: string | null;
  ref: string | null;
  note: string | null;
  available_change_usd: number;
  reserved_change_usd: number;
}

export interface PaperPortfolio {
  label: string;
  simulated: true;
  active: boolean;
  wallets: PaperWallet[];
  totals: {
    book_balance_usd: number;
    unallocated_usd: number;
    available_usd: number;
    reserved_usd: number;
    realized_pnl_usd: number;
    fees_usd?: number;
    net_realized_pnl_usd?: number;
    net_funding_usd: number;
    unrealized_pnl_usd: number | null;
  };
  consistency: { ok: boolean; issues: string[] };
  history: PortfolioEntry[];
  strategies: Record<string, { validated_engine: boolean; settings: StrategySettings }>;
  validated_engines: string[];
  limits: {
    max_order_notional_usd: number | null; max_position_exposure_usd: number | null; short_selling_enabled: boolean;
    /** Added with the Verified Performance release; absent on older Workers. */
    max_total_exposure_usd?: number | null; max_open_positions?: number | null; daily_loss_limit_usd?: number | null;
  };
  /** Execution-cost profile applied to new PAPER fills; absent on Workers without cost accounting. */
  costs?: CostProfileInfo;
}

export type CostProfileInfo =
  | {
      profile: string; name: string; maker_pct: number; taker_pct: number; taker_slippage_pct: number;
      min_qty: number; min_notional_usd: number; fee_source: string; slippage_source: string; caveat: string | null;
      /** How PAPER fills are priced and classified (absent on older Workers). */
      fill_disclosure?: string;
      invalid?: undefined;
    }
  | { profile: string | null; invalid: true; fill_disclosure?: string };

// ---- Verified performance and trade proof (GET /api/dashboard/performance, /api/dashboard/trade-proof) ----

/** A closed ALPHA PAPER ledger trade: the only kind counted as verified. */
export interface VerifiedTrade {
  id: number;
  symbol: string;
  direction: string;
  strategy: string | null;
  realized_pnl: number;
  return_pct: number | null;
  cost_basis: number;
  opened_at: string;
  closed_at: string;
  price_sources: string | null;
  gross_pnl?: number | null;
  fees_usd?: number | null;
  slippage_usd?: number | null;
  cost_profile?: string | null;
}

export interface PerformanceData {
  verification: string;
  trades: VerifiedTrade[];
  truncated: boolean;
  /** Closed trades from other sources (not the ALPHA PAPER ledger), never counted. */
  excluded_closed_trades: number;
}

export interface ProofFill {
  id: number;
  client_order_id: string;
  alert_id: string;
  risk_decision_fk: number | null;
  kind: "OPEN" | "ADD" | "REDUCE" | "CLOSE" | string;
  side: "buy" | "sell" | string;
  qty: number;
  price: number;
  price_source: string;
  price_at: string;
  realized_pnl: number;
  position_qty_after: number;
  avg_entry_after: number;
  filled_at: string;
  /** Market reference price before slippage; null on fills made before cost accounting. */
  reference_price?: number | null;
  liquidity?: "MAKER" | "TAKER" | string | null;
  fee_micro?: number | null;
  slippage_micro?: number | null;
  cost_profile?: string | null;
}

export interface ProofAlert {
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
  response_code: string | null;
  rejection_reason: string | null;
}

export interface ProofRisk {
  id: number;
  alert_id: string;
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

export interface ProofOrder {
  id: number;
  alert_id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  qty: NumLike;
  order_type: string;
  status: string;
  submitted_at: string;
  error_detail: string | null;
  broker_request_sent: false;
}

export interface TradeProof {
  verified: boolean;
  verification: string;
  trade: TradeRow & { closed_cost_basis?: NumLike; leg_order_ids?: unknown };
  fills: ProofFill[];
  alerts: ProofAlert[];
  risk_decisions: ProofRisk[];
  orders: ProofOrder[];
}
