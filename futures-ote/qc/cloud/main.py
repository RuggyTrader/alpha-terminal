# region imports
from AlgorithmImports import *
# endregion
"""ALPHA TERMINAL MFFU research backtest (SIMULATED). QuantConnect Cloud, free tier. Places NO orders.

Parameters (Project panel -> Parameters):
  mode    coverage | full | mffu
  period  dev | holdout              (ignored for coverage)
  jobs    full: S0_none,S1_optimistic,S2_base,S3_conservative (comma list)
          mffu: pre-registered config ids, e.g. builder-50k   (see QUANTCONNECT.md for the backtest plan)

The locked OTE strategy (Configuration A) and the MFFU account simulator run on each MNQ contract's own raw minute
bars inside this backtest. Only summary results are logged (compressed, checksummed ATQC1 lines); no market data.
External execution is DISABLED: no brokerage, no orders, no live trading.
"""
import calendar as _calendar

import at_build
import at_config
import at_stream
import ote_locked
from mffu_calendar import NewsCalendar
from mffu_instruments import INSTRUMENTS


class AlphaTerminalMffuResearch(QCAlgorithm):

    def initialize(self):
        self._mode = (self.get_parameter("mode") or "coverage").strip()
        self._period = (self.get_parameter("period") or "dev").strip()
        self._jobs_spec = (self.get_parameter("jobs") or "").strip()
        if self._jobs_spec in ("-", "none"):                                     # the IDE needs a value; coverage takes no jobs
            self._jobs_spec = ""
        self._plan = at_stream.plan(self._mode, self._period, at_config)       # raises if unsealed or not pre-registered

        self._sources = at_stream.verify_sources(at_build.MANIFEST)
        if self._sources["status"] == "MISMATCH":
            raise Exception("Project files differ from the committed bundle: " + ", ".join(self._sources["mismatched"]))
        ok, detail = ote_locked.check()
        if not ok:
            raise Exception("Configuration A is not locked: " + detail)
        self._selftest = at_stream.selftest()
        if self._selftest != at_build.SELFTEST_SHA256:
            raise Exception("Engine self-test differs from the local engine (environment mismatch); results would not be comparable")

        self.set_start_date(*self._plan["start"])
        if self._plan["end"]:
            self.set_end_date(*self._plan["end"])
        self.set_cash(100000)                                                   # unused: nothing is ever traded
        self.universe_settings.fill_forward = False                             # genuine bars only
        self.universe_settings.extended_market_hours = True                     # full Globex session
        self.universe_settings.resolution = Resolution.MINUTE
        fut = self.add_future(Futures.Indices.MICRO_NASDAQ_100_E_MINI, Resolution.MINUTE, fill_forward=False, extended_market_hours=True,
                              data_normalization_mode=DataNormalizationMode.RAW, data_mapping_mode=DataMappingMode.OPEN_INTEREST,
                              contract_depth_offset=0)
        fut.set_filter(0, 200)                                                  # front and next contracts (individual, unadjusted)

        self._news = NewsCalendar.official(at_config.NEWS_VARIANT)
        jobs = [] if self._mode == "coverage" else at_stream.make_jobs(self._mode, self._jobs_spec, INSTRUMENTS[at_config.ROOT], self._news)
        self._stream = at_stream.Stream(at_config.ROOT, self._plan["lo"], self._plan["hi"], jobs)
        self._ff = 0

    def on_data(self, data: Slice):
        t_ns = (_calendar.timegm(self.utc_time.timetuple()) - 60) * 1_000_000_000   # minute bar start (UTC)
        for symbol, bar in data.bars.items():
            if symbol.security_type != SecurityType.FUTURE or symbol.is_canonical():
                continue                                                        # individual contracts only
            if bar.is_fill_forward:
                self._ff += 1
                continue
            e = symbol.id.date                                                  # contract expiry (3rd Friday of the contract month)
            self._stream.add(at_stream.contract_name(at_config.ROOT, e.year, e.month), t_ns, float(bar.open), float(bar.high),
                             float(bar.low), float(bar.close), float(bar.volume))

    def on_end_of_algorithm(self):
        result = self._stream.finish(self._plan["hold_start"]) if self._stream.jobs else {"runs": {}, "featured_account": None}
        orders = len(list(self.transactions.get_orders()))
        payload = at_stream.build_payload(mode=self._mode, period=self._period, jobs_spec=self._jobs_spec, p=self._plan, stream=self._stream,
                                          result=result, bundle=at_build.BUNDLE_SHA256, sources=self._sources, selftest_sha=self._selftest,
                                          config_a_sha=ote_locked.CONFIG_A_SHA256, news_source=self._news.source, ff_skipped=self._ff,
                                          orders=orders, cfg=at_config)
        lines = at_stream.encode(payload)
        pid = lines[0].split()[1]
        self.set_runtime_statistic("ATQC payload", pid)
        if orders:
            self.set_runtime_statistic("ATQC status", "INVALID: orders were placed")
        if not at_stream.fits(lines):
            self.set_runtime_statistic("ATQC status", "TOO LARGE: split the jobs")
            self.log(f"{at_stream.PREFIX} {pid} TOO_LARGE chars={sum(len(x) + 1 for x in lines)} jobs={self._jobs_spec}")
            return
        for line in lines:
            self.log(line)
        self.set_runtime_statistic("ATQC status", "OK" if not orders else "INVALID")
