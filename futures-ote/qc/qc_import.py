"""Import QuantConnect backtest logs (summary results only) into results/qc/ and the ALPHA TERMINAL dashboard.

  python qc/qc_import.py <downloaded log file> [more log files...] [--publish]

Each log holds one checksummed ATQC1 payload written by qc/cloud/main.py. A payload is accepted only if:
  * its checksum and every log line are intact;
  * it came from exactly the committed qc/cloud bundle (bundle SHA-256), and the cloud verified its own files against it;
  * the cloud engine self-test matched the local engine, and Configuration A is the locked one;
  * it used the frozen boundaries in qc/at_config.py (DATA_END, HOLDOUT_START), placed no orders, and kept external
    execution DISABLED.
Accepted payloads are stored under results/qc/<period>/payloads/. Once every pre-registered run of a period is present
(10 MFFU variants x 4 cost scenarios, and the 4 x 3 cost/sizing grid), MFFU-SUMMARY.json, SUMMARY.json and the dashboard
snapshot are written; --publish also copies the snapshot to frontend/public/research/mffu-dashboard.json.
No market data is imported: payloads contain summary statistics, roll dates and data-coverage dates only.
"""
import argparse
import glob
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
CLOUD = os.path.join(HERE, "cloud")
sys.path[:0] = [HERE, ROOT]

import at_config  # noqa: E402
import at_stream as A  # noqa: E402
from ote_engine import locked  # noqa: E402
from ote_engine.replay import SCEN, SIZING  # noqa: E402
from mffu.experiments import CONFIGS, SCENARIOS  # noqa: E402
from mffu.instruments import COST_SCENARIOS  # noqa: E402
from mffu import dashboard  # noqa: E402

RESULTS = os.path.join(ROOT, "results", "qc")
EXPECTED = {"mffu": [f"{c[0]}__{s}" for c in CONFIGS for s in SCENARIOS],
            "full": [f"{s}__{z}" for s in SCEN for z in SIZING]}


def committed_bundle():
    """(bundle sha, self-test sha) of qc/cloud exactly as it is on disk, recomputed from the files."""
    ns = {}
    with open(os.path.join(CLOUD, "at_build.py"), encoding="utf-8") as f:
        exec(f.read(), ns)   # our own generated constants file
    man = {}
    for name in ns["MANIFEST"]:
        with open(os.path.join(CLOUD, name), encoding="utf-8") as f:
            man[name] = A.file_sha(f.read())
    if man != ns["MANIFEST"] or A.bundle_sha(man) != ns["BUNDLE_SHA256"]:
        raise SystemExit("qc/cloud does not match its own manifest: rebuild with qc/build_bundle.py")
    return ns["BUNDLE_SHA256"], ns["SELFTEST_SHA256"]


def check(p, bundle, selftest, cfg=at_config):
    errs = []
    if p.get("schema") != A.SCHEMA:
        errs.append("wrong schema")
    if p.get("external_execution") != "DISABLED" or p.get("orders_placed") != 0:
        errs.append("orders were placed or external execution was not DISABLED")
    if p.get("bundle_sha256") != bundle:
        errs.append("produced by a different code bundle than the committed qc/cloud")
    if (p.get("sources") or {}).get("status") != "VERIFIED":
        errs.append(f"cloud could not verify its project files ({(p.get('sources') or {}).get('status')})")
    if p.get("selftest_sha256") != selftest:
        errs.append("cloud engine self-test differs from the local engine")
    if p.get("config_a_sha256") != locked.CONFIG_A_SHA256:
        errs.append("not the locked Configuration A")
    if list(p.get("data_start") or []) != list(cfg.DATA_START):
        errs.append("different DATA_START")
    if p.get("mode") != "coverage":
        for k in ("DATA_END", "HOLDOUT_START", "DEV_RESULTS_SHA256"):
            if p.get(k.lower()) != getattr(cfg, k) and not (k == "DEV_RESULTS_SHA256" and p.get("period") == "dev"):
                errs.append(f"{k} differs from qc/at_config.py")
        if p.get("period") not in ("dev", "holdout"):
            errs.append("unknown period")
    return errs


def results_digest(period_dir):
    """SHA-256 of a period's imported results (both summaries, canonical JSON). Frozen into at_config before the holdout."""
    parts = {}
    for n in ("MFFU-SUMMARY.json", "SUMMARY.json"):
        with open(os.path.join(period_dir, n), encoding="utf-8") as f:
            parts[n] = json.load(f)["runs"]
    return hashlib.sha256(A.canonical(parts)).hexdigest()


def dev_is_committed(period_dir):
    for n in ("MFFU-SUMMARY.json", "SUMMARY.json"):
        p = os.path.join(period_dir, n)
        try:
            subprocess.run(["git", "ls-files", "--error-unmatch", p], cwd=REPO, check=True, capture_output=True)
            subprocess.run(["git", "diff", "--quiet", "HEAD", "--", p], cwd=REPO, check=True)
        except Exception:
            return False
    return True


def assemble(period):
    d = os.path.join(RESULTS, period)
    payloads = []
    for f in sorted(glob.glob(os.path.join(d, "payloads", "*.json"))):
        with open(f, encoding="utf-8") as fh:
            payloads.append(json.load(fh))
    runs = {"mffu": {}, "full": {}}
    featured, windows = None, set()
    meta = {"full": None}
    for p in payloads:
        for name, r in p["runs"].items():
            prev = runs[p["mode"]].get(name)
            if prev is not None and A.canonical(prev) != A.canonical(r):
                raise SystemExit(f"{period}: two payloads disagree on {name}")
            runs[p["mode"]][name] = r
        windows.add(tuple(p["window"]))
        if p.get("featured_account"):
            featured = p["featured_account"]
        if p["mode"] == "full":
            meta["full"] = p
    if len(windows) > 1:
        raise SystemExit(f"{period}: payloads cover different windows {sorted(windows)}")
    missing = {m: [n for n in EXPECTED[m] if n not in runs[m]] for m in EXPECTED}
    status = {m: f"{len(EXPECTED[m]) - len(missing[m])}/{len(EXPECTED[m])}" for m in EXPECTED}
    if any(missing.values()):
        return status, missing, None
    w = next(iter(windows))
    data_note = (f"QuantConnect Cloud backtests: US Futures (AlgoSeek) MNQ 1-minute trade bars, individual contracts, raw prices, "
                 f"{w[0]} to {w[1]} ({period})")
    base = {"label": "SIMULATED research results computed in QuantConnect Cloud. Historical simulated results do not guarantee evaluation success.",
            "period": period, "data": data_note, "instrument": at_config.ROOT, "strategy": "OTE + PD Array, Configuration A (locked), 1 contract",
            "holdout_start": at_config.HOLDOUT_START, "data_end": at_config.DATA_END, "bundle_sha256": payloads[0]["bundle_sha256"],
            "payloads": sorted(os.path.basename(x)[:-5] for x in glob.glob(os.path.join(d, "payloads", "*.json")))}
    mffu = dict(base, news_calendar=payloads[0]["news_calendar"], preregistered_configs=[c[0] for c in CONFIGS],
                scenarios={s: COST_SCENARIOS[s].label for s in SCENARIOS}, runs={n: runs["mffu"][n] for n in EXPECTED["mffu"]})
    full = dict(base, scenarios=sorted(SCEN), sizing=SIZING, runs={n: runs["full"][n] for n in EXPECTED["full"]},
                rolls=meta["full"]["coverage"]["front_segments"], validation_front=meta["full"]["validation_front"])
    for n, obj in (("MFFU-SUMMARY.json", mffu), ("SUMMARY.json", full)):
        with open(os.path.join(d, n), "w", encoding="utf-8", newline="\n") as f:
            json.dump(obj, f, indent=1, sort_keys=True, default=str)
            f.write("\n")
    snap = dashboard.snapshot(mffu, featured, data_note, demo=False)
    snap_p = os.path.join(d, "mffu-dashboard.json")
    with open(snap_p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(snap, f, indent=1, default=str)
        f.write("\n")
    return status, missing, snap_p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--publish", action="store_true", help="copy the complete snapshot into the dashboard (frontend/public/research)")
    a = ap.parse_args()
    bundle, selftest = committed_bundle()
    touched, bad = set(), 0
    for path in a.logs:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        try:
            found = A.decode_lines(text)
        except ValueError as e:
            print(f"REJECTED {os.path.basename(path)}: {e}"); bad += 1; continue
        if not found:
            print(f"REJECTED {os.path.basename(path)}: no ATQC1 payload (TOO_LARGE lines mean the jobs must be split)"); bad += 1; continue
        for pid, p in found.items():
            errs = check(p, bundle, selftest)
            if errs:
                print(f"REJECTED {pid} ({os.path.basename(path)}): " + "; ".join(errs)); bad += 1; continue
            if p["mode"] == "coverage":
                out = os.path.join(RESULTS, "coverage", f"{pid}.json")
                print(f"coverage {pid}: data {p['first_bar_et']} to {p['last_bar_et']}; {len(p['coverage']['contracts'])} contracts;"
                      f" {len(p['coverage']['front_segments'])} front segments; proposed {p.get('proposed')}")
            else:
                if p["period"] == "holdout":
                    dev_dir = os.path.join(RESULTS, "dev")
                    if not dev_is_committed(dev_dir) or results_digest(dev_dir) != at_config.DEV_RESULTS_SHA256:
                        print(f"REJECTED {pid}: holdout results need the committed dev results matching DEV_RESULTS_SHA256"); bad += 1; continue
                out = os.path.join(RESULTS, p["period"], "payloads", f"{pid}.json")
                touched.add(p["period"])
                print(f"accepted {pid}: {p['mode']} {p['period']} {sorted(p['runs'])}")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "w", encoding="utf-8", newline="\n") as f:
                json.dump(p, f, indent=1, sort_keys=True, default=str)
                f.write("\n")
    for period in sorted(touched):
        status, missing, snap = assemble(period)
        print(f"{period}: MFFU runs {status['mffu']}, cost/sizing grid {status['full']}")
        if snap is None:
            for m, names in missing.items():
                if names:
                    print(f"  still missing ({m}): {', '.join(names)}")
            continue
        print(f"  complete: wrote results/qc/{period}/MFFU-SUMMARY.json, SUMMARY.json, mffu-dashboard.json")
        if period == "dev":
            print(f"  DEV_RESULTS_SHA256 = \"{results_digest(os.path.join(RESULTS, 'dev'))}\"  (commit results/qc/dev first, then set it in qc/at_config.py)")
        if a.publish:
            dst = os.path.join(REPO, "frontend", "public", "research", "mffu-dashboard.json")
            with open(snap, encoding="utf-8") as fs, open(dst, "w", encoding="utf-8", newline="\n") as fd:
                fd.write(fs.read())
            print(f"  published to frontend/public/research/mffu-dashboard.json")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
