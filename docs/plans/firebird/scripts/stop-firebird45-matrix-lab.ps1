# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet(4,5)][int]$Major,
    [Parameter(Mandatory)][string]$LabRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'firebird45-matrix-native-common.ps1')
$context = Read-MatrixLab $Major $LabRoot -ForStop
$statePath = Assert-MatrixChild $context.Lab (Join-Path $context.Lab 'server-state.json')
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$process = Get-MatrixOwnedProcess $context $state
$forced = $false
if ($process) {
    try {
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(3000)) {
            $forced = $true
            $process.Kill() # Exact verified owned PID only; never a name/tree/service kill.
            if (-not $process.WaitForExit(5000)) { throw 'Owned server termination could not be confirmed.' }
        }
    } finally { $process.Dispose() }
}
$remaining = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $context.Candidate.port)
$receipt = [ordered]@{ owner = $context.Manifest.owner; root = $context.Lab; major = $Major; processId = $state.processId; startedAtUtc = $state.startedAtUtc; stoppedAtUtc = [DateTime]::UtcNow.ToString('o'); processGone = $true; listenerAbsent = ($remaining.Count -eq 0); forcedOwnedProcessTermination = $forced; databasesRetained = $true; otherProcessesTouched = $false; servicesChanged = $false; supportAccepted = $false }
Write-MatrixJson (Join-Path $context.Lab ('stop-' + $state.processId + '-' + [Guid]::NewGuid().ToString('N') + '.json')) $receipt -New
if ($remaining.Count) { throw 'The owned PID is gone, but the reserved port has a listener; no other process will be stopped.' }
$receipt | ConvertTo-Json
