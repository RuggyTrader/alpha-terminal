"""Source register for every MFFU, CME, Federal Reserve and BLS fact used by the simulator.

All pages were read on RETRIEVED. "page_date" is the date printed under each article's title; MFFU does not label it as
an update or effective date. Rules change: re-verify before relying on them.
"""
RETRIEVED = "2026-11-27"
H = "https://help.myfundedfutures.com/en/articles/"

SOURCES = {
    "S1": ("Traders Evaluation Simplified", H + "11802636-traders-evaluation-simplified", "2026-09-24"),
    "S2": ("Understanding Evaluation Parameters at MyFundedFutures", H + "8528339-understanding-evaluation-parameters-at-myfundedfutures", "2026-08-24"),
    "S3": ("Consistency Rule at My FundedFutures", H + "11994562-consistency-rule-at-my-fundedfutures", "2026-09-25"),
    "S4": ("End of Day (EOD) Drawdown Explained", H + "8348565-end-of-day-eod-drawdown-explained", "2026-08-24"),
    "S5": ("Fair Play and Prohibited Trading Practices", H + "8444599-fair-play-and-prohibited-trading-practices", "'updated over a month ago'"),
    "S6": ("Overview of Supported Platforms at MFFU", H + "8528335-overview-of-supported-platforms-at-mffu", "2026-10-08"),
    "S7": ("News Trading Policy (incl. the '2026 T1 News Calendar' image)", H + "8230009-news-trading-policy", "2026-08-31"),
    "S8": ("Builder Plan 100k - Comprehensive Guide", H + "17005296-builder-plan-100k-comprehensive-guide", "2026-09-25"),
    "S9": ("Rapid Plan 50k - A Comprehensive Look", H + "13134709-rapid-plan-50k-a-comprehensive-look", "2026-08-24"),
    "S10": ("Comprehensive Look into Redesigned Pro Plan", H + "17573707-comprehensive-look-into-redesigned-pro-plan", "'updated this week'; effective 2026-11-23"),
    "S11": ("Intraday Drawdown Explained", H + "12802721-intraday-drawdown-explained", "2026-01-08"),
    "S12": ("Builder Plan 50k - A Comprehensive Guide", H + "14290805-builder-plan-50k-a-comprehensive-guide", "2026-10-21"),
    "S13": ("Rapid EOD 50k - A Comprehensive Look", H + "16158363", "2026-08-24"),
    "S14": ("2% Price Limit Rule", H + "9698984", "2026-08-24"),
    "S15": ("Cross Instrument Policy", H + "10244682", "2026-08-24"),
    "S16": ("Keys to Managing Your Funded Account (advice only, no rules)", H + "8528346", "2026-08-24"),
    "S17": ("Permitted Times to Trade (Core Rules)", H + "9558251-permitted-times-to-trade", "2026-08-24"),
    "S18": ("Moving from Evaluation to Sim-Funded", H + "16498635", "2026-09-04"),
    "S19": ("Inactivity Rule - One-Time Payment Model", H + "16596524-inactivity-rule-one-time-payment-model", "effective 2026-08-25"),
    "S20": ("Rapid Plan 25k - A Comprehensive Look", H + "14116402", "2026-08-14"),
    "S21": ("Rapid Plan 100k - A Comprehensive Look", H + "13286542", "2026-07-01"),
    "S22": ("Rapid Plan 150k - A Comprehensive Look", H + "13286582", "2026-07-01"),
    "S23": ("Understanding Rapid Live", H + "13134718", "2026-09-08"),
    "S24": ("Rapid EOD 25k - A Comprehensive Look", H + "16727601", "2026-09-02"),
    "S25": ("Rapid EOD with DLL - A Detailed Look", H + "18337038", "'updated over 2 weeks ago'"),
    "S26": ("Builder Plan 25k - A Comprehensive Look", H + "17036130", "'updated over 2 weeks ago'"),
    "S27": ("Builder Plan 150k - Comprehensive Guide", H + "17035331", "2026-09-25"),
    "S28": ("Legacy Pro Plan Sim-Funded and Live Account Highlights", H + "11802674", "2026-10-20"),
    "S29": ("Payout Policy Overview", H + "13745661", "'updated this week'"),
    "S30": ("Hedging - What You Should Know", H + "12011241", "2025-11-10"),
    "C1": ("CME Micro E-mini Nasdaq-100 contract specs", "https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html", "page data 2026-11-27"),
    "C2": ("CME Micro E-mini S&P 500 contract specs", "https://www.cmegroup.com/markets/equities/sp/micro-e-mini-sandp-500.contractSpecs.html", "page data 2026-11-27"),
    "C3": ("CME Group Holiday and Trading Hours", "https://www.cmegroup.com/trading-hours.html", "2026 schedule; 'subject to change'"),
    "F1": ("Federal Reserve: FOMC meeting calendars 2021-2027 and historical 2019-2020", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "last update 2026-11-18"),
    "F2": ("Federal Reserve press releases (FOMC statements and minutes; 'For release at ...')", "https://www.federalreserve.gov/newsevents/pressreleases.htm", "each release"),
    "B1": ("BLS Consumer Price Index archived news releases ('embargoed until 8:30 a.m.')", "https://www.bls.gov/bls/news-release/cpi.htm", "each release"),
    "B2": ("BLS Employment Situation archived news releases ('embargoed until 8:30 a.m.')", "https://www.bls.gov/bls/news-release/empsit.htm", "each release"),
}

# Status: RESOLVED (evidence settles it), VARIANTS (still contradictory; every reading is simulated separately),
# OPEN (contradictory or missing, cannot be simulated either way; the affected rule blocks trading or is reported).
CONTRADICTIONS = [
    {"id": "X1", "status": "VARIANTS", "src": ["S1", "S2", "S9", "S20", "S21", "S22"], "topic": "Rapid evaluation drawdown type",
     "detail": "Every Rapid plan article labels the evaluation loss limit 'EOD' and only the sim stage 'intra-day trailing'; S2 says Rapid plans use intraday drawdown. Evidence favours EOD; both are run."},
    {"id": "X2", "status": "RESOLVED", "src": ["S1", "S2", "S13", "S24", "S25"], "topic": "Minimum trading days for Rapid EOD",
     "detail": "S2's generic '2 days' is superseded by the Rapid EOD plan articles (4 days)."},
    {"id": "X3", "status": "RESOLVED", "src": ["S4", "S18"], "topic": "EOD drawdown lock level",
     "detail": "S18: the drawdown 'will now lock at +$100 after the drawdown % + $100 has been reached'. S4's 52.1k / 103.1k / 154.6k examples are the balance highs at which the lock happens."},
    {"id": "X4", "status": "VARIANTS", "src": ["S4", "S12"], "topic": "EOD-trailing breach test",
     "detail": "S4: open equity below the minimum balance fails the account; S12: open equity losses are counted 'at the end of the trading day'. Both readings are run."},
    {"id": "X5", "status": "VARIANTS", "src": ["S12", "S26", "S27"], "topic": "Builder live MLL lock (25k / 50k)",
     "detail": "Live tables say 'static once MLL reaches $0'; account rules say 'locks at $100 above the starting balance'. S27 (150k) and S8 (100k) say $100 only."},
    {"id": "X6", "status": "RESOLVED", "src": ["S11", "S9", "S20", "S21", "S22"], "topic": "Intraday trailing lock",
     "detail": "All four Rapid plan articles: 'Once your trailing Max Loss reaches $100, it locks there'. S11's 'will not exceed the starting balance' is the generic statement."},
    {"id": "X7", "status": "VARIANTS", "src": ["S10", "S28"], "topic": "Pro sim-funded contract limits",
     "detail": "The redesigned plan lists '3 mini / 3 micro' (6/6, 9/9) while its evaluation allows 30/60/90 micros; legacy accounts list 5/5, 10/10, 15/15. The stricter micro count is the default."},
    {"id": "X8", "status": "VARIANTS", "src": ["S9", "S15", "S20", "S21", "S22"], "topic": "Rapid 50k sim contract limit",
     "detail": "S9: 5 minis / 50 micros; S15: a Rapid 50k sim account 'starts off with 2 contracts' under a scaling plan no Rapid article describes. The stricter 20 micros is the default."},
    {"id": "X9", "status": "RESOLVED", "src": ["S7", "S13", "S25", "S26", "S27"], "topic": "T1 news scope",
     "detail": "T1 is prohibited on Rapid, Rapid EOD and Pro sim funded; allowed on all evaluations and Builder. S7's '2-minute protocol for all releases' for non-T1 news is not simulated (no complete calendar of all releases)."},
    {"id": "X10", "status": "OPEN", "src": ["S3"], "topic": "Consistency denominator",
     "detail": "Defined as a share of 'total evaluation profits made' but the worked example divides the profit target. The literal definition is used; the example would only change attempts that exceed the target."},
    {"id": "X11", "status": "OPEN", "src": ["S14"], "topic": "2% price-limit example",
     "detail": "Text refers to a 5% limit while formulas use 7%. Price-limit levels are not in the data, so the rule is reported as unverified, not enforced."},
    {"id": "X12", "status": "VARIANTS", "src": ["S7", "B1", "B2", "F2"], "topic": "MFFU 2026 T1 image vs official release times",
     "detail": "MFFU's image lists the January Employment Report on Feb 6 and CPI on Feb 11 (released Feb 11 and Feb 13) and omits the Oct 28 FOMC statement. Default blocks the union of both."},
    {"id": "X13", "status": "OPEN", "src": ["S24", "S23"], "topic": "Rapid EOD 25k live",
     "detail": "S24 says live follows standard Rapid 25k, but the Rapid live table (S23) is used because it is the only stated live table."},
]

# Facts that no page states. The simulator never fills these in silently.
NOT_STATED = [
    "The exact time an MFFU EOD balance is snapshotted (S17 fixes the 4:10 PM ET auto-flat; day-end is taken after it).",
    "Whether unrealized P&L counts toward the EOD high-water mark (S4 states only that open losses count toward a breach).",
    "Whether the soft daily loss limit uses realized or open (equity) P&L.",
    "Whether every plan uses the 'one-time payment model' inactivity rule (S19).",
    "Builder 25k / 50k live contract limits; Rapid live DLL; Pro live micro limits and lock; Pro 50k One Day sim-funded rules.",
    "Penalties for T1 news violations (S7 gives none).",
    "Whether ALPHA TERMINAL's unattended automated execution is permitted: S5 allows automated strategies 'tailored to their own specific settings' that do not exploit simulated fills; nothing approves this application.",
    "Which platform API (if any) MFFU supports for automation: S6 and 'Connecting to Different Platforms' list platforms with no API or automation statement.",
    "CME exchange and clearing fees and broker commissions (fee pages not read): all commissions are labelled scenarios.",
]


def cite(*ids):
    return [{"id": i, "title": SOURCES[i][0], "url": SOURCES[i][1], "page_date": SOURCES[i][2], "retrieved": RETRIEVED} for i in ids]
