#!/usr/bin/env bash
# Mac (or Linux) development test runner. Development only: it never starts the PAPER engine, never contacts the
# production Worker and reads no secrets. The Windows PC remains the only production engine host.
#   scripts/mac-test.sh            # engine + research, frontend tests + build, worker (needs the frontend build)
#   scripts/mac-test.sh research   # research suites only (fast)
set -euo pipefail
cd "$(dirname "$0")/.."
# Node 22+ (installed per-user in ~/.local/node on the Mac continuation machine; any Node 22+ on PATH also works)
[ -x "$HOME/.local/node/bin/node" ] && export PATH="$HOME/.local/node/bin:$PATH"
node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("Node 22+ required"); process.exit(1) }'

if [ "${1:-}" = "research" ]; then
  (cd engine && node --test test/r7-backtester.test.mjs test/r8-*.test.mjs test/forward-shadow.test.mjs test/research-*.test.mjs)
  exit 0
fi
(cd engine && npm test)
(cd frontend && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm test && npm run build)
(cd worker && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm test)
