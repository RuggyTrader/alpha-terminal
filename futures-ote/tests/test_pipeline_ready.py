"""Everything between "key set" and the development-period results, rehearsed offline.

* The fetcher's quote / cap / cache / top-up logic against a fake Databento client (no network, no key, no charge).
* A SYNTHETIC DBN cache (tests/synthetic_dbn.py) through the real reader, roll selection, spread filter and both runners.
* Configuration A is locked; synthetic output is labelled and refused under results/; the holdout stays sealed.
"""
import json
import os
import subprocess
import sys
from types import SimpleNamespace as N

import pandas as pd
import pytest

import fetch_databento as F
from ote_engine import locked
from tests.synthetic_dbn import build_cache, MARKER

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_configuration_a_is_locked():
    ok, detail = locked.check()
    assert ok, detail
    assert locked.digest(locked.CONFIG_A) == locked.CONFIG_A_SHA256


class FakeClient:
    """Stands in for databento.Historical: $0.50 and 1 MB per started month; records every call."""
    def __init__(self, end):
        self.calls, self.end = [], end
        self.metadata = N(get_dataset_range=lambda dataset: {"start": "2010-06-06", "end": self.end + "T00:00:00Z"},
                          get_cost=self._cost, get_billable_size=self._size)
        self.timeseries = N(get_range=self._get)

    @staticmethod
    def _months(start, end):
        a, b = pd.Timestamp(start), pd.Timestamp(end)
        return max(1, (b.year - a.year) * 12 + b.month - a.month + (b.day > 1))

    def _cost(self, **k):
        self.calls.append(("cost", k["start"], k["end"]))
        return 0.5 * self._months(k["start"], k["end"])

    def _size(self, **k):
        return 1_000_000 * self._months(k["start"], k["end"])

    def _get(self, **k):
        self.calls.append(("get", k["start"], k["end"]))
        with open(k["path"], "wb") as f:
            f.write(f"{k['start']}..{k['end']}".encode())


def test_quote_is_free_and_cap_refuses_before_any_request(tmp_path):
    c = FakeClient("2021-03-10")
    q = F.make_plan(c, str(tmp_path), "MNQ")
    assert not [x for x in c.calls if x[0] == "get"]                       # quoting downloads nothing
    assert [p["start"] for p in q["plan"]] == ["2019-05-05", "2020-01-01", "2021-01-01"]
    assert q["plan"][-1]["end"] == "2021-03-10" and q["estimated_total_usd"] == sum(p["cost_usd"] for p in q["plan"])
    assert q["billable_gb"] == round(q["billable_bytes"] / 1e9, 4)
    msgs = []
    assert F.download(c, q, str(tmp_path), "MNQ", max_cost=q["estimated_total_usd"] - 0.01, log=msgs.append) == 3
    assert "REFUSED" in msgs[0] and not [x for x in c.calls if x[0] == "get"] and not os.path.exists(F.out_dir(str(tmp_path), "MNQ"))


def test_download_caches_years_and_tops_up_only_the_missing_tail(tmp_path):
    c = FakeClient("2021-03-10")
    q = F.make_plan(c, str(tmp_path), "MNQ")
    assert F.download(c, q, str(tmp_path), "MNQ", max_cost=100, log=lambda m: None) == 0
    d = F.out_dir(str(tmp_path), "MNQ")
    assert sorted(os.listdir(d)) == ["2019.dbn.zst", "2020.dbn.zst", "2021.dbn.zst", "MANIFEST.json"]
    man = json.load(open(os.path.join(d, "MANIFEST.json")))
    assert all(len(v["sha256"]) == 64 for v in man.values()) and man["2021"]["end"] == "2021-03-10"
    c2 = FakeClient("2021-06-01")                                             # three months later
    q2 = F.make_plan(c2, str(tmp_path), "MNQ")
    assert [p.get("status") for p in q2["plan"][:2]] == ["cached", "cached"]
    tail = q2["plan"][2]
    assert (tail["start"], tail["end"], tail["file"]) == ("2021-03-10", "2021-06-01", "2021.2021-03-10.dbn.zst")   # nothing paid twice
    assert F.download(c2, q2, str(tmp_path), "MNQ", max_cost=100, log=lambda m: None) == 0
    assert [x for x in c2.calls if x[0] == "get"] == [("get", "2021-03-10", "2021-06-01")]
    assert all(p.get("status") == "cached" for p in F.make_plan(FakeClient("2021-06-01"), str(tmp_path), "MNQ")["plan"])
    os.remove(os.path.join(d, "2020.dbn.zst"))                                # a missing file is fetched again
    assert F.make_plan(FakeClient("2021-06-01"), str(tmp_path), "MNQ")["plan"][1]["start"] == "2020-01-01"


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    cache = str(tmp_path_factory.mktemp("synthetic-cache"))
    build_cache(cache, start="2023-11-01", end="2024-12-20")
    return cache


def test_synthetic_cache_reads_like_databento(synth):
    from run_full import load_cache
    from ote_engine.rolls import front_schedule, segments, last_trade_time
    df = load_cache(synth)
    assert set(df["symbol"]) == {"MNQZ3", "MNQH4", "MNQM4", "MNQU4", "MNQZ4"}       # spreads dropped
    assert df["time"].dt.tz is not None and ((df["open"] * 4) % 1 == 0).all()
    segs = segments(front_schedule(df))
    assert [s["symbol"] for s in segs] == ["MNQZ3", "MNQH4", "MNQM4", "MNQU4", "MNQZ4"]
    for a, b in zip(segs, segs[1:]):
        assert a["end"] <= b["start"]
    for s in segs:
        y, m = 2020 + int(s["symbol"][-1]), "FGHJKMNQUVXZ".index(s["symbol"][3]) + 1
        assert s["end"] <= last_trade_time(y, m)


def _py(*args, cwd=HERE):
    return subprocess.run([sys.executable, "-W", "ignore", *args], cwd=cwd, capture_output=True, text=True)


def test_runners_rehearse_end_to_end_label_synthetic_and_parallel_is_identical(synth, tmp_path):
    r = _py("run_full.py", synth, str(tmp_path / "full"))
    assert r.returncode == 0, r.stderr[-2000:]
    s = json.load(open(tmp_path / "full" / "dev" / "SUMMARY.json"))
    assert s["synthetic"] is True and "SYNTHETIC" in s["data"] and len(s["runs"]) == 12
    out = {}
    for j in (1, 2):
        r = _py("run_mffu.py", str(tmp_path / f"m{j}"), "--cache", synth, "--configs", "builder-50k,pro-50k", "--scenarios", "C2_base,C3_conservative", "--jobs", str(j))
        assert r.returncode == 0, r.stderr[-2000:]
        out[j] = json.load(open(tmp_path / f"m{j}" / "dev" / "MFFU-SUMMARY.json"))
    assert list(out[1]["runs"]) == list(out[2]["runs"]) == ["builder-50k__C2_base", "builder-50k__C3_conservative", "pro-50k__C2_base", "pro-50k__C3_conservative"]
    assert json.dumps(out[1]["runs"], sort_keys=True) == json.dumps(out[2]["runs"], sort_keys=True)
    snap = json.load(open(tmp_path / "m1" / "dev" / "mffu-dashboard.json"))
    assert snap["demo"] is True and snap["external_execution"] == "DISABLED" and all(not x["evidence"] for x in snap["results"])
    assert snap["account"]


def test_synthetic_output_is_refused_under_results_and_holdout_stays_sealed(synth, tmp_path):
    for script in (["run_full.py", synth, os.path.join(HERE, "results", "rehearsal-should-not-exist")],
                   ["run_mffu.py", os.path.join(HERE, "results", "rehearsal-should-not-exist"), "--cache", synth, "--configs", "builder-50k", "--scenarios", "C2_base"]):
        r = _py(*script)
        assert r.returncode != 0 and "REFUSED" in (r.stdout + r.stderr)
    assert not os.path.exists(os.path.join(HERE, "results", "rehearsal-should-not-exist"))
    r = _py("run_mffu.py", str(tmp_path / "h"), "--cache", synth, "--holdout")
    assert r.returncode == 4 and "sealed" in r.stdout
    r = _py("run_full.py", synth, str(tmp_path / "h2"), "--holdout")
    assert r.returncode == 4 and "sealed" in r.stdout
    assert os.path.exists(os.path.join(synth, MARKER))
