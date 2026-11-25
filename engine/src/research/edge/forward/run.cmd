@echo off
rem READ-ONLY forward observation of the SOL open-interest reversal. Public data only; no wallet, no keys, no trading.
rem One run per invocation; memory capped at 128 MB; output appended to run.log.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" --max-old-space-size=128 collect.mjs data >> run.log 2>&1
