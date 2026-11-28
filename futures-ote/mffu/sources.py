"""Source register for every MFFU and CME rule used by the simulator.

All pages were read on RETRIEVED (from help.myfundedfutures.com and cmegroup.com). "page_date" is the date printed under
each article's title; MFFU does not label it as an update or effective date. Rules change: re-verify before relying on them.
"""
RETRIEVED = "2026-11-27"

SOURCES = {
    "S1": ("Traders Evaluation Simplified", "https://help.myfundedfutures.com/en/articles/11802636-traders-evaluation-simplified", "2026-09-24"),
    "S2": ("Understanding Evaluation Parameters at MyFundedFutures", "https://help.myfundedfutures.com/en/articles/8528339-understanding-evaluation-parameters-at-myfundedfutures", "2026-08-24"),
    "S3": ("Consistency Rule at My FundedFutures", "https://help.myfundedfutures.com/en/articles/11994562-consistency-rule-at-my-fundedfutures", "2026-09-25"),
    "S4": ("End of Day (EOD) Drawdown Explained", "https://help.myfundedfutures.com/en/articles/8348565-end-of-day-eod-drawdown-explained", "2026-08-24"),
    "S5": ("Fair Play and Prohibited Trading Practices", "https://help.myfundedfutures.com/en/articles/8444599-fair-play-and-prohibited-trading-practices", "'updated over a month ago'"),
    "S6": ("Overview of Supported Platforms at MFFU", "https://help.myfundedfutures.com/en/articles/8528335-overview-of-supported-platforms-at-mffu", "2026-10-08"),
    "S7": ("News Trading Policy", "https://help.myfundedfutures.com/en/articles/8230009", "2026-08-31"),
    "S8": ("Builder Plan 100k - Comprehensive Guide", "https://help.myfundedfutures.com/en/articles/17005296-builder-plan-100k-comprehensive-guide", "2026-09-25"),
    "S9": ("Rapid Plan 50k - A Comprehensive Look", "https://help.myfundedfutures.com/en/articles/13134709-rapid-plan-50k-a-comprehensive-look", "2026-08-24"),
    "S10": ("Comprehensive Look into Redesigned Pro Plan", "https://help.myfundedfutures.com/en/articles/17573707-comprehensive-look-into-redesigned-pro-plan", "'updated this week'; multi-account rule effective 2026-11-23"),
    "S11": ("Intraday Drawdown Explained", "https://help.myfundedfutures.com/en/articles/12802721-intraday-drawdown-explained", "2026-01-08"),
    "S12": ("Builder Plan 50k - A Comprehensive Guide", "https://help.myfundedfutures.com/en/articles/14290805-builder-plan-50k-a-comprehensive-guide", "2026-10-21"),
    "S13": ("Rapid EOD 50k - A Comprehensive Look", "https://help.myfundedfutures.com/en/articles/16158363", "2026-08-24"),
    "S14": ("2% Price Limit Rule", "https://help.myfundedfutures.com/en/articles/9698984", "2026-08-24"),
    "S15": ("Cross Instrument Policy", "https://help.myfundedfutures.com/en/articles/10244682", "2026-08-24"),
    "S16": ("Keys to Managing Your Funded Account (advice only, no rules)", "https://help.myfundedfutures.com/en/articles/8528346", "2026-08-24"),
    "C1": ("CME Micro E-mini Nasdaq-100 contract specs", "https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html", "page data 2026-11-27"),
    "C2": ("CME Micro E-mini S&P 500 contract specs", "https://www.cmegroup.com/markets/equities/sp/micro-e-mini-sandp-500.contractSpecs.html", "page data 2026-11-27"),
    "C3": ("CME Group Holiday and Trading Hours", "https://www.cmegroup.com/trading-hours.html", "2026 schedule; 'subject to change'"),
}

# Contradictions found between or inside the pages. Each one is modelled as UNRESOLVED (or as a labelled choice) in rules.py.
CONTRADICTIONS = [
    {"id": "X1", "src": ["S1", "S2", "S9"], "topic": "Rapid (intraday) evaluation drawdown type",
     "detail": "S2 says Rapid plans use intraday trailing drawdown; S1 and S9 label the Rapid evaluation loss limit 'EOD' and S9 says only the sim-funded stage trails intraday."},
    {"id": "X2", "src": ["S1", "S2"], "topic": "Minimum trading days for Rapid",
     "detail": "S2: Rapid and Pro need 2 days. S1: Rapid intraday 2 days but Rapid EOD 4 days."},
    {"id": "X3", "src": ["S4"], "topic": "EOD drawdown lock level",
     "detail": "S4 states the trail locks at starting balance + $100, but its examples (52.1k, 103.1k, 154.6k) add the MLL to the start."},
    {"id": "X4", "src": ["S4", "S12", "S8"], "topic": "EOD drawdown breach test",
     "detail": "S4: open equity losses below the minimum balance fail the account at any time. S8: the MLL 'does not move intraday'. S12: open equity losses are counted 'at the end of the trading day'. Whether an intraday dip that recovers is a breach is not consistent."},
    {"id": "X5", "src": ["S12"], "topic": "Builder live MLL lock",
     "detail": "S12 live table: 'static once MLL reaches $0'; S12 account rules: locks at $100 above the starting balance."},
    {"id": "X6", "src": ["S11", "S9"], "topic": "Intraday trailing lock",
     "detail": "S11: the drawdown 'will not exceed the starting balance'. S9: the sim trailing max loss locks at $100 (start $0)."},
    {"id": "X7", "src": ["S10"], "topic": "Pro sim-funded contract limits",
     "detail": "S10 lists sim-funded limits as '3 mini / 3 micro', '6 / 6', '9 / 9' while the evaluation uses 3/30, 6/60, 9/90 (probably a typo, not confirmed)."},
    {"id": "X8", "src": ["S9", "S15"], "topic": "Rapid 50k sim contract limit",
     "detail": "S9: 5 minis / 50 micros. S15: a Rapid 50k sim account 'starts off with 2 contracts' under a scaling plan that is not published."},
    {"id": "X9", "src": ["S7", "S8", "S12"], "topic": "News rule scope",
     "detail": "S7's 2-minute flat protocol says it applies to all releases, but S7 also allows trading other releases; Builder articles allow holding through T1 news without limitation."},
    {"id": "X10", "src": ["S3"], "topic": "Consistency denominator",
     "detail": "S3 defines the cap as a share of 'total evaluation profits made' but its worked example divides the profit target."},
    {"id": "X11", "src": ["S14"], "topic": "2% price-limit example",
     "detail": "S14's text refers to a 5% limit while its formulas use 7%."},
]

# Facts that no page states. The simulator never fills these in silently.
NOT_STATED = [
    "The time and time zone at which an MFFU trading day ends and EOD balances are taken (no page states it).",
    "Whether unrealized P&L counts toward the EOD high-water mark (S4 states only that open losses count toward a breach).",
    "Whether the soft daily loss limit uses realized or open (equity) P&L, and its trigger time.",
    "What counts as a 'trading day' or 'qualifying day' for minimum-day and payout rules.",
    "The consequence of breaking the inactivity rule.",
    "Session flat-by times for plans other than Builder (S12: positions must be closed before the session ends; no time given).",
    "Contract limits for Builder 50k live and for Rapid live; Rapid 25k/100k/150k and Builder 25k/150k sim-funded parameters (articles not read).",
    "Penalties for T1 news violations (S7 gives none).",
    "Whether ALPHA TERMINAL's unattended automated execution is permitted: S5 allows automated strategies 'tailored to their own specific settings' that do not exploit simulated fills; nothing approves this application.",
    "Which platform API (if any) MFFU supports for automation: S6 lists platforms with no API or automation statement.",
    "CME exchange and clearing fees for MNQ/MES (fee pages not read): all commissions are labelled scenarios.",
]


def cite(*ids):
    return [{"id": i, "title": SOURCES[i][0], "url": SOURCES[i][1], "page_date": SOURCES[i][2], "retrieved": RETRIEVED} for i in ids]
