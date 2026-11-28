"""A minimal stand-in for QuantConnect's AlgorithmImports, ONLY for local tests of qc/cloud/main.py.

It mirrors just the API surface main.py uses (parameters, dates, universe settings, add_future, slices of TradeBars keyed by
contract Symbols, logs, runtime statistics, transactions). It does not emulate LEAN itself; the real platform is
exercised by the coverage backtest described in QUANTCONNECT.md.
"""
import datetime as _dt


class Resolution:
    MINUTE = "Minute"


class SecurityType:
    FUTURE = "Future"
    EQUITY = "Equity"


class DataNormalizationMode:
    RAW = "Raw"


class DataMappingMode:
    OPEN_INTEREST = "OpenInterest"


class Futures:
    class Indices:
        MICRO_NASDAQ_100_E_MINI = "MNQ"


class Slice:
    def __init__(self, bars):
        self.bars = bars


class _Id:
    def __init__(self, date):
        self.date = date


class Symbol:
    def __init__(self, value, expiry=None, security_type=SecurityType.FUTURE):
        self.value, self.security_type, self.id, self._canonical = value, security_type, _Id(expiry), expiry is None

    def is_canonical(self):
        return self._canonical


class TradeBar:
    def __init__(self, o, h, l, c, v, ff=False):
        self.open, self.high, self.low, self.close, self.volume, self.is_fill_forward = o, h, l, c, v, ff


class _Settings:
    fill_forward = True
    extended_market_hours = False
    resolution = Resolution.MINUTE


class _Future:
    def __init__(self, ticker):
        self.symbol, self.filter = Symbol(ticker), None

    def set_filter(self, lo, hi):
        self.filter = (lo, hi)


class _Transactions:
    def __init__(self):
        self.orders = []

    def get_orders(self):
        return iter(self.orders)


class QCAlgorithm:
    def __init__(self):
        self._params, self.logs, self.runtime = {}, [], {}
        self.start = self.end = None
        self.universe_settings = _Settings()
        self.transactions = _Transactions()
        self.futures, self.add_future_kwargs = [], None
        self.utc_time = None

    def get_parameter(self, name, default_value=None):
        return self._params.get(name, default_value)

    def set_start_date(self, y, m, d):
        self.start = _dt.date(y, m, d)

    def set_end_date(self, y, m, d):
        self.end = _dt.date(y, m, d)

    def set_cash(self, x):
        self.cash = x

    def add_future(self, ticker, resolution=None, **kw):
        self.add_future_kwargs = kw
        f = _Future(ticker)
        self.futures.append(f)
        return f

    def log(self, msg):
        self.logs.append(str(msg))

    def set_runtime_statistic(self, k, v):
        self.runtime[k] = str(v)
