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
DAY_BOUNDARY = {"time_et": "17:00", "status": "ASSUMPTION", "why": "MFFU states no day-end time; the CME equity session ends at 17:00 ET (C1/C2)."}

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

    def __init__(self, events: Optional[Iterable[Tuple[dt.datetime, str]]] = None, source: str = ""):
        self.events: List[Tuple[dt.datetime, str]] = sorted(events or [])
        self.source = source
        self.available = events is not None

    @classmethod
    def from_csv(cls, path: str) -> "NewsCalendar":
        ev = []
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                ev.append((dt.datetime.strptime(r["time_et"], "%Y-%m-%d %H:%M").replace(tzinfo=ET), r["event"]))
        return cls(ev, source=path)

    def covers(self, a: dt.datetime, b: dt.datetime) -> bool:
        """True when the calendar's own span includes [a, b]."""
        return self.available and bool(self.events) and self.events[0][0] - dt.timedelta(days=45) <= a and b <= self.events[-1][0] + dt.timedelta(days=45)

    def in_window(self, a: dt.datetime, b: Optional[dt.datetime] = None) -> Optional[str]:
        """Event name if [a, b] overlaps any event's +/- 2 minute window."""
        b = b or a
        for t, name in self.events:
            if a <= t + self.WINDOW and b >= t - self.WINDOW:
                return name
        return None


def load_dates(path: str) -> Dict[str, str]:
    with open(path) as f:
        return {r["date"]: r.get("note", "") for r in csv.DictReader(f)}
