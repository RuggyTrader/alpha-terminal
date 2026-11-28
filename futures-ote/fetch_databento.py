"""Download genuine CME Globex MNQ 1-minute OHLCV (unadjusted, per contract) from Databento, with a cost check first.

  python fetch_databento.py <cache dir> --estimate            # cost estimate only (no data billed)
  python fetch_databento.py <cache dir> --max-cost 5.00       # download; refuses if the estimate exceeds the cap

* Dataset GLBX.MDP3, schema ohlcv-1m, parent symbology MNQ.FUT (every MNQ contract; spreads are dropped later).
* One cached file per calendar year (DBN, zstd). Existing files are never requested again.
* Uses free credits only if your account has NO payment method: Databento cannot charge an account without one.
  The cap is an extra guard on the estimate, not a billing control.
* The API key is read by ote_engine.secret and is never printed, logged or saved.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sys

from ote_engine.secret import get_key, redact

DATASET, SCHEMA, STYPE = "GLBX.MDP3", "ohlcv-1m", "parent"
ROOTS = ("MNQ", "MES")          # Micro E-mini Nasdaq-100 / S&P 500 (both launched 2019-05-06)
START = dt.date(2019, 5, 5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cache")
    ap.add_argument("--estimate", action="store_true")
    ap.add_argument("--max-cost", type=float, default=5.0)
    ap.add_argument("--schema", default=SCHEMA)
    ap.add_argument("--root", default="MNQ", choices=ROOTS)
    a = ap.parse_args()
    SYMBOLS = [f"{a.root}.FUT"]
    key = None
    try:
        import databento as db
        key = get_key()
        client = db.Historical(key=key)
        rng = client.metadata.get_dataset_range(dataset=DATASET)
        end = str(rng["end"] if isinstance(rng, dict) else rng.end)[:10]
        out_dir = os.path.join(a.cache, DATASET, a.schema, SYMBOLS[0])
        os.makedirs(out_dir, exist_ok=True)
        years = list(range(START.year, int(end[:4]) + 1))
        plan, total = [], 0.0
        for y in years:
            s = max(START, dt.date(y, 1, 1)).isoformat()
            e = min(dt.date(y + 1, 1, 1).isoformat(), end)
            path = os.path.join(out_dir, f"{y}.dbn.zst")
            if os.path.exists(path):
                plan.append({"year": y, "status": "cached"})
                continue
            cost = client.metadata.get_cost(dataset=DATASET, start=s, end=e, symbols=SYMBOLS, stype_in=STYPE, schema=a.schema)
            size = client.metadata.get_billable_size(dataset=DATASET, start=s, end=e, symbols=SYMBOLS, stype_in=STYPE, schema=a.schema)
            plan.append({"year": y, "start": s, "end": e, "cost_usd": round(float(cost), 4), "bytes": int(size), "path": path})
            total += float(cost)
        print(json.dumps({"dataset": DATASET, "schema": a.schema, "symbols": SYMBOLS, "available_end": end, "estimated_total_usd": round(total, 4), "plan": plan}, indent=1))
        if a.estimate:
            return
        if total > a.max_cost:
            print(f"REFUSED: estimate ${total:.2f} exceeds --max-cost ${a.max_cost:.2f}; nothing requested")
            sys.exit(3)
        man_path = os.path.join(out_dir, "MANIFEST.json")
        man = json.load(open(man_path)) if os.path.exists(man_path) else {}
        for p in plan:
            if p.get("status") == "cached":
                continue
            tmp = p["path"] + ".part"
            client.timeseries.get_range(dataset=DATASET, start=p["start"], end=p["end"], symbols=SYMBOLS, stype_in=STYPE, schema=a.schema, path=tmp)
            os.replace(tmp, p["path"])
            h = hashlib.sha256(open(p["path"], "rb").read()).hexdigest()
            man[str(p["year"])] = {"start": p["start"], "end": p["end"], "estimated_cost_usd": p["cost_usd"], "sha256": h, "downloaded": dt.datetime.utcnow().isoformat() + "Z"}
            json.dump(man, open(man_path, "w"), indent=1)
            print(f"downloaded {p['year']} -> {os.path.basename(p['path'])} sha256 {h[:16]}")
    except Exception as e:   # never show the key, even inside an exception message
        print("ERROR:", redact(e, key))
        sys.exit(2)


if __name__ == "__main__":
    main()
