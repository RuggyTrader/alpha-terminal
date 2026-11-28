"""Historical Tier 1 (T1) news calendar for MFFU compliance simulation, built only from primary sources.

MFFU (S7, News Trading Policy, 2026-08-31; and its "2026 T1 News Calendar" image on the same page) defines T1 for all
traders as: FOMC meetings (the policy statement), FOMC minutes, the Employment Report and CPI. Restricted window: no
positions or orders from 2 minutes before to 2 minutes after the release (S7 example: 8:30 news -> flat by 8:28:00,
reopen after 8:32:00). Restricted accounts: Rapid sim funded and Pro sim funded (S7); Rapid EOD sim funded (S13).
Permitted: all evaluations and Builder plans (S7). Live accounts: not addressed (unresolved).

Release times (every row was read from the release itself on 2026-11-27):
  * FOMC statements: federalreserve.gov press release "Federal Reserve issues FOMC statement", line "For release at
    <time> EST|EDT". Includes the 2020 unscheduled meetings (Mar 3 10:00, Mar 15 17:00 Sunday, Mar 23 08:00).
  * FOMC minutes: federalreserve.gov press release "Minutes of the Federal Open Market Committee ...", "For release at
    2:00 p.m. EST|EDT" (the "for release at 2:00 p.m." sentence INSIDE the minutes is the desk directive, not used).
  * CPI and Employment Situation: bls.gov archived release, "embargoed until 8:30 a.m. (ET|EST|EDT) <date>". Dates are
    the actual releases, so rescheduled ones (e.g. the 2025 appropriations lapse: September 2025 CPI on 2025-10-24,
    October 2025 CPI not published) are as released.
Times are wall-clock America/New_York; the stated EST/EDT label is checked against the date's DST state (tests).
Coverage: 2019-01-01 to 2026-11-27. Outside it the calendar reports "not covered" and restricted stages are blocked.
"""
from __future__ import annotations

import datetime as dt
from typing import Dict, List, Tuple
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
COVERAGE = (dt.datetime(2019, 1, 1, 0, 0, tzinfo=ET), dt.datetime(2026, 11, 27, 0, 0, tzinfo=ET))
RETRIEVED = "2026-11-27"
FED_PR = "https://www.federalreserve.gov/newsevents/pressreleases/monetary{d}a.htm"
BLS = "https://www.bls.gov/news.release/archives/{f}"

# (YYYYMMDD, HH:MM, label) — FOMC statements ("Federal Reserve issues FOMC statement")
FOMC_STATEMENTS = """20190130 14:00 EST|20190320 14:00 EDT|20190501 14:00 EDT|20190619 14:00 EDT|20190731 14:00 EDT|20190918 14:00 EDT|20191030 14:00 EDT|20191211 14:00 EST
20200129 14:00 EST|20200303 10:00 EST|20200315 17:00 EDT|20200323 08:00 EDT|20200429 14:00 EDT|20200610 14:00 EDT|20200729 14:00 EDT|20200916 14:00 EDT|20201105 14:00 EST|20201216 14:00 EST
20210127 14:00 EST|20210317 14:00 EDT|20210428 14:00 EDT|20210616 14:00 EDT|20210728 14:00 EDT|20210922 14:00 EDT|20211103 14:00 EDT|20211215 14:00 EST
20220126 14:00 EST|20220316 14:00 EDT|20220504 14:00 EDT|20220615 14:00 EDT|20220727 14:00 EDT|20220921 14:00 EDT|20221102 14:00 EDT|20221214 14:00 EST
20230201 14:00 EST|20230322 14:00 EDT|20230503 14:00 EDT|20230614 14:00 EDT|20230726 14:00 EDT|20230920 14:00 EDT|20231101 14:00 EDT|20231213 14:00 EST
20240131 14:00 EST|20240320 14:00 EDT|20240501 14:00 EDT|20240612 14:00 EDT|20240731 14:00 EDT|20240918 14:00 EDT|20241107 14:00 EST|20241218 14:00 EST
20250129 14:00 EST|20250319 14:00 EDT|20250507 14:00 EDT|20250618 14:00 EDT|20250730 14:00 EDT|20250917 14:00 EDT|20251029 14:00 EDT|20251210 14:00 EST
20260128 14:00 EST|20260318 14:00 EDT|20260429 14:00 EDT|20260617 14:00 EDT|20260729 14:00 EDT|20260916 14:00 EDT|20261028 14:00 EDT"""

# FOMC minutes press releases ("Minutes of the Federal Open Market Committee"), all "For release at 2:00 p.m."
FOMC_MINUTES = """20190220 EST|20190410 EDT|20190522 EDT|20190710 EDT|20190821 EDT|20191009 EDT|20191120 EST|20200103 EST|20200219 EST|20200408 EDT
20200520 EDT|20200701 EDT|20200819 EDT|20201007 EDT|20201125 EST|20210106 EST|20210217 EST|20210407 EDT|20210519 EDT|20210707 EDT
20210818 EDT|20211013 EDT|20211124 EST|20220105 EST|20220216 EST|20220406 EDT|20220525 EDT|20220706 EDT|20220817 EDT|20221012 EDT
20221123 EST|20230104 EST|20230222 EST|20230412 EDT|20230524 EDT|20230705 EDT|20230816 EDT|20231011 EDT|20231121 EST|20240103 EST
20240221 EST|20240410 EDT|20240522 EDT|20240703 EDT|20240821 EDT|20241009 EDT|20241126 EST|20250108 EST|20250219 EST|20250409 EDT
20250528 EDT|20250709 EDT|20250820 EDT|20251008 EDT|20251119 EST|20251230 EST|20260218 EST|20260408 EDT|20260520 EDT|20260708 EDT
20260819 EDT|20261007 EDT|20261118 EST"""

# BLS archive file -> embargo label (time 8:30 for every row; label as printed: ET, EST or EDT)
CPI = """cpi_02132019 EST|cpi_03122019 EDT|cpi_04102019 EDT|cpi_05102019 EDT|cpi_06122019 EDT|cpi_07112019 EDT|cpi_08132019 EDT|cpi_09122019 EDT|cpi_10102019 EDT|cpi_11132019 EST|cpi_12112019 EST
cpi_01142020 EST|cpi_02132020 EST|cpi_03112020 EDT|cpi_04102020 EDT|cpi_05122020 EDT|cpi_06102020 EDT|cpi_07142020 EDT|cpi_08122020 ET|cpi_09112020 ET|cpi_10132020 ET|cpi_11122020 ET|cpi_12102020 ET
cpi_01132021 ET|cpi_02102021 ET|cpi_03102021 ET|cpi_04132021 ET|cpi_05122021 ET|cpi_06102021 ET|cpi_07132021 ET|cpi_08112021 ET|cpi_09142021 ET|cpi_10132021 ET|cpi_11102021 ET|cpi_12102021 ET
cpi_01122022 ET|cpi_02102022 ET|cpi_03102022 ET|cpi_04122022 ET|cpi_05112022 ET|cpi_06102022 ET|cpi_07132022 ET|cpi_08102022 ET|cpi_09132022 ET|cpi_10132022 ET|cpi_11102022 ET|cpi_12132022 ET
cpi_01122023 ET|cpi_02142023 ET|cpi_03142023 ET|cpi_04122023 ET|cpi_05102023 ET|cpi_06132023 ET|cpi_07122023 ET|cpi_08102023 ET|cpi_09132023 ET|cpi_10122023 ET|cpi_11142023 ET|cpi_12122023 ET
cpi_01112024 ET|cpi_02132024 ET|cpi_03122024 ET|cpi_04102024 ET|cpi_05152024 ET|cpi_06122024 ET|cpi_07112024 ET|cpi_08142024 ET|cpi_09112024 ET|cpi_10102024 ET|cpi_11132024 ET|cpi_12112024 ET
cpi_01152025 ET|cpi_02122025 ET|cpi_03122025 ET|cpi_04102025 ET|cpi_05132025 ET|cpi_06112025 ET|cpi_07152025 ET|cpi_08122025 ET|cpi_09112025 ET|cpi_10242025 ET|cpi_12182025 ET
cpi_01132026 ET|cpi_02132026 ET|cpi_03112026 ET|cpi_04102026 ET|cpi_05122026 ET|cpi_06102026 ET|cpi_07142026 ET|cpi_08122026 ET|cpi_09112026 ET|cpi_10142026 ET|cpi_11102026 ET"""

EMPSIT = """empsit_02012019 EST|empsit_03082019 EST|empsit_04052019 EDT|empsit_05032019 EDT|empsit_06072019 EDT|empsit_07052019 EDT|empsit_08022019 EDT|empsit_09062019 EDT|empsit_10042019 EDT|empsit_11012019 EDT|empsit_12062019 EST
empsit_01102020 EST|empsit_02072020 EST|empsit_03062020 EST|empsit_04032020 EDT|empsit_05082020 EDT|empsit_06052020 EDT|empsit_07022020 ET|empsit_08072020 ET|empsit_09042020 ET|empsit_10022020 ET|empsit_11062020 ET|empsit_12042020 ET
empsit_01082021 ET|empsit_02052021 ET|empsit_03052021 ET|empsit_04022021 ET|empsit_05072021 ET|empsit_06042021 ET|empsit_07022021 ET|empsit_08062021 ET|empsit_09032021 ET|empsit_10082021 ET|empsit_11052021 ET|empsit_12032021 ET
empsit_01072022 ET|empsit_02042022 ET|empsit_03042022 ET|empsit_04012022 ET|empsit_05062022 ET|empsit_06032022 ET|empsit_07082022 ET|empsit_08052022 ET|empsit_09022022 ET|empsit_10072022 ET|empsit_11042022 ET|empsit_12022022 ET
empsit_01062023 ET|empsit_02032023 ET|empsit_03102023 ET|empsit_04072023 ET|empsit_05052023 ET|empsit_06022023 ET|empsit_07072023 ET|empsit_08042023 ET|empsit_09012023 ET|empsit_10062023 ET|empsit_11032023 ET|empsit_12082023 ET
empsit_01052024 ET|empsit_02022024 ET|empsit_03082024 ET|empsit_04052024 ET|empsit_05032024 ET|empsit_06072024 ET|empsit_07052024 ET|empsit_08022024 ET|empsit_09062024 ET|empsit_10042024 ET|empsit_11012024 ET|empsit_12062024 ET
empsit_01102025 ET|empsit_02072025 ET|empsit_03072025 ET|empsit_04042025 ET|empsit_05022025 ET|empsit_06062025 ET|empsit_07032025 ET|empsit_08012025 ET|empsit_09052025 ET|empsit_11202025 ET|empsit_12162025 ET
empsit_01092026 ET|empsit_02112026 ET|empsit_03062026 ET|empsit_04032026 ET|empsit_05082026 ET|empsit_06052026 ET|empsit_07022026 ET|empsit_08072026 ET|empsit_09042026 ET|empsit_10022026 ET|empsit_11062026 ET"""

# MFFU's own 2026 T1 image (S7 page), transcribed 2026-11-27. "All listed times are Eastern Standard Time (EST)" is read as
# New York wall-clock time. Compared with the official record in tests; disagreements are listed in MFFU_2026_DIFFS.
MFFU_2026 = """0109 08:30 EMP|0113 08:30 CPI|0128 14:00 FOMC|0206 08:30 EMP|0211 08:30 CPI|0218 14:00 MIN|0306 08:30 EMP|0311 08:30 CPI|0318 14:00 FOMC
0403 08:30 EMP|0408 14:00 MIN|0410 08:30 CPI|0429 14:00 FOMC|0508 08:30 EMP|0512 08:30 CPI|0520 14:00 MIN|0605 08:30 EMP|0610 08:30 CPI|0617 14:00 FOMC
0702 08:30 EMP|0708 14:00 MIN|0714 08:30 CPI|0729 14:00 FOMC|0807 08:30 EMP|0812 08:30 CPI|0819 14:00 MIN|0904 08:30 EMP|0911 08:30 CPI|0916 14:00 FOMC
1002 08:30 EMP|1007 14:00 MIN|1014 08:30 CPI|1106 08:30 EMP|1110 08:30 CPI|1118 14:00 MIN|1204 08:30 EMP|1209 14:00 FOMC|1210 08:30 CPI|1230 14:00 MIN"""
MFFU_IMAGE_SRC = "S7 image '2026 T1 News Calendar' on https://help.myfundedfutures.com/en/articles/8230009"
KIND = {"EMP": "Employment Report", "CPI": "CPI", "FOMC": "FOMC statement", "MIN": "FOMC minutes"}


def _rows(block: str) -> List[str]:
    return [x.strip() for x in block.replace("\n", "|").split("|") if x.strip()]


def _at(ymd: str, hm: str) -> dt.datetime:
    return dt.datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8]), int(hm[:2]), int(hm[3:]), tzinfo=ET)


def official_events() -> List[Dict]:
    out = []
    for r in _rows(FOMC_STATEMENTS):
        d, hm, lab = r.split()
        out.append({"t": _at(d, hm), "event": "FOMC statement", "label": lab, "source": FED_PR.format(d=d)})
    for r in _rows(FOMC_MINUTES):
        d, lab = r.split()
        out.append({"t": _at(d, "14:00"), "event": "FOMC minutes", "label": lab, "source": FED_PR.format(d=d)})
    for block, name in ((CPI, "CPI"), (EMPSIT, "Employment Report")):
        for r in _rows(block):
            f, lab = r.split()
            md = f.split("_")[1]
            out.append({"t": _at(md[4:] + md[:4], "08:30"), "event": name, "label": lab, "source": BLS.format(f=f + ".htm")})
    return sorted(out, key=lambda e: e["t"])


def mffu_2026_events() -> List[Dict]:
    return [{"t": _at("2026" + md, hm), "event": KIND[k], "label": "ET", "source": MFFU_IMAGE_SRC} for md, hm, k in (r.split() for r in _rows(MFFU_2026))]


def mffu_2026_diffs() -> Dict[str, List[str]]:
    off = {(e["t"], e["event"]) for e in official_events() if e["t"].year == 2026}
    mf = {(e["t"], e["event"]) for e in mffu_2026_events() if e["t"] < COVERAGE[1]}
    f = lambda s: sorted(f"{t:%Y-%m-%d %H:%M} {n}" for t, n in s)
    return {"official_only": f(off - mf), "mffu_image_only": f(mf - off)}


def events(variant: str = "union") -> List[Tuple[dt.datetime, str]]:
    """'official': primary-source releases only. 'mffu_image': MFFU's published 2026 dates in place of the official 2026
    releases. 'union' (default, stricter): both, so a window is blocked if either source puts an event there."""
    off = [(e["t"], e["event"]) for e in official_events()]
    if variant == "official":
        return off
    mf = [(e["t"], e["event"]) for e in mffu_2026_events() if e["t"] < COVERAGE[1]]
    if variant == "mffu_image":
        return sorted(set(mf + [x for x in off if x[0].year < 2026]))
    if variant == "union":
        return sorted(set(off + mf))
    raise ValueError(variant)
