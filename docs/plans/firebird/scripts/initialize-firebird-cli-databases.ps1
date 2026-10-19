# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
[CmdletBinding()]
param([string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab'))
$ErrorActionPreference = 'Stop'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $labPath 'manifest.json') | ConvertFrom-Json
if ($manifest.root -ne $labPath -or (Get-Content -Raw -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab')).Trim() -ne $manifest.owner) { throw 'Private lab ownership mismatch.' }
$runtime = [IO.Path]::GetFullPath($manifest.runtime)
if (-not $runtime.StartsWith($labPath + '\runtime\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime escapes the owned lab.' }
$isql = Join-Path $runtime 'isql.exe'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $isql).Hash.ToLowerInvariant() -ne $manifest.extractedComponentHashes.'isql.exe') { throw 'The pinned isql executable changed.' }
$server = Get-Content -Raw -LiteralPath (Join-Path $labPath 'server-state.json') | ConvertFrom-Json
$process = Get-Process -Id $server.processId -ErrorAction Stop
if ($process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$server.startedAtUtc).ToUniversalTime().Ticks) { throw 'The recorded lab server process changed.' }
$bindings = @(Get-NetTCPConnection -LocalPort ([int]$manifest.port) -State Listen -ErrorAction Stop)
if ($bindings.Count -ne 1 -or $bindings[0].LocalAddress -ne '127.0.0.1' -or $bindings[0].OwningProcess -ne $process.Id) { throw 'The server must own the exact private IPv4-loopback listener.' }
$private = Join-Path $labPath 'private'
$main = Get-Content -Raw -LiteralPath (Join-Path $private 'connection.json') | ConvertFrom-Json -AsHashtable
if ($main.host -ne '127.0.0.1' -or $main.port -eq 3050) { throw 'Use only the private non-default loopback port.' }
$receiptPath = Join-Path $labPath 'cli-databases.json'
$existing = if (Test-Path -LiteralPath $receiptPath) { Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json } else { $null }
if ($existing -and $existing.owner -ne $manifest.owner) { throw 'CLI database receipt ownership mismatch.' }
$databases = [ordered]@{}
foreach ($name in @('cli-main', 'cli-shadow', 'cli-replay', 'cli-pull', 'cli-reset')) {
    $database = [IO.Path]::GetFullPath((Join-Path $labPath "db\$name.fdb"))
    if (-not $database.StartsWith($labPath + '\db\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Database path escapes the owned lab.' }
    if (Test-Path -LiteralPath $database) {
        if (-not $existing -or $existing.databases.$name -ne $database) { throw 'An existing database has no matching owned receipt; inspect it instead of adopting it.' }
    } else {
        $connectionName = "127.0.0.1/$($main.port):$database".Replace("'", "''")
        $userSql = ([string]$main.user).Replace("'", "''")
        $passwordSql = ([string]$main.password).Replace("'", "''")
        $inputPath = Join-Path $private "create-$name.sql"
        $sql = "SET SQL DIALECT 3;`nSET NAMES UTF8;`nCREATE DATABASE '$connectionName' USER '$userSql' PASSWORD '$passwordSql' PAGE_SIZE 16384 DEFAULT CHARACTER SET UTF8;`nCOMMIT;`nQUIT;`n"
        [IO.File]::WriteAllText($inputPath, $sql, [Text.UTF8Encoding]::new($false))
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $isql
        $start.WorkingDirectory = $runtime
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($argument in @('-bail', '-quiet', '-charset', 'UTF8', '-sql', '3', '-input', $inputPath)) { $start.ArgumentList.Add($argument) }
        foreach ($key in @($start.Environment.Keys)) { if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($key) } }
        $start.Environment['FIREBIRD'] = $runtime
        $start.Environment['FIREBIRD_LOCK'] = Join-Path $labPath 'locks'
        $start.Environment['FIREBIRD_TMP'] = Join-Path $labPath 'temp'
        $start.Environment['TEMP'] = Join-Path $labPath 'temp'
        $start.Environment['TMP'] = Join-Path $labPath 'temp'
        $creator = [Diagnostics.Process]::new()
        $creator.StartInfo = $start
        try {
            [void]$creator.Start()
            $stdout = $creator.StandardOutput.ReadToEndAsync()
            $stderr = $creator.StandardError.ReadToEndAsync()
            if (-not $creator.WaitForExit(30000)) { $creator.Kill(); [void]$creator.WaitForExit(5000); throw 'Private database creation timed out.' }
            $outText = $stdout.GetAwaiter().GetResult().Replace([string]$main.password, '[REDACTED]')
            $errText = $stderr.GetAwaiter().GetResult().Replace([string]$main.password, '[REDACTED]')
            [IO.File]::WriteAllText((Join-Path $labPath "logs\create-$name.stdout.txt"), $outText)
            [IO.File]::WriteAllText((Join-Path $labPath "logs\create-$name.stderr.txt"), $errText)
            if ($creator.ExitCode -ne 0) { throw 'Private database creation failed; inspect the redacted lab log.' }
        } finally {
            $creator.Dispose()
            if (Test-Path -LiteralPath $inputPath) { Remove-Item -LiteralPath $inputPath }
        }
    }
    $databases[$name] = $database
    [ordered]@{ owner = $manifest.owner; databases = $databases; syntheticOnly = $true; host = '127.0.0.1'; port = $main.port; servicesChanged = $false; preparedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
}
$connections = [ordered]@{}
foreach ($name in $databases.Keys) {
    $copy = @{} + $main
    $copy.database = $databases[$name]
    $connections[$name] = $copy
}
$connections | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $private 'cli-connections.json') -Encoding utf8
[ordered]@{ owner = $manifest.owner; databases = $databases; syntheticOnly = $true; host = '127.0.0.1'; port = $main.port; servicesChanged = $false; preparedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
[pscustomobject]@{ prepared = $true; databaseCount = $databases.Count; syntheticOnly = $true; privateConnections = 'private/cli-connections.json'; receipt = $receiptPath } | ConvertTo-Json
