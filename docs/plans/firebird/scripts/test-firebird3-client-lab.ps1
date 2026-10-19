# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
[CmdletBinding()]
param([string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-client-lab'))
$ErrorActionPreference = 'Stop'
$labPath = [IO.Path]::GetFullPath($LabRoot).TrimEnd('\')
$manifest = Get-Content -Raw -LiteralPath (Join-Path $labPath 'manifest.json') | ConvertFrom-Json
$state = Get-Content -Raw -LiteralPath (Join-Path $labPath 'server-state.json') | ConvertFrom-Json
if ($manifest.root -ne $labPath -or $state.owner -ne $manifest.owner -or (Get-Content -Raw -LiteralPath (Join-Path $labPath '.prisma-firebird-client-lab')).Trim() -ne $manifest.owner) { throw 'Private lab ownership mismatch.' }
$runtime = [IO.Path]::GetFullPath($manifest.runtime)
if (-not $runtime.StartsWith($labPath + '\runtime\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime escapes the owned lab.' }
$process = Get-Process -Id $state.processId -ErrorAction Stop
if ($process.Path -ne (Join-Path $runtime 'firebird.exe') -or $process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$state.startedAtUtc).ToUniversalTime().Ticks) { throw 'Private server PID ownership mismatch.' }
$sql = @'
SET LIST ON;
SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS ENGINE_VERSION FROM RDB$DATABASE;
SELECT MON$REMOTE_PROTOCOL AS REMOTE_PROTOCOL, MON$REMOTE_ADDRESS AS REMOTE_ADDRESS, MON$AUTH_METHOD AS AUTH_METHOD FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = CURRENT_CONNECTION;
SELECT COUNT(*) AS USER_ROWS FROM "User";
SELECT COUNT(*) AS POST_ROWS FROM "Post";
SELECT TRIM(RF.RDB$RELATION_NAME) AS TABLE_NAME, TRIM(RF.RDB$FIELD_NAME) AS COLUMN_NAME, F.RDB$FIELD_TYPE AS TYPE_CODE, F.RDB$FIELD_SUB_TYPE AS SUB_TYPE, F.RDB$FIELD_SCALE AS SCALE_VALUE FROM RDB$RELATION_FIELDS RF JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = RF.RDB$FIELD_SOURCE WHERE RF.RDB$RELATION_NAME IN ('User','Post') ORDER BY RF.RDB$RELATION_NAME, RF.RDB$FIELD_POSITION;
COMMIT;
QUIT;
'@
$input = Join-Path $labPath 'logs\tcp-smoke.sql'
[IO.File]::WriteAllText($input, $sql, [Text.UTF8Encoding]::new($false))
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $runtime 'isql.exe'
$start.WorkingDirectory = $runtime
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($arg in @('-bail','-quiet','-user','SYSDBA','-fetch_password',(Join-Path $labPath 'private\sysdba-password.txt'),'-charset','UTF8','-sql','3','-input',$input,"127.0.0.1/$($manifest.port):$($manifest.database)")) { $start.ArgumentList.Add($arg) }
foreach ($key in @($start.Environment.Keys)) { if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($key) } }
$start.Environment['FIREBIRD'] = $runtime
$start.Environment['FIREBIRD_LOCK'] = Join-Path $labPath 'locks'
$start.Environment['FIREBIRD_TMP'] = Join-Path $labPath 'temp'
$start.Environment['TEMP'] = Join-Path $labPath 'temp'
$start.Environment['TMP'] = Join-Path $labPath 'temp'
$native = [Diagnostics.Process]::new()
$native.StartInfo = $start
try {
  [void]$native.Start()
  $stdout = $native.StandardOutput.ReadToEndAsync()
  $stderr = $native.StandardError.ReadToEndAsync()
  if (-not $native.WaitForExit(20000)) { $native.Kill(); [void]$native.WaitForExit(5000); throw 'TCP smoke query timed out.' }
  $outText = $stdout.GetAwaiter().GetResult()
  $errText = $stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $labPath 'logs\tcp-smoke.stdout.txt'), $outText)
  [IO.File]::WriteAllText((Join-Path $labPath 'logs\tcp-smoke.stderr.txt'), $errText)
  $passed = $native.ExitCode -eq 0 -and $outText -match '(?m)^ENGINE_VERSION\s+3\.0\.14\s*$' -and $outText -match '(?m)^REMOTE_PROTOCOL\s+TCPv4\s*$' -and $outText -match '(?m)^USER_ROWS\s+0\s*$' -and $outText -match '(?m)^POST_ROWS\s+0\s*$'
  $result = [ordered]@{ classification='NATIVE_ISQL_TCP_SMOKE_NOT_PRISMA_CRUD'; passed=$passed; engineVersion=([regex]::Match($outText,'(?m)^ENGINE_VERSION\s+([^\r\n]+)')).Groups[1].Value.Trim(); remoteProtocol=([regex]::Match($outText,'(?m)^REMOTE_PROTOCOL\s+([^\r\n]+)')).Groups[1].Value.Trim(); authenticationMethod=([regex]::Match($outText,'(?m)^AUTH_METHOD\s+([^\r\n]+)')).Groups[1].Value.Trim(); listenerAddress=$state.listenerAddress; listenerOwned=$state.listenerOwned; wireCryptConfiguration='Required'; serverProcessId=$process.Id; nativeProcessId=$native.Id; host='127.0.0.1'; port=$manifest.port; database=$manifest.database; schemaTables=@('User','Post'); credentialsPublished=$false; completedAtUtc=[DateTime]::UtcNow.ToString('o') }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $labPath 'tcp-smoke-results.json') -Encoding utf8
  $result | ConvertTo-Json
  if (-not $passed) { throw 'TCP smoke failed; inspect private lab logs.' }
} finally { $native.Dispose() }
