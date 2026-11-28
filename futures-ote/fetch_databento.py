"""Download genuine CME Globex MNQ 1-minute OHLCV (unadjusted, per contract) from Databento, with a cost check first.

  python fetch_databento.py <cache dir> --estimate            # exact cost quote from Databento; nothing is downloaded or billed
  python fetch_databento.py <cache dir> --max-cost 20.00      # download; refuses if the quote exceeds the cap

* Dataset GLBX.MDP3, schema ohlcv-1m, parent symbology MNQ.FUT (every MNQ contract; spreads are dropped later).
* One cached file per calendar year (DBN, zstd), recorded in MANIFEST.json with its range and SHA-256.
  Covered ranges are never requested again. A year downloaded before it ended (the current year) is topped up later
  with only the missing range, in a separate file, so nothing is paid for twice.
* Uses free credits only if your account has NO payment method: Databento cannot charge an account without one.
  The cap is an extra guard on the quote, not a billing control. Databento's API does not report the credit balance:
  check it in the portal (Billing) before raising --max-cost.
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


def out_dir(cache, root, schema=SCHEMA):
    return os.path.join(cache, DATASET, schema, f"{root}.FUT")


def load_manifest(d):
    p = os.path.join(d, "MANIFEST.json")
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def covered_until(man, d, year):
    """End of the contiguous range already on disk for this year (None if nothing). Files missing on disk do not count."""
    ends = [v["end"] for k, v in man.items() if str(k).split(".")[0] == str(year) and os.path.exists(os.path.join(d, v.get("file", f"{k}.dbn.zst")))]
    return max(ends) if ends else None


def available_end(client):
    rng = client.metadata.get_dataset_range(dataset=DATASET)
    return str(rng["end"] if isinstance(rng, dict) else rng.end)[:10]


def make_plan(client, cache, root, schema=SCHEMA, end=None):
    """Ask Databento for the exact cost of every range not yet on disk. Metadata calls are free; nothing is downloaded."""
    end = end or available_end(client)
    d = out_dir(cache, root, schema)
    man = load_manifest(d)
    symbols = [f"{root}.FUT"]
    plan, total, total_bytes = [], 0.0, 0
    for y in range(START.year, int(end[:4]) + 1):
        s = max(START, dt.date(y, 1, 1)).isoformat()
        e = min(dt.date(y + 1, 1, 1).isoformat(), end)
        have = covered_until(man, d, y)
        if have and have >= e:
            plan.append({"year": y, "status": "cached", "end": have})
            continue
        key = str(y) if not have else f"{y}.{have}"
        s = have or s
        cost = float(client.metadata.get_cost(dataset=DATASET, start=s, end=e, symbols=symbols, stype_in=STYPE, schema=schema))
        size = int(client.metadata.get_billable_size(dataset=DATASET, start=s, end=e, symbols=symbols, stype_in=STYPE, schema=schema))
        plan.append({"year": y, "key": key, "start": s, "end": e, "cost_usd": round(cost, 4), "bytes": size, "file": f"{key}.dbn.zst"})
        total += cost
        total_bytes += size
    return {"dataset": DATASET, "schema": schema, "symbols": symbols, "available_end": end, "estimated_total_usd": round(total, 4),
            "billable_bytes": total_bytes, "billable_gb": round(total_bytes / 1e9, 4), "plan": plan}


def download(client, quote, cache, root, schema=SCHEMA, max_cost=5.0, log=print):
    if quote["estimated_total_usd"] > max_cost:
        log(f"REFUSED: quote ${quote['estimated_total_usd']:.2f} exceeds --max-cost ${max_cost:.2f}; nothing requested")
        return 3
    d = out_dir(cache, root, schema)
    os.makedirs(d, exist_ok=True)
    man = load_manifest(d)
    for p in quote["plan"]:
        if p.get("status") == "cached":
            continue
        path = os.path.join(d, p["file"])
        tmp = path + ".part"
        client.timeseries.get_range(dataset=DATASET, start=p["start"], end=p["end"], symbols=quote["symbols"], stype_in=STYPE, schema=schema, path=tmp)
        os.replace(tmp, path)
        with open(path, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()
        man[p["key"]] = {"file": p["file"], "start": p["start"], "end": p["end"], "estimated_cost_usd": p["cost_usd"], "sha256": h,
                         "downloaded": dt.datetime.now(dt.timezone.utc).isoformat()}
        with open(os.path.join(d, "MANIFEST.json"), "w") as f:
            json.dump(man, f, indent=1)
        log(f"downloaded {p['start']}..{p['end']} -> {p['file']} sha256 {h[:16]}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cache")
    ap.add_argument("--estimate", action="store_true")
    ap.add_argument("--max-cost", type=float, default=5.0)
    ap.add_argument("--schema", default=SCHEMA)
    ap.add_argument("--root", default="MNQ", choices=ROOTS)
    a = ap.parse_args()
    key = None
    try:
        import databento as db
        key = get_key()
        client = db.Historical(key=key)
        quote = make_plan(client, a.cache, a.root, a.schema)
        quote["quoted_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        print(json.dumps(quote, indent=1))
        d = out_dir(a.cache, a.root, a.schema)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "LAST-QUOTE.json"), "w") as f:   # the figure the owner approves, kept next to the data
            json.dump(quote, f, indent=1)
        if a.estimate:
            return
        sys.exit(download(client, quote, a.cache, a.root, a.schema, a.max_cost))
    except SystemExit:
        raise
    except Exception as e:   # never show the key, even inside an exception message
        print("ERROR:", redact(e, key))
        sys.exit(2)


if __name__ == "__main__":
    main()
