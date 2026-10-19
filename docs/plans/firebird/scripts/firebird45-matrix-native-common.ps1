# Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
# Dot-sourced only by the three version-pinned native matrix lifecycle helpers.
# No top-level process, database, environment, network or filesystem mutation.
Set-StrictMode -Version Latest

function Assert-MatrixWindows {
    if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Native Windows x64 PowerShell 7+ is required.' }
}

function Get-MatrixCandidate([int]$Major) {
    $catalog = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\matrix\firebird45-candidates.json') | ConvertFrom-Json
    $matches = @($catalog.candidates | Where-Object major -eq $Major)
    if ($matches.Count -ne 1 -or $Major -notin @(4, 5)) { throw 'Select exactly one pinned Firebird 4/5 candidate.' }
    $candidate = $matches[0]
    if (($Major -eq 4 -and $candidate.port -ne 3054) -or ($Major -eq 5 -and $candidate.port -ne 3055)) { throw 'Unexpected matrix endpoint.' }
    return $candidate
}

function Assert-MatrixPlainPath([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\' -or $Path -match '[\x00-\x1f"''#;{}]' -or $Path.Substring(2).Contains(':')) { throw 'Use an absolute native drive path without configuration/SQL metacharacters.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($part in $full.Substring(3).Split('\')) {
        if (-not $part -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'Ambiguous Windows path segment.' }
    }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed in matrix paths.' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Assert-MatrixChild([string]$Root, [string]$Path) {
    $full = Assert-MatrixPlainPath $Path
    if (-not $full.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes the owned matrix root.' }
    return $full
}

function Write-MatrixJson([string]$Path, [object]$Value, [switch]$New) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 15) + "`n")
    $mode = if ($New) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Create }
    $stream = [IO.File]::Open($Path, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes) } finally { $stream.Dispose() }
}

function Get-MatrixHash([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Assert-MatrixNoOtherRuntime {
    # Both tagged Windows sources use a fixed FirebirdCommon kernel namespace.
    # Refuse overlap; never kill, stop services or delete global locks to proceed.
    $conflicts = @(Get-Process -Name firebird, fbserver, fb_inet_server, fbguard, isql -ErrorAction SilentlyContinue)
    if ($conflicts.Count) { throw 'Another Firebird/isql process is active. Its owner must finish it before this sequential matrix runtime starts.' }
}

function New-MatrixProcessInfo([string]$Executable, [string]$Runtime, [string]$Lab) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.WorkingDirectory = $Runtime
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($key in @($info.Environment.Keys)) {
        if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$info.Environment.Remove($key) }
    }
    $info.Environment['FIREBIRD'] = $Runtime
    $info.Environment['FIREBIRD_LOCK'] = Join-Path $Lab 'locks'
    $info.Environment['FIREBIRD_TMP'] = Join-Path $Lab 'temp'
    $info.Environment['TEMP'] = Join-Path $Lab 'temp'
    $info.Environment['TMP'] = Join-Path $Lab 'temp'
    $info.Environment['PATH'] = $Runtime + ';' + (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot
    return $info
}

function Read-MatrixLab([int]$Major, [string]$LabRoot, [switch]$ForStop) {
    Assert-MatrixWindows
    $candidate = Get-MatrixCandidate $Major
    $lab = Assert-MatrixPlainPath $LabRoot
    if ([IO.Path]::GetFileName($lab) -cne $candidate.suggestedLabDirectory) { throw 'Use the version-specific reserved matrix directory name.' }
    $manifestPath = Assert-MatrixChild $lab (Join-Path $lab 'manifest.json')
    $markerPath = Assert-MatrixChild $lab (Join-Path $lab '.prisma-firebird-matrix-lab')
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $marker = [IO.File]::ReadAllText($markerPath).Trim()
    if ($manifest.owner -notmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $marker -cne $manifest.owner -or $manifest.root -cne $lab -or $manifest.major -ne $Major -or -not $manifest.syntheticOnly -or -not $manifest.nativeLocalFilesystem) { throw 'Matrix ownership/namespace mismatch.' }
    if ($manifest.host -cne '127.0.0.1' -or $manifest.port -ne $candidate.port -or $manifest.archiveSha256 -cne $candidate.sha256) { throw 'Matrix candidate/endpoint changed.' }
    $runtime = Assert-MatrixChild $lab $manifest.runtime
    $expectedRuntime = Join-Path $lab ('runtime\firebird-' + $candidate.build + '-x64')
    if ($runtime -cne $expectedRuntime) { throw 'Unexpected private extraction path.' }
    foreach ($name in @('db', 'private', 'logs', 'locks', 'temp')) { [void](Assert-MatrixChild $lab (Join-Path $lab $name)) }
    $executable = Assert-MatrixChild $runtime (Join-Path $runtime 'firebird.exe')
    if ((Get-MatrixHash $executable) -cne $manifest.immutableComponentHashes.'firebird.exe') { throw 'Owned server executable changed.' }
    if (-not $ForStop) {
        foreach ($property in $manifest.immutableComponentHashes.PSObject.Properties) {
            $file = Assert-MatrixChild $runtime (Join-Path $runtime $property.Name)
            if ((Get-MatrixHash $file) -cne $property.Value) { throw 'An observed private runtime component changed.' }
        }
        foreach ($property in $manifest.configurationHashes.PSObject.Properties) {
            $file = Assert-MatrixChild $runtime (Join-Path $runtime $property.Name)
            if ((Get-MatrixHash $file) -cne $property.Value) { throw 'The private server configuration changed.' }
        }
        if ($manifest.prepared -ne $true) { throw 'Matrix bootstrap has not completed.' }
    }
    return [pscustomobject]@{ Lab = $lab; Runtime = $runtime; Executable = $executable; Manifest = $manifest; Candidate = $candidate }
}

function Get-MatrixOwnedProcess([object]$Context, [object]$State) {
    if ($State.owner -cne $Context.Manifest.owner -or $State.root -cne $Context.Lab -or $State.executable -cne $Context.Executable) { throw 'Server state ownership mismatch.' }
    $process = Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue
    if ($process) {
        if ($process.Path -ine $Context.Executable -or $process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$State.startedAtUtc).ToUniversalTime().Ticks) { throw 'Recorded PID was reused or its executable changed; refusing to stop it.' }
    }
    return $process
}
