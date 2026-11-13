// Transactional D1 stand-in for fault injection. Integration tests still exercise real Miniflare D1.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function sqliteD1(migrations, upTo = 7) {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(migrations).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    if (Number(f.slice(0, 4)) <= upTo) raw.exec(readFileSync(`${migrations}/${f}`, 'utf8'));
  }
  let failAt = -1;
  let barrier = null;
  let beforeBatch = null;
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = raw.prepare(sql).get(...args); return r ? { ...r } : null; },
    all: async () => ({ results: raw.prepare(sql).all(...args).map(r => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }),
  });
  return {
    raw, prepare: sql => stmt(sql),
    failNextBatchAt: index => { failAt = index; },
    beforeNextBatch: fn => { beforeBatch = fn; },
    holdNextBatches: count => {
      let release;
      const ready = new Promise(r => { release = r; });
      barrier = { count, ready, release };
    },
    batch: async list => {
      const hook = beforeBatch; beforeBatch = null;
      if (hook) await hook();
      if (barrier) {
        const b = barrier;
        if (--b.count === 0) { barrier = null; b.release(); }
        await b.ready;
      }
      const fault = failAt; failAt = -1;
      raw.exec('BEGIN');
      try {
        const results = list.map((s, i) => {
          if (i === fault) throw new Error('injected transaction interruption');
          return { meta: { changes: Number(raw.prepare(s.sql).run(...s.args).changes) } };
        });
        raw.exec('COMMIT');
        return results;
      } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}
