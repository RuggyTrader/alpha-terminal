#!/bin/sh
# Installs the hourly cron entry for this user (idempotent). Requires `crontab` + a running cron daemon.
set -e
command -v crontab >/dev/null || { echo "crontab not installed" >&2; exit 1; }
D=/workspace/ruggy/alpha-terminal/collector/jupiter_forward
LINE="7 * * * * /usr/bin/python3 -I $D/collect.py >> /workspace/ruggy/data/jupiter/cron.log 2>&1 # jupiter-forward"
( crontab -l 2>/dev/null | grep -v '# jupiter-forward' ; echo "$LINE" ) | crontab -
crontab -l | grep jupiter-forward
