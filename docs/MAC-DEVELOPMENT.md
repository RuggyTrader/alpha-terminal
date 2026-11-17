# Developing ALPHA TERMINAL on a Mac (secondary workstation)

The Windows PC runs the only production PAPER engine. **On the Mac:**
- **Never** start `engine` (`npm start` / `src/cli/run.mjs`) against production.
- **Never** copy `engine.env`.
- **Never** run Windows `.bat` / `.ps1` / Task Scheduler scripts.

The Mac is for code, tests, research, frontend previews and isolated tooling.

## Setup (done on 2026-11-17)

- **Node 22 LTS**, per user, in `~/.local/node`. It is the official nodejs.org tarball, checked against `SHASUMS256.txt`.
  Add it to your shell when wanted: `export PATH="$HOME/.local/node/bin:$PATH"`.
  The session did not edit `~/.zprofile`.
- **Dependencies** from the lockfiles: `npm ci` in `worker/` and `frontend/`. `engine/` has no dependencies.
- **Python 3.9** (system) is enough for the repo's helper scripts. The research code is Node.

## Commands

```bash
scripts/mac-test.sh research   # research suites only (seconds)
scripts/mac-test.sh            # engine, frontend (tests + build), worker
cd frontend && npm run dev     # local frontend preview (no production calls without a session)
```

**Order matters.** The worker suite needs `frontend/dist`, so build the frontend before the Worker tests. Run in the
other order, the dashboard-proof tests fail with `frontend/dist missing`.

## Known Mac limitations

- `engine/test`: the "real launcher" test is skipped (Windows launcher).
- **No `wrangler login`.** Read-only production checks need the owner's Cloudflare OAuth on this machine, or the PC.
- **No exchange APIs.** This Claude Code session's sandbox refuses `api.exchange.coinbase.com` and `api.kraken.com`, so
  research data downloads and the forward collector must run where those hosts are allowed.
