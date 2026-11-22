' Runs the read-only cost-study collector without a console window; output goes to run.log.
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("Process")
env("COST_STUDY_END") = "2026-11-29T19:45:00Z"
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """"C:\Program Files\nodejs\node.exe"" """ & dir & "\collect.mjs"" """ & dir & "\data"" >> """ & dir & "\run.log"" 2>&1"""
sh.Run cmd, 0, False
