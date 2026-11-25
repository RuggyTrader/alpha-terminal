// Minimal ZIP reader (stored / deflate entries) using the central directory. Treats input strictly as data.
import { inflateRawSync } from "node:zlib";

export function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip (no end of central directory)");
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28), data = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out[name] = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : (() => { throw new Error(`unsupported method ${method}`); })();
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
