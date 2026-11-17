// Auto-batching D1 for READ paths (2026-11-17, dashboard CPU). Workers CPU on D1-heavy requests is dominated by the
// per-call overhead of each D1 round trip, not by query logic (worker/scripts/dashboard-profile.mjs: < 1 ms of JS per
// dashboard request locally, while production measured 12–19 ms with ~25 round trips). This wrapper lets unchanged
// read-only code (same SQL, same mapping) issue its statements through ONE `db.batch` per wave: every `.all()` /
// `.first()` started in the same turn (a few microtask hops) is queued and sent together; statements that depend on an
// earlier result (a second `await`) form the next wave.
//
// Semantics kept: `.all()` → { results }, `.first()` → the first row or null, `.first(col)` → that column or null,
// `.raw()` → row arrays. Errors stay PER STATEMENT, exactly as without batching: one failing statement fails a whole D1
// batch, so a failed wave is re-run one statement at a time and each statement gets its own outcome (callers rely on this,
// e.g. a reader that tolerates a table missing on an older schema). Writes (`.run()`, `db.batch`, `db.exec`) are NOT
// batched: they first flush what is queued and then go straight to D1, so their order relative to earlier reads is kept.
// Use it for read paths only.

type Mode = "all" | "first" | "raw";
interface Queued { stmt: D1PreparedStatement; mode: Mode; col?: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }
type Res = D1Result<Record<string, unknown>>;

const WAVE_HOPS = 16;

export interface AutoBatchStats { waves: number; statements: number; fallbacks: number }

export function autoBatch(db: D1Database, stats: AutoBatchStats = { waves: 0, statements: 0, fallbacks: 0 }): D1Database & { stats: AutoBatchStats } {
  let queue: Queued[] = [];
  let scheduled = false;

  const settle = (q: Queued, res: Res | undefined) => {
    const rows = (res?.results ?? []) as Record<string, unknown>[];
    if (q.mode === "all") q.resolve({ ...res, results: rows });
    else if (q.mode === "raw") q.resolve(rows.map((r) => Object.values(r)));
    else {
      const row = rows[0] ?? null;
      q.resolve(q.col === undefined ? row : row === null ? null : (row[q.col] ?? null));
    }
  };

  const flush = async (): Promise<void> => {
    scheduled = false;
    const wave = queue;
    queue = [];
    if (!wave.length) return;
    stats.waves++;
    stats.statements += wave.length;
    let out: Res[];
    try {
      out = (await db.batch(wave.map((q) => q.stmt))) as Res[];
    } catch {
      stats.fallbacks++;
      await Promise.all(wave.map(async (q) => {
        try { settle(q, (await q.stmt.all()) as Res); } catch (e) { q.reject(e); }
      }));
      return;
    }
    wave.forEach((q, i) => settle(q, out[i]));
  };

  const enqueue = (stmt: D1PreparedStatement, mode: Mode, col?: string) =>
    new Promise<unknown>((resolve, reject) => {
      queue.push({ stmt, mode, col, resolve, reject });
      // A short chain of microtask hops (no timer: no added latency, no timer granularity) lets every reader started in
      // the same turn, including ones a few awaits deep, queue its statement before the wave is sent.
      if (!scheduled) { scheduled = true; void (async () => { for (let i = 0; i < WAVE_HOPS; i++) await null; await flush(); })(); }
    });

  // wrapped statement → the real one, so code that builds its own db.batch from this wrapper's statements still works
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      all: () => enqueue(stmt, "all"),
      first: (col?: string) => enqueue(stmt, "first", col),
      raw: () => enqueue(stmt, "raw"),
      run: async () => { await flush(); return stmt.run(); },
    };
    real.set(w, stmt);
    return w as unknown as D1PreparedStatement;
  };

  return {
    stats,
    prepare: (sql: string) => wrap(db.prepare(sql)),
    // an explicit batch from the caller: sent as it is (its own round trip), after what is already queued
    batch: async (list: D1PreparedStatement[]) => { await flush(); return db.batch(list.map((s) => real.get(s as object) ?? s)); },
    exec: async (sql: string) => { await flush(); return db.exec(sql); },
    dump: () => db.dump(),
  } as unknown as D1Database & { stats: AutoBatchStats };
}
