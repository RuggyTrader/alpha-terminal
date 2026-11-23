@echo off
rem Read-only P1 study: one public order-book sample (run.log), then the forward PAPER engine (paper.log). No orders, no keys.
set GAP_STUDY_END=2026-12-23T02:00:00Z
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" collect-gap.mjs data >> run.log 2>&1
"C:\Program Files\nodejs\node.exe" paper-engine.mjs . >> paper.log 2>&1
