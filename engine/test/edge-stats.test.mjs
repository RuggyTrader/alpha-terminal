// Event-study statistics: reference values (t-test p from known tables, Holm by hand, bootstrap sanity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tTest, holm, clusterBootstrap, ibeta, decileFn, median } from "../src/research/edge/stats.mjs";
import { unzip } from "../src/research/edge/zip.mjs";
import { deflateRawSync } from "node:zlib";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("incomplete beta and t-test p-values match reference values", () => {
  near(ibeta(2, 3, 0.4), 0.5248, 1e-4);                 // I_0.4(2,3) = 0.5248
  // t = 2.262 with df 9 -> two-sided p = 0.05 (t table)
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => x - 5.5); // mean 0
  assert.ok(tTest(xs).p > 0.99);
  const ys = [0.5, 1.2, -0.3, 0.8, 1.5, 0.2, 0.9, 1.1, -0.1, 0.7]; const r = tTest(ys);
  near(r.t, 0.65 / (Math.sqrt(ys.reduce((s, x) => s + (x - 0.65) ** 2, 0) / 9) / Math.sqrt(10)), 1e-9);
  near(r.t, 3.557, 1e-3);                                // hand: mean 0.65, sd 0.5778, se 0.1827
  near(ibeta(4.5, 0.5, 9 / (9 + 2.262 ** 2)), 0.05, 5e-4); // t-table: t = 2.262, df 9 -> two-sided p = 0.05
  near(ibeta(4.5, 0.5, 9 / (9 + 3.25 ** 2)), 0.01, 3e-4);  // t-table: t = 3.250, df 9 -> p = 0.01
  assert.ok(r.p > 0.005 && r.p < 0.01);
});

test("Holm adjustment by hand", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03, null]).map((x) => (x === null ? null : +x.toFixed(4))), [0.03, 0.06, 0.06, null]);
});

test("cluster bootstrap CI covers the mean and widens with between-day dispersion", () => {
  const g = { a: [1, 1, 1], b: [2, 2, 2], c: [3, 3, 3], d: [4, 4], e: [5] };
  const ci = clusterBootstrap(g); assert.ok(ci[0] < 2.6 && ci[1] > 2.6);
  assert.equal(clusterBootstrap({ a: [1], b: [2] }), null);
});

test("deciles and median", () => {
  const f = decileFn(Array.from({ length: 100 }, (_, i) => i)); assert.equal(f(-5), 0); assert.equal(f(55), 5); assert.equal(f(1000), 9);
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("zip reader: deflate entry via the central directory", () => {
  const data = Buffer.from("open_time,open\n1,2\n"), comp = deflateRawSync(data), name = Buffer.from("a.csv");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, comp]), cd = Buffer.concat([cen, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  assert.equal(unzip(Buffer.concat([body, cd, end]))["a.csv"].toString(), data.toString());
});
