# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
<#
.SYNOPSIS
Creates an isolated Firebird 3 TCP fixture from the existing hash-pinned ZIP.
No installer, service, registry, existing database, or existing runtime is used.
#>
[CmdletBinding()]
param(
  [string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab'),
  [string]$ArchivePath = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-lab\Firebird-3.0.14.33856-0-x64.zip'),
  [ValidateRange(1024,65535)][int]$Port = 3059
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 PowerShell is required.' }
$expectedHash = 'a070bc5633f9fb5ad261d87d19276324679e8ec77afb03a2bec056ba7e2d2dad'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$archive = [IO.Path]::GetFullPath($ArchivePath)
function Assert-PlainPath([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse point is not allowed: $cursor" }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
Assert-PlainPath $labPath
Assert-PlainPath $archive
if ([IO.Path]::GetPathRoot($labPath).TrimEnd('\') -eq $labPath) { throw 'LabRoot cannot be a volume root.' }
if (Test-Path -LiteralPath $labPath) { throw 'A new directory is required; an existing lab is never adopted or overwritten.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'The official ZIP SHA-256 differs from the pinned digest.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } finally { $listener.Stop() }
New-Item -ItemType Directory -Path $labPath | Out-Null
$owner = [Guid]::NewGuid().ToString('N')
$owner | Set-Content -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab') -Encoding ascii
foreach ($directory in @('runtime', 'db', 'logs', 'locks', 'temp', 'private')) { New-Item -ItemType Directory -Path (Join-Path $labPath $directory) | Out-Null }
$private = Join-Path $labPath 'private'
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', $inherit, 'None', 'Allow'))
Set-Acl -LiteralPath $private -AclObject $acl
$runtime = Join-Path $labPath 'runtime\firebird-3.0.14-x64'
$runtimePrefix = $runtime.TrimEnd('\') + '\'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::GetFullPath((Join-Path $runtime $entry.FullName))
    if (-not $target.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP entry escapes the private runtime.' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $runtime)
$runtimeHashes = [ordered]@{}
foreach ($name in @('firebird.exe','isql.exe','fbclient.dll','plugins\engine12.dll','plugins\srp.dll','security3.fdb','firebird.msg','msvcr100.dll','msvcp100.dll')) {
  $path = Join-Path $runtime $name
  Assert-PlainPath $path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Private component is absent: $name" }
  $runtimeHashes[$name] = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}
if ((Get-Item -LiteralPath (Join-Path $runtime 'firebird.exe')).VersionInfo.ProductVersion -ne '3.0.14.33856') { throw 'Unexpected Firebird server product version.' }
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$passwordFile = Join-Path $private 'sysdba-password.txt'
[IO.File]::WriteAllText($passwordFile, $password + "`n", [Text.UTF8Encoding]::new($false))
$database = Join-Path $labPath 'db\client-synthetic.fdb'
$instance = 'PrismaClientLab' + $owner.Substring(0, 12)
$security = Join-Path $runtime 'security3.fdb'
$commonConfig = @"
# Disposable TCP client lab; this file belongs only to its private extraction.
DatabaseAccess = Restrict $(Join-Path $labPath 'db')
ExternalFileAccess = None
UdfAccess = None
TempDirectories = $(Join-Path $labPath 'temp')
SecurityDatabase = $security
AuthServer = Srp256, Srp
AuthClient = Srp256, Srp
UserManager = Srp
WireCrypt = Required
RemoteBindAddress = 127.0.0.1
RemoteServiceName = $instance
RemoteServicePort = $Port
IpcName = $instance
ServerMode = Super
"@
$configPath = Join-Path $runtime 'firebird.conf'
[IO.File]::WriteAllText($configPath, $commonConfig + "`nProviders = Engine12`n", [Text.UTF8Encoding]::new($false))
$aliases = @"
security.db = $security
{
  RemoteAccess = false
  DefaultDbCachePages = 50
}
"@
[IO.File]::WriteAllText((Join-Path $runtime 'databases.conf'), $aliases, [Text.UTF8Encoding]::new($false))
$dbSql = $database.Replace("'", "''")
$bootstrapSql = @"
SET SQL DIALECT 3;
SET NAMES UTF8;
CREATE DATABASE '$dbSql' USER 'SYSDBA' DEFAULT CHARACTER SET UTF8;
CREATE USER SYSDBA PASSWORD '$password' USING PLUGIN Srp;
COMMIT;
CREATE TABLE "User" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "email" VARCHAR(255) CHARACTER SET UTF8 NOT NULL,
  "name" VARCHAR(255) CHARACTER SET UTF8,
  "balance" DECIMAL(18,4),
  "bigValue" BIGINT,
  "createdAt" TIMESTAMP,
  "dateValue" DATE,
  "timeValue" TIME,
  "active" BOOLEAN,
  "bytes" BLOB SUB_TYPE BINARY,
  CONSTRAINT "User_email_key" UNIQUE ("email")
);
CREATE TABLE "Post" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "title" VARCHAR(255) CHARACTER SET UTF8 NOT NULL,
  "content" BLOB SUB_TYPE TEXT CHARACTER SET UTF8,
  "published" BOOLEAN,
  "authorId" INTEGER NOT NULL,
  CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id")
);
COMMIT;
SET LIST ON;
SELECT RDB`$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS ENGINE_VERSION FROM RDB`$DATABASE;
SELECT COUNT(*) AS USER_ROWS FROM "User";
SELECT COUNT(*) AS POST_ROWS FROM "Post";
COMMIT;
QUIT;
"@
$input = Join-Path $private 'bootstrap.sql'
[IO.File]::WriteAllText($input, $bootstrapSql, [Text.UTF8Encoding]::new($false))
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $runtime 'isql.exe'
$start.WorkingDirectory = $runtime
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($arg in @('-bail','-quiet','-user','SYSDBA','-charset','UTF8','-sql','3','-input',$input)) { $start.ArgumentList.Add($arg) }
foreach ($key in @($start.Environment.Keys)) { if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($key) } }
$start.Environment['FIREBIRD'] = $runtime
$start.Environment['FIREBIRD_LOCK'] = Join-Path $labPath 'locks'
$start.Environment['FIREBIRD_TMP'] = Join-Path $labPath 'temp'
$start.Environment['TEMP'] = Join-Path $labPath 'temp'
$start.Environment['TMP'] = Join-Path $labPath 'temp'
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) { $process.Kill(); [void]$process.WaitForExit(5000); throw 'Private bootstrap isql timed out.' }
  $outText = $stdout.GetAwaiter().GetResult().Replace($password, '[REDACTED]')
  $errText = $stderr.GetAwaiter().GetResult().Replace($password, '[REDACTED]')
  [IO.File]::WriteAllText((Join-Path $labPath 'logs\bootstrap.stdout.txt'), $outText)
  [IO.File]::WriteAllText((Join-Path $labPath 'logs\bootstrap.stderr.txt'), $errText)
  if ($process.ExitCode -ne 0) { throw 'Private schema/security bootstrap failed; inspect the redacted logs.' }
} finally {
  $process.Dispose()
  if (Test-Path -LiteralPath $input) { Remove-Item -LiteralPath $input }
}
[IO.File]::WriteAllText($configPath, $commonConfig + "`nProviders = Remote, Engine12`n", [Text.UTF8Encoding]::new($false))
$connection = [ordered]@{ host='127.0.0.1'; port=$Port; database=$database; user='SYSDBA'; password=$password; lowercase_keys=$false; role=$null; pageSize=4096; encoding='UTF8'; pluginName='Srp256'; wireCrypt=1 }
$connection | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $private 'connection.json') -Encoding utf8
$manifest = [ordered]@{ schemaVersion=1; classification='DISPOSABLE_FIREBIRD_TCP_INFRASTRUCTURE_NOT_PRISMA_CRUD'; owner=$owner; root=$labPath; runtime=$runtime; database=$database; host='127.0.0.1'; port=$Port; instance=$instance; archiveSha256=$expectedHash; extractedComponentHashes=$runtimeHashes; configSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash.ToLowerInvariant(); preparedAtUtc=[DateTime]::UtcNow.ToString('o'); credentialFile='private/connection.json'; passwordPublished=$false; existingServiceOrRegistryMutation=$false }
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $labPath 'manifest.json') -Encoding utf8
[pscustomobject]@{ prepared=$true; manifest=(Join-Path $labPath 'manifest.json'); privateConnectionFile=(Join-Path $private 'connection.json'); database=$database; host='127.0.0.1'; port=$Port } | ConvertTo-Json
