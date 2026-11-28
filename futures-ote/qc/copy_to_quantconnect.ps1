# Copies each QuantConnect project file to the clipboard, one at a time, for pasting into the web IDE.
#
#   powershell -ExecutionPolicy Bypass -File qc\copy_to_quantconnect.ps1                           # all files
#   powershell -ExecutionPolicy Bypass -File qc\copy_to_quantconnect.ps1 -Only at_config.py,at_build.py
#
# For each file: in the QuantConnect project, create (or open) the file with exactly the name shown, select all of its
# contents, paste, save, then press Enter here for the next file. Nothing is uploaded by this script; it only uses the
# clipboard. main.py verifies every file's SHA-256 in the cloud and stops if any paste differs.
param([string[]]$Only)
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "cloud"
$order = @("main.py", "at_build.py", "at_config.py", "at_stream.py") + (Get-ChildItem $dir -Filter *.py | Where-Object { $_.Name -notin @("main.py", "at_build.py", "at_config.py", "at_stream.py") } | Sort-Object Name | ForEach-Object { $_.Name })
if ($Only) { $order = $order | Where-Object { $_ -in $Only } }
$i = 0
foreach ($name in $order) {
    $i++
    $text = [IO.File]::ReadAllText((Join-Path $dir $name), [Text.Encoding]::UTF8)
    Set-Clipboard -Value $text
    $lines = ($text -split "`n").Count
    Read-Host "[$i/$($order.Count)] $name ($lines lines) is on the clipboard. Paste it into the QuantConnect file '$name', save, then press Enter"
}
Set-Clipboard -Value ""
"Done: $($order.Count) file(s). In QuantConnect, the project should hold exactly these .py files plus research.ipynb."
