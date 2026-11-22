// The strategies carried into Phase 3, FROZEN exactly as selected in DD2 / the DD2 frontier. No parameter is changed in
// Phase 3: everything from here on evaluates them, it does not tune them.
export const CANDIDATES = Object.freeze({
  "A BTC momentum 0.25%": { uni: ["BTC"], spec: { family: "M", p: { L: 56, th: 0.05 }, k: 2, trail: true, r: 0.25, cb: 0 }, origin: "DD2 winner (2 % limit)" },
  "B 3-asset momentum 0.10%": { uni: ["BTC", "ETH", "SOL"], spec: { family: "M", p: { L: 56, th: 0.05 }, k: 1.5, trail: true, r: 0.1, cb: 0 }, origin: "DD2 #4; the only ROBUST label at the 2 % limit" },
  "C 3-asset 55/10 breakout 0.25%": { uni: ["BTC", "ETH", "SOL"], spec: { family: "B", p: { N: 55, M: 10 }, k: 2, trail: true, r: 0.25, cb: 0 }, origin: "DD2 #2 (2 % limit)" },
  "D 3-asset 20/10 breakout 0.25%": { uni: ["BTC", "ETH", "SOL"], spec: { family: "B", p: { N: 20, M: 10 }, k: 1.5, trail: true, r: 0.25, cb: 0 }, origin: "frontier ROBUST at 3 %; historical 2016-2026 drawdown 3.61 % (fails 2 %)" },
});
