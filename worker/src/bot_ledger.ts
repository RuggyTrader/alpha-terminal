// The bot fleet's funded PAPER ledger (docs/MULTI-BOT-ARCHITECTURE.md, migration 0007). PAPER only: nothing here
// contacts a broker or exchange. Every authoritative amount is an integer number of micro-USD.
//
//   POST /webhook/bot-order   {secret, bot_id, order_id, action OPEN_LONG|OPEN_SHORT|CLOSE, symbol, timeframe, qty, …}
//   POST /webhook/bot-ledger  {secret, bot_id, symbol, alert_ids}   read-only view for the bot's engine
//   POST /api/paper/allocate  {group, amount_usd, request_id, passphrase}   MAIN → group, split equally between bots
//   POST /api/paper/bot-risk  {bot_id, risk_usd, request_id, passphrase}   versioned dollar risk for ONE bot
//   POST /api/paper/bot-entries {bot_id, paused, request_id, passphrase}   pause / resume NEW entries (exits continue)
//
// Model (labelled in every proof):
//   * Fill price: the Kraken reference price when the order arrives (as the legacy ledger), not the strategy's price.
//   * LONG:  the bot pays qty × price from its OWN wallet (reserved as the position's cost).
//   * SHORT: SIMULATED and fully collateralised: the bot posts cash equal to qty × entry price as collateral; the short
//            proceeds are never spendable; no borrowing or financing fee is modelled (none verified). Ndax offers no
//            short product: these are hypothetical PAPER positions only.
//   * Fees: Ndax-equivalent 0.20% of each fill's USD notional, on every entry and every exit (ndax.io/fees, read
//           2026-11-12: "flat 0.20% on every buy and sell", no tiers, no maker/taker split). A cross-venue model: the
//           notional is the Kraken USD reference, not an observed Ndax CAD execution.
//   * Close: gross = (exit − entry) × qty (LONG) or (entry − exit) × qty (SHORT); net = gross − entry fee − exit fee.
//            A positive net is swept to MAIN in the SAME transaction (settlement key SWEEP:<trade id>), so the bot's
//            wallet returns to its pre-trade balance; a loss reduces the bot's own wallet only. A loss beyond the bot's
//            collateral and cash is recorded as a shortfall (never covered by MAIN or another bot) and pauses entries.

import { BOT_ID_RE, type BotRow } from "./bots";
import { getInstrument, referencePrices, type MarketDataConfig } from "./instruments";
import { fromMicro, toMicro } from "./portfolio";
import { secureEqual } from "./trade_core";

export const FEE_MODEL = Object.freeze({
  id: "ndax-flat-0.20-2026-11-12",
  provider: "Ndax",
  ratePct: 0.2,
  currency: "USD (USD-equivalent of the Kraken reference notional; cross-venue commission model)",
  source: "https://ndax.io/fees (read 2026-11-12): \"Ndax charges a flat 0.20% trading fee on the value of every buy and sell. There are no volume tiers and no maker/taker split.\"",
  formula: "fee = round(qty × fill price × 0.20%) per fill, in micro-USD",
});
export const SHORT_MODEL = Object.freeze({
  id: "short-fully-collateralised-v1",
  collateral: "cash equal to 100% of the short's entry notional, posted from the bot's own wallet; proceeds never spendable",
  financing: "not modelled: no verified borrowing fee (Ndax shows no short-selling product)",
  shortfall: "a loss beyond collateral and cash is recorded as the bot's shortfall; MAIN and other bots never cover it; new entries pause",
});
// Kraken venue minimums (AssetPairs, verified 2026-11-12) — the same values as engine/src/instruments.mjs.
const VENUE: Record<string, { minQty: number; minNotional: number; decimals: number }> = {
  SOLUSD: { minQty: 0.05, minNotional: 0.5, decimals: 8 },
  BTCUSD: { minQty: 0.00006, minNotional: 0.5, decimals: 8 },
};

export interface BotLedgerEnv extends MarketDataConfig {
  DB: D1Database;
  WEBHOOK_SECRET: string;
  DASHBOARD_PASSPHRASE?: string;
  MAX_ORDER_NOTIONAL?: string;
  MAX_TOTAL_EXPOSURE?: string;
  MAX_OPEN_POSITIONS?: string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const limit = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const feeMicro = (notionalMicro: number) => Math.round((notionalMicro * FEE_MODEL.ratePct) / 100);
const ORDER_ID_RE = /^[\x21-\x7E]{8,160}$/;

/** Before migration 0007 (production schema 6) there is no bot ledger: every bot route answers a clear 409, never a 5xx. */
async function botLedgerInstalled(db: D1Database): Promise<boolean> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('bots', 'bot_positions', 'bot_orders', 'bot_fills')`).first<{ n: number }>().catch(() => null);
  return Number(r?.n ?? 0) === 4;
}
const NOT_INSTALLED = () => json({ ok: false, code: "BOT_LEDGER_NOT_INSTALLED", message: "The bot ledger (migration 0007) is not applied; no funded bot trading is possible." }, 409);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 16_384) return null;
  try { const b = JSON.parse(text); return b && typeof b === "object" ? b : null; } catch { return null; }
}

interface PositionRow {
  id: number; trade_id: string; bot_id: string; symbol: string; side: "LONG" | "SHORT"; status: string; qty: number;
  entry_price: number; entry_fee_micro: number; collateral_micro: number; stop: number | null; tp: number | null; opened_at: string;
}

/** Account-wide safety: open positions and reserved exposure across the fleet AND the legacy ledger. */
async function accountExposure(db: D1Database) {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM bot_positions WHERE status = 'OPEN') + (SELECT COUNT(*) FROM paper_positions WHERE status = 'OPEN') AS n,
            (SELECT COALESCE(SUM(collateral_micro), 0) FROM bot_positions WHERE status = 'OPEN')
            + (SELECT COALESCE(SUM(reserved_micro), 0) FROM paper_positions WHERE status = 'OPEN') AS reserved`
  ).first<{ n: number; reserved: number }>();
  return { open: Number(r?.n ?? 0), reservedMicro: Number(r?.reserved ?? 0) };
}

async function recordRejection(db: D1Database, o: { orderId: string; botId: string; action: string; symbol: string; qty: number | null; code: string; message: string; payload: string }) {
  try {
    await db.prepare(
      `INSERT INTO bot_orders (order_id, bot_id, action, symbol, requested_qty, status, code, message, received_at, payload_json)
       VALUES (?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?, ?)`
    ).bind(o.orderId, o.botId, o.action, o.symbol, o.qty, o.code, o.message.slice(0, 300), new Date().toISOString(), (o.payload.length <= 16000 ? o.payload : null)).run();
  } catch { /* a concurrent duplicate already recorded it */ }
}
const reject = async (db: D1Database, o: Parameters<typeof recordRejection>[1], http = 422) => {
  await recordRejection(db, o);
  return json({ ok: false, status: "rejected", code: o.code, message: o.message, order_id: o.orderId, mode: "PAPER", broker_request_sent: false }, http);
};

export async function handleBotOrder(request: Request, env: BotLedgerEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ ok: false, code: "INVALID_JSON" }, 400);
  if (typeof body.secret !== "string" || !(await secureEqual(body.secret, env.WEBHOOK_SECRET))) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  const db = env.DB;
  if (!(await botLedgerInstalled(db))) return NOT_INSTALLED();
  const orderId = typeof body.order_id === "string" ? body.order_id : "";
  const botId = typeof body.bot_id === "string" ? body.bot_id : "";
  const action = String(body.action ?? "");
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  if (!ORDER_ID_RE.test(orderId) || !BOT_ID_RE.test(botId) || !["OPEN_LONG", "OPEN_SHORT", "CLOSE"].includes(action)) {
    return json({ ok: false, code: "INVALID_ORDER", message: "order_id, bot_id (ALPHA-NN) and action OPEN_LONG|OPEN_SHORT|CLOSE are required" }, 400);
  }
  // Idempotency: the same order id is answered with its original outcome, never applied twice.
  const prior = await db.prepare(`SELECT status, code, message, trade_id FROM bot_orders WHERE order_id = ?`).bind(orderId).first<{ status: string; code: string; message: string | null; trade_id: string | null }>();
  if (prior) {
    return json({ ok: true, status: "duplicate", code: "DUPLICATE", data: { original_status: prior.status === "ACCEPTED" ? "dry_run" : "rejected", original_code: prior.code, trade_id: prior.trade_id } });
  }
  const payload = JSON.stringify({ ...body, secret: undefined });
  const qtyIn = typeof body.qty === "number" && Number.isFinite(body.qty) ? body.qty : null;
  const ctx = { orderId, botId, action, symbol, qty: qtyIn, payload };
  const bot = await db.prepare(`SELECT * FROM bots WHERE bot_id = ?`).bind(botId).first<BotRow>();
  if (!bot) return reject(db, { ...ctx, code: "UNKNOWN_BOT", message: `${botId} is not a registered bot` }, 400).catch(() => json({ ok: false, code: "UNKNOWN_BOT" }, 400));
  if (bot.status !== "ACTIVE") return reject(db, { ...ctx, code: "BOT_NOT_ACTIVE", message: `${botId} is ${bot.status}; only ACTIVE bots trade` });
  if (bot.ledger_api !== "bot") return reject(db, { ...ctx, code: "BOT_LEDGER_PATH", message: `${botId} trades through the legacy ledger path` });
  if (symbol !== bot.symbol) return reject(db, { ...ctx, code: "BOT_MARKET_MISMATCH", message: `${botId} trades ${bot.symbol}, not ${symbol}` });
  const tf = Number(String(body.timeframe ?? "").replace(/m$/i, ""));
  if (tf !== bot.timeframe_min) return reject(db, { ...ctx, code: "BOT_TIMEFRAME_MISMATCH", message: `${botId} trades ${bot.timeframe_min}m, not ${body.timeframe}` });
  const venue = VENUE[symbol];
  const inst = getInstrument(symbol);
  if (!venue || !inst) return reject(db, { ...ctx, code: "INVALID_SYMBOL", message: `${symbol} has no verified venue rules` });

  const open = await db.prepare(`SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'`).bind(botId).first<PositionRow>();
  const price = (await referencePrices([inst], env)).get(symbol);
  if (!price || !price.ok || price.price === null) {
    // Nothing is recorded: the engine retries (market data unavailable is not a decision about the order).
    return json({ ok: false, status: "error", code: "MARKET_DATA_UNAVAILABLE", message: price && !price.ok ? price.message : "no reference price" }, 503);
  }
  const px = price.price;
  const now = new Date().toISOString();

  if (action === "CLOSE") {
    if (!open) return reject(db, { ...ctx, code: "NO_POSITION", message: `${botId} has no open position to close` });
    return closePosition(env, bot, open, { ...ctx, px, priceSource: price.source, priceAt: price.at, now });
  }

  // ---- OPEN_LONG / OPEN_SHORT
  if (bot.entries_paused) return reject(db, { ...ctx, code: "BOT_ENTRIES_PAUSED", message: `${botId}: new entries are paused; open positions are still managed` });
  if (open) return reject(db, { ...ctx, code: "POSITION_ALREADY_OPEN", message: `${botId} already holds ${open.side} ${open.qty} (${open.trade_id}); pyramiding is 0` });
  if (qtyIn === null || !(qtyIn > 0) || Number(qtyIn.toFixed(venue.decimals)) !== qtyIn) {
    return reject(db, { ...ctx, code: "INVALID_QTY", message: `quantity must be positive with at most ${venue.decimals} decimals` }, 400);
  }
  if (qtyIn < venue.minQty) return reject(db, { ...ctx, code: "BELOW_MIN_QTY", message: `${qtyIn} is below the ${symbol} minimum of ${venue.minQty}` });
  const requestedQty = qtyIn;
  let qty = qtyIn;
  let notional = toMicro(qty * px);
  if (notional < toMicro(venue.minNotional)) return reject(db, { ...ctx, code: "BELOW_MIN_COST", message: `order value $${fromMicro(notional)} is below the $${venue.minNotional} minimum` });
  let fee = feeMicro(notional);
  const maxOrder = limit(env.MAX_ORDER_NOTIONAL);
  if (maxOrder !== null && notional > toMicro(maxOrder)) return reject(db, { ...ctx, code: "MAX_ORDER_NOTIONAL", message: `order value $${fromMicro(notional)} exceeds the $${maxOrder} limit` });
  const acct = await accountExposure(db);
  const maxOpen = limit(env.MAX_OPEN_POSITIONS), maxTotal = limit(env.MAX_TOTAL_EXPOSURE);
  if (maxOpen !== null && acct.open >= maxOpen) return reject(db, { ...ctx, code: "MAX_OPEN_POSITIONS", message: `${acct.open} of ${maxOpen} positions are open` });
  if (maxTotal !== null && acct.reservedMicro + notional > toMicro(maxTotal)) return reject(db, { ...ctx, code: "MAX_TOTAL_EXPOSURE", message: `account exposure would exceed $${maxTotal}` });
  const w = await db.prepare(`SELECT available_micro FROM portfolio_wallets WHERE wallet = ?`).bind(bot.wallet).first<{ available_micro: number }>();
  if (!w) return reject(db, { ...ctx, code: "NO_WALLET", message: `${botId} has no wallet` });
  let reducedNote: string | null = null;
  if (notional + fee > Number(w.available_micro)) {
    // The engine sized at its planned price; the ledger fills at the live reference price. When the market has moved
    // beyond the sizing headroom, the quantity is REDUCED (never raised) to what this bot's own wallet can pay, floored
    // to the venue's step. Refused only if even the reduced size is below the venue minimum.
    const fit = Math.floor((Number(w.available_micro) / 1e6 / (px * (1 + FEE_MODEL.ratePct / 100))) * 10 ** venue.decimals) / 10 ** venue.decimals;
    const fitNotional = toMicro(fit * px);
    if (fit >= venue.minQty && fitNotional >= toMicro(venue.minNotional) && fitNotional + feeMicro(fitNotional) <= Number(w.available_micro)) {
      reducedNote = `quantity reduced from ${requestedQty} to ${fit} to fit ${botId}'s available $${fromMicro(Number(w.available_micro))} at the fill price ${px}`;
      qty = fit; notional = fitNotional; fee = feeMicro(fitNotional);
    }
  }
  if (notional + fee > Number(w.available_micro)) {
    return reject(db, { ...ctx, code: "INSUFFICIENT_BOT_CAPITAL", message: `${botId} has $${fromMicro(w.available_micro)} available; this ${action === "OPEN_LONG" ? "LONG costs" : "SHORT needs collateral of"} $${fromMicro(notional)} + fee $${fromMicro(fee)}. Another bot's capital is never used.` });
  }
  const side = action === "OPEN_LONG" ? "LONG" : "SHORT";
  const tradeId = orderId;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const note = `${side} ${qty} @ ${px}: ${side === "LONG" ? "purchase cost reserved" : "short collateral posted (simulated, fully collateralised)"}${reducedNote ? `; ${reducedNote}` : ""}`;
  try {
    await db.batch([
      db.prepare(`INSERT INTO bot_orders (order_id, bot_id, action, symbol, requested_qty, status, code, message, trade_id, received_at, payload_json)
                  VALUES (?, ?, ?, ?, ?, 'ACCEPTED', 'DRY_RUN_ACCEPTED', ?, ?, ?, ?)`).bind(orderId, botId, action, symbol, requestedQty, note, tradeId, now, payload.length <= 16000 ? payload : null),
      db.prepare(`INSERT INTO bot_positions (trade_id, bot_id, symbol, side, status, qty, entry_price, entry_fee_micro, collateral_micro, stop, tp, risk_usd,
                    profile, inputs_hash, fee_model, opened_at, mark_price, mark_at)
                  VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(tradeId, botId, symbol, side, qty, px, fee, notional, num(body.stop), num(body.tp), num(body.risk_usd), bot.profile,
          typeof body.config_hash === "string" ? body.config_hash.slice(0, 32) : bot.inputs_hash, FEE_MODEL.id, now, px, price.at),
      db.prepare(`INSERT INTO bot_fills (fill_id, bot_id, trade_id, kind, side, qty, price, notional_micro, fee_rate_pct, fee_micro, fee_currency, fee_model, price_source, price_at, filled_at)
                  VALUES (?, ?, ?, 'ENTRY', ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?)`)
        .bind(orderId, botId, tradeId, side, qty, px, notional, FEE_MODEL.ratePct, fee, FEE_MODEL.id, price.source, price.at, now),
      // CHECK (available_micro >= 0) fails the whole transaction if the bot's own wallet cannot pay.
      db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, reserved_micro = reserved_micro + ?, fees_micro = fees_micro + ?, updated_at = ? WHERE wallet = ?`)
        .bind(notional + fee, notional, fee, now, bot.wallet),
      db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, note)
                  VALUES (?, ?, ?, 'RESERVE', ?, ?, ?, ?, ?)`).bind(`RESERVE:${orderId}`, orderId, now, bot.wallet, -notional, notional, orderId, note),
      db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, note)
                  VALUES (?, ?, ?, 'FEE', ?, ?, 0, ?, ?)`).bind(`FEE:${orderId}`, orderId, now, bot.wallet, -fee, orderId, `${FEE_MODEL.provider}-equivalent ${FEE_MODEL.ratePct}% entry fee on $${fromMicro(notional)}`),
    ]);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/UNIQUE/i.test(msg)) return json({ ok: false, status: "error", code: "CONCURRENT_ORDER", message: "a concurrent order changed this bot; nothing was committed (retry)" }, 409);
    if (/CHECK constraint failed/i.test(msg)) return reject(db, { ...ctx, code: "INSUFFICIENT_BOT_CAPITAL", message: `${botId}'s wallet cannot cover this order; nothing was committed` });
    return json({ ok: false, status: "error", code: "LEDGER_ERROR", message: `nothing was committed: ${msg.slice(0, 200)}` }, 500);
  }
  return json({ ok: true, status: "dry_run", code: "DRY_RUN_ACCEPTED", mode: "PAPER", broker_request_sent: false,
    data: { trade_id: tradeId, bot_id: botId, side, qty, requested_qty: requestedQty, reduced_to_fit: reducedNote !== null, price: px, price_source: price.source, notional_usd: fromMicro(notional), fee_usd: fromMicro(fee), fee_model: FEE_MODEL.id } });
}

async function closePosition(env: BotLedgerEnv, bot: BotRow, p: PositionRow,
  c: { orderId: string; botId: string; action: string; symbol: string; qty: number | null; payload: string; px: number; priceSource: string; priceAt: string; now: string }): Promise<Response> {
  const db = env.DB;
  const exitNotional = toMicro(p.qty * c.px);
  const entryNotional = p.collateral_micro; // = qty × entry price, posted at entry
  const gross = p.side === "LONG" ? exitNotional - entryNotional : entryNotional - exitNotional;
  const exitFee = feeMicro(exitNotional);
  const net = gross - p.entry_fee_micro - exitFee;
  const paid = entryNotional + gross - exitFee; // what flows back into the bot's available balance (may be < 0 for a short)
  const sweep = net > 0 ? net : 0;
  const w = await db.prepare(`SELECT available_micro FROM portfolio_wallets WHERE wallet = ?`).bind(bot.wallet).first<{ available_micro: number }>();
  const shortfallEstimate = Math.max(0, -(Number(w?.available_micro ?? 0) + paid));
  const settlement = `SWEEP:${p.trade_id}`;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO bot_orders (order_id, bot_id, action, symbol, requested_qty, status, code, message, trade_id, received_at, payload_json)
                VALUES (?, ?, 'CLOSE', ?, ?, 'ACCEPTED', 'DRY_RUN_ACCEPTED', ?, ?, ?, ?)`)
      .bind(c.orderId, c.botId, c.symbol, p.qty, `close ${p.side} ${p.qty} @ ${c.px}`, p.trade_id, c.now, (c.payload.length <= 16000 ? c.payload : null)),
    // The exit fill: fails (NOT NULL from the guarded row) unless this exact position is still OPEN.
    db.prepare(`INSERT INTO bot_fills (fill_id, bot_id, trade_id, kind, side, qty, price, notional_micro, fee_rate_pct, fee_micro, fee_currency, fee_model, price_source, price_at, filled_at)
                SELECT ?, p.bot_id, p.trade_id, 'EXIT', p.side, p.qty, ?, ?, ?, ?, 'USD', ?, ?, ?, ?
                FROM (SELECT 1) AS one LEFT JOIN bot_positions p ON p.id = ? AND p.status = 'OPEN'`)
      .bind(c.orderId, c.px, exitNotional, FEE_MODEL.ratePct, exitFee, FEE_MODEL.id, c.priceSource, c.priceAt, c.now, p.id),
    // Ledger entries (computed against the wallet BEFORE its update in this transaction).
    db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, note)
                VALUES (?, ?, ?, 'RELEASE', ?, ?, ?, ?, ?)`)
      .bind(`RELEASE:${c.orderId}`, c.orderId, c.now, bot.wallet, entryNotional, -entryNotional, p.trade_id, `${p.side} closed: ${p.side === "LONG" ? "cost basis" : "short collateral"} released`),
    db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, note)
                SELECT ?, ?, ?, 'REALIZED_PNL', ?, ? + MAX(0, -(w.available_micro + ?)), 0, ?, ? FROM portfolio_wallets w WHERE w.wallet = ?`)
      .bind(`PNL:${c.orderId}`, c.orderId, c.now, bot.wallet, gross, paid, p.trade_id, `realized ${p.side} P&L (gross; the covered part if a shortfall)`, bot.wallet),
    db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, ref, note)
                VALUES (?, ?, ?, 'FEE', ?, ?, 0, ?, ?)`)
      .bind(`FEE:${c.orderId}`, c.orderId, c.now, bot.wallet, -exitFee, p.trade_id, `${FEE_MODEL.provider}-equivalent ${FEE_MODEL.ratePct}% exit fee on $${fromMicro(exitNotional)}`),
    db.prepare(`UPDATE bot_positions SET status = 'CLOSED', exit_price = ?, exit_fee_micro = ?, closed_at = ?, close_order_id = ?,
                  gross_pnl_micro = ?, net_pnl_micro = ?, swept_micro = ?, mark_price = ?, mark_at = ?,
                  shortfall_micro = (SELECT MAX(0, -(w.available_micro + ?)) FROM portfolio_wallets w WHERE w.wallet = ?)
                WHERE id = ? AND status = 'OPEN'`)
      .bind(c.px, exitFee, c.now, c.orderId, gross, net, sweep, c.px, c.priceAt, paid, bot.wallet, p.id),
    // The wallet (one statement: every right-hand side reads the values before the update).
    db.prepare(`UPDATE portfolio_wallets SET
                  shortfall_micro = shortfall_micro + MAX(0, -(available_micro + ?)),
                  realized_pnl_micro = realized_pnl_micro + ? + MAX(0, -(available_micro + ?)),
                  reserved_micro = reserved_micro - ?,
                  fees_micro = fees_micro + ?,
                  available_micro = MAX(0, available_micro + ?),
                  updated_at = ?
                WHERE wallet = ?`)
      .bind(paid, gross, paid, entryNotional, exitFee, paid, c.now, bot.wallet),
  ];
  if (sweep > 0) {
    // Positive net profit → MAIN, atomically with the close (unique settlement keys: never twice).
    stmts.push(
      db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, net_funding_micro = net_funding_micro - ?, updated_at = ? WHERE wallet = ?`).bind(sweep, sweep, c.now, bot.wallet),
      db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro + ?, net_funding_micro = net_funding_micro + ?, updated_at = ? WHERE wallet = 'MAIN'`).bind(sweep, sweep, c.now),
      db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note)
                  VALUES (?, ?, ?, 'TRANSFER_OUT', ?, ?, 0, 'MAIN', ?, ?)`).bind(`${settlement}:OUT`, settlement, c.now, bot.wallet, -sweep, p.trade_id, `net profit swept to MAIN`),
      db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note)
                  VALUES (?, ?, ?, 'TRANSFER_IN', 'MAIN', ?, 0, ?, ?, ?)`).bind(`${settlement}:IN`, settlement, c.now, sweep, bot.wallet, p.trade_id, `net profit from ${c.botId} (${p.trade_id})`),
    );
  }
  if (shortfallEstimate > 0) stmts.push(db.prepare(`UPDATE bots SET entries_paused = 1, updated_at = ? WHERE bot_id = ?`).bind(c.now, c.botId));
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/UNIQUE|NOT NULL/i.test(msg)) return json({ ok: false, status: "error", code: "CONCURRENT_ORDER", message: "the position changed concurrently; nothing was committed (retry)" }, 409);
    return json({ ok: false, status: "error", code: "LEDGER_ERROR", message: `nothing was committed: ${msg.slice(0, 200)}` }, 500);
  }
  return json({ ok: true, status: "dry_run", code: "DRY_RUN_ACCEPTED", mode: "PAPER", broker_request_sent: false,
    data: { trade_id: p.trade_id, bot_id: c.botId, side: p.side, qty: p.qty, entry_price: p.entry_price, exit_price: c.px, gross_usd: fromMicro(gross),
      fees_usd: fromMicro(p.entry_fee_micro + exitFee), net_usd: fromMicro(net), swept_to_main_usd: fromMicro(sweep), shortfall_usd: fromMicro(shortfallEstimate) } });
}

/** Read-only ledger view for one bot's engine (same shape as /webhook/engine-ledger). */
export async function handleBotLedger(request: Request, env: BotLedgerEnv): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ ok: false, code: "INVALID_JSON" }, 400);
  if (typeof body.secret !== "string" || !(await secureEqual(body.secret, env.WEBHOOK_SECRET))) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  if (!(await botLedgerInstalled(env.DB))) return NOT_INSTALLED();
  const botId = typeof body.bot_id === "string" ? body.bot_id : "";
  const bot = BOT_ID_RE.test(botId) ? await env.DB.prepare(`SELECT * FROM bots WHERE bot_id = ?`).bind(botId).first<BotRow>() : null;
  if (!bot) return json({ ok: false, code: "UNKNOWN_BOT" }, 400);
  const ids = Array.isArray(body.alert_ids) ? body.alert_ids.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  const p = await env.DB.prepare(`SELECT * FROM bot_positions WHERE bot_id = ? AND status = 'OPEN'`).bind(botId).first<PositionRow>();
  const alerts: Record<string, { status: string; response_code: string; rejection_reason: string | null }> = {};
  if (ids.length) {
    const rows = await env.DB.prepare(`SELECT order_id, status, code, message FROM bot_orders WHERE order_id IN (${ids.map(() => "?").join(",")})`).bind(...ids)
      .all<{ order_id: string; status: string; code: string; message: string | null }>();
    for (const r of rows.results) alerts[r.order_id] = { status: r.status === "ACCEPTED" ? "dry_run" : "rejected", response_code: r.code, rejection_reason: r.status === "ACCEPTED" ? null : r.message };
  }
  const w = await env.DB.prepare(`SELECT available_micro, reserved_micro FROM portfolio_wallets WHERE wallet = ?`).bind(bot.wallet).first<{ available_micro: number; reserved_micro: number }>();
  const acct = await accountExposure(env.DB);
  return json({
    ok: true, mode: "PAPER", read_only: true, symbol: bot.symbol, bot_id: botId, alerts,
    position: p ? { symbol: p.symbol, side: p.side.toLowerCase(), status: p.status, qty: p.qty, avg_entry_price: p.entry_price, open_alert_id: p.trade_id, opened_at: p.opened_at } : null,
    balance: w ? {
      wallet: bot.wallet, available_usd: fromMicro(w.available_micro), reserved_usd: fromMicro(w.reserved_micro), bot_id: botId, bot_available_usd: fromMicro(w.available_micro),
      max_order_notional_usd: limit(env.MAX_ORDER_NOTIONAL), max_total_exposure_usd: limit(env.MAX_TOTAL_EXPOSURE), max_open_positions: limit(env.MAX_OPEN_POSITIONS),
      total_exposure_usd: fromMicro(acct.reservedMicro), open_positions: acct.open, position_exposure_usd: p ? fromMicro(p.collateral_micro) : 0,
      fee_model: FEE_MODEL.id,
    } : null,
  });
}

// ---------------------------------------------------------------------------------------------- owner actions

/** Equal split of an allocation, in micro-USD: every bot gets floor(amount / n); the remainder goes one micro-USD at a
 *  time to the bots in priority order. The parts always sum exactly to the amount (nothing created or lost). */
export function splitEqual(amountMicro: number, botIds: string[]): { bot_id: string; amount_micro: number }[] {
  const n = botIds.length;
  if (!n) return [];
  const base = Math.floor(amountMicro / n);
  const rem = amountMicro - base * n;
  return botIds.map((id, i) => ({ bot_id: id, amount_micro: base + (i < rem ? 1 : 0) }));
}

async function groupBots(db: D1Database, group: string) {
  return (await db.prepare(`SELECT * FROM bots WHERE group_id = ? AND status = 'ACTIVE' ORDER BY priority, bot_id`).bind(group).all<BotRow>()).results;
}

/** Preview (read-only): how an allocation to a group would split. */
export async function allocationPreview(db: D1Database, group: string, amountUsd: number) {
  if (!(await botLedgerInstalled(db))) return { group, amount_usd: amountUsd, available: false, main_available_usd: null, affordable: false, split: [] };
  const bots = await groupBots(db, group);
  const main = await db.prepare(`SELECT available_micro FROM portfolio_wallets WHERE wallet = 'MAIN'`).first<{ available_micro: number }>();
  const amount = toMicro(amountUsd);
  return { group, amount_usd: amountUsd, main_available_usd: fromMicro(main?.available_micro ?? 0), affordable: amount <= Number(main?.available_micro ?? 0),
    split: splitEqual(amount, bots.map((b) => b.bot_id)).map((s) => ({ ...s, amount_usd: fromMicro(s.amount_micro), wallet: bots.find((b) => b.bot_id === s.bot_id)?.wallet })) };
}

/** Owner actions; the caller (portfolio.ts handlePaperApi) has already checked the session, origin and passphrase. */
export async function handleBotOwnerAction(env: BotLedgerEnv, pathname: string, body: Record<string, unknown>): Promise<Response> {
  const db = env.DB;
  if (!(await botLedgerInstalled(db))) return NOT_INSTALLED();
  const requestId = typeof body.request_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.request_id) ? body.request_id : null;
  if (!requestId) return json({ ok: false, code: "INVALID_REQUEST", message: "request_id is required" }, 400);
  const now = new Date().toISOString();

  if (pathname === "/api/paper/allocate") {
    const group = typeof body.group === "string" ? body.group : "";
    const amount = typeof body.amount_usd === "number" && Number.isFinite(body.amount_usd) && body.amount_usd > 0 && Math.abs(body.amount_usd * 100 - Math.round(body.amount_usd * 100)) < 1e-6 ? body.amount_usd : null;
    if (!amount) return json({ ok: false, code: "INVALID_AMOUNT", message: "amount_usd must be a positive amount in cents" }, 400);
    const bots = await groupBots(db, group);
    if (!bots.length) return json({ ok: false, code: "NO_ACTIVE_BOTS", message: `${group} has no ACTIVE bot to allocate to` }, 422);
    const prior = await db.prepare(`SELECT split_json FROM allocation_events WHERE request_key = ?`).bind(requestId).first<{ split_json: string }>();
    if (prior) return json({ ok: true, duplicate: true, split: JSON.parse(prior.split_json) });
    const amountMicro = toMicro(amount);
    const split = splitEqual(amountMicro, bots.map((b) => b.bot_id));
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO allocation_events (request_key, group_id, amount_micro, split_json, created_at, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(requestId, group, amountMicro, JSON.stringify(split), now, `owner allocation MAIN → ${group}`),
      // CHECK (available_micro >= 0) on MAIN fails the whole transaction if MAIN cannot cover it (only unreserved money).
      db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro - ?, net_funding_micro = net_funding_micro - ?, updated_at = ? WHERE wallet = 'MAIN'`).bind(amountMicro, amountMicro, now),
    ];
    for (const s of split) {
      const wallet = bots.find((b) => b.bot_id === s.bot_id)!.wallet;
      stmts.push(
        db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note)
                    VALUES (?, ?, ?, 'TRANSFER_OUT', 'MAIN', ?, 0, ?, ?, ?)`).bind(`ALLOC:${requestId}:${s.bot_id}:OUT`, `ALLOC:${requestId}`, now, -s.amount_micro, wallet, requestId, `${group} allocation → ${s.bot_id}`),
        db.prepare(`INSERT INTO portfolio_entries (entry_key, group_key, created_at, kind, wallet, available_change_micro, reserved_change_micro, counterparty, ref, note)
                    VALUES (?, ?, ?, 'TRANSFER_IN', ?, ?, 0, 'MAIN', ?, ?)`).bind(`ALLOC:${requestId}:${s.bot_id}:IN`, `ALLOC:${requestId}`, now, wallet, s.amount_micro, requestId, `${group} allocation (equal split)`),
        db.prepare(`UPDATE portfolio_wallets SET available_micro = available_micro + ?, net_funding_micro = net_funding_micro + ?, updated_at = ? WHERE wallet = ?`).bind(s.amount_micro, s.amount_micro, now, wallet),
      );
    }
    try { await db.batch(stmts); } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/CHECK constraint failed/i.test(msg)) return json({ ok: false, code: "INSUFFICIENT_MAIN", message: "MAIN does not have that much unreserved money; nothing was moved" }, 422);
      if (/UNIQUE/i.test(msg)) return json({ ok: false, code: "DUPLICATE_REQUEST" }, 409);
      throw e;
    }
    return json({ ok: true, group, amount_usd: amount, split: split.map((s) => ({ ...s, amount_usd: fromMicro(s.amount_micro) })) });
  }

  const botId = typeof body.bot_id === "string" ? body.bot_id : "";
  const bot = BOT_ID_RE.test(botId) ? await db.prepare(`SELECT * FROM bots WHERE bot_id = ?`).bind(botId).first<BotRow>() : null;
  if (!bot) return json({ ok: false, code: "UNKNOWN_BOT" }, 400);

  if (pathname === "/api/paper/bot-risk") {
    const risk = typeof body.risk_usd === "number" && Number.isFinite(body.risk_usd) && body.risk_usd >= 0.01 && body.risk_usd <= 1_000_000
      && Math.abs(body.risk_usd * 100 - Math.round(body.risk_usd * 100)) < 1e-6 ? body.risk_usd : null;
    if (risk === null) return json({ ok: false, code: "INVALID_RISK", message: "risk_usd must be a dollar amount in cents (at least $0.01)" }, 400);
    const last = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM bot_settings WHERE bot_id = ?`).bind(botId).first<{ v: number }>();
    const version = Number(last?.v ?? 0) + 1;
    try {
      await db.batch([
        db.prepare(`UPDATE bot_settings SET status = 'SUPERSEDED' WHERE bot_id = ? AND status = 'PENDING'`).bind(botId),
        db.prepare(`INSERT INTO bot_settings (bot_id, version, risk_usd, status, request_key, requested_at, note) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`)
          .bind(botId, version, risk, requestId, now, "owner request; applies to new orders once the bot's engine confirms"),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e instanceof Error ? e.message : e))) return json({ ok: false, code: "DUPLICATE_REQUEST" }, 409);
      throw e;
    }
    return json({ ok: true, bot_id: botId, version, risk_usd: risk, status: "PENDING" });
  }

  if (pathname === "/api/paper/bot-entries") {
    if (typeof body.paused !== "boolean") return json({ ok: false, code: "INVALID_REQUEST", message: "paused must be true or false" }, 400);
    await db.prepare(`UPDATE bots SET entries_paused = ?, updated_at = ? WHERE bot_id = ?`).bind(body.paused ? 1 : 0, now, botId).run();
    return json({ ok: true, bot_id: botId, entries_paused: body.paused, note: body.paused ? "new entries refused; open positions keep their exits" : "new entries allowed" });
  }
  return json({ ok: false, code: "NOT_FOUND" }, 404);
}

/** Per-bot risk settings handshake on the bot's status heartbeat: confirm what the engine applied; send what is pending. */
export async function botSettingsExchange(db: D1Database, bot: BotRow, applied: unknown) {
  const now = new Date().toISOString();
  const a = applied && typeof applied === "object" ? (applied as { version?: unknown; risk_usd?: unknown }) : null;
  if (a && Number.isInteger(a.version) && typeof a.risk_usd === "number") {
    const row = await db.prepare(`SELECT version, risk_usd, status FROM bot_settings WHERE bot_id = ? AND version = ?`).bind(bot.bot_id, a.version).first<{ version: number; risk_usd: number; status: string }>();
    if (row && row.status === "PENDING" && row.risk_usd === a.risk_usd) {
      await db.batch([
        db.prepare(`UPDATE bot_settings SET status = 'APPLIED', applied_at = ? WHERE bot_id = ? AND version = ?`).bind(now, bot.bot_id, a.version),
        db.prepare(`UPDATE bots SET risk_usd = ?, updated_at = ? WHERE bot_id = ?`).bind(a.risk_usd, now, bot.bot_id),
      ]);
    }
  }
  const next = await db.prepare(`SELECT version, risk_usd FROM bot_settings WHERE bot_id = ? AND status IN ('PENDING', 'APPLIED') ORDER BY version DESC LIMIT 1`).bind(bot.bot_id).first<{ version: number; risk_usd: number }>();
  return next ? { bot_id: bot.bot_id, version: next.version, risk_usd: next.risk_usd } : null;
}
