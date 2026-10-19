# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
[CmdletBinding()]
param([string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab'))
$ErrorActionPreference = 'Stop'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $labPath 'manifest.json') | ConvertFrom-Json
$statePath = Join-Path $labPath 'server-state.json'
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($manifest.root -ne $labPath -or $state.owner -ne $manifest.owner -or (Get-Content -Raw -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab')).Trim() -ne $manifest.owner) { throw 'Private lab ownership mismatch.' }
$expectedExecutable = [IO.Path]::GetFullPath((Join-Path $manifest.runtime 'firebird.exe'))
if (-not $expectedExecutable.StartsWith($labPath + '\runtime\', [StringComparison]::OrdinalIgnoreCase) -or $state.executable -ne $expectedExecutable) { throw 'Private executable ownership mismatch.' }
$process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
if ($process) {
  if ($process.Path -ne $expectedExecutable -or $process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$state.startedAtUtc).ToUniversalTime().Ticks) { throw 'PID was reused or does not belong to this lab; refusing to stop it.' }
  [void]$process.CloseMainWindow()
  if (-not $process.WaitForExit(3000)) { $process.Kill(); if (-not $process.WaitForExit(5000)) { throw 'Private process termination was not confirmed.' } }
}
$state | Add-Member -NotePropertyName stoppedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
[pscustomobject]@{ stopped=$true; processId=$state.processId; databaseRetained=$true; otherProcessesTouched=$false } | ConvertTo-Json
