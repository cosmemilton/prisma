# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
<#
.SYNOPSIS
Read-only validation of an already obtained official Firebird 4/5 ZIP candidate.
Does not download, extract, configure, start/stop a process, or connect to a database.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet(4,5)][int]$Major,
  [Parameter(Mandatory)][string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 PowerShell is required.' }
$catalog = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\matrix\firebird45-candidates.json') | ConvertFrom-Json
$candidate = @($catalog.candidates | Where-Object major -eq $Major)
if ($candidate.Count -ne 1) { throw 'The pinned matrix candidate is ambiguous.' }
$candidate = $candidate[0]
$archive = [IO.Path]::GetFullPath($ArchivePath)
if ([IO.Path]::GetFileName($archive) -cne $candidate.archive) { throw 'The archive filename differs from the pinned candidate.' }
$cursor = $archive
while ($cursor) {
  if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Archive paths must not traverse reparse points.' }
  $cursor = [IO.Path]::GetDirectoryName($cursor)
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'Supply the already downloaded official ZIP. This helper never downloads.' }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
if ($actual -cne $candidate.sha256) { throw 'The archive SHA-256 differs from the pinned official metadata.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
  foreach ($name in $names) {
    if ($name.StartsWith('/') -or $name -match '^[a-zA-Z]:' -or $name.Split('/') -contains '..') { throw 'Unsafe archive entry; refuse future extraction.' }
  }
  foreach ($required in @('firebird.exe', 'isql.exe', 'fbclient.dll', "security$Major.fdb")) {
    if (@($names | Where-Object { $_ -ieq $required }).Count -ne 1) { throw "Missing or duplicated portable runtime entry: $required" }
  }
  [ordered]@{
    classification = 'ARCHIVE_INPUT_VERIFIED_NOT_RUNTIME_OR_COMPATIBILITY_ACCEPTANCE'
    major = $Major
    archive = $candidate.archive
    bytes = (Get-Item -LiteralPath $archive).Length
    sha256 = $actual
    entryCount = $names.Count
    plannedPort = $candidate.port
    metadataSource = $candidate.metadataUrl
    downloaded = $false
    extracted = $false
    serverStarted = $false
    databaseConnected = $false
  } | ConvertTo-Json
} finally { $zip.Dispose() }
