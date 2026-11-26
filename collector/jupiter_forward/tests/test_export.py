"""Offline tests for the NDJSON exporter."""
import glob
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import ndjson_export as ex  # noqa: E402
from test_collect import fake_get, no_rpc  # noqa: E402


def lines(d, table):
    out = []
    for p in sorted(glob.glob(os.path.join(d, table + "_*.ndjson"))):
        out += [json.loads(l) for l in open(p)]
    return out


class T(unittest.TestCase):
    def test_two_runs_append_dated_files_and_state(self):
        with tempfile.TemporaryDirectory() as root:
            data = os.path.join(root, "data")
            for _ in range(2):
                st = os.path.join(root, "stg")
                os.makedirs(data, exist_ok=True)
                rc, n = ex.run_once(os.path.join(data, "state.json"), st, fake_get, no_rpc, events=False)
                self.assertEqual(rc, 0)
                ex.append_staged(st, data)
                import shutil
                shutil.rmtree(st)
            runs = lines(data, "runs")
            self.assertEqual([r["id"] for r in runs], [1, 2])  # global run ids, seed row not exported
            self.assertEqual(len(lines(data, "pool_info")), 6)
            self.assertEqual(len(lines(data, "jlp_custody")), 6)
            self.assertTrue(all("id" not in r for r in lines(data, "pool_info")))
            self.assertRegex(os.path.basename(glob.glob(os.path.join(data, "runs_*.ndjson"))[0]), r"runs_\d{4}-\d\d-\d\d\.ndjson")
            self.assertEqual(json.load(open(os.path.join(data, "state.json")))["last_run_id"], 2)

    def test_failures_exported_as_rows(self):
        def bad(path, params=None):
            raise RuntimeError("HTTP 500")
        with tempfile.TemporaryDirectory() as root:
            st = os.path.join(root, "stg")
            ex.run_once(os.path.join(root, "state.json"), st, bad, no_rpc, events=False)
            self.assertEqual(len(lines(st, "gaps")), 7)
            self.assertEqual(lines(st, "runs")[0]["status"], "partial")

    def test_missed_schedule_gap_after_long_pause(self):
        with tempfile.TemporaryDirectory() as root:
            sp = os.path.join(root, "state.json")
            json.dump({"last_run_id": 5, "last_ok_started_utc": "2020-01-01T00:00:00Z", "last_signature": "abc"}, open(sp, "w"))
            st = os.path.join(root, "stg")
            ex.run_once(sp, st, fake_get, no_rpc, events=False)
            self.assertEqual([g["kind"] for g in lines(st, "gaps")], ["missed_schedule"])
            self.assertEqual(lines(st, "runs")[0]["id"], 6)

    def test_wrapper_crash_recorded(self):
        with tempfile.TemporaryDirectory() as root:
            st = os.path.join(root, "stg")
            orig = ex.collect.run
            ex.collect.run = lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt("boom"))
            try:
                ex.run_once(os.path.join(root, "state.json"), st, fake_get, no_rpc, events=False)
            finally:
                ex.collect.run = orig
            self.assertEqual(lines(st, "runs")[0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
