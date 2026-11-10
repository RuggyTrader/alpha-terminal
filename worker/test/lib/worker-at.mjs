// The Worker exactly as committed at a git ref (code, wrangler.jsonc and migrations; tests excluded), in a temporary
// folder, with node_modules and the frontend linked from this checkout. Used where a test must run a released Worker
// or apply only the migrations that release shipped (e.g. 8b188c8 = the deployed e941387e, migrations 0001-0004).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_DIR = join(HERE, "..", "..");
const REPO = join(DEV_DIR, "..");
const WIN = process.platform === "win32";

/** The commit deployed to production as Worker version e941387e on 2026-11-10 (schema 4). */
export const DEPLOYED_REF = "8b188c8";

export function workerAt(ref, root = mkdtempSync(join(tmpdir(), `alpha-worker-${ref}-`))) {
  for (const f of execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", ref, "worker"], { encoding: "utf8" }).trim().split("\n")) {
    if (f.startsWith("worker/test/")) continue;
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), execFileSync("git", ["-C", REPO, "show", `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  const link = (target, path) => (WIN ? execFileSync("cmd", ["/c", "mklink", "/J", path, target], { stdio: "ignore" }) : execFileSync("ln", ["-s", target, path]));
  link(join(DEV_DIR, "node_modules"), join(root, "worker", "node_modules"));
  link(join(REPO, "frontend"), join(root, "frontend"));
  return join(root, "worker");
}
