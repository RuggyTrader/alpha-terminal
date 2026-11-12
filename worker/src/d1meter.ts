// Opt-in D1 measurement for local resource audits (never on unless MEASURE_D1 = "1" is set as a variable; production
// does not set it). Counts the statements one request runs and the rows D1 reports reading/writing (result.meta), and
// returns them in an "x-d1" response header. It changes no query and no result.

export interface D1Meter { statements: number; rows_read: number; rows_written: number; d1_ms: number }

type Meta = { rows_read?: number; rows_written?: number; duration?: number };
const add = (m: D1Meter, meta: Meta | undefined) => {
  m.rows_read += Number(meta?.rows_read ?? 0); m.rows_written += Number(meta?.rows_written ?? 0); m.d1_ms += Number(meta?.duration ?? 0);
};

function meterStatement(st: D1PreparedStatement, m: D1Meter): D1PreparedStatement {
  return new Proxy(st, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "__target") return target;
      if (prop === "bind") return (...a: unknown[]) => meterStatement((v as (...x: unknown[]) => D1PreparedStatement).apply(target, a), m);
      if (prop === "all" || prop === "run") {
        return async (...a: unknown[]) => { m.statements += 1; const r = await (v as (...x: unknown[]) => Promise<{ meta?: Meta }>).apply(target, a); add(m, r?.meta); return r; };
      }
      if (prop === "first" || prop === "raw") {
        return async (...a: unknown[]) => { m.statements += 1; return (v as (...x: unknown[]) => Promise<unknown>).apply(target, a); };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function meterD1(db: D1Database): { db: D1Database; meter: D1Meter } {
  const meter: D1Meter = { statements: 0, rows_read: 0, rows_written: 0, d1_ms: 0 };
  const unwrap = (st: D1PreparedStatement) => (st as unknown as { __target?: D1PreparedStatement }).__target ?? st;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (q: string) => meterStatement((v as (q: string) => D1PreparedStatement).call(target, q), meter);
      if (prop === "batch") {
        return async (sts: D1PreparedStatement[]) => {
          meter.statements += sts.length;
          const r = await (v as (s: D1PreparedStatement[]) => Promise<{ meta?: Meta }[]>).call(target, sts.map(unwrap));
          for (const x of r ?? []) add(meter, x?.meta);
          return r;
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, meter };
}

export const meterHeader = (m: D1Meter, ms: number) =>
  `statements=${m.statements};rows_read=${m.rows_read};rows_written=${m.rows_written};d1_ms=${m.d1_ms.toFixed(2)};wall_ms=${ms.toFixed(1)}`;
