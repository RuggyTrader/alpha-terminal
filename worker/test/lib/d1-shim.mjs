// A minimal Cloudflare D1 stand-in over node:sqlite for unit tests of Worker modules (prepare / bind / first / all /
// run / batch with a transaction). Every statement's SQL is recorded so tests can assert which tables were touched.
import { DatabaseSync } from "node:sqlite";

export function d1(schemaSql = "") {
  const db = new DatabaseSync(":memory:");
  if (schemaSql) db.exec(schemaSql);
  const trace = [];
  const prepare = (sql) => {
    let args = [];
    const st = {
      sql,
      bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return st; },
      first: async () => { trace.push(sql); const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      all: async () => { trace.push(sql); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
      run: async () => { trace.push(sql); const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  };
  return {
    prepare,
    batch: async (stmts) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    sql: (q, ...a) => (/^\s*SELECT/i.test(q) ? db.prepare(q).all(...a).map((r) => ({ ...r })) : db.prepare(q).run(...a)),
    trace,
  };
}
