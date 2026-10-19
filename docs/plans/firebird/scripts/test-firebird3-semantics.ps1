# Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
#requires -Version 7.0
<#
.SYNOPSIS
Runs offline isql/Engine12 probes against a new private synthetic database, never Prisma Client.
#>
[CmdletBinding()]
param(
  [string]$LabRoot = (Join-Path $PSScriptRoot '..\..\..\..\..\firebird-lab'),
  [ValidateRange(5, 120)][int]$ProcessTimeoutSeconds = 30,
  [switch]$KeepDatabase
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This harness targets Windows with the pinned x64 runtime.' }
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
Assert-PlainPath $labPath
$manifestPath = Join-Path $labPath 'lab-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Run initialize-firebird3-lab.ps1 first. This test performs no downloads.' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$runtime = Join-Path $labPath 'runtime\firebird-3.0.14-x64'
$runtimePrefix = [IO.Path]::GetFullPath($runtime).TrimEnd('\') + '\'
if ($manifest.runtime -ne $runtime -or -not (Test-Path -LiteralPath (Join-Path $runtime '.prisma-firebird-lab-runtime'))) { throw 'Private runtime marker or path mismatch.' }
Assert-PlainPath $runtime
if (@($manifest.runtimeFileHashes.PSObject.Properties).Count -ne 6) { throw 'Runtime component hashes missing. Re-run the offline bootstrap.' }
foreach ($entry in $manifest.runtimeFileHashes.PSObject.Properties) {
  Assert-PlainPath (Join-Path $runtime $entry.Name)
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtime $entry.Name)).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Private runtime component changed: $($entry.Name)" }
}
$configPath = Join-Path $runtime 'firebird.conf'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash.ToLowerInvariant() -ne $manifest.configSha256) { throw 'Private config changed since bootstrap.' }
if ((Get-Content -Raw -LiteralPath $configPath) -notmatch '(?m)^Providers = Engine12\s*$') { throw 'Only the embedded Engine12 provider is permitted.' }
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runsPath = [IO.Path]::GetFullPath((Join-Path $labPath 'runs')).TrimEnd('\') + '\'
Assert-PlainPath $runsPath
$runPath = [IO.Path]::GetFullPath((Join-Path $runsPath $runId))
if (-not $runPath.StartsWith($runsPath, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $runPath)) { throw 'Run path must be new and inside the private runs directory.' }
New-Item -ItemType Directory -Path $runPath | Out-Null
$databasePath = Join-Path $runPath 'synthetic.fdb'
$markerPath = Join-Path $runPath '.prisma-firebird-lab-run'
$runId | Set-Content -LiteralPath $markerPath -Encoding ascii
$results = [Collections.Generic.List[object]]::new()
$commands = [Collections.Generic.List[object]]::new()
$isql = Join-Path $runtime 'isql.exe'
if (-not ([IO.Path]::GetFullPath($isql)).StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'isql must be in the private runtime.' }

function Invoke-LabSql([string]$Name, [string]$Sql, [bool]$Connect = $true) {
  $inputPath = Join-Path $runPath "$Name.sql"
  [IO.File]::WriteAllText($inputPath, $Sql, [Text.UTF8Encoding]::new($false))
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $isql
  $start.WorkingDirectory = $runtime
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($arg in @('-bail', '-quiet', '-user', 'SYSDBA', '-charset', 'UTF8', '-sql', '3', '-input', $inputPath)) { $start.ArgumentList.Add($arg) }
  if ($Connect) { $start.ArgumentList.Add($databasePath) }
  foreach ($key in @($start.Environment.Keys)) {
    if ($key.StartsWith('ISC_', [StringComparison]::OrdinalIgnoreCase) -or $key.StartsWith('FIREBIRD', [StringComparison]::OrdinalIgnoreCase)) { [void]$start.Environment.Remove($key) }
  }
  $start.Environment['FIREBIRD'] = $runtime
  $start.Environment['FIREBIRD_LOCK'] = Join-Path $labPath 'locks'
  $start.Environment['FIREBIRD_TMP'] = Join-Path $labPath 'temp'
  $start.Environment['TEMP'] = Join-Path $labPath 'temp'
  $start.Environment['TMP'] = Join-Path $labPath 'temp'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $started = [DateTime]::UtcNow
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $process.WaitForExit($ProcessTimeoutSeconds * 1000)) {
      $process.Kill()
      if (-not $process.WaitForExit(5000)) {
        $commands.Add([ordered]@{ name=$Name; executable=$isql; arguments=@($start.ArgumentList); processId=$process.Id; startedAtUtc=$started.ToString('o'); timedOut=$true; terminationConfirmed=$false })
        throw "Private isql process termination was not confirmed within five seconds: $Name"
      }
      $timedOut = $true
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    [IO.File]::WriteAllText((Join-Path $runPath "$Name.stdout.txt"), $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $runPath "$Name.stderr.txt"), $stderr, [Text.UTF8Encoding]::new($false))
    $command = [ordered]@{ name = $Name; executable = $isql; arguments = @($start.ArgumentList); processId = $process.Id; startedAtUtc = $started.ToString('o'); exitCode = $exitCode; timedOut = $timedOut }
    $commands.Add($command)
    if ($timedOut) { throw "Private isql process timed out: $Name; captured output was retained." }
    return [pscustomobject]@{ stdout = $stdout; stderr = $stderr; exitCode = $exitCode }
  } finally { $process.Dispose() }
}

function Add-MarkerResults($Execution, [string[]]$Ids) {
  foreach ($id in $Ids) {
    $match = [regex]::Match($Execution.stdout, "(?m)^LAB_RESULT\s+LAB\|$([regex]::Escape($id))\|(PASS|FAIL)\|([^\r\n]*)")
    $results.Add([ordered]@{ id = $id; passed = ($Execution.exitCode -eq 0 -and $match.Success -and $match.Groups[1].Value -eq 'PASS'); actual = $match.Groups[2].Value; exitCode = $Execution.exitCode; evidence = 'semantics.stdout.txt' })
  }
}

$dbSql = $databasePath.Replace("'", "''")
$semantics = @"
SET SQL DIALECT 3;
SET NAMES UTF8;
CREATE DATABASE '$dbSql' USER 'SYSDBA' DEFAULT CHARACTER SET UTF8;
SET AUTODDL OFF;
SET LIST ON;
CREATE TABLE LAB_TYPES (
  ID INTEGER NOT NULL PRIMARY KEY,
  SMALL_VALUE SMALLINT, INT_VALUE INTEGER, BIG_VALUE BIGINT,
  N_VALUE NUMERIC(18,2), D_VALUE DECIMAL(18,4),
  DATE_VALUE DATE, TIME_VALUE TIME, STAMP_VALUE TIMESTAMP,
  LABEL VARCHAR(40) CHARACTER SET UTF8,
  TEXT_VALUE BLOB SUB_TYPE TEXT CHARACTER SET UTF8,
  BIN_VALUE BLOB SUB_TYPE BINARY
);
CREATE TABLE LAB_BOOL (ID INTEGER PRIMARY KEY, FLAG BOOLEAN);
CREATE TABLE LAB_IDENTITY (ID INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, LABEL VARCHAR(20));
CREATE TABLE LAB_START (ID INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH 40) PRIMARY KEY);
CREATE SEQUENCE LAB_TRIGGER_SEQ;
CREATE TABLE LAB_TRIGGER_KEY (ID BIGINT PRIMARY KEY, LABEL VARCHAR(20));
SET TERM ^;
CREATE TRIGGER LAB_BI FOR LAB_TRIGGER_KEY ACTIVE BEFORE INSERT POSITION 0 AS
BEGIN
  IF (NEW.ID IS NULL) THEN NEW.ID = NEXT VALUE FOR LAB_TRIGGER_SEQ;
END^
SET TERM ;^
CREATE TABLE LAB_PAGE (ID INTEGER PRIMARY KEY);
CREATE TABLE "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDE" (ID INTEGER);
CREATE DOMAIN LAB_DOMAIN AS NUMERIC(18,4) DEFAULT 1.2500 NOT NULL;
CREATE TABLE LAB_PARENT (ID INTEGER PRIMARY KEY);
CREATE TABLE LAB_CHILD (ID INTEGER PRIMARY KEY, P_ID INTEGER, A INTEGER, B INTEGER,
  DOMAIN_VALUE LAB_DOMAIN, BASE_VALUE INTEGER, DOUBLE_VALUE COMPUTED BY (BASE_VALUE * 2),
  CONSTRAINT LAB_FK FOREIGN KEY (P_ID) REFERENCES LAB_PARENT(ID) ON DELETE CASCADE,
  CONSTRAINT LAB_UQ UNIQUE (A,B));
COMMIT;
INSERT INTO LAB_TYPES VALUES (1, -32768, 2147483647, 9223372036854775807,
  9999999999999999.99, -12345678901234.5678,
  DATE '2020-02-29', TIME '23:59:59.123', TIMESTAMP '2020-02-29 12:34:56.789',
  _UTF8 X'636166C3A9F09F8C8D', RPAD(CAST('x' AS BLOB SUB_TYPE TEXT),70000,'x'), _OCTETS X'00017FFF80');
INSERT INTO LAB_BOOL VALUES (1, TRUE);
INSERT INTO LAB_BOOL VALUES (2, FALSE);
INSERT INTO LAB_BOOL VALUES (3, NULL);
INSERT INTO LAB_PAGE VALUES (1);
INSERT INTO LAB_PAGE VALUES (2);
INSERT INTO LAB_PAGE VALUES (3);
INSERT INTO LAB_PAGE VALUES (4);
INSERT INTO LAB_PARENT VALUES (1);
INSERT INTO LAB_CHILD (ID,P_ID,A,B,BASE_VALUE) VALUES (1,1,10,20,3);
INSERT INTO LAB_IDENTITY (LABEL) VALUES ('identity')
  RETURNING 'LAB|identity-default|' || IIF(ID=1,'PASS','FAIL') || '|' || CAST(ID AS VARCHAR(20)) AS LAB_RESULT;
INSERT INTO LAB_START DEFAULT VALUES
  RETURNING 'LAB|identity-start-with|' || IIF(ID=41,'PASS','FAIL') || '|' || CAST(ID AS VARCHAR(20)) AS LAB_RESULT;
INSERT INTO LAB_TRIGGER_KEY (LABEL) VALUES ('trigger')
  RETURNING 'LAB|trigger-generated-key|' || IIF(ID=1,'PASS','FAIL') || '|' || CAST(ID AS VARCHAR(20)) AS LAB_RESULT;
COMMIT;
SELECT 'LAB|engine-version|' || IIF(RDB`$GET_CONTEXT('SYSTEM','ENGINE_VERSION') STARTING WITH '3.0.14','PASS','FAIL') || '|' || RDB`$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS LAB_RESULT FROM RDB`$DATABASE;
SELECT 'LAB|embedded-attachment|' || IIF(MON`$REMOTE_PROTOCOL IS NULL,'PASS','FAIL') || '|' || COALESCE(MON`$REMOTE_PROTOCOL,'NULL') AS LAB_RESULT FROM MON`$ATTACHMENTS WHERE MON`$ATTACHMENT_ID=CURRENT_CONNECTION;
SELECT 'LAB|exact-integers|' || IIF(SMALL_VALUE=-32768 AND INT_VALUE=2147483647 AND BIG_VALUE=9223372036854775807,'PASS','FAIL') || '|' || CAST(BIG_VALUE AS VARCHAR(30)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|exact-fixed-numerics|' || IIF(N_VALUE=9999999999999999.99 AND D_VALUE=-12345678901234.5678,'PASS','FAIL') || '|' || CAST(N_VALUE AS VARCHAR(40)) || ',' || CAST(D_VALUE AS VARCHAR(40)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|date-time|' || IIF(DATE_VALUE=DATE '2020-02-29' AND TIME_VALUE=TIME '23:59:59.123' AND STAMP_VALUE=TIMESTAMP '2020-02-29 12:34:56.789','PASS','FAIL') || '|' || CAST(DATE_VALUE AS VARCHAR(20)) || ',' || CAST(TIME_VALUE AS VARCHAR(20)) || ',' || CAST(STAMP_VALUE AS VARCHAR(30)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|boolean-null|' || IIF((SELECT COUNT(*) FROM LAB_BOOL WHERE FLAG IS TRUE)=1 AND (SELECT COUNT(*) FROM LAB_BOOL WHERE FLAG IS FALSE)=1 AND (SELECT COUNT(*) FROM LAB_BOOL WHERE FLAG IS NULL)=1,'PASS','FAIL') || '|true,false,null' AS LAB_RESULT FROM RDB`$DATABASE;
SELECT 'LAB|unicode-text|' || IIF(LABEL=_UTF8 X'636166C3A9F09F8C8D' AND CHAR_LENGTH(LABEL)=5,'PASS','FAIL') || '|' || CAST(CHAR_LENGTH(LABEL) AS VARCHAR(10)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|text-blob-70k|' || IIF(CHAR_LENGTH(TEXT_VALUE)=70000,'PASS','FAIL') || '|' || CAST(CHAR_LENGTH(TEXT_VALUE) AS VARCHAR(20)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|binary-blob|' || IIF(OCTET_LENGTH(BIN_VALUE)=5 AND CAST(BIN_VALUE AS VARCHAR(5) CHARACTER SET OCTETS)=_OCTETS X'00017FFF80','PASS','FAIL') || '|' || CAST(OCTET_LENGTH(BIN_VALUE) AS VARCHAR(10)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
SELECT 'LAB|offset-fetch|' || IIF(COUNT(*)=2 AND SUM(ID)=5,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) || ',' || CAST(SUM(ID) AS VARCHAR(10)) AS LAB_RESULT FROM (SELECT ID FROM LAB_PAGE ORDER BY ID OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY);
SELECT 'LAB|first-skip|' || IIF(COUNT(*)=2 AND SUM(ID)=5,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) || ',' || CAST(SUM(ID) AS VARCHAR(10)) AS LAB_RESULT FROM (SELECT FIRST 2 SKIP 1 ID FROM LAB_PAGE ORDER BY ID);
SELECT 'LAB|first-zero|' || IIF(COUNT(*)=0,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) AS LAB_RESULT FROM (SELECT FIRST 0 ID FROM LAB_PAGE);
SELECT 'LAB|identifier-31|' || IIF(COUNT(*)=1,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) AS LAB_RESULT FROM RDB`$RELATIONS WHERE RDB`$RELATION_NAME='ABCDEFGHIJKLMNOPQRSTUVWXYZABCDE';
SELECT 'LAB|numeric-metadata|' || IIF(F.RDB`$FIELD_TYPE=16 AND F.RDB`$FIELD_SUB_TYPE=1 AND F.RDB`$FIELD_PRECISION=18 AND F.RDB`$FIELD_SCALE=-2,'PASS','FAIL') || '|' || CAST(F.RDB`$FIELD_TYPE AS VARCHAR(10)) || ',' || CAST(F.RDB`$FIELD_SUB_TYPE AS VARCHAR(10)) || ',' || CAST(F.RDB`$FIELD_PRECISION AS VARCHAR(10)) || ',' || CAST(F.RDB`$FIELD_SCALE AS VARCHAR(10)) AS LAB_RESULT FROM RDB`$RELATION_FIELDS RF JOIN RDB`$FIELDS F ON F.RDB`$FIELD_NAME=RF.RDB`$FIELD_SOURCE WHERE RF.RDB`$RELATION_NAME='LAB_TYPES' AND RF.RDB`$FIELD_NAME='N_VALUE';
SELECT 'LAB|identity-metadata|' || IIF(RDB`$IDENTITY_TYPE=1 AND RDB`$GENERATOR_NAME IS NOT NULL,'PASS','FAIL') || '|' || TRIM(RDB`$GENERATOR_NAME) AS LAB_RESULT FROM RDB`$RELATION_FIELDS WHERE RDB`$RELATION_NAME='LAB_IDENTITY' AND RDB`$FIELD_NAME='ID';
SELECT 'LAB|domain-and-computed|' || IIF(DOMAIN_VALUE=1.2500 AND DOUBLE_VALUE=6,'PASS','FAIL') || '|' || CAST(DOMAIN_VALUE AS VARCHAR(20)) || ',' || CAST(DOUBLE_VALUE AS VARCHAR(10)) AS LAB_RESULT FROM LAB_CHILD WHERE ID=1;
SELECT 'LAB|foreign-key-metadata|' || IIF(COUNT(*)=1,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) AS LAB_RESULT FROM RDB`$REF_CONSTRAINTS WHERE RDB`$CONSTRAINT_NAME='LAB_FK' AND RDB`$DELETE_RULE='CASCADE';
SELECT 'LAB|composite-key-order|' || IIF(COUNT(*)=2 AND MIN(IIF(I.RDB`$FIELD_POSITION=0,TRIM(I.RDB`$FIELD_NAME),NULL))='A' AND MIN(IIF(I.RDB`$FIELD_POSITION=1,TRIM(I.RDB`$FIELD_NAME),NULL))='B','PASS','FAIL') || '|' || MIN(IIF(I.RDB`$FIELD_POSITION=0,TRIM(I.RDB`$FIELD_NAME),NULL)) || ',' || MIN(IIF(I.RDB`$FIELD_POSITION=1,TRIM(I.RDB`$FIELD_NAME),NULL)) AS LAB_RESULT FROM RDB`$INDEX_SEGMENTS I JOIN RDB`$RELATION_CONSTRAINTS C ON C.RDB`$INDEX_NAME=I.RDB`$INDEX_NAME WHERE C.RDB`$CONSTRAINT_NAME='LAB_UQ';
UPDATE LAB_TYPES SET LABEL='updated' WHERE ID=1 RETURNING 'LAB|update-returning|' || IIF(LABEL='updated','PASS','FAIL') || '|' || CAST(ID AS VARCHAR(10)) AS LAB_RESULT;
COMMIT;
UPDATE LAB_TYPES SET LABEL='rolled-back' WHERE ID=1;
ROLLBACK;
SELECT 'LAB|transaction-rollback|' || IIF(LABEL='updated','PASS','FAIL') || '|' || LABEL AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
INSERT INTO LAB_PAGE VALUES (5);
SAVEPOINT LAB_SAVE;
INSERT INTO LAB_PAGE VALUES (6);
ROLLBACK TO SAVEPOINT LAB_SAVE;
RELEASE SAVEPOINT LAB_SAVE;
SELECT 'LAB|savepoint-rollback|' || IIF((SELECT COUNT(*) FROM LAB_PAGE WHERE ID=5)=1 AND (SELECT COUNT(*) FROM LAB_PAGE WHERE ID=6)=0,'PASS','FAIL') || '|keep5,undo6' AS LAB_RESULT FROM RDB`$DATABASE;
COMMIT;
INSERT INTO LAB_PAGE VALUES (99);
DELETE FROM LAB_PAGE WHERE ID=99 RETURNING 'LAB|delete-returning|PASS|' || CAST(ID AS VARCHAR(10)) AS LAB_RESULT;
COMMIT;
UPDATE LAB_TYPES SET LABEL='missing' WHERE ID=-1 RETURNING ID AS MISSING_ID;
SELECT 'LAB|integer-minimum|' || IIF(CAST('-9223372036854775808' AS BIGINT)=-9223372036854775808,'PASS','FAIL') || '|' || CAST(CAST('-9223372036854775808' AS BIGINT) AS VARCHAR(30)) AS LAB_RESULT FROM RDB`$DATABASE;
UPDATE LAB_TYPES SET TIME_VALUE=TIME '12:34:56.1234' WHERE ID=1;
COMMIT;
SELECT 'LAB|fractional-column-precision|' || IIF(CAST(TIME_VALUE AS VARCHAR(20))='12:34:56.1234','PASS','FAIL') || '|' || CAST(TIME_VALUE AS VARCHAR(20)) AS LAB_RESULT FROM LAB_TYPES WHERE ID=1;
COMMIT;
QUIT;
"@

$fatal = $null
try {
  $execution = Invoke-LabSql 'semantics' $semantics $false
  $ids = @('engine-version','embedded-attachment','exact-integers','exact-fixed-numerics','date-time','boolean-null','unicode-text','text-blob-70k','binary-blob','offset-fetch','first-skip','first-zero','identifier-31','numeric-metadata','identity-metadata','domain-and-computed','foreign-key-metadata','composite-key-order','identity-default','identity-start-with','trigger-generated-key','update-returning','transaction-rollback','savepoint-rollback','delete-returning','integer-minimum','fractional-column-precision')
  Add-MarkerResults $execution $ids
  $results.Add([ordered]@{ id='no-match-returning-null-row'; passed=($execution.exitCode -eq 0 -and $execution.stdout -match '(?m)^MISSING_ID\s+<null>'); actual=([regex]::Match($execution.stdout,'(?m)^MISSING_ID\s+([^\r\n]*)')).Groups[1].Value; exitCode=$execution.exitCode; evidence='semantics.stdout.txt' })
  if ($execution.exitCode -ne 0) { throw "Initial semantics SQL failed; inspect semantics.stderr.txt: $($execution.stderr)" }
  $persisted = Invoke-LabSql 'committed-reconnect' "SET LIST ON; SELECT 'LAB|committed-reconnect|' || IIF(COUNT(*)=1,'PASS','FAIL') || '|' || CAST(COUNT(*) AS VARCHAR(10)) AS LAB_RESULT FROM LAB_PAGE WHERE ID=5; COMMIT; QUIT;"
  $match = [regex]::Match($persisted.stdout, '(?m)^LAB_RESULT\s+LAB\|committed-reconnect\|(PASS|FAIL)\|([^\r\n]*)')
  $results.Add([ordered]@{ id='committed-reconnect'; passed=($persisted.exitCode -eq 0 -and $match.Success -and $match.Groups[1].Value -eq 'PASS'); actual=$match.Groups[2].Value; exitCode=$persisted.exitCode; evidence='committed-reconnect.stdout.txt' })
  $errorProbes = @(
    @{ id='multirow-returning-rejected'; sql="UPDATE LAB_PAGE SET ID=ID RETURNING ID;"; state='21000'; message='multiple rows in singleton select' },
    @{ id='returning-star-rejected'; sql="UPDATE LAB_PAGE SET ID=ID WHERE ID=1 RETURNING *;"; state='42000'; message='Token unknown' },
    @{ id='identifier-32-rejected'; sql='CREATE TABLE "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF" (ID INTEGER);'; state='42000'; message='longer than|too long' },
    @{ id='numeric-19-rejected'; sql='CREATE TABLE LAB_BAD_NUMERIC (N NUMERIC(19,2));'; state='HY104'; message='Precision must be from 1 to 18' },
    @{ id='foreign-key-rejected'; sql='INSERT INTO LAB_CHILD (ID,P_ID) VALUES (2,999);'; state='23000'; message='FOREIGN KEY' },
    @{ id='unique-key-rejected'; sql='INSERT INTO LAB_CHILD (ID,P_ID,A,B) VALUES (2,1,10,20);'; state='23000'; message='UNIQUE KEY' }
  )
  foreach ($probe in $errorProbes) {
    $errorExecution = Invoke-LabSql $probe.id ($probe.sql + "`nROLLBACK;`nQUIT;")
    $combined = $errorExecution.stdout + "`n" + $errorExecution.stderr
    $results.Add([ordered]@{ id=$probe.id; passed=($errorExecution.exitCode -ne 0 -and $combined -match "SQLSTATE = $($probe.state)" -and $combined -match $probe.message); expectedSqlState=$probe.state; actualSqlState=([regex]::Match($combined,'SQLSTATE = (\w+)')).Groups[1].Value; exitCode=$errorExecution.exitCode; evidence="$($probe.id).stderr.txt" })
  }
} catch { $fatal = $_.Exception.Message }

$failed = @($results | Where-Object { -not $_.passed }).Count
$cleanup = 'database retained by request or failure'
if (-not $KeepDatabase -and -not $fatal -and $failed -eq 0 -and (Test-Path -LiteralPath $databasePath)) {
  $resolvedDatabase = [IO.Path]::GetFullPath($databasePath)
  Assert-PlainPath $resolvedDatabase
  $ownedRunPrefix = $runPath.TrimEnd('\') + '\'
  if (-not $resolvedDatabase.StartsWith($ownedRunPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Get-Content -Raw -LiteralPath $markerPath).Trim() -ne $runId -or [IO.Path]::GetFileName($resolvedDatabase) -ne 'synthetic.fdb') { throw 'Refusing cleanup outside this owned synthetic database.' }
  Remove-Item -LiteralPath $resolvedDatabase
  $cleanup = 'only this run synthetic.fdb deleted; evidence and runtime retained'
}
$summary = [ordered]@{
  schemaVersion=1; classification='DATABASE_SEMANTICS_PROBES_NOT_PRISMA_CRUD'; runId=$runId;
  engineVersion='3.0.14.33856'; architecture='Windows AMD64'; transport='embedded Engine12';
  archiveSha256=$manifest.archiveSha256; startedBy='test-firebird3-semantics.ps1';
  harnessSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash.ToLowerInvariant();
  generatedPrismaClientCrud='NOT_IMPLEMENTED_NOT_TESTED'; parameterBinding='NOT_TESTED_ISQL_HAS_NO_BOUND_INPUT_API';
  nodeDriver='NOT_TESTED'; firebird4='NOT_TESTED'; firebird5='NOT_TESTED';
  passed=($failed -eq 0 -and -not $fatal); passedCount=($results.Count-$failed); failedCount=$failed; fatalError=$fatal;
  database=$databasePath; cleanup=$cleanup; completedAtUtc=[DateTime]::UtcNow.ToString('o'); probes=@($results.ToArray()); commands=@($commands.ToArray())
}
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runPath 'results.json') -Encoding utf8
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $labPath 'latest-results.json') -Encoding utf8
[pscustomobject]@{ resultPath=(Join-Path $runPath 'results.json'); passed=$summary.passed; passedCount=$summary.passedCount; failedCount=$failed; fatalError=$fatal; cleanup=$cleanup } | ConvertTo-Json
if (-not $summary.passed) { exit 1 }
