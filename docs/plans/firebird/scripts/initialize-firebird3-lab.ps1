# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
<#
.SYNOPSIS
Prepares a private, hash-pinned Firebird 3 x64 ZIP runtime. Downloads occur only with -Download.
#>
[CmdletBinding()]
param(
  [string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-lab'),
  [switch]$Download
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This pinned runtime is for Windows x64.' }
$archiveName = 'Firebird-3.0.14.33856-0-x64.zip'
$expectedHash = 'A070BC5633F9FB5AD261D87D19276324679E8EC77AFB03A2BEC056BA7E2D2DAD'
$releaseApi = 'https://api.github.com/repos/FirebirdSQL/firebird/releases/tags/v3.0.14'
$assetUrl = "https://github.com/FirebirdSQL/firebird/releases/download/v3.0.14/$archiveName"
function Assert-PlainPath([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Lab path cannot traverse a reparse point: $cursor" }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
$labPath = [IO.Path]::GetFullPath($LabRoot)
if ([IO.Path]::GetPathRoot($labPath).TrimEnd('\') -eq $labPath.TrimEnd('\')) { throw 'LabRoot cannot be a drive root.' }
Assert-PlainPath $labPath
New-Item -ItemType Directory -Path $labPath -Force | Out-Null
$archivePath = Join-Path $labPath $archiveName

if ($Download) {
  if (Test-Path -LiteralPath $archivePath) { throw 'Archive already exists. Verify it offline instead of overwriting it.' }
  $release = Invoke-RestMethod -Uri $releaseApi -Headers @{ 'User-Agent' = 'Prisma-Firebird-Disposable-Lab' }
  $asset = @($release.assets | Where-Object name -eq $archiveName)
  if ($asset.Count -ne 1 -or $asset[0].browser_download_url -ne $assetUrl -or $asset[0].digest -ne "sha256:$($expectedHash.ToLowerInvariant())") {
    throw 'Official release metadata differs from the pinned URL or digest.'
  }
  $release | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $labPath 'release-metadata.json') -Encoding utf8
  Invoke-WebRequest -Uri $assetUrl -OutFile $archivePath
}
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Archive missing. Run this bootstrap separately with -Download, or supply the hash-matching official ZIP.' }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
if ($actualHash -ne $expectedHash) { throw "Archive SHA-256 mismatch: $actualHash" }

$runtimePath = Join-Path $labPath 'runtime\firebird-3.0.14-x64'
$runtimePrefix = [IO.Path]::GetFullPath($runtimePath).TrimEnd('\') + '\'
$ownershipMarker = Join-Path $runtimePath '.prisma-firebird-lab-runtime'
Assert-PlainPath $runtimePath
if ((Test-Path -LiteralPath $runtimePath) -and -not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)) { throw 'Refusing to adopt or reconfigure an existing unowned runtime directory.' }
if (-not (Test-Path -LiteralPath $runtimePath)) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    foreach ($entry in $zip.Entries) {
      $entryTarget = [IO.Path]::GetFullPath((Join-Path $runtimePath $entry.FullName))
      if (-not $entryTarget.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes the private runtime.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $runtimePath)
}

$required = @('isql.exe', 'fbclient.dll', 'plugins\engine12.dll', 'firebird.msg', 'msvcr100.dll', 'msvcp100.dll')
foreach ($relative in $required) {
  Assert-PlainPath (Join-Path $runtimePath $relative)
  if (-not (Test-Path -LiteralPath (Join-Path $runtimePath $relative) -PathType Leaf)) { throw "Runtime component missing: $relative" }
}
$runtimeHashes = [ordered]@{}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($relative in $required) {
    $entry = @($zip.Entries | Where-Object { $_.FullName.Replace('/', '\') -eq $relative })
    if ($entry.Count -ne 1) { throw "Archive component is ambiguous or absent: $relative" }
    $stream = $entry[0].Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }
    $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtimePath $relative)).Hash
    if ($fileHash -ne $entryHash) { throw "Runtime component differs from the hash-verified archive: $relative" }
    $runtimeHashes[$relative] = $fileHash.ToLowerInvariant()
  }
} finally { $zip.Dispose() }
$isqlPath = Join-Path $runtimePath 'isql.exe'
$peBytes = [IO.File]::ReadAllBytes($isqlPath)
$peOffset = [BitConverter]::ToInt32($peBytes, 0x3c)
$machine = [BitConverter]::ToUInt16($peBytes, $peOffset + 4)
if ($machine -ne 0x8664) { throw 'isql.exe is not an AMD64 PE binary.' }
if ((Get-Item -LiteralPath $isqlPath).VersionInfo.ProductVersion -ne '3.0.14.33856') { throw 'Unexpected isql product version.' }

foreach ($name in @('runs', 'locks', 'temp')) { New-Item -ItemType Directory -Path (Join-Path $labPath $name) -Force | Out-Null }
$configPath = Join-Path $runtimePath 'firebird.conf'
$aliasesPath = Join-Path $runtimePath 'databases.conf'
Assert-PlainPath $configPath
Assert-PlainPath $aliasesPath
if (-not (Test-Path -LiteralPath $ownershipMarker)) {
  Copy-Item -LiteralPath $configPath -Destination (Join-Path $runtimePath 'firebird.conf.distribution')
  Copy-Item -LiteralPath $aliasesPath -Destination (Join-Path $runtimePath 'databases.conf.distribution')
  'Private extracted runtime; no service or registry installation.' | Set-Content -LiteralPath $ownershipMarker -Encoding ascii
}
$config = @"
# Private disposable lab. Remote and loopback providers are deliberately absent.
Providers = Engine12
DatabaseAccess = Restrict $(Join-Path $labPath 'runs')
ExternalFileAccess = None
UdfAccess = None
TempDirectories = $(Join-Path $labPath 'temp')
SecurityDatabase = $(Join-Path $runtimePath 'security3.fdb')
"@
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($aliasesPath, '# No aliases: the lab uses only newly created absolute database paths.', [Text.UTF8Encoding]::new($false))

$manifest = [ordered]@{
  schemaVersion = 1
  purpose = 'Disposable Firebird database semantics probes; not Prisma CRUD'
  releaseApi = $releaseApi
  releasePage = 'https://github.com/FirebirdSQL/firebird/releases/tag/v3.0.14'
  officialDownloadPage = 'https://firebirdsql.org/en/firebird-3-0/'
  assetUrl = $assetUrl
  archiveName = $archiveName
  archiveBytes = (Get-Item -LiteralPath $archivePath).Length
  archiveSha256 = $actualHash.ToLowerInvariant()
  runtime = $runtimePath
  isqlVersion = (Get-Item -LiteralPath $isqlPath).VersionInfo.FileVersion
  peMachine = 'AMD64 (0x8664)'
  runtimeFileHashes = $runtimeHashes
  providers = @('Engine12')
  configSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash.ToLowerInvariant()
  preparedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $labPath 'lab-manifest.json') -Encoding utf8
$manifest | ConvertTo-Json -Depth 8
