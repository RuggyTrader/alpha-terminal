"""Repository safety scan. Exit code 1 on any finding.

    python scripts/security_scan.py            (run after `npm run build`)

Checks:
 1. No Alpaca trading host other than paper-api.alpaca.markets anywhere.
 2. No hidden live-mode switches in code (env names / flags).
 3. Frontend bundle contains no secret names or secret values from .env.
 4. No .env file is tracked by git; .env is ignored.
 5. No credential-looking strings committed in source files.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "data"}
TEXT_EXT = {".py", ".ts", ".tsx", ".js", ".json", ".md", ".toml", ".txt", ".html", ".css", ".yml", ".yaml", ".example",
            ".webmanifest", ""}

findings: list[str] = []


def files(base: Path):
    for p in base.rglob("*"):
        if p.is_file() and not any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
            if p.suffix in TEXT_EXT or p.name.startswith(".env") or p.name == "Dockerfile":
                yield p


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return ""


# 1. Alpaca hosts: the only trading host allowed is paper-api.alpaca.markets
host_re = re.compile(r"(?<![\w.-])((?:[\w-]+\.)*alpaca\.markets)")
ALLOWED_HOSTS = {"paper-api.alpaca.markets", "data.alpaca.markets", "app.alpaca.markets", "docs.alpaca.markets"}
for p in files(ROOT):
    if p.name == "security_scan.py":
        continue
    for m in host_re.finditer(read(p)):
        if m.group(1) not in ALLOWED_HOSTS:
            findings.append(f"non-paper Alpaca host {m.group(1)!r} in {p.relative_to(ROOT)}")

# 2. Hidden live mode: switches that would select a non-paper account
live_re = re.compile(r"(LIVE_TRADING|TRADING_MODE|ALPACA_LIVE|paper\s*=\s*False|USE_LIVE|IS_LIVE|live_mode)", re.I)
for p in files(ROOT / "backend"):
    if "tests" in p.parts:
        continue
    for m in live_re.finditer(read(p)):
        findings.append(f"possible live-mode switch {m.group(0)!r} in {p.relative_to(ROOT)}")
for p in files(ROOT / "frontend" / "src"):
    for m in live_re.finditer(read(p)):
        findings.append(f"possible live-mode switch {m.group(0)!r} in {p.relative_to(ROOT)}")

# 3. Frontend bundle
dist = ROOT / "frontend" / "dist"
secret_names = ["ALPACA_KEY", "ALPACA_SECRET", "WEBHOOK_SECRET", "ADMIN_SECRET", "APCA-API-KEY-ID", "APCA-API-SECRET-KEY"]
secret_values: list[str] = []
env_file = ROOT / ".env"
if env_file.exists():
    for line in read(env_file).splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            if k.strip() in ("ALPACA_KEY", "ALPACA_SECRET", "WEBHOOK_SECRET", "ADMIN_SECRET") and len(v.strip()) >= 8:
                secret_values.append(v.strip())
if not dist.exists():
    findings.append("frontend/dist missing: run `npm run build` before the scan")
else:
    for p in dist.rglob("*"):
        if not p.is_file():
            continue
        text = p.read_bytes().decode("utf-8", "ignore")
        for name in secret_names:
            if name in text:
                findings.append(f"secret name {name} in bundle {p.relative_to(ROOT)}")
        for value in secret_values:
            if value in text:
                findings.append(f"a secret VALUE from .env appears in bundle {p.relative_to(ROOT)}")
        if "alpaca.markets" in text:
            findings.append(f"bundle references Alpaca directly: {p.relative_to(ROOT)}")
        if re.search(r"localStorage\.setItem\([^)]*(secret|token|password)", text, re.I):
            findings.append(f"bundle stores a credential in localStorage: {p.relative_to(ROOT)}")

# 4. git hygiene
try:
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()  # noqa: S607
    for t in tracked:
        if Path(t).name.startswith(".env") and Path(t).name != ".env.example":
            findings.append(f"env file tracked by git: {t}")
    ignored = subprocess.run(["git", "check-ignore", ".env"], cwd=ROOT, capture_output=True, text=True)  # noqa: S607
    if ignored.returncode != 0:
        findings.append(".env is not git-ignored")
except (OSError, subprocess.CalledProcessError):
    findings.append("git not available; could not verify tracked files")

# 5. credential-looking strings in source (not tests, not .env)
cred_res = [
    re.compile(r"\b(PK|AK)[A-Z0-9]{18,}\b"),  # Alpaca key id shape
    re.compile(r"(secret|password|api[_-]?key)\s*[:=]\s*[\"'][A-Za-z0-9_\-]{24,}[\"']", re.I),
]
for p in files(ROOT):
    rel = p.relative_to(ROOT)
    if p.name == ".env" or "tests" in rel.parts or p.name == "security_scan.py":
        continue
    text = read(p)
    for rx in cred_res:
        for m in rx.finditer(text):
            findings.append(f"credential-like string in {rel}: {m.group(0)[:12]}…")

if findings:
    print("SECURITY SCAN: FAIL")
    for f in findings:
        print(" -", f)
    sys.exit(1)
print("SECURITY SCAN: PASS")
print(f" - checked Alpaca hosts, live-mode switches, frontend bundle ({len(secret_values)} .env secret values compared), git hygiene")
