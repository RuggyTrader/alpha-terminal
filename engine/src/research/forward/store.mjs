// RESEARCH forward store: append-only candle files with provenance, and a hash-chained audit log.
// Research only: its own directory (default engine/data/forward, gitignored), its own RESEARCH-FWD-* ids. It never
// reads or writes the funded ledger, bot state, engine.env or the Worker.
//
// Candles: <dir>/candles/<MARKET>-<granularity>.jsonl, one JSON row per candle:
//   { t, o, h, l, c, v, first_seen_at, source }   (t = candle OPEN time, ms UTC)
// A candle is stored only after it CLOSED (t + granularity <= fetch time). An already-stored candle is never
// rewritten; if the exchange later reports different values, a { revision_of: t, ... } row is appended and the
// evaluator keeps the FIRST-SEEN values (what a live system would have acted on) and reports the revision.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const candleFile = (dir, m, g) => join(dir, "candles", `${m}-${g}.jsonl`);
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []);

/** Reads first-seen candles (ascending) and the list of revisions for one market and granularity. */
export function readCandles(dir, m, g) {
  const rows = lines(candleFile(dir, m, g)), first = new Map(), revisions = [];
  for (const r of rows) { if (r.revision_of !== undefined) revisions.push(r); else if (!first.has(r.t)) first.set(r.t, r); }
  return { candles: [...first.values()].sort((a, b) => a.t - b.t), revisions };
}

/** Appends newly fetched candles. Returns { added, revised, skippedOpen }. Pure with respect to existing rows. */
export function appendCandles(dir, m, g, fetched, { now, source }) {
  mkdirSync(join(dir, "candles"), { recursive: true });
  const f = candleFile(dir, m, g), { candles } = readCandles(dir, m, g), have = new Map(candles.map((c) => [c.t, c]));
  let added = 0, revised = 0, skippedOpen = 0; const out = [];
  for (const k of [...fetched].sort((a, b) => a.t - b.t)) {
    if (k.t + g * 1000 > now) { skippedOpen++; continue; } // still forming: never stored
    const prev = have.get(k.t);
    if (!prev) { out.push({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v ?? null, first_seen_at: new Date(now).toISOString(), source }); have.set(k.t, k); added++; }
    else if (prev.o !== k.o || prev.h !== k.h || prev.l !== k.l || prev.c !== k.c) { out.push({ revision_of: k.t, o: k.o, h: k.h, l: k.l, c: k.c, seen_at: new Date(now).toISOString(), source }); revised++; }
  }
  if (out.length) appendFileSync(f, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { added, revised, skippedOpen };
}

/** Hash-chained audit log: each row carries sha256(previous row's hash + this row's body). Tampering breaks the chain. */
export function audit(dir, event) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "audit.jsonl"), rows = lines(f), prev = rows.at(-1)?.hash ?? "GENESIS";
  const body = { at: event.at ?? new Date().toISOString(), ...event };
  const hash = createHash("sha256").update(prev + JSON.stringify(body)).digest("hex");
  appendFileSync(f, JSON.stringify({ ...body, prev, hash }) + "\n");
  return hash;
}

export function verifyAudit(dir) {
  const rows = lines(join(dir, "audit.jsonl")); let prev = "GENESIS";
  for (let i = 0; i < rows.length; i++) {
    const { prev: p, hash, ...body } = rows[i];
    if (p !== prev || createHash("sha256").update(prev + JSON.stringify(body)).digest("hex") !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, rows: rows.length };
}
