"""Offline unit tests: python3 -m unittest discover -s collector/jupiter_forward/tests"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import collect  # noqa: E402
import decoder  # noqa: E402

JLP = {"aumUsd": "671247872880211", "jlpPriceUsd": "3652673", "jlpAprPct": "24.22", "jlpApyPct": "27.39", "jlpRealizedFeeUsd": "2392160465038",
       "custodies": [{"symbol": s, "mint": m, "aumUsd": "1000000", "utilizationPct": "9.91", "currentWeightagePct": "47.2", "targetWeightagePct": "47",
                      "owned": "5", "locked": "2", "guaranteedUsd": "24507995616068", "globalShortSizes": "6647160525187", "globalShortAveragePrice": "73166133"}
                     for s, m in collect.MARKETS.items()]}
POOL = {"longAvailableLiquidity": "10000000.00", "longBorrowRatePercent": "0.0015", "longUtilizationPercent": "9.91", "shortAvailableLiquidity": "9.5",
        "shortBorrowRatePercent": "0.0006", "shortUtilizationPercent": "57.77", "openFeePercent": "0.06", "maxRequestExecutionSec": "45", "maxPriceImpactFeePercent": "0.94"}
STATS = {"price": "71.09", "priceChange24H": "3.05", "priceHigh24H": "71.8", "priceLow24H": "65.7", "volume": "122347292.54"}


def fake_get(path, params=None):
    return {"/jlp-info": JLP, "/pool-info": POOL, "/market-stats": STATS}[path]


def no_rpc(*a, **k):
    raise AssertionError("network/RPC must not be used")


def counts(d):
    import sqlite3
    db = sqlite3.connect(os.path.join(d, "jupiter.db"))
    return {t: db.execute("select count(*) from " + t).fetchone()[0] for t in ("runs", "pool_info", "market_stats", "jlp_info", "jlp_custody", "events", "gaps")}


class T(unittest.TestCase):
    def test_parsers_scale_and_units(self):
        p = collect.parse_pool_info(POOL)
        self.assertEqual(p["long_borrow_rate_pct"], 0.0015)
        self.assertEqual(p["short_available_liquidity_usd"], 9.5)
        top, cust = collect.parse_jlp(JLP)
        self.assertAlmostEqual(top["aum_usd"], 671247872.880211)
        self.assertAlmostEqual(cust["SOL"][0]["short_oi_usd"], 6647160.525187)
        self.assertEqual(set(cust), {"SOL", "ETH", "BTC"})

    def test_snapshot_run_stores_rows_no_rpc(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(collect.run(d, fake_get, no_rpc, events=False), 0)
            c = counts(d)
            self.assertEqual((c["pool_info"], c["market_stats"], c["jlp_info"], c["jlp_custody"], c["gaps"]), (3, 3, 1, 3, 0))

    def test_endpoint_failure_recorded_as_gap_not_filled(self):
        def bad(path, params=None):
            if path == "/pool-info" and params["mint"] == collect.MARKETS["ETH"]:
                raise RuntimeError("HTTP 500")
            return fake_get(path, params)
        with tempfile.TemporaryDirectory() as d:
            collect.run(d, bad, no_rpc, events=False)
            c = counts(d)
            self.assertEqual((c["pool_info"], c["gaps"]), (2, 1))

    def test_lock_prevents_overlap(self):
        with tempfile.TemporaryDirectory() as d:
            held = collect.acquire_lock(d)
            self.assertIsNotNone(held)
            self.assertEqual(collect.run(d, fake_get, no_rpc, events=False), 0)
            self.assertFalse(os.path.exists(os.path.join(d, "jupiter.db")))  # skipped entirely
            held.close()

    def test_decoder_real_tx_and_event_cap_gap(self):
        tx = json.load(open(os.path.join(HERE, "fixtures", "tx_decrease.json")))
        ev = [e for e in decoder.decode_events(tx) if e[0] in collect.TRADE_EVENTS]
        row = collect.parse_event(*ev[0])
        self.assertEqual(row["event"], "InstantDecreasePositionEvent")
        self.assertAlmostEqual(row["price"], 71.116736)
        self.assertAlmostEqual(row["fee_usd"], 2.527611)
        # cap: 3 ok sigs, cap of 1 -> 1 decoded call, 2 recorded as unprocessed gap, cursor moves to newest
        sigs = [{"signature": "S%d" % i, "blockTime": 1795665839 - i, "slot": 1, "err": None} for i in range(3)]

        def rpc(m, p):
            return {"result": sigs} if m == "getSignaturesForAddress" else tx
        with tempfile.TemporaryDirectory() as d:
            db = collect.connect(d)
            n, calls, failed = collect.collect_events(db, 1, rpc, max_tx=1)
            self.assertEqual((n, calls, failed), (1, 1, False))
            g = db.execute("select kind,count from gaps").fetchall()
            self.assertEqual(g, [("rpc_unprocessed", 2)])
            self.assertEqual(db.execute("select value from kv").fetchone()[0], "S0")


if __name__ == "__main__":
    unittest.main()
