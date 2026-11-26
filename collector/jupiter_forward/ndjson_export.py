#!/usr/bin/env python3
"""Run one collector pass on an ephemeral SQLite DB and export it as dated NDJSON (CI use).

No change to collect.py. State that must survive between ephemeral runs (event cursor, last
successful run time, run-id counter) lives in state.json next to the data files.

  ndjson_export.py run --state DIR/state.json --staging DIR   # collect + export this run to staging
  ndjson_export.py append --staging DIR --out DIR             # append staged files to the data dir

Files: <out>/<table>_<YYYY-MM-DD>.ndjson (UTC day of each row's own timestamp), plus <out>/state.json.
Failures (crash, error status) are exported as `runs` rows with status 'error'; never silently dropped.
"""
import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect  # noqa: E402

TABLES = ("runs", "pool_info", "market_stats", "jlp_info", "jlp_custody", "events", "gaps")
TS_COL = {"runs": "started_utc", "gaps": "recorded_utc"}  # default: fetched_utc


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def seed(db, state):
    """Restore cursor + previous-run marker so collect.py's own cursor and missed-schedule logic work unchanged."""
    if state.get("last_signature"):
        db.execute("INSERT OR REPLACE INTO kv VALUES('last_signature',?)", (state["last_signature"],))
    if state.get("last_run_id"):
        # synthetic predecessor row (excluded from export: only run_id > last_run_id is exported)
        db.execute("INSERT INTO runs(id,started_utc,finished_utc,status,notes) VALUES(?,?,?,?,?)",
                   (state["last_run_id"], state.get("last_ok_started_utc") or "1970-01-01T00:00:00Z",
                    None, "ok" if state.get("last_ok_started_utc") else "seed", "seed"))
    db.commit()


def write_lines(staging, table, rows):
    for r in rows:
        ts = r.get(TS_COL.get(table, "fetched_utc")) or r.get("fetched_utc") or collect.iso(collect.utcnow())
        path = os.path.join(staging, "%s_%s.ndjson" % (table, ts[:10]))
        with open(path, "a") as f:
            f.write(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n")


def export_run(db, first_run_id, staging):
    db.row_factory = sqlite3.Row
    n = 0
    for t in TABLES:
        col = "id" if t == "runs" else "run_id"
        rows = [dict(r) for r in db.execute("SELECT * FROM %s WHERE %s>=? ORDER BY id" % (t, col), (first_run_id,))]
        for r in rows:
            r.pop("id", None) if t != "runs" else None  # local ids are per-DB; runs.id is globally unique via state
        write_lines(staging, t, rows)
        n += len(rows)
    return n


def run_once(state_path, staging, get=collect.api_get, rpc=collect.rpc_call, events=True):
    state = load_state(state_path)
    os.makedirs(staging, exist_ok=True)
    work = tempfile.mkdtemp(prefix="jupiter_work_")
    first = (state.get("last_run_id") or 0) + 1
    rc = 1
    try:
        db = collect.connect(work)
        seed(db, state)
        db.close()
        collect.setup_logging(work)
        rc = collect.run(work, get, rpc, events)
    except BaseException as e:  # record, never skip
        db = collect.connect(work)
        db.execute("INSERT INTO runs(started_utc,finished_utc,status,notes) VALUES(?,?,?,?)",
                   (collect.iso(collect.utcnow()), collect.iso(collect.utcnow()), "error", json.dumps({"error": "wrapper: %r" % e})[:400]))
        db.commit()
        db.close()
    db = sqlite3.connect(os.path.join(work, "jupiter.db"))
    new = dict(state)
    row = db.execute("SELECT id,started_utc,status FROM runs WHERE id>=? ORDER BY id DESC LIMIT 1", (first,)).fetchone()
    if row:
        new["last_run_id"] = row[0]
        if row[2] in ("ok", "partial"):
            new["last_ok_started_utc"] = row[1]
    k = db.execute("SELECT value FROM kv WHERE key='last_signature'").fetchone()
    if k:
        new["last_signature"] = k[0]
    n = export_run(db, first, staging)
    db.close()
    with open(os.path.join(staging, "state.json"), "w") as f:
        json.dump(new, f, sort_keys=True, indent=1)
    shutil.rmtree(work, ignore_errors=True)
    return rc, n


def append_staged(staging, out):
    os.makedirs(out, exist_ok=True)
    for name in sorted(os.listdir(staging)):
        src, dst = os.path.join(staging, name), os.path.join(out, name)
        if name == "state.json":
            shutil.copyfile(src, dst)
        elif name.endswith(".ndjson"):
            with open(src) as s, open(dst, "a") as d:
                d.write(s.read())


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--state", required=True)
    r.add_argument("--staging", required=True)
    a = sub.add_parser("append")
    a.add_argument("--staging", required=True)
    a.add_argument("--out", required=True)
    ns = ap.parse_args(argv)
    if ns.cmd == "run":
        rc, n = run_once(ns.state, ns.staging)
        print("run rc=%s rows_exported=%d" % (rc, n))
        return 0  # the failure is recorded as data; the workflow step should not abort before pushing it
    append_staged(ns.staging, ns.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
