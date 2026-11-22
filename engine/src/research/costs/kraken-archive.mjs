// Kraken's OFFICIAL downloadable OHLCVT archive (support.kraken.com, "Downloadable historical OHLCVT data") is ~9.5 GB,
// published as a ZIP split into 5 parts. Instead of downloading all of it, this reads the ZIP's central directory with
// HTTP range requests and extracts ONLY the requested CSV files (a few MB). Files are written unchanged (authentic data).
//   node kraken-archive.mjs <out dir> NAME1.csv NAME2.csv ...     (names like XBTUSD_1440.csv; "--list REGEX" to list)
import { writeFileSync, mkdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";

const BASE = "https://assets.kraken.com/marketing/institutions/Kraken_OHLCVT_Full.zip.part";
const PART = 2_097_152_000;
const SIZES = [PART, PART, PART, PART, 1_157_945_626];
const TOTAL = SIZES.reduce((a, b) => a + b, 0);
const [OUT, ...names] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

async function range(off, len) { // read [off, off+len) of the virtual concatenated file
  const bufs = [];
  let start = off, left = len, p = 0, base = 0;
  while (start >= base + SIZES[p]) { base += SIZES[p]; p++; }
  while (left > 0) {
    const inPart = start - base, n = Math.min(left, SIZES[p] - inPart);
    const r = await fetch(`${BASE}${String(p).padStart(2, "0")}`, { headers: { Range: `bytes=${inPart}-${inPart + n - 1}`, "User-Agent": "research-client (read-only)" } });
    if (r.status !== 206) throw new Error(`range HTTP ${r.status}`);
    bufs.push(Buffer.from(await r.arrayBuffer()));
    left -= n; start += n; base += SIZES[p]; p++;
  }
  return Buffer.concat(bufs);
}
// End of central directory (ZIP64-aware)
const tail = await range(TOTAL - 65_536, 65_536);
const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
let cdOff = tail.readUInt32LE(eocd + 16), cdSize = tail.readUInt32LE(eocd + 12);
if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
  const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  const z64 = Number(tail.readBigUInt64LE(loc + 8));
  const rec = await range(z64, 56);
  cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
}
const cd = await range(cdOff, cdSize);
const entries = [];
for (let i = 0; i < cd.length && cd.readUInt32LE(i) === 0x02014b50;) {
  const method = cd.readUInt16LE(i + 10); let csize = cd.readUInt32LE(i + 20), usize = cd.readUInt32LE(i + 24);
  const nlen = cd.readUInt16LE(i + 28), xlen = cd.readUInt16LE(i + 30), clen = cd.readUInt16LE(i + 32);
  let lho = cd.readUInt32LE(i + 42);
  const name = cd.toString("utf8", i + 46, i + 46 + nlen);
  let x = i + 46 + nlen; const xe = x + xlen;
  while (x < xe) { const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2); if (id === 1) { let y = x + 4; if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(y)); y += 8; } if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(y)); y += 8; } if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(y)); } } x += 4 + sz; }
  entries.push({ name, method, csize, usize, lho });
  i = xe + clen;
}
if (names[0] === "--list") { const re = new RegExp(names[1] ?? "."); for (const e of entries.filter((e) => re.test(e.name))) console.log(e.name, e.usize); process.exit(0); }
for (const want of names) {
  const e = entries.find((x) => x.name === want || x.name.endsWith(`/${want}`));
  if (!e) { console.log(`not in archive: ${want}`); continue; }
  const lh = await range(e.lho, 30);
  const dataOff = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = await range(dataOff, e.csize);
  const data = e.method === 8 ? inflateRawSync(raw) : raw;
  writeFileSync(join(OUT, want.split("/").pop()), data);
  console.log(`${e.name}: ${data.length} bytes (compressed ${e.csize})`);
}
