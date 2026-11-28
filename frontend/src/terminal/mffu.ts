// MFFU research snapshot: a static JSON file written by futures-ote/run_mffu.py. Every value in it is SIMULATED
// (virtual research accounts). It is never added to funded PAPER figures, and external execution is always DISABLED.

export const MFFU_SNAPSHOT_PATH = "/research/mffu-dashboard.json";
export const MFFU_SCHEMA = "alpha-terminal.mffu-research.v1";

export interface MffuRun {
  run: string; plan: string; scenario: string; attempts: number; passed: number; breached: number; open_at_end: number;
  pass_rate_pct: number | null; median_trading_days_to_pass: number | null; failure_reasons: Record<string, number>;
  net_pnl: number; payouts_trader_share: number; trades: number; commissions: number; slippage: number; worst_drawdown: number;
  profit_factor: number | null; win_rate_pct: number | null; expectancy: number | null; consistency_delays: number; refusals: Record<string, number>;
}
export interface MffuEvent { t: string; kind: string; [k: string]: unknown }
export interface MffuAccount {
  account_id: string; stage: string; status: string; reason: string; opened: string; closed: string | null;
  equity_simulated: number; minimum_balance: number; remaining_drawdown: number; profit_target: number | null; target_progress_pct: number | null;
  daily_loss_limit: number | null; daily_allowance_note: string; consistency: { rule: number | null; ok: boolean; best_day: number; total: number };
  trading_days: number; min_trading_days: number | null; violations: MffuEvent[]; configuration: Record<string, unknown>;
  choices: Record<string, unknown>; unresolved: string[];
}
export interface MffuSnapshot {
  schema: string; generatedAt: string; simulated: true; label: string; demo: boolean; data: string; strategy: string; period: string;
  news_calendar: string; external_execution: "DISABLED";
  integration: { external_execution: string; mffu_automation_approval: string; supported_api_route: string; owner_authorization: string; candidates: string[]; selected: string | null };
  account: MffuAccount | Record<string, never>; results: MffuRun[];
  plans: { plan: string; stages_documented: string[]; evaluation: Record<string, { value: unknown; status: string }> }[];
  sources: { id: string; title: string; url: string; page_date: string }[]; retrieved: string;
  contradictions: { id: string; topic: string; detail: string; src: string[] }[]; not_stated: string[];
}

/** A snapshot is shown only if it declares the expected schema, says it is simulated and keeps external execution DISABLED. */
export function validSnapshot(x: unknown): x is MffuSnapshot {
  const s = x as MffuSnapshot;
  return !!s && s.schema === MFFU_SCHEMA && s.simulated === true && s.external_execution === "DISABLED" && Array.isArray(s.results);
}

export async function fetchMffuSnapshot(timeoutMs = 8000, f: typeof fetch = fetch): Promise<MffuSnapshot> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await f(MFFU_SNAPSHOT_PATH, { signal: ac.signal, credentials: "omit", cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "No MFFU research snapshot has been published yet" : `Snapshot request failed (${r.status})`);
    const j: unknown = await r.json();
    if (!validSnapshot(j)) throw new Error("Snapshot rejected: wrong schema, not marked simulated, or external execution not DISABLED");
    return j;
  } finally {
    clearTimeout(timer);
  }
}
