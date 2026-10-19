# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
[CmdletBinding()]
param([string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab'), [ValidateRange(0,3600)][int]$KeepAliveSeconds = 0)
$ErrorActionPreference = 'Stop'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $labPath 'manifest.json') | ConvertFrom-Json
if ($manifest.root -ne $labPath -or (Get-Content -Raw -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab')).Trim() -ne $manifest.owner) { throw 'Private lab ownership mismatch.' }
$runtime = [IO.Path]::GetFullPath($manifest.runtime)
$executable = Join-Path $runtime 'firebird.exe'
if (-not $runtime.StartsWith($labPath + '\runtime\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime escapes the owned lab.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -ne $manifest.extractedComponentHashes.'firebird.exe') { throw 'Server executable changed since extraction.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtime 'firebird.conf')).Hash.ToLowerInvariant() -ne $manifest.configSha256) { throw 'Private configuration changed since preparation.' }
$statePath = Join-Path $labPath 'server-state.json'
if (Test-Path -LiteralPath $statePath) {
  $old = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $oldProcess = Get-Process -Id $old.processId -ErrorAction SilentlyContinue
  if ($oldProcess -and $oldProcess.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$old.startedAtUtc).ToUniversalTime().Ticks) { throw 'The recorded lab process is still running.' }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$manifest.port)
try { $listener.Start() } finally { $listener.Stop() }
$environment = @{}
foreach ($item in Get-ChildItem Env:) { if ($item.Name -like 'ISC_*' -or $item.Name -like 'FIREBIRD*' -or $item.Name -in @('TEMP','TMP')) { $environment[$item.Name] = $item.Value } }
try {
  foreach ($name in @($environment.Keys)) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
  $env:FIREBIRD = $runtime
  $env:FIREBIRD_LOCK = Join-Path $labPath 'locks'
  $env:FIREBIRD_TMP = Join-Path $labPath 'temp'
  $env:TEMP = Join-Path $labPath 'temp'
  $env:TMP = Join-Path $labPath 'temp'
  # Firebird 3's -p override bypasses RemoteBindAddress; use only the private config port.
  $process = Start-Process -FilePath $executable -ArgumentList @('-a','-n','-i','-s',$manifest.instance) -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $labPath 'logs\server.stdout.txt') -RedirectStandardError (Join-Path $labPath 'logs\server.stderr.txt')
} finally {
  foreach ($name in @('FIREBIRD','FIREBIRD_LOCK','FIREBIRD_TMP','TEMP','TMP')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
  foreach ($name in $environment.Keys) { Set-Item -LiteralPath "Env:$name" -Value $environment[$name] }
}
$state = [ordered]@{ owner=$manifest.owner; executable=$executable; processId=$process.Id; startedAtUtc=$process.StartTime.ToUniversalTime().ToString('o'); arguments=@('-a','-n','-i','-s',$manifest.instance); host=$manifest.host; port=$manifest.port; installedAsService=$false }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) { throw 'Private Firebird server exited; inspect its private logs.' }
  $socket = [Net.Sockets.TcpClient]::new()
  try { $socket.Connect('127.0.0.1', [int]$manifest.port); $ready = $true; break } catch { Start-Sleep -Milliseconds 200 } finally { $socket.Dispose() }
}
if (-not $ready) { & (Join-Path $PSScriptRoot 'stop-firebird3-client-lab.ps1') -LabRoot $labPath; throw 'Private server failed readiness within 15 seconds.' }
try {
  $bindings = @(Get-NetTCPConnection -LocalPort ([int]$manifest.port) -State Listen -ErrorAction Stop)
  if ($bindings.Count -ne 1 -or $bindings[0].LocalAddress -ne '127.0.0.1' -or $bindings[0].OwningProcess -ne $process.Id) {
    throw 'Private listener must belong to this exact PID and bind only IPv4 loopback.'
  }
} catch {
  & (Join-Path $PSScriptRoot 'stop-firebird3-client-lab.ps1') -LabRoot $labPath
  throw
}
$state['listenerAddress'] = $bindings[0].LocalAddress
$state['listenerOwned'] = $true
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
[pscustomobject]@{ started=$true; processId=$process.Id; host='127.0.0.1'; port=$manifest.port; statePath=$statePath; connectionFile=(Join-Path $labPath 'private\connection.json') } | ConvertTo-Json

if ($KeepAliveSeconds -gt 0) {
  $keepAliveDeadline = [DateTime]::UtcNow.AddSeconds($KeepAliveSeconds)
  try {
    while (-not $process.WaitForExit(1000)) {
      if ([DateTime]::UtcNow -ge $keepAliveDeadline) { break }
    }
  } finally {
    $process.Refresh()
    if (-not $process.HasExited) { & (Join-Path $PSScriptRoot 'stop-firebird3-client-lab.ps1') -LabRoot $labPath }
  }
}