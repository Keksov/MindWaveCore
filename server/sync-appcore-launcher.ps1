<#
  AP1.2: sync the AppCore launcher binaries (AppMain.exe + libwebview.dll) into
  this server folder, next to app.cfg, so AppMain.exe auto-loads app.cfg and
  launches MindWave via AppCore.

  Binaries are SYNC-ONLY (AP-D7a): they are gitignored here; re-run this after
  (re)building AppCore. Default source is the sibling Games/AppCore prebuilt bin.
#>
[CmdletBinding()]
param(
  [string]$AppCoreBin
)

$ErrorActionPreference = 'Stop'
if (-not $AppCoreBin) {
  $AppCoreBin = Join-Path $PSScriptRoot '..\..\..\Games\AppCore\build\win_x64\bin'
}
if (-not (Test-Path -LiteralPath $AppCoreBin)) {
  throw "AppCore bin not found: $AppCoreBin (build AppCore or pass -AppCoreBin <path>)"
}

foreach ($file in @('AppMain.exe', 'libwebview.dll')) {
  $src = Join-Path $AppCoreBin $file
  if (-not (Test-Path -LiteralPath $src)) { throw "missing AppCore artifact: $src" }
  Copy-Item -LiteralPath $src -Destination (Join-Path $PSScriptRoot $file) -Force
  Write-Host ("  synced {0}" -f $file)
}

# The synced bin\AppMain.exe is generic (no embedded icon). Stamp this deployment's
# AppCore.ico into it (overlay-safe) so Explorer / taskbar / pinned shortcuts show the
# right icon - mirrors AppCore build_app.bat's deploy stamping.
$icon    = Join-Path $PSScriptRoot 'AppCore.ico'
$stamper = Join-Path $AppCoreBin 'IconStamp.exe'
$exe     = Join-Path $PSScriptRoot 'AppMain.exe'
if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath $stamper)) {
  & $stamper $exe $icon
  Write-Host '  stamped icon from AppCore.ico'
} else {
  Write-Host '  (no AppCore.ico or IconStamp.exe next to AppCore bin - skipped icon stamping)'
}

Write-Host 'Done. Run AppMain.exe in this folder (it auto-loads app.cfg) to launch MindWave.'
