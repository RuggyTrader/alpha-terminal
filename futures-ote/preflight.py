"""Readiness check for the historical backtest. Makes NO network call, downloads nothing, and never shows the API key.

  python preflight.py [<cache dir>]

Prints one line per check (READY / WAITING / PROBLEM) and the exact next command. Exit code 0 when everything up to the
cost quote is ready, 1 while only the Databento key is missing, 2 on any other problem.
"""
import datetime as dt
import importlib
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CACHE = os.path.join(os.path.expanduser("~"), "AlphaTerminal", "research", "futures-ote", "data", "databento")


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CACHE
    rows, waiting, problem = [], False, False

    def add(state, name, detail):
        nonlocal waiting, problem
        rows.append((state, name, detail))
        waiting |= state == "WAITING"
        problem |= state == "PROBLEM"

    vers = []
    for m in ("databento", "databento_dbn", "pandas", "numpy", "zstandard"):
        try:
            mod = importlib.import_module(m)
            vers.append(f"{m} {getattr(mod, '__version__', 'ok')}")
        except ImportError:
            add("PROBLEM", "python packages", f"{m} is not installed in this environment")
    if len(vers) == 5:
        add("READY", "python packages", f"Python {sys.version.split()[0]}; " + ", ".join(vers))

    from ote_engine import locked
    ok, detail = locked.check()
    add("READY" if ok else "PROBLEM", "strategy (Configuration A)", detail)

    try:
        br = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=HERE, capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "ote_engine", "mffu", "run_full.py", "run_mffu.py", "fetch_databento.py"],
                               cwd=HERE, capture_output=True, text=True, check=True).stdout.strip()
        if br != "research/futures":
            add("PROBLEM", "git branch", f"on {br}; the backtest is run and committed on research/futures only")
        elif dirty:
            add("PROBLEM", "git branch", "engine or runner files have uncommitted changes; commit or discard them first")
        else:
            add("READY", "git branch", "research/futures, engine and runners committed")
    except Exception as e:
        add("PROBLEM", "git branch", f"not a git checkout ({e.__class__.__name__}); the holdout seal needs git")

    from ote_engine.secret import ENV, get_key
    try:
        get_key()
        where = "process environment" if os.environ.get(ENV) else "Windows user environment (registry)"
        add("READY", "Databento key", f"{ENV} is set in the {where} and has the expected format (value not shown)")
    except RuntimeError as e:
        add("WAITING", "Databento key", str(e))

    try:
        os.makedirs(cache, exist_ok=True)
        probe = os.path.join(cache, ".write-test")
        with open(probe, "w") as f:
            f.write("x")
        os.remove(probe)
        free = shutil.disk_usage(cache).free / 1e9
        add("READY" if free > 5 else "PROBLEM", "cache folder", f"{cache} is writable; {free:.0f} GB free (worst case needs about 2.3 GB per root)")
    except OSError as e:
        add("PROBLEM", "cache folder", f"{cache} is not writable ({e.__class__.__name__})")
    if os.path.exists(os.path.join(cache, "SYNTHETIC-NOT-MARKET-DATA.txt")):
        add("PROBLEM", "cache folder", "this folder holds the synthetic rehearsal fixture; use a separate folder for real data")
    from fetch_databento import load_manifest, out_dir
    for root in ("MNQ", "MES"):
        man = load_manifest(out_dir(cache, root))
        if man:
            add("READY", f"{root} cache", f"{len(man)} range(s) on disk, up to {max(v['end'] for v in man.values())}")
        elif root == "MNQ":
            add("WAITING", "MNQ cache", "no data yet (the download follows the approved quote)")
        qp = os.path.join(out_dir(cache, root), "LAST-QUOTE.json")
        if os.path.exists(qp):
            import json
            with open(qp) as f:
                q = json.load(f)
            add("READY", f"{root} quote", f"${q['estimated_total_usd']:.2f} for {q['billable_gb']} GB to {q['available_end']} (quoted {q.get('quoted_at', '?')[:16]} UTC)")

    from mffu.t1_calendar import COVERAGE
    end = dt.date.fromisoformat(str(COVERAGE[1])[:10])
    lag = (dt.date.today() - end).days
    add("READY" if lag <= 7 else "WAITING", "T1 news calendar", f"covers to {end}; restricted stages are blocked after that date"
        + ("" if lag <= 7 else f" ({lag} days ago: extend mffu/t1_calendar.py before the holdout)"))

    for name, p in (("run_full", "results/full/dev/SUMMARY.json"), ("run_mffu", "results/mffu/dev/MFFU-SUMMARY.json")):
        add("READY", f"holdout seal ({name})", "sealed: no development summary committed yet" if not os.path.exists(os.path.join(HERE, p))
            else f"{p} exists; the holdout opens only once it is committed unchanged")

    w = max(len(r[1]) for r in rows)
    for state, name, detail in rows:
        print(f"{state:8} {name:<{w}}  {detail}")
    py = sys.executable
    print()
    if problem:
        print("NEXT: fix the PROBLEM lines above.")
        sys.exit(2)
    if waiting and any(r[1] == "Databento key" and r[0] == "WAITING" for r in rows):
        print("NEXT: store the key (DATABENTO-SETUP.md step 3), then run this check again.")
        sys.exit(1)
    print("NEXT (free, downloads nothing): exact quote from Databento")
    print(f'  & "{py}" fetch_databento.py "{cache}" --estimate')
    sys.exit(0)


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    main()
