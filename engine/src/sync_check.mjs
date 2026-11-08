// Pre-sync comparison of the engine's saved state with the production ALPHA PAPER ledger. Fails closed: anything
// unreadable, malformed or different is a mismatch, and sync must stay off. Pure; no I/O.
//
// A held position matches only when ALL of these agree: symbol, direction, quantity (8 decimals, as sent),
// open status and the opening alert id, and the engine's own record of that entry was accepted by the Worker.
// A matching id with different details is a mismatch.

const QTY_TOLERANCE = 1e-8;
const round8 = (q) => Number(Number(q).toFixed(8));
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const fail = (detail) => ({ pass: false, detail });

/** Reads the ledger answer of POST /webhook/engine-ledger; null when it is not a complete, readable answer. */
function readLedger(resp, symbol) {
  if (!isObj(resp) || resp.ok !== true || resp.read_only !== true || resp.symbol !== symbol || !("position" in resp)) return null;
  const p = resp.position;
  if (p === null) return { position: null };
  if (!isObj(p)) return null;
  const qty = Number(p.qty);
  if (typeof p.symbol !== "string" || typeof p.side !== "string" || typeof p.status !== "string"
    || typeof p.open_alert_id !== "string" || !p.open_alert_id || !Number.isFinite(qty) || qty <= 0) return null;
  return { position: { symbol: p.symbol, side: p.side, status: p.status, qty, openAlertId: p.open_alert_id } };
}

/** Reads the engine's saved state; null when malformed. A missing state file (state === null) means flat. */
function readEngine(state) {
  if (state === null) return { position: null };
  const broker = state?.strategy?.broker;
  if (!isObj(state) || !isObj(broker) || !Array.isArray(state.outbox)) return null;
  const pos = broker.pos;
  if (pos === null || pos === undefined) return { position: null, openEntryId: state.openEntryId ?? null };
  const qty = Number(pos.qty);
  if (!isObj(pos) || (pos.side !== 1 && pos.side !== -1) || !Number.isFinite(qty) || qty <= 0) return null;
  const entryId = typeof state.openEntryId === "string" && state.openEntryId ? state.openEntryId : null;
  const entry = entryId ? state.outbox.find((x) => isObj(x) && x.id === entryId) ?? null : null;
  return { position: { side: pos.side === 1 ? "long" : "short", qty: round8(qty), entryId, entry } };
}

/**
 * @param {object|null|undefined} state   parsed engine state file; null = no file (flat); undefined = unreadable
 * @param {object|null|undefined} ledgerResp parsed /webhook/engine-ledger answer; null/undefined = unreadable
 * @param {string} symbol
 * @returns {{pass: boolean, detail: string}}
 */
export function compareEngineAndLedger(state, ledgerResp, symbol) {
  const ledger = readLedger(ledgerResp, symbol);
  if (!ledger) return fail("the production ledger answer is missing or unreadable; nothing can be verified");
  if (state === undefined) return fail("the engine's saved state could not be read; nothing can be verified");
  const engine = readEngine(state);
  if (!engine) return fail("the engine's saved state is malformed; nothing can be verified");

  const e = engine.position, l = ledger.position;
  if (!e && !l) return { pass: true, detail: `both flat${state === null ? " (no saved engine state yet: it starts flat)" : ""}` };
  if (!e) return fail(`production holds an open ${l.symbol} ${l.side} ${l.qty} (${l.openAlertId}) that the engine does not hold`);
  if (!l) return fail(`the engine's saved state holds ${e.side} ${e.qty} (${e.entryId ?? "no entry id"}) that production does not hold; it would send an unmatched CLOSE`);

  const diffs = [];
  if (l.symbol !== symbol) diffs.push(`symbol: ledger ${l.symbol}, engine ${symbol}`);
  if (l.side !== e.side) diffs.push(`direction: ledger ${l.side}, engine ${e.side}`);
  if (l.status !== "OPEN") diffs.push(`status: ledger ${l.status}, engine open`);
  if (Math.abs(l.qty - e.qty) > QTY_TOLERANCE) diffs.push(`quantity: ledger ${l.qty}, engine ${e.qty}`);
  if (!e.entryId) diffs.push("opening alert id: the engine has none for its open position");
  else if (l.openAlertId !== e.entryId) diffs.push(`opening alert id: ledger ${l.openAlertId}, engine ${e.entryId}`);
  if (e.entryId && !e.entry) diffs.push(`the engine has no record of sending ${e.entryId}`);
  else if (e.entry) {
    if (e.entry.status !== "accepted") diffs.push(`the engine's ${e.entryId} is ${e.entry.status}, not accepted`);
    if (e.entry.qty !== undefined && e.entry.qty !== null && Math.abs(Number(e.entry.qty) - l.qty) > QTY_TOLERANCE) diffs.push(`quantity sent: ${e.entry.qty}, ledger ${l.qty}`);
  }
  if (diffs.length) return fail(`positions differ: ${diffs.join("; ")}`);
  return { pass: true, detail: `same open position: ${symbol} ${l.side} ${l.qty} from ${l.openAlertId}` };
}
