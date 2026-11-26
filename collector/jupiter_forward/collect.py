#!/usr/bin/env python3
"""Read-only forward data collector for Jupiter Perps. Run hourly (cron).

Public endpoints only; no keys, wallets or signing; no LLM calls. Never backfills: anything
it could not capture is written to the `gaps` table.
Env overrides (tests): JUPITER_DATA_DIR, JUPITER_RPC_URL.
"""
import datetime as dt
import fcntl
import json
import logging
import logging.handlers
import os
import sqlite3
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decoder  # noqa: E402

DATA_DIR = os.environ.get("JUPITER_DATA_DIR", "/workspace/ruggy/data/jupiter")
API = "https://perps-api.jup.ag/v1"
RPC_URL = os.environ.get("JUPITER_RPC_URL", "https://solana-rpc.publicnode.com")
MARKETS = {  # symbol -> mint (jlp-info custody mints; BTC is wBTC)
    "SOL": "So11111111111111111111111111111111111111112",
    "ETH": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    "BTC": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
}
MINT2SYM = {v: k for k, v in MARKETS.items()}
TIMEOUT = 10          # seconds per HTTP call
MAX_RETRIES = 2       # retries after the first try
MAX_TX = 200          # getTransaction calls per run
RPC_BUDGET_S = 300    # wall-clock budget for the event phase
MISSED_AFTER_S = 90 * 60
TRADE_EVENTS = {"IncreasePositionEvent", "DecreasePositionEvent", "InstantIncreasePositionEvent",
                "InstantDecreasePositionEvent", "LiquidateFullPositionEvent", "LiquidateBorrowPositionEvent"}
log = logging.getLogger("jupiter")

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, started_utc TEXT, finished_utc TEXT, status TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS pool_info(id INTEGER PRIMARY KEY, run_id INT, fetched_utc TEXT, market TEXT,
  long_borrow_rate_pct REAL, short_borrow_rate_pct REAL, long_utilization_pct REAL, short_utilization_pct REAL,
  long_available_liquidity_usd REAL, short_available_liquidity_usd REAL, open_fee_pct REAL,
  max_price_impact_fee_pct REAL, max_request_execution_sec REAL, raw_json TEXT);
CREATE TABLE IF NOT EXISTS market_stats(id INTEGER PRIMARY KEY, run_id INT, fetched_utc TEXT, market TEXT,
  price REAL, price_change_24h_pct REAL, price_high_24h REAL, price_low_24h REAL, volume_24h_usd REAL, raw_json TEXT);
CREATE TABLE IF NOT EXISTS jlp_info(id INTEGER PRIMARY KEY, run_id INT, fetched_utc TEXT, aum_usd REAL,
  jlp_price_usd REAL, jlp_apr_pct REAL, jlp_apy_pct REAL, realized_fee_usd REAL, raw_json TEXT);
-- long_guaranteed_usd = custody guaranteedUsd (long-side proxy, not exact OI); short_oi_usd = globalShortSizes.
CREATE TABLE IF NOT EXISTS jlp_custody(id INTEGER PRIMARY KEY, run_id INT, fetched_utc TEXT, market TEXT,
  aum_usd REAL, utilization_pct REAL, weight_pct REAL, target_weight_pct REAL, owned_token REAL, locked_token REAL,
  long_guaranteed_usd REAL, short_oi_usd REAL, short_avg_price REAL, raw_json TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, run_id INT, fetched_utc TEXT, signature TEXT, ix_idx INT,
  slot INT, block_time_utc TEXT, event TEXT, market TEXT, side TEXT, price REAL, size_usd_delta REAL, fee_usd REAL,
  position_fee_usd REAL, borrow_fee_usd REAL, price_impact_fee_usd REAL, liquidation_fee_usd REAL, pnl_delta_usd REAL,
  raw_json TEXT, UNIQUE(signature, ix_idx));
CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY, run_id INT, recorded_utc TEXT, kind TEXT, ref TEXT,
  start_utc TEXT, end_utc TEXT, count INT, detail TEXT);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
"""


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def ts_iso(sec):
    return iso(dt.datetime.fromtimestamp(sec, dt.timezone.utc)) if sec else None


def num(x, scale=1.0):
    try:
        return float(x) / scale
    except (TypeError, ValueError):
        return None


# ---------- http ----------
def http(method, url, **kw):
    """requests call, short timeout, at most MAX_RETRIES retries. Raises on final failure."""
    last = None
    for i in range(MAX_RETRIES + 1):
        try:
            r = requests.request(method, url, timeout=TIMEOUT, **kw)
            if r.status_code == 200:
                return r.json()
            last = RuntimeError("HTTP %s: %s" % (r.status_code, r.text[:200]))
        except (requests.RequestException, ValueError) as e:
            last = e
        if i < MAX_RETRIES:
            time.sleep(1 + i)
    raise last


def api_get(path, params=None):
    return http("GET", API + path, params=params)


def rpc_call(method, params):
    j = http("POST", RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in j:
        raise RuntimeError("rpc error: %s" % json.dumps(j["error"])[:200])
    return j


# ---------- parsing ----------
def parse_pool_info(j):
    return dict(long_borrow_rate_pct=num(j.get("longBorrowRatePercent")), short_borrow_rate_pct=num(j.get("shortBorrowRatePercent")),
                long_utilization_pct=num(j.get("longUtilizationPercent")), short_utilization_pct=num(j.get("shortUtilizationPercent")),
                long_available_liquidity_usd=num(j.get("longAvailableLiquidity")), short_available_liquidity_usd=num(j.get("shortAvailableLiquidity")),
                open_fee_pct=num(j.get("openFeePercent")), max_price_impact_fee_pct=num(j.get("maxPriceImpactFeePercent")),
                max_request_execution_sec=num(j.get("maxRequestExecutionSec")))


def parse_market_stats(j):
    return dict(price=num(j.get("price")), price_change_24h_pct=num(j.get("priceChange24H")),
                price_high_24h=num(j.get("priceHigh24H")), price_low_24h=num(j.get("priceLow24H")), volume_24h_usd=num(j.get("volume")))


def parse_jlp(j):
    top = dict(aum_usd=num(j.get("aumUsd"), 1e6), jlp_price_usd=num(j.get("jlpPriceUsd"), 1e6), jlp_apr_pct=num(j.get("jlpAprPct")),
               jlp_apy_pct=num(j.get("jlpApyPct")), realized_fee_usd=num(j.get("jlpRealizedFeeUsd"), 1e6))
    cust = {}
    for c in j.get("custodies", []):
        sym = MINT2SYM.get(c.get("mint"))
        if not sym:
            continue
        cust[sym] = (dict(aum_usd=num(c.get("aumUsd"), 1e6), utilization_pct=num(c.get("utilizationPct")),
                          weight_pct=num(c.get("currentWeightagePct")), target_weight_pct=num(c.get("targetWeightagePct")),
                          owned_token=num(c.get("owned")), locked_token=num(c.get("locked")),
                          long_guaranteed_usd=num(c.get("guaranteedUsd"), 1e6), short_oi_usd=num(c.get("globalShortSizes"), 1e6),
                          short_avg_price=num(c.get("globalShortAveragePrice"), 1e6)), c)
    return top, cust


def parse_event(name, f):
    u = lambda k: num(f.get(k), 1e6) if f.get(k) is not None else None  # noqa: E731
    side = f.get("positionSide")
    mint = f.get("positionMint")
    pnl = u("pnlDelta")
    if pnl is not None and f.get("hasProfit") is False:
        pnl = -pnl
    return dict(event=name, market=MINT2SYM.get(mint, mint), side=side if isinstance(side, str) else json.dumps(side),
                price=u("price"), size_usd_delta=u("sizeUsdDelta"), fee_usd=u("feeUsd"), position_fee_usd=u("positionFeeUsd"),
                borrow_fee_usd=u("fundingFeeUsd"), price_impact_fee_usd=u("priceImpactFeeUsd"),
                liquidation_fee_usd=u("liquidationFeeUsd"), pnl_delta_usd=pnl)


# ---------- storage ----------
def connect(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    db = sqlite3.connect(os.path.join(data_dir, "jupiter.db"), timeout=30)
    db.executescript(SCHEMA)
    return db


def insert(db, table, row):
    cols = ",".join(row)
    db.execute("INSERT OR IGNORE INTO %s(%s) VALUES(%s)" % (table, cols, ",".join("?" * len(row))), list(row.values()))


def add_gap(db, run_id, kind, ref=None, start=None, end=None, count=None, detail=None):
    insert(db, "gaps", dict(run_id=run_id, recorded_utc=iso(utcnow()), kind=kind, ref=ref, start_utc=start, end_utc=end,
                            count=count, detail=detail))
    log.warning("GAP %s ref=%s count=%s %s", kind, ref, count, detail)


def check_missed_schedule(db, run_id, now):
    row = db.execute("SELECT started_utc FROM runs WHERE id<>? AND status IN('ok','partial') ORDER BY id DESC LIMIT 1", (run_id,)).fetchone()
    if not row:
        return
    prev = dt.datetime.fromisoformat(row[0].replace("Z", "+00:00"))
    if (now - prev).total_seconds() > MISSED_AFTER_S:
        add_gap(db, run_id, "missed_schedule", "hourly_run", row[0], iso(now), None,
                "no successful run for %d min; not backfilled" % ((now - prev).total_seconds() // 60))


# ---------- snapshot phase ----------
def snapshot(db, run_id, get=api_get):
    """Returns number of failed endpoint fetches."""
    failed = 0

    def fetch(path, params, ref):
        nonlocal failed
        t = iso(utcnow())
        try:
            return t, get(path, params)
        except Exception as e:
            failed += 1
            add_gap(db, run_id, "endpoint_failed", ref, t, t, 1, str(e)[:300])
            return t, None

    t, j = fetch("/jlp-info", None, "jlp-info")
    if j is not None:
        top, cust = parse_jlp(j)
        insert(db, "jlp_info", dict(run_id=run_id, fetched_utc=t, **top, raw_json=json.dumps(j)))
        for sym, (p, rawc) in cust.items():
            insert(db, "jlp_custody", dict(run_id=run_id, fetched_utc=t, market=sym, **p, raw_json=json.dumps(rawc)))
        for sym in MARKETS:
            if sym not in cust:
                add_gap(db, run_id, "field_missing", "jlp-info:" + sym, t, t, 1, "custody not in response")
    for sym, mint in MARKETS.items():
        for path, table, parser in (("/pool-info", "pool_info", parse_pool_info), ("/market-stats", "market_stats", parse_market_stats)):
            t, j = fetch(path, {"mint": mint}, "%s:%s" % (path[1:], sym))
            if j is not None:
                insert(db, table, dict(run_id=run_id, fetched_utc=t, market=sym, **parser(j), raw_json=json.dumps(j)))
    db.commit()
    return failed


# ---------- event phase ----------
def collect_events(db, run_id, rpc=rpc_call, max_tx=MAX_TX, budget_s=RPC_BUDGET_S):
    """Decode new trade/liquidation events since the cursor. Returns (n_events, n_tx_calls, failed_bool)."""
    cur = db.execute("SELECT value FROM kv WHERE key='last_signature'").fetchone()
    cursor = cur[0] if cur else None
    opts = {"limit": 1000, "commitment": "finalized"}
    if cursor:
        opts["until"] = cursor
    try:
        sigs = rpc("getSignaturesForAddress", [decoder.PROGRAM, opts])["result"]
    except Exception as e:
        add_gap(db, run_id, "rpc_list_failed", "program_signatures", None, iso(utcnow()), None, str(e)[:300])
        db.commit()
        return 0, 0, True
    if not sigs:
        return 0, 0, False
    if cursor and len(sigs) >= 1000:
        add_gap(db, run_id, "rpc_unlisted", "program_signatures", None, ts_iso(sigs[-1].get("blockTime")), None,
                "listing hit 1000 cap; older signatures between cursor %s and %s were not listed" % (cursor[:12], sigs[-1]["signature"][:12]))
    ok = [s for s in sigs if not s.get("err")]
    todo, skipped = ok[:max_tx], ok[max_tx:]
    if skipped:
        add_gap(db, run_id, "rpc_unprocessed", "program_signatures", ts_iso(skipped[-1].get("blockTime")), ts_iso(skipped[0].get("blockTime")),
                len(skipped), "over %d getTransaction cap; signatures not decoded (sampling, not backfilled)" % max_tx)
    n_ev = calls = fails = consec = 0
    t0 = time.time()
    unreached = []
    for i, s in enumerate(todo):
        if consec >= 5 or time.time() - t0 > budget_s:
            unreached = todo[i:]
            break
        calls += 1
        try:
            tx = rpc("getTransaction", [s["signature"], {"encoding": "json", "maxSupportedTransactionVersion": 2, "commitment": "finalized"}])
            consec = 0
        except Exception as e:
            fails += 1
            consec += 1
            log.warning("getTransaction failed %s: %s", s["signature"][:12], e)
            unreached.append(s)
            continue
        if not tx.get("result"):
            fails += 1
            unreached.append(s)
            continue
        for idx, (name, f) in enumerate(decoder.decode_events(tx)):
            if name.startswith("DECODE_ERROR") or name == "UNKNOWN":
                add_gap(db, run_id, "decode_failed", s["signature"], ts_iso(s.get("blockTime")), None, 1, "%s %s" % (name, f))
                continue
            if name not in TRADE_EVENTS:
                continue
            row = parse_event(name, f)
            insert(db, "events", dict(run_id=run_id, fetched_utc=iso(utcnow()), signature=s["signature"], ix_idx=idx, slot=s.get("slot"),
                                      block_time_utc=ts_iso(s.get("blockTime")), **row, raw_json=json.dumps(f)))
            n_ev += 1
        time.sleep(0.05)
    if unreached:
        add_gap(db, run_id, "rpc_tx_unfetched", "program_signatures", ts_iso(unreached[-1].get("blockTime")), ts_iso(unreached[0].get("blockTime")),
                len(unreached), "getTransaction failed/aborted (%d failures); not retried later" % fails)
    # cursor always advances to the newest listed signature: everything older is either decoded or recorded as a gap
    db.execute("INSERT OR REPLACE INTO kv VALUES('last_signature',?)", (sigs[0]["signature"],))
    db.commit()
    return n_ev, calls, fails > 0


# ---------- main ----------
def setup_logging(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(os.path.join(data_dir, "collector.log"), maxBytes=2_000_000, backupCount=3)
    h.setFormatter(logging.Formatter("%(asctime)sZ %(levelname)s %(message)s"))
    logging.Formatter.converter = time.gmtime
    log.setLevel(logging.INFO)
    log.addHandler(h)
    log.addHandler(logging.StreamHandler())


def acquire_lock(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    fh = open(os.path.join(data_dir, "collector.lock"), "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def run(data_dir=DATA_DIR, get=api_get, rpc=rpc_call, events=True):
    lock = acquire_lock(data_dir)
    if lock is None:
        log.warning("another run holds the lock; exiting")
        return 0
    db = connect(data_dir)
    now = utcnow()
    run_id = db.execute("INSERT INTO runs(started_utc,status) VALUES(?,?)", (iso(now), "running")).lastrowid
    db.commit()
    status, notes = "ok", {}
    try:
        check_missed_schedule(db, run_id, now)
        failed = snapshot(db, run_id, get)
        notes["endpoint_failures"] = failed
        if failed:
            status = "partial"
        if events:
            n_ev, calls, ev_failed = collect_events(db, run_id, rpc)
            notes.update(events_stored=n_ev, getTransaction_calls=calls)
            if ev_failed:
                status = "partial"
    except Exception as e:
        log.exception("run crashed")
        status, notes["error"] = "error", str(e)[:300]
    db.execute("UPDATE runs SET finished_utc=?, status=?, notes=? WHERE id=?", (iso(utcnow()), status, json.dumps(notes), run_id))
    db.commit()
    db.close()
    lock.close()
    log.info("run %d %s %s", run_id, status, notes)
    return 0 if status != "error" else 1


if __name__ == "__main__":
    setup_logging(DATA_DIR)
    sys.exit(run())
