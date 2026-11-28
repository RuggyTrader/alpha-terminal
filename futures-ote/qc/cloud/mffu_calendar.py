"""CME Globex session calendar for equity-index futures (C1, C2, C3) and a T1 news calendar loader (S7).

* Regular hours (C1/C2): Sunday 6:00 p.m. to Friday 5:00 p.m. ET, daily maintenance 5:00-6:00 p.m. ET.
* Session (trade) date: bars from 18:00 ET belong to the next day's session.
* Holidays: C3 publishes the 2026 holiday dates; hours are finalized about two weeks before each holiday. Only the
  Thanksgiving 2026 equity hours were read. For history, holiday closures are detected from the data (missing minutes),
  never assumed.
* MFFU does not state when its trading day ends. DAY_BOUNDARY uses the CME session end (17:00 ET) and is an ASSUMPTION.
"""
from __future__ import annotations

import csv
import datetime as dt
from typing import Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DAY_BOUNDARY = {"flat_et": "16:10", "status": "DOCUMENTED (S17)", "why": "MFFU Core Rules: trading from 6:00 PM (Globex open) until 4:10 PM; open positions auto-closed at 4:10 PM ET."}
MFFU_FLAT = (16, 10)   # S17, New York wall clock

# C3, 2026 CME Globex holiday windows (dates the holiday schedule covers). Hours: see HOLIDAY_HOURS.
HOLIDAYS_2026 = {
    "New Year's": ("2025-12-31", "2026-01-02"), "Martin Luther King Jr.": ("2026-01-18", "2026-01-20"),
    "Presidents Day": ("2026-02-15", "2026-02-17"), "Good Friday": ("2026-04-02", "2026-04-04"),
    "Memorial Day": ("2026-05-24", "2026-05-26"), "Juneteenth": ("2026-06-18", "2026-06-19"),
    "Independence Day": ("2026-07-03", "2026-07-05"), "Labor Day": ("2026-09-06", "2026-09-08"),
    "Thanksgiving": ("2026-11-26", "2026-11-28"), "Christmas": ("2026-12-24", "2026-12-26"),
    "New Year's 2027": ("2026-12-31", "2027-01-01"),
}
# C3, equities, Thanksgiving 2026 (times converted from CT): Wed 25 Nov closes 17:00 ET; Thu 26 Nov trades from 18:00 ET
# Wed until a 13:00 ET halt (trade date Fri 27 Nov), reopens 18:00 ET Thu; Fri 27 Nov closes early at 13:15 ET.
HOLIDAY_HOURS = {
    "2026-11-26": {"halt_et": "13:00", "reopen_et": "18:00", "src": "C3"},
    "2026-11-27": {"close_et": "13:15", "src": "C3"},
}


def session_day(t: dt.datetime) -> dt.date:
    return (t.astimezone(ET) + dt.timedelta(hours=6)).date()


def mffu_flat_time(t: dt.datetime) -> dt.datetime:
    """4:10 PM ET of the bar's session day (S17)."""
    d = session_day(t)
    return dt.datetime(d.year, d.month, d.day, MFFU_FLAT[0], MFFU_FLAT[1], tzinfo=ET)


def mffu_permitted(t: dt.datetime) -> bool:
    """S17: orders may be live from the 6:00 PM ET Globex open until 4:10 PM ET (and only while CME is open)."""
    return is_open(t) and t.astimezone(ET) < mffu_flat_time(t)


def regular_open(t: dt.datetime) -> bool:
    """True inside regular CME Globex equity hours (holidays not applied)."""
    t = t.astimezone(ET)
    wd, hm = t.weekday(), t.hour * 60 + t.minute
    if wd == 5:
        return False
    if wd == 6:
        return hm >= 18 * 60
    if wd == 4:
        return hm < 17 * 60
    return not (17 * 60 <= hm < 18 * 60)


def documented_closed(t: dt.datetime) -> bool:
    """Only closures that C3 documents with times (Thanksgiving 2026 equities)."""
    t = t.astimezone(ET)
    d, hm = t.date().isoformat(), t.hour * 60 + t.minute
    h = HOLIDAY_HOURS.get(d)
    if not h:
        return False
    if "halt_et" in h:
        a = int(h["halt_et"][:2]) * 60 + int(h["halt_et"][3:])
        b = int(h["reopen_et"][:2]) * 60 + int(h["reopen_et"][3:])
        return a <= hm < b
    if "close_et" in h:
        return hm >= int(h["close_et"][:2]) * 60 + int(h["close_et"][3:])
    return False


def is_open(t: dt.datetime) -> bool:
    return regular_open(t) and not documented_closed(t)


def minutes_to_session_end(t: dt.datetime) -> float:
    """Minutes until 17:00 ET of this bar's session (DAY_BOUNDARY assumption); documented early closes come first."""
    t = t.astimezone(ET)
    sd = session_day(t)
    end = dt.datetime(sd.year, sd.month, sd.day, 17, 0, tzinfo=ET)
    h = HOLIDAY_HOURS.get(sd.isoformat())
    if h and "close_et" in h:
        end = end.replace(hour=int(h["close_et"][:2]), minute=int(h["close_et"][3:]))
    return (end - t).total_seconds() / 60.0


class NewsCalendar:
    """Tier 1 events (S7: FOMC meetings, FOMC minutes, Employment Report, CPI for all traders). No calendar is bundled:
    the owner must supply a CSV with columns time_et (YYYY-MM-DD HH:MM) and event. Without one, restricted stages are
    blocked (status UNAVAILABLE), never assumed news-free."""

    WINDOW = dt.timedelta(minutes=2)   # S7: no positions or orders 2 minutes before and after the release

    def __init__(self, events: Optional[Iterable[Tuple[dt.datetime, str]]] = None, source: str = "",
                 coverage: Optional[Tuple[dt.datetime, dt.datetime]] = None):
        self.events: List[Tuple[dt.datetime, str]] = sorted(events or [])
        self.source = source
        self.available = events is not None
        self.coverage = coverage   # the period the source is complete for; outside it nothing is assumed

    @classmethod
    def official(cls, variant: str = "union") -> "NewsCalendar":
        """Primary-source T1 calendar (t1_calendar.py): Federal Reserve and BLS releases, plus MFFU's 2026 list."""
        import mffu_t1_calendar as T
        return cls(T.events(variant), source=f"t1_calendar.py ({variant}; Federal Reserve + BLS releases, retrieved {T.RETRIEVED})", coverage=T.COVERAGE)

    @classmethod
    def from_csv(cls, path: str, coverage: Optional[Tuple[dt.datetime, dt.datetime]] = None) -> "NewsCalendar":
        ev = []
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                ev.append((dt.datetime.strptime(r["time_et"], "%Y-%m-%d %H:%M").replace(tzinfo=ET), r["event"]))
        if coverage is None:
            raise ValueError("a news CSV needs an explicit coverage period (start, end) for which it is complete")
        return cls(ev, source=path, coverage=coverage)

    def covers(self, a: dt.datetime, b: dt.datetime) -> bool:
        """True only when [a, b] lies inside the period the source is known to be complete for."""
        return self.available and self.coverage is not None and self.coverage[0] <= a and b <= self.coverage[1]

    def in_window(self, a: dt.datetime, b: Optional[dt.datetime] = None) -> Optional[str]:
        """Event name if [a, b] overlaps any event's +/- 2 minute window."""
        b = b or a
        for t, name in self.events:
            if a <= t + self.WINDOW and b >= t - self.WINDOW:
                return name
        return None
