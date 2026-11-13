// ALPHA Assistant, one specific trade ("Ask ALPHA about this trade"): answers ONLY from that trade's recorded story and
// ledger figures (tradeStory.ts). Read-only, deterministic, $0. When something was not recorded it says so.

import { UNKNOWN, type Answer, type Evidence } from "./assistant";
import { CONFLUENCE, explainEntry, explainExit, hypotheticalFees, planFigures, type TradeView } from "./tradeStory";

const usdT = (x: number | null) => (x === null ? "unavailable" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);

export function answerTrade(question: string, v: TradeView): Answer {
  const s = question.toLowerCase();
  const ev: Evidence[] = [
    { label: "Trade", value: `${v.botLabel} · ${v.symbol}${v.timeframe ? ` ${v.timeframe}` : ""} · ${v.side} · ${v.status}`, link: v.proofUrl },
    ...(v.chartUrl ? [{ label: "Chart", value: "entry, stop and target on the market", link: v.chartUrl }] : []),
    { label: "Ledger", value: `entry ${v.entry ?? "?"} · exit ${v.exit ?? "open"} · gross ${usdT(v.gross)} · fees ${usdT(v.fees)} · net ${usdT(v.net)}` },
  ];
  const missing = v.story?.missing?.length ? v.story.missing : ["no recorded story was returned for this trade"];
  const entry = explainEntry(v), exit = explainExit(v), f = planFigures(v), pl = v.story?.plan ?? null;
  const notRecorded = (what: string): Answer => ({ text: `${UNKNOWN} The ${what} was not recorded for this trade (${missing.join("; ")}).`, evidence: ev, known: false });

  if (/\bstop\b/.test(s) && !/why/.test(s)) {
    if (!pl) return notRecorded("stop loss");
    const atExit = v.story?.exit?.stop_at_exit;
    return { text: `Initial stop ${pl.initial_stop ?? "unavailable"}${atExit !== undefined && atExit !== null ? `; stop at exit ${atExit}` : ""}.`, evidence: ev, known: true };
  }
  if (/target|take[\s-]?profit|\btp2?\b/.test(s)) return pl ? { text: `Take-profit target (TP2) ${pl.tp2 ?? "unavailable"}.`, evidence: ev, known: true } : notRecorded("target");
  if (/\bpd\b|confluence|array|fvg|order block|rejection/.test(s)) {
    if (!pl) return notRecorded("PD-array confluence");
    return { text: pl.confluence.length ? `Qualifying PD arrays: ${pl.confluence.map((t) => CONFLUENCE[t] ?? t).join(", ")} (score ${pl.score ?? "?"}).` : `Confluence score ${pl.score ?? "?"}; the PD-array types were not recorded.`, evidence: ev, known: true };
  }
  if (/fee|cost/.test(s)) {
    const h = hypotheticalFees(v);
    const freeLegacy = v.costProfile === null || v.costProfile === "none";
    return { text: `Fees recorded: ${usdT(v.fees)}${v.costProfile ? ` (cost profile ${v.costProfile})` : ""}.${freeLegacy && h ? ` At the Ndax-equivalent 0.20% per fill it would have been ${usdT(h.fees)} (comparison only; nothing was charged).` : ""}`, evidence: ev, known: true };
  }
  if (/small|size|quantity|\bqty\b|how much.*(use|position)/.test(s)) {
    const value = v.qty !== null && v.entry !== null ? v.qty * v.entry : null;
    return { text: `Position ${v.qty ?? "?"} ${v.symbol.replace("USD", "")} ≈ ${usdT(value)}.${f.risk !== null ? ` At the recorded stop that risks ${usdT(f.risk)}.` : ""} A bot's size is capped by the capital in its own wallet, so with a small wallet the actual risk is below its risk target.`, evidence: ev, known: value !== null };
  }
  if (/why.*(close|exit|stopped|sell|end)|\bclosed\b|\blose\b|\blost\b|\bloss\b/.test(s) && !/enter|open|buy|point/.test(s)) {
    if (v.status !== "CLOSED") return { text: "This trade is still open.", evidence: ev, known: true };
    if (!exit) return notRecorded("exit reason");
    return { text: `${exit}${/lose|lost|loss/.test(s) && v.net !== null && v.net < 0 ? ` Net result ${usdT(v.net)} after ${usdT(v.fees)} of fees.` : ""}`, evidence: ev, known: true };
  }
  // "What was the point of this trade?", "why did it enter?", "why a LONG / SHORT?"
  if (!entry) return notRecorded("entry plan");
  const tail = exit ? ` ${exit}` : v.status === "CLOSED" ? " The exit reason was not recorded." : " The position is still open.";
  return { text: `${entry}${tail}${v.net !== null ? ` Result: ${usdT(v.net)} net.` : ""}`, evidence: ev, known: true };
}
