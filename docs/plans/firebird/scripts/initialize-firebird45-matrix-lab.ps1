# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.4
<#
.SYNOPSIS
After separate owner authorization, extracts one already downloaded pinned ZIP and
bootstraps only its private security database and two new empty synthetic databases.
Does not download, install a service, edit registry/global environment, or start TCP.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet(4,5)][int]$Major,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$LabRoot,
    [Parameter(Mandatory)][switch]$CreateSyntheticLab
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'firebird45-matrix-native-common.ps1')
Assert-MatrixWindows
if (-not $CreateSyntheticLab) { throw 'Explicit CreateSyntheticLab is required.' }
$candidate = Get-MatrixCandidate $Major
$lab = Assert-MatrixPlainPath $LabRoot
$archive = Assert-MatrixPlainPath $ArchivePath
if ([IO.Path]::GetFileName($lab) -cne $candidate.suggestedLabDirectory) { throw 'Use the reserved version-specific matrix root name.' }
if ([IO.Path]::GetFileName($archive) -cne $candidate.archive) { throw 'The archive filename is not the pinned candidate.' }
if (Test-Path -LiteralPath $lab) { throw 'Existing roots are never adopted, overwritten or cleaned up.' }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($lab)) -PathType Container)) { throw 'The new lab parent must already exist.' }
Assert-MatrixNoOtherRuntime
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $candidate.port)
if ($listeners.Count) { throw 'The reserved matrix port already has a listener.' }

# Validate the actual archive before creating a root. Component/layout assertions
# below are future input requirements, not claims that this ZIP has been opened.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveStream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $archiveHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($archiveStream)).ToLowerInvariant()
    if ($archiveHash -cne $candidate.sha256) { throw 'The ZIP does not match the pinned official SHA-256.' }
    $archiveStream.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
} catch { $archiveStream.Dispose(); throw }
$inventory = [Collections.Generic.List[object]]::new()
try {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$expanded = 0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or $name -match '[\x00-\x1f]' -or -not $seen.Add($name.TrimEnd('/'))) { throw 'Rooted, alternate-stream or duplicate Windows ZIP entry.' }
        foreach ($segment in $name.TrimEnd('/').Split('/')) {
            if (-not $segment -or $segment -in @('.', '..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe Windows ZIP path segment.' }
        }
        $attributes = [uint32]([long]$entry.ExternalAttributes -band 0xffffffffL)
        if (($attributes -band 0x400) -or ((($attributes -shr 16) -band 0xf000) -eq 0xa000)) { throw 'ZIP links/reparse points are not eligible.' }
        $expanded += $entry.Length
        if ($expanded -gt 2GB -or $seen.Count -gt 10000) { throw 'Unexpected archive expansion bounds.' }
        if (-not $name.EndsWith('/')) {
            $stream = $entry.Open()
            try { $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() } finally { $stream.Dispose() }
            $inventory.Add([ordered]@{ path = $name; bytes = $entry.Length; sha256 = $digest })
        }
    }
    foreach ($required in @('firebird.exe', 'isql.exe', 'fbclient.dll', 'firebird.conf', 'databases.conf', 'plugins.conf', 'plugins/engine13.dll', 'plugins/srp.dll', 'firebird.msg', "security$Major.fdb")) {
        if (@($inventory | Where-Object path -ieq $required).Count -ne 1) { throw "The actual ZIP lacks the expected tagged-source runtime contract: $required. Review rather than substitute a component." }
    }

    New-Item -ItemType Directory -Path $lab | Out-Null
    # Protect the entire lab, including the security database and diagnostic logs.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $lab -AclObject $acl
    $owner = [Guid]::NewGuid().ToString()
    [IO.File]::WriteAllText((Join-Path $lab '.prisma-firebird-matrix-lab'), $owner + "`n", [Text.UTF8Encoding]::new($false))
    foreach ($name in @('runtime', 'db', 'logs', 'locks', 'temp', 'private')) { New-Item -ItemType Directory -Path (Join-Path $lab $name) | Out-Null }
    $runtime = Join-Path $lab ('runtime\firebird-' + $candidate.build + '-x64')
    New-Item -ItemType Directory -Path $runtime | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = Assert-MatrixChild $runtime (Join-Path $runtime $entry.FullName)
        if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { [void][IO.Directory]::CreateDirectory($target) }
        else {
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    }
} finally { $zip.Dispose() }

$immutable = [ordered]@{}
foreach ($item in $inventory) {
    $file = Assert-MatrixChild $runtime (Join-Path $runtime $item.path)
    if ((Get-MatrixHash $file) -cne $item.sha256) { throw 'Extracted bytes differ from the verified ZIP stream.' }
    if ($item.path -match '(?i)\.(exe|dll|dat)$' -or $item.path -eq 'firebird.msg') { $immutable[$item.path] = $item.sha256 }
}
$version = (Get-Item -LiteralPath (Join-Path $runtime 'firebird.exe')).VersionInfo
$observedBuild = '{0}.{1}.{2}.{3}' -f $version.FileMajorPart, $version.FileMinorPart, $version.FileBuildPart, $version.FilePrivatePart
if ($observedBuild -cne $candidate.build) { throw 'The observed server executable version differs from the pinned build.' }
Write-MatrixJson (Join-Path $lab 'archive-inventory.json') ([ordered]@{ owner = $owner; archive = $candidate.archive; sha256 = $candidate.sha256; files = $inventory.ToArray(); observedExecutableBuild = $observedBuild }) -New
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$instance = 'PrismaMatrix' + $Major + $owner.Replace('-', '').Substring(0, 16)
$security = Join-Path $runtime "security$Major.fdb"
$configuration = @"
# Owned synthetic matrix only; no default service, global aliases or fallback providers.
DatabaseAccess = Restrict $(Join-Path $lab 'db')
ExternalFileAccess = None
UdfAccess = None
TempDirectories = $(Join-Path $lab 'temp')
SecurityDatabase = $security
AuthServer = Srp256
AuthClient = Srp256
UserManager = Srp
WireCrypt = Required
RemoteBindAddress = 127.0.0.1
RemoteServiceName = $instance
RemoteServicePort = $($candidate.port)
IpcName = $instance
ServerMode = Super
"@
$configPath = Join-Path $runtime 'firebird.conf'
[IO.File]::WriteAllText($configPath, $configuration + "`nProviders = Engine13`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $runtime 'databases.conf'), "security.db = $security`n{`nRemoteAccess = false`n}`n", [Text.UTF8Encoding]::new($false))
$databases = [ordered]@{ client = (Join-Path $lab 'db\matrix-client.fdb'); guard = (Join-Path $lab 'db\matrix-guard.fdb') }
$bootstrap = @'
SET SQL DIALECT 3;
SET NAMES UTF8;
CREATE DATABASE '{0}' USER 'SYSDBA' PAGE_SIZE 16384 DEFAULT CHARACTER SET UTF8;
CREATE OR ALTER USER SYSDBA PASSWORD '{1}' USING PLUGIN Srp;
COMMIT;
SET LIST ON;
SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS ENGINE_VERSION FROM RDB$DATABASE;
SELECT COUNT(*) AS USER_TABLES FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0;
SELECT COUNT(*) AS USER_GENERATORS FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0;
COMMIT;
DISCONNECT;
CREATE DATABASE '{2}' USER 'SYSDBA' PASSWORD '{1}' PAGE_SIZE 16384 DEFAULT CHARACTER SET UTF8;
SET LIST ON;
SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS ENGINE_VERSION FROM RDB$DATABASE;
SELECT COUNT(*) AS USER_TABLES FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0;
SELECT COUNT(*) AS USER_GENERATORS FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0;
COMMIT;
QUIT;
'@ -f $databases.client.Replace("'", "''"), $password, $databases.guard.Replace("'", "''")
$inputPath = Join-Path $lab ('private\bootstrap-' + $owner + '.sql')
$inputBytes = [Text.UTF8Encoding]::new($false).GetBytes($bootstrap)
$stream = [IO.File]::Open($inputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($inputBytes) } finally { $stream.Dispose() }
$inputHash = Get-MatrixHash $inputPath
$start = New-MatrixProcessInfo (Join-Path $runtime 'isql.exe') $runtime $lab
foreach ($argument in @('-bail', '-quiet', '-user', 'SYSDBA', '-charset', 'UTF8', '-sql', '3', '-input', $inputPath)) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); if (-not $process.WaitForExit(5000)) { throw 'Owned isql termination could not be confirmed.' }; throw 'Owned isql bootstrap timed out.' }
    $outText = $stdout.GetAwaiter().GetResult().Replace($password, '[REDACTED]')
    $errText = $stderr.GetAwaiter().GetResult().Replace($password, '[REDACTED]')
    [IO.File]::WriteAllText((Join-Path $lab 'logs\bootstrap.stdout.txt'), $outText, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $lab 'logs\bootstrap.stderr.txt'), $errText, [Text.UTF8Encoding]::new($false))
    if ($process.ExitCode -ne 0) { throw 'Private bootstrap failed; retain the owned lab for diagnosis and inspect its redacted logs.' }
    if ([regex]::Matches($outText, ('(?m)^ENGINE_VERSION\s+' + [regex]::Escape($candidate.version) + '\s*$')).Count -ne 2 -or [regex]::Matches($outText, '(?m)^USER_TABLES\s+0\s*$').Count -ne 2 -or [regex]::Matches($outText, '(?m)^USER_GENERATORS\s+0\s*$').Count -ne 2) { throw 'Both fresh empty databases and exact engine version were not confirmed.' }
} finally {
    $process.Dispose()
    if (Test-Path -LiteralPath $inputPath) {
        [void](Assert-MatrixChild $lab $inputPath)
        if ((Get-MatrixHash $inputPath) -cne $inputHash) { throw 'Owned private input changed; refusing to delete it.' }
        Remove-Item -LiteralPath $inputPath
    }
}
foreach ($database in $databases.Values) { if (-not (Test-Path -LiteralPath (Assert-MatrixChild $lab $database) -PathType Leaf)) { throw 'An expected new database is missing.' } }
[IO.File]::WriteAllText($configPath, $configuration + "`nProviders = Remote, Engine13`n", [Text.UTF8Encoding]::new($false))
$connections = [ordered]@{}
foreach ($role in $databases.Keys) { $connections[$role] = [ordered]@{ host = '127.0.0.1'; port = $candidate.port; database = $databases[$role]; user = 'SYSDBA'; password = $password; lowercase_keys = $false; encoding = 'UTF8'; pluginName = 'Srp256'; wireCrypt = 1 } }
Write-MatrixJson (Join-Path $lab 'private\connections.json') $connections -New
$configHashes = [ordered]@{}
foreach ($name in @('firebird.conf', 'databases.conf', 'plugins.conf')) { $configHashes[$name] = Get-MatrixHash (Join-Path $runtime $name) }
$manifest = [ordered]@{ schemaVersion = 1; classification = 'ISOLATED_MATRIX_INFRASTRUCTURE_NOT_PROVIDER_SUPPORT'; owner = $owner; root = $lab; syntheticOnly = $true; nativeLocalFilesystem = $true; major = $Major; host = '127.0.0.1'; port = $candidate.port; archive = $candidate.archive; archiveSha256 = $candidate.sha256; runtime = $runtime; instance = $instance; securityDatabase = $security; databases = $databases; immutableComponentHashes = $immutable; configurationHashes = $configHashes; provider = 'Engine13'; authentication = 'Srp256'; wireCrypt = 'Required'; defaultCipherListRetained = $true; prepared = $true; preparedAtUtc = [DateTime]::UtcNow.ToString('o'); serverStarted = $false; serviceOrRegistryChanged = $false; supportAccepted = $false }
Write-MatrixJson (Join-Path $lab 'manifest.json') $manifest -New
[pscustomobject]@{ prepared = $true; owner = $owner; major = $Major; root = $lab; host = '127.0.0.1'; port = $candidate.port; freshEmptyDatabases = 2; serverStarted = $false; supportAccepted = $false } | ConvertTo-Json
