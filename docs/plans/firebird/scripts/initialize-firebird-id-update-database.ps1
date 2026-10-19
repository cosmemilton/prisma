# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab')
)
$ErrorActionPreference = 'Stop'
$Role = 'id-updates'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $labPath 'manifest.json') | ConvertFrom-Json
$marker = (Get-Content -Raw -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab')).Trim()
if ($manifest.root -ne $labPath -or $manifest.owner -ne $marker -or $manifest.host -ne '127.0.0.1' -or $manifest.port -ne 3059) { throw 'Owned Firebird 3 laboratory mismatch.' }
$state = Get-Content -Raw -LiteralPath (Join-Path $labPath 'server-state.json') | ConvertFrom-Json
if ($state.owner -ne $marker -or -not $state.stoppedAtUtc) { throw 'Root must stop the owned server before embedded provisioning.' }
$recordedProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
$recordedPidReused = $false
if ($recordedProcess) {
    $observedExecutable = $recordedProcess.Path
    if (-not $observedExecutable) { throw 'Recorded PID executable identity is unavailable; nothing created.' }
    $observedStartedAtUtc = $recordedProcess.StartTime.ToUniversalTime()
    $sameExecutable = [string]::Equals($observedExecutable, [string]$state.executable, [StringComparison]::OrdinalIgnoreCase)
    $sameStart = $observedStartedAtUtc.Ticks -eq ([DateTime]$state.startedAtUtc).ToUniversalTime().Ticks
    if ($sameExecutable -and $sameStart) { throw 'Recorded owned server identity is still alive; nothing created.' }
    $recordedPidReused = $true
}
if (@(Get-NetTCPConnection -State Listen -LocalPort 3059 -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Private port is not free; nothing created.' }
$runtime = [IO.Path]::GetFullPath($manifest.runtime)
if (-not $runtime.StartsWith($labPath + '\runtime\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime escapes the owned lab.' }
$expectedServerExecutable = Join-Path $runtime 'firebird.exe'
if (-not [string]::Equals([string]$state.executable, $expectedServerExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Recorded server executable does not match the owned runtime.' }
$ownedRuntimeProcesses = @(Get-Process -Name firebird -ErrorAction SilentlyContinue | Where-Object { [string]::Equals($_.Path, $expectedServerExecutable, [StringComparison]::OrdinalIgnoreCase) })
if ($ownedRuntimeProcesses.Count -ne 0) { throw 'An owned runtime Firebird process is still present; nothing created.' }
foreach ($name in @('isql.exe', 'plugins\engine12.dll', 'fbclient.dll')) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtime $name)).Hash.ToLowerInvariant() -ne $manifest.extractedComponentHashes.$name) { throw 'Pinned embedded runtime changed.' }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtime 'firebird.conf')).Hash.ToLowerInvariant() -ne $manifest.configSha256) { throw 'Owned runtime configuration changed.' }
$database = Join-Path $labPath "db\$Role.fdb"
$privatePath = Join-Path $labPath "private\$Role-connection.json"
$receiptName = 'id-updates-database.json'
$receiptPath = Join-Path $labPath $receiptName
foreach ($target in @($database, $privatePath, $receiptPath)) {
    if (Test-Path -LiteralPath $target) { throw 'Milestone 6 fixture already exists; never adopt, delete or recreate it.' }
}
$main = Get-Content -Raw -LiteralPath (Join-Path $labPath 'private\connection.json') | ConvertFrom-Json -AsHashtable
if ($main.host -ne '127.0.0.1' -or $main.port -ne 3059 -or -not $main.user -or -not $main.password) { throw 'Private connection template mismatch.' }
$sqlPath = Join-Path $labPath ('private\create-' + $Role + '-' + [Guid]::NewGuid().ToString('N') + '.sql')
$databaseSql = $database.Replace("'", "''")
$userSql = ([string]$main.user).Replace("'", "''")
$passwordSql = ([string]$main.password).Replace("'", "''")
$sql = "SET SQL DIALECT 3;`nSET NAMES UTF8;`nCREATE DATABASE '$databaseSql' USER '$userSql' PASSWORD '$passwordSql' PAGE_SIZE 16384 DEFAULT CHARACTER SET UTF8;`nCOMMIT;`nQUIT;`n"
$creator = [Diagnostics.Process]::new()
$creator.StartInfo = [Diagnostics.ProcessStartInfo]::new()
$start = $creator.StartInfo
$start.FileName = Join-Path $runtime 'isql.exe'
$start.WorkingDirectory = $runtime
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in @('-bail', '-quiet', '-charset', 'UTF8', '-sql', '3', '-input', $sqlPath)) { $start.ArgumentList.Add($argument) }
foreach ($key in @($start.Environment.Keys)) {
    if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($key) }
}
$start.Environment['FIREBIRD'] = $runtime
$start.Environment['FIREBIRD_LOCK'] = Join-Path $labPath 'locks'
$start.Environment['FIREBIRD_TMP'] = Join-Path $labPath 'temp'
$start.Environment['TEMP'] = Join-Path $labPath 'temp'
$start.Environment['TMP'] = Join-Path $labPath 'temp'
function Write-NewUtf8([string]$Target, [string]$Text) {
    $stream = [IO.FileStream]::new($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
try {
    Write-NewUtf8 $sqlPath $sql
    [void]$creator.Start()
    $outTask = $creator.StandardOutput.ReadToEndAsync()
    $errTask = $creator.StandardError.ReadToEndAsync()
    if (-not $creator.WaitForExit(30000)) { $creator.Kill(); [void]$creator.WaitForExit(5000); throw 'Owned embedded creation timed out.' }
    $outText = $outTask.GetAwaiter().GetResult()
    $errText = $errTask.GetAwaiter().GetResult()
    foreach ($token in @([string]$main.password, [string]$main.user, $database)) { $outText = $outText.Replace($token, '<REDACTED>'); $errText = $errText.Replace($token, '<REDACTED>') }
    Write-NewUtf8 (Join-Path $labPath "logs\create-$Role.stdout.txt") $outText
    Write-NewUtf8 (Join-Path $labPath "logs\create-$Role.stderr.txt") $errText
    if ($creator.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Embedded creation failed; retain any partial file and inspect redacted lab logs.' }
    $copy = @{} + $main
    $copy.database = $database
    $connections = [ordered]@{}
    $connections[$Role] = $copy
    Write-NewUtf8 $privatePath (($connections | ConvertTo-Json -Depth 8) + "`n")
    $receipt = [ordered]@{ schemaVersion = 1; milestone = 6; owner = $marker; root = $labPath; database = $database; role = $Role; syntheticOnly = $true; freshDatabaseCreated = $true; host = '127.0.0.1'; port = 3059; embeddedOfficialIsql = $true; serverWasStopped = $true; recordedPidReused = $recordedPidReused; reusedProcessTouched = $false; existingDatabaseAdopted = $false; databaseDropped = $false; servicesChanged = $false; privateConnection = "private/$Role-connection.json"; preparedAtUtc = [DateTime]::UtcNow.ToString('o') }
    Write-NewUtf8 $receiptPath (($receipt | ConvertTo-Json -Depth 8) + "`n")
    [pscustomobject]@{ prepared = $true; role = $Role; syntheticOnly = $true; embeddedOfficialIsql = $true; servicesChanged = $false; receipt = $receiptPath } | ConvertTo-Json
} finally {
    $creator.Dispose()
    if (Test-Path -LiteralPath $sqlPath) { Remove-Item -LiteralPath $sqlPath }
}
