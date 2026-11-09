// Renders equity curves from research.mjs (equity.json) as a static SVG: one line per strategy, $100 start,
// a dashed line where the untouched out-of-sample period begins.
//   node src/cli/equity-svg.mjs --in runs/research/equity.json --venue ndax --ids "<id1>,<id2>" --out docs/research/equity-ndax.svg

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const doc = JSON.parse(readFileSync(arg("in"), "utf8"));
const venue = arg("venue", "ndax");
const ids = arg("ids", "").split(",").filter(Boolean);
const labels = (arg("labels", "") || "").split("|").filter(Boolean);
const curves = ids.map((id) => doc.curves.find((c) => c.id === id)).filter(Boolean);
const W = 820, H = 380, L = 56, R = 16, T = 34, B = 40;
const all = curves.flatMap((c) => c[venue].map((p) => p.eq));
const lo = Math.min(100, ...all), hi = Math.max(100, ...all);
const x = (t) => L + ((t - doc.from) / (doc.to - doc.from)) * (W - L - R);
const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
const colors = ["#5b6170", "#d9480f", "#2b8a3e", "#1c7ed6", "#ae3ec9", "#e67700"];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11">`;
s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
s += `<text x="${L}" y="18" font-size="13" font-weight="600">Balance from $100 after ${venue === "none" ? "no costs" : `${venue} costs`} (closed trades, compounding)</text>`;
for (const v of [lo, 100, hi]) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e9ecef"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" fill="#5b6170">$${v.toFixed(2)}</text>`;
s += `<line x1="${x(doc.split)}" x2="${x(doc.split)}" y1="${T}" y2="${H - B}" stroke="#868e96" stroke-dasharray="4 4"/>`;
s += `<text x="${x(doc.split) + 4}" y="${T + 10}" fill="#5b6170">out-of-sample →</text>`;
s += `<text x="${L}" y="${H - 14}" fill="#5b6170">${day(doc.from)}</text><text x="${W - R}" y="${H - 14}" text-anchor="end" fill="#5b6170">${day(doc.to)}</text>`;
curves.forEach((c, i) => {
  const pts = c[venue];
  let d = `M${x(pts[0].t).toFixed(1)},${y(pts[0].eq).toFixed(1)}`;
  for (let k = 1; k < pts.length; k++) d += ` H${x(pts[k].t).toFixed(1)} V${y(pts[k].eq).toFixed(1)}`;
  d += ` H${x(doc.to).toFixed(1)}`;
  s += `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="1.8"/>`;
  s += `<rect x="${L + 8}" y="${T + 6 + i * 15}" width="10" height="3" fill="${colors[i % colors.length]}"/><text x="${L + 22}" y="${T + 10 + i * 15}">${labels[i] ?? c.id} · $${pts[pts.length - 1].eq.toFixed(2)}</text>`;
});
s += "</svg>";
mkdirSync(dirname(arg("out")), { recursive: true });
writeFileSync(arg("out"), s);
console.log(`wrote ${arg("out")} (${curves.length} curves)`);
