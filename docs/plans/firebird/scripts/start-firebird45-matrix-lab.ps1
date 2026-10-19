# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.4
<# Application-mode keeper. No service/guardian, -p override, registry or global env. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet(4,5)][int]$Major,
    [Parameter(Mandatory)][string]$LabRoot,
    [ValidateRange(15,3600)][int]$KeepAliveSeconds = 900
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'firebird45-matrix-native-common.ps1')
$context = Read-MatrixLab $Major $LabRoot
Assert-MatrixNoOtherRuntime
$statePath = Assert-MatrixChild $context.Lab (Join-Path $context.Lab 'server-state.json')
if (Test-Path -LiteralPath $statePath) { throw 'This one-shot matrix runtime has a previous state receipt. Retain it; prepare a separately reviewed fresh root for a new lifecycle.' }
$bindings = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $context.Candidate.port)
if ($bindings.Count) { throw 'The matrix port is already in use.' }
$start = New-MatrixProcessInfo $context.Executable $context.Runtime $context.Lab
# Tagged Windows parser: -a application, -n no tray, -i IPv4/IPv6 TCP provider,
# -s separate instance mutex. No -p: bind/port come only from the verified config.
foreach ($argument in @('-a', '-n', '-i', '-s', $context.Manifest.instance)) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$stdoutFile = $null
$stderrFile = $null
$copyOut = $null
$copyErr = $null
$started = $false
$stateWritten = $false
$createdIdentity = $null
function Stop-HeldMatrixChild {
    $process.Refresh()
    if ($process.HasExited) { return }
    if (-not $createdIdentity -or $process.Id -ne $createdIdentity.processId -or $process.Path -ine $createdIdentity.executable -or $createdIdentity.executable -ine $context.Executable -or $process.StartTime.ToUniversalTime().Ticks -ne $createdIdentity.startTimeTicks) { throw 'Held child identity changed; refusing fallback termination.' }
    # Use only the Process object returned by this invocation's Start(), without
    # trusting a changed marker/state file or looking up any replacement PID.
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'Held owned child termination could not be confirmed.' }
}
try {
    $stdoutFile = [IO.File]::Open((Join-Path $context.Lab 'logs\server.stdout.bin'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $stderrFile = [IO.File]::Open((Join-Path $context.Lab 'logs\server.stderr.bin'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    [void]$process.Start()
    $started = $true
    $createdIdentity = [pscustomobject]@{ processId = $process.Id; executable = $process.Path; startTimeTicks = $process.StartTime.ToUniversalTime().Ticks }
    $copyOut = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
    $copyErr = $process.StandardError.BaseStream.CopyToAsync($stderrFile)
    $state = [ordered]@{ owner = $context.Manifest.owner; root = $context.Lab; executable = $context.Executable; processId = $process.Id; startedAtUtc = $process.StartTime.ToUniversalTime().ToString('o'); host = '127.0.0.1'; port = $context.Candidate.port; arguments = @('-a', '-n', '-i', '-s', $context.Manifest.instance); listenerOwned = $false; installedAsService = $false; keepAliveSeconds = $KeepAliveSeconds }
    Write-MatrixJson $statePath $state -New
    $stateWritten = $true
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $ready = $false
    while ([DateTime]::UtcNow -lt $readyDeadline) {
        $process.Refresh()
        if ($process.HasExited) { throw 'Private matrix server exited during startup; retain its owned logs.' }
        $bindings = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $process.Id -or $_.LocalPort -eq $context.Candidate.port })
        if ($bindings.Count) {
            if ($bindings.Count -ne 1 -or $bindings[0].OwningProcess -ne $process.Id -or $bindings[0].LocalAddress -cne '127.0.0.1' -or $bindings[0].LocalPort -ne $context.Candidate.port) { throw 'The owned PID must expose exactly its single reserved IPv4-loopback listener.' }
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'Private matrix listener was not ready within 15 seconds.' }
    $state.listenerOwned = $true
    $state['listenerAddress'] = $bindings[0].LocalAddress
    Write-MatrixJson $statePath $state
    [pscustomobject]@{ started = $true; owner = $context.Manifest.owner; major = $Major; processId = $process.Id; host = '127.0.0.1'; port = $context.Candidate.port; statePath = $statePath; expiresAtUtc = [DateTime]::UtcNow.AddSeconds($KeepAliveSeconds).ToString('o'); engineHandshakeNotYetTested = $true; supportAccepted = $false } | ConvertTo-Json
    $deadline = [DateTime]::UtcNow.AddSeconds($KeepAliveSeconds)
    while (-not $process.WaitForExit(5000)) {
        if ([DateTime]::UtcNow -ge $deadline) { break }
        $bindings = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $process.Id -or $_.LocalPort -eq $context.Candidate.port })
        if ($bindings.Count -ne 1 -or $bindings[0].OwningProcess -ne $process.Id -or $bindings[0].LocalAddress -cne '127.0.0.1' -or $bindings[0].LocalPort -ne $context.Candidate.port) { throw 'Owned matrix listener changed during the bounded lifecycle.' }
    }
} finally {
    try {
        if ($started) {
            if ($stateWritten) {
                try { & (Join-Path $PSScriptRoot 'stop-firebird45-matrix-lab.ps1') -Major $Major -LabRoot $context.Lab }
                catch {
                    $stopFailure = $_
                    try {
                        Stop-HeldMatrixChild
                        Write-Warning 'Recorded stop validation failed; the originally created held child is confirmed gone. Preserving the stop error.'
                    } catch {
                        Write-Warning ('Held-child fallback also failed: ' + $_.Exception.Message)
                    }
                    throw $stopFailure
                }
            }
            else { Stop-HeldMatrixChild }
            if ($copyOut) { $copyOut.GetAwaiter().GetResult() }
            if ($copyErr) { $copyErr.GetAwaiter().GetResult() }
        }
    } finally {
        if ($stdoutFile) { $stdoutFile.Dispose() }
        if ($stderrFile) { $stderrFile.Dispose() }
        $process.Dispose()
    }
}
