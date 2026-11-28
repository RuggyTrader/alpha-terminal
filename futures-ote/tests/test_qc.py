"""QuantConnect adapter: identical results to the local reference, free-tier limits, holdout seal, integrity, import.

All data here is SYNTHETIC (tests/synthetic_bars.py). The real platform is exercised by the coverage backtest.
"""
import json
import os
import shutil
import subprocess
import sys
from types import SimpleNamespace as N

import pandas as pd
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QC = os.path.join(HERE, "qc")
CLOUD = os.path.join(QC, "cloud")
sys.path.insert(0, QC)

import at_stream as A  # noqa: E402
import at_config  # noqa: E402
import qc_import as I  # noqa: E402
from ote_engine import locked, replay  # noqa: E402
from ote_engine.rolls import front_schedule, segments  # noqa: E402
from ote_engine.strategy import Settings  # noqa: E402
from mffu.experiments import config, run_one  # noqa: E402
from mffu.instruments import MNQ  # noqa: E402
from mffu.calendar import NewsCalendar  # noqa: E402
from tests.synthetic_bars import bars as synthetic_bars  # noqa: E402

NEWS = NewsCalendar.official("union")


@pytest.fixture(scope="module")
def data():
    df = synthetic_bars()
    end = df["time"].max()
    hold = A.holdout_start_for(end)
    return N(df=df, end=end, hold=hold, segs=segments(front_schedule(df)),
             cfg={"DATA_START": [2023, 11, 1], "DATA_END": end.strftime("%Y-%m-%d %H:%M"), "HOLDOUT_START": hold.strftime("%Y-%m-%d")})


def _stream(d, lo, hi, mode, spec):
    s = A.Stream("MNQ", lo, hi, A.make_jobs(mode, spec, MNQ, NEWS))
    df = d.df
    for sym, t, o, h, l, c, v in zip(df.symbol, df.time, df.open, df.high, df.low, df.close, df.volume):
        s.add(sym, t.value, o, h, l, c, v)
    return s, s.finish(d.hold)


def _ref_full(d, lo, hi, sc, sz):
    res, times = replay.run_period(d.df, d.segs, lo, hi, Settings(), replay.full_execution(sc, sz))
    return replay.summarize(res, times, len(replay.ambiguous(res["trades"], replay.df_bar_at(d.df))))


def _ref_mffu(d, lo, hi, cid, sc):
    ov, rep = run_one(config(cid), sc, MNQ, lambda ex, ov: replay.run_period(d.df, d.segs, lo, hi, Settings(), ex, overlay=ov)[1][-1], NEWS, d.hold)
    return {k: v for k, v in rep.items() if k != "attempts"}


def test_configuration_a_is_locked():
    ok, detail = locked.check()
    assert ok, detail


def test_bundle_is_current_fits_free_tier_and_self_test_matches_local_engine():
    r = subprocess.run([sys.executable, "-B", os.path.join(QC, "build_bundle.py"), "--check"], capture_output=True, text=True, cwd=HERE)
    assert r.returncode == 0, r.stdout + r.stderr
    files = [f for f in os.listdir(CLOUD) if os.path.isfile(os.path.join(CLOUD, f))]
    assert len(files) + 1 <= 25                                         # + the project's research.ipynb
    assert all(os.path.getsize(os.path.join(CLOUD, f)) <= 32_000 for f in files)
    bundle, selftest = I.committed_bundle()
    assert selftest == A.selftest()                                    # cloud fingerprint == this engine, from package sources


def test_plan_refuses_unregistered_or_unsealed_runs(data):
    base = N(DATA_START=(2023, 11, 1), DATA_END=None, HOLDOUT_START=None, DEV_RESULTS_SHA256=None)
    assert A.plan("coverage", "dev", base)["end"] is None
    with pytest.raises(ValueError, match="not frozen"):
        A.plan("mffu", "dev", base)
    frozen = N(**{**vars(base), "DATA_END": data.cfg["DATA_END"], "HOLDOUT_START": data.cfg["HOLDOUT_START"]})
    p = A.plan("mffu", "dev", frozen)
    assert p["hi"] == data.hold and pd.Timestamp(*p["end"]).date() < data.hold.date()
    with pytest.raises(ValueError, match="sealed"):
        A.plan("mffu", "holdout", frozen)
    with pytest.raises(ValueError, match="pre-registered"):
        A.plan("mffu", "dev", N(**{**vars(frozen), "HOLDOUT_START": "2024-01-01"}))
    h = A.plan("full", "holdout", N(**{**vars(frozen), "DEV_RESULTS_SHA256": "ab" * 32}))
    assert h["lo"] == data.hold and h["hi"] == data.end + pd.Timedelta(minutes=1)
    for bad in [("full", "S9_x"), ("mffu", "builder-1m"), ("mffu", "builder-50k:C9"), ("mffu", "")]:
        with pytest.raises(ValueError):
            A.make_jobs(bad[0], bad[1], MNQ, NEWS)


def test_codec_round_trip_detects_truncation_and_tampering():
    p = {"schema": A.SCHEMA, "x": list(range(3000)), "s": "é"}
    lines = A.encode(p)
    assert len(lines) > 2 and all(len(x) < 8192 for x in lines)
    log = "\n".join(f"2026-11-28 10:00:{i:02d} {x}" for i, x in enumerate(lines))   # QuantConnect prefixes timestamps
    assert list(A.decode_lines(log).values()) == [json.loads(A.canonical(p))]
    with pytest.raises(ValueError, match="missing"):
        A.decode_lines("\n".join(lines[:1] + lines[2:]))
    with pytest.raises(ValueError, match="no END"):
        A.decode_lines("\n".join(lines[:-1]))
    pid = lines[0].split()[1]
    forged = lines[:-1] + [f"{A.PREFIX} {pid} END sha256={'0' * 64} bytes=1"]
    with pytest.raises(ValueError, match="checksum"):
        A.decode_lines("\n".join(forged))
    assert not A.fits(A.encode({"big": os.urandom(9000).hex()}))


def test_streamed_results_equal_the_local_reference(data):
    lo, hi = data.df["time"].min(), data.hold
    _, r = _stream(data, None, hi, "full", "S2_base")
    for sz in replay.SIZING:
        assert A.canonical(r["runs"][f"S2_base__{sz}"]) == A.canonical(_ref_full(data, lo, hi, "S2_base", sz))
    _, r = _stream(data, None, hi, "mffu", "builder-50k:C2_base,pro-50k-one-day:C4_stress")
    assert A.canonical(r["runs"]["builder-50k__C2_base"]) == A.canonical(_ref_mffu(data, lo, hi, "builder-50k", "C2_base"))
    assert A.canonical(r["runs"]["pro-50k-one-day__C4_stress"]) == A.canonical(_ref_mffu(data, lo, hi, "pro-50k-one-day", "C4_stress"))
    assert r["featured_account"]["stage"] == "evaluation"
    hlo, hhi = data.hold, data.end + pd.Timedelta(minutes=1)
    s, r = _stream(data, hlo, hhi, "mffu", "rapid-eod-50k:C3_conservative")
    assert A.canonical(r["runs"]["rapid-eod-50k__C3_conservative"]) == A.canonical(_ref_mffu(data, hlo, hhi, "rapid-eod-50k", "C3_conservative"))
    cov = s.coverage_summary()
    assert [x["symbol"] for x in cov["front_segments"]] == [x["symbol"] for x in data.segs]
    assert all("open" not in str(v) and "close" not in str(v) for v in cov["contracts"].values())   # dates and counts only


def _drive(tmp, data, params, cloud=CLOUD, cfg=None):
    bars = os.path.join(tmp, "bars.pkl")
    if not os.path.exists(bars):
        data.df.to_pickle(bars)
    pp, op, out = (os.path.join(tmp, f"{n}.json") for n in ("params", "over", "out"))
    json.dump(params, open(pp, "w")); json.dump(cfg if cfg is not None else data.cfg, open(op, "w"))
    r = subprocess.run([sys.executable, "-I", "-B", "-W", "ignore", os.path.join(HERE, "tests", "fake_lean", "drive.py"), cloud, pp, op, bars, out],
                       capture_output=True, text=True)
    return r, (json.load(open(out)) if r.returncode == 0 else None)


def test_cloud_main_matches_reference_skips_non_genuine_bars_and_is_importable(data, tmp_path):
    r, o = _drive(str(tmp_path), data, {"mode": "mffu", "period": "dev", "jobs": "builder-50k"})
    assert r.returncode == 0, r.stderr[-3000:]
    assert o["universe"] == {"fill_forward": False, "extended": True} and o["filter"] == [0, 200]
    assert o["add_future"]["data_normalization_mode"] == "Raw" and o["add_future"]["fill_forward"] == "False"
    assert o["ff"] > 0 and o["runtime"]["ATQC status"] == "OK" and A.fits(o["logs"])
    (p,) = A.decode_lines("\n".join(o["logs"])).values()
    assert p["sources"]["status"] == "VERIFIED" and p["orders_placed"] == 0 and p["external_execution"] == "DISABLED"
    lo = data.df["time"].min()
    for sc in ("C2_base", "C3_conservative", "C4_stress", "C1_optimistic"):
        assert A.canonical(p["runs"][f"builder-50k__{sc}"]) == A.canonical(_ref_mffu(data, lo, data.hold, "builder-50k", sc))
    cfg = N(DATA_START=(2023, 11, 1), DATA_END=data.cfg["DATA_END"], HOLDOUT_START=data.cfg["HOLDOUT_START"], DEV_RESULTS_SHA256=None)
    bundle, selftest = I.committed_bundle()
    assert I.check(p, bundle, selftest, cfg) == []
    for k, v in [("orders_placed", 1), ("bundle_sha256", "0" * 64), ("sources", {"status": "UNVERIFIABLE"}), ("config_a_sha256", "x"),
                 ("holdout_start", "2024-01-01"), ("external_execution", "ENABLED")]:
        assert I.check({**p, k: v}, bundle, selftest, cfg), k


def test_cloud_run_stops_on_a_pasted_file_that_differs_and_keeps_the_holdout_sealed(data, tmp_path):
    bad = os.path.join(str(tmp_path), "cloud")
    shutil.copytree(CLOUD, bad)
    with open(os.path.join(bad, "mffu_rules.py"), "a", encoding="utf-8") as f:
        f.write("X = 1\n")
    r, _ = _drive(str(tmp_path), data, {"mode": "coverage"}, cloud=bad)
    assert r.returncode != 0 and "mffu_rules.py" in r.stderr
    r, _ = _drive(str(tmp_path), data, {"mode": "mffu", "period": "holdout", "jobs": "builder-50k"})
    assert r.returncode != 0 and "sealed" in r.stderr


def test_import_assembles_only_complete_periods_and_refuses_conflicts(data, tmp_path, monkeypatch):
    monkeypatch.setattr(I, "RESULTS", str(tmp_path))
    _, r = _stream(data, None, data.hold, "mffu", "builder-50k:C2_base")
    one = r["runs"]["builder-50k__C2_base"]
    _, rf = _stream(data, None, data.hold, "full", "S2_base")
    s_full, _ = _stream(data, None, data.hold, "full", "S0_none")
    d = os.path.join(str(tmp_path), "dev", "payloads")
    os.makedirs(d)
    common = {"bundle_sha256": "b" * 64, "news_calendar": NEWS.source, "window": ["a", "b"]}

    def put(pid, mode, runs, **kw):
        json.dump({**common, "mode": mode, "runs": runs, **kw}, open(os.path.join(d, pid + ".json"), "w"))
    put("m1", "mffu", {n: one for n in I.EXPECTED["mffu"][:20]}, featured_account=r["featured_account"])
    status, missing, snap = I.assemble("dev")
    assert snap is None and status["mffu"] == "20/40" and len(missing["full"]) == 12
    put("m2", "mffu", {n: one for n in I.EXPECTED["mffu"][20:]})
    put("f1", "full", {n: rf["runs"]["S2_base__fixed1"] for n in I.EXPECTED["full"]},
        coverage=s_full.coverage_summary(), validation_front=s_full.validation)
    status, missing, snap = I.assemble("dev")
    assert snap and status == {"mffu": "40/40", "full": "12/12"}
    s = json.load(open(snap))
    assert s["simulated"] is True and s["external_execution"] == "DISABLED" and not s["demo"] and len(s["results"]) == 40
    assert all(x["evidence"] for x in s["results"]) and "QuantConnect" in s["data"]
    assert len(I.results_digest(os.path.join(str(tmp_path), "dev"))) == 64
    put("m3", "mffu", {I.EXPECTED["mffu"][0]: {**one, "plan": "changed"}})
    with pytest.raises(SystemExit, match="disagree"):
        I.assemble("dev")
