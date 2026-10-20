# Experimental Firebird 3 support

This fork adds a real `firebird` provider, a JavaScript driver adapter, generated Prisma Client queries, and a schema-engine Wasm route for introspection and migrations. The initial runtime target is Firebird 3.0.14 on Windows x64, SQL dialect 3, with UTF8 text. See the [adapter README](../packages/adapter-firebird/README.md) for its connection and transaction API.

## Source and runtime requirements

The ORM source line is Prisma 7.10.1. Its paired engines baseline is `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`, with the Firebird changes applied in the companion checkout. The matching upstream Wasm package version is `8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`; that package label does not make this a Prisma 8 implementation. Use the paired sources together rather than replacing either checkout with upstream `main`.

Use [paired engines commit c32198f4f6e15732ad4db408121cbb380db0c7c8](https://github.com/cosmemilton/prisma-engines/commit/c32198f4f6e15732ad4db408121cbb380db0c7c8) (`work/firebird3`) in a sibling `prisma-engines-firebird` checkout. Build the local Wasm packages and provide the matching upstream compiler package as described below. The expected local layout is:

```text
workspace/
  prisma-firebird/
  prisma-engines-firebird/
    target/prisma-schema-wasm/
    target/query-compiler-wasm/
    target/schema-engine-wasm/
  firebird-client-lab/          # created separately for disposable database tests
```

The three local overrides in [pnpm-workspace.yaml](../pnpm-workspace.yaml) require these generated engines packages. They must exist before installing the ORM workspace dependencies. The engines source tree, a native schema-engine executable, and an upstream registry Wasm package are not substitutes for the Firebird-enabled outputs.

Use Node.js 24 or newer for the documented CLI and generated-TypeScript test flows, and the pnpm 11 version pinned by [package.json](../package.json). The adapter pins `node-firebird` 2.18.2 and depends on its exported wire modules and original prepared-statement metadata. Upgrading that driver requires reviewing those interfaces and running both unit and real database tests.

The Windows engines wrappers require tools already installed locally: Rust `1.97.1-x86_64-pc-windows-msvc`, its `wasm32-unknown-unknown` target, and a wasm-bindgen executable matching the companion `Cargo.lock` (currently 0.2.105). They validate the supplied tools and do not install them. PowerShell 7 is required by the database laboratory helpers.

## Build the paired packages

These commands describe an existing, prepared development environment. They do not bootstrap Rust, Node.js, a package manager, or dependency caches. Use a dedicated shell and actual absolute tool paths. From the companion engines checkout:

```powershell
$firebirdBuild = @{
  CargoHome = 'C:\tools\cargo'
  RustupHome = 'C:\tools\rustup'
  WasmBindgenPath = 'C:\tools\wasm-bindgen-0.2.105\wasm-bindgen.exe'
  BuildProfile = 'dev'
  Offline = $true
}
$env:CARGO_BUILD_JOBS = '4'

./script/build-firebird-schema.ps1 @firebirdBuild
if ($LASTEXITCODE -ne 0) { throw 'Schema validator build failed.' }
./script/build-firebird-query-compiler.ps1 @firebirdBuild
if ($LASTEXITCODE -ne 0) { throw 'Query compiler build failed.' }
./script/build-firebird-schema-engine.ps1 @firebirdBuild
if ($LASTEXITCODE -ne 0) { throw 'Schema engine build failed.' }
```

`-Offline` requires an already populated Cargo cache and fails when an input is missing. The wrappers use locked dependencies. Development mode emits the query compiler under both `fast` and `small` names from one build; these names do not imply separately optimized release binaries.

The outputs have different roles:

| Local engines package                 | Used for                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `target/prisma-schema-wasm`           | PSL validation, DMMF and generation inputs                                     |
| `target/query-compiler-wasm/firebird` | Firebird query planning and SQL compilation                                    |
| `target/schema-engine-wasm`           | Catalog introspection, schema diff and migration execution through the adapter |

The query-compiler wrapper initially emits only the Firebird compiler. The ordinary Client build also expects the unchanged upstream compilers for PostgreSQL, MySQL, SQLite, SQL Server and CockroachDB. From the ORM root, prepare that complete development package with the already extracted, exact upstream package directory:

```powershell
node scripts/prepare-firebird-local-engines.cjs 'C:\inputs\upstream-query-compiler-wasm'
if ($LASTEXITCODE -ne 0) { throw 'Local compiler package preparation failed.' }
```

[prepare-firebird-local-engines.cjs](../scripts/prepare-firebird-local-engines.cjs) verifies the upstream package version, preserves its legal files and copies unchanged provider assets beside the local Firebird output. It does not download the input. The explicit input directory avoids relying on an ORM installation that does not yet exist.

Only after all three local packages are ready should a new workspace install its locked dependencies with `pnpm install --frozen-lockfile`. An already installed workspace can proceed directly to builds. Dependency installation needs its own available cache or registry access; neither this guide nor the local overrides provide an offline dependency bootstrap. pnpm's offline setting alone is not a complete network-isolation mechanism.

For the complete dependency graph, use the upstream `pnpm build` workflow described in [CONTRIBUTING.md](../CONTRIBUTING.md). When changing the CLI profile through Turborepo, force a rebuild with `pnpm build --force`: the profile variable is not part of the current Turbo cache key. For an already installed Windows workspace, the following sequence invokes the official package build helpers directly and avoids pnpm's implicit dependency-status installation before each package script:

```powershell
$firebirdOrmRoot = (Get-Location).Path
$firebirdTsx = Join-Path $firebirdOrmRoot 'node_modules/.bin/tsx.cmd'
$env:PATH = (Join-Path $firebirdOrmRoot 'node_modules/.bin') + ';' + $env:PATH
$env:PNPM_MAX_WORKERS = '2'
$env:GOMAXPROCS = '2'

$firebirdPackages = @(
  'debug', 'client-runtime-utils', 'driver-adapter-utils', 'param-graph',
  'json-protocol', 'dmmf', 'get-platform', 'schema-files-loader',
  'sqlcommenter', 'generator', 'config', 'fetch-engine', 'get-dmmf',
  'param-graph-builder', 'client-engine-runtime', 'engines',
  'generator-helper', 'internals', 'client-common', 'ts-builders',
  'client-generator-ts', 'client-generator-js', 'instrumentation-contract',
  'adapter-firebird', 'migrate', 'client', 'cli'
)
$env:PRISMA_CLI_BUILD_PROFILE = 'firebird'
foreach ($firebirdPackage in $firebirdPackages) {
  Push-Location (Join-Path $firebirdOrmRoot "packages/$firebirdPackage")
  try {
    & $firebirdTsx helpers/build.ts
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $firebirdPackage" }
  } finally {
    Pop-Location
  }
}
Remove-Item Env:PRISMA_CLI_BUILD_PROFILE
```

The `firebird` CLI profile is selected at build time in [the CLI build helper](../packages/cli/helpers/build.ts). It retains the public dispatcher/parser and core init, validate, format, generate, db and migrate commands. It excludes optional Studio/dev and cloud/auth registrations and copies only the Firebird query-compiler assets into the CLI. Omit the profile for the default upstream command set. Changing the environment after a build does not change the compiled profile.

Client builds copy or embed query-compiler Wasm; internals and CLI builds copy schema Wasm assets. Rebuild the consuming packages after changing any engines output, then regenerate the application Client. An adapter-only change does not require a Wasm rebuild. Successful source compilation alone does not establish real database behavior.

## Configure a project

Use the built fork CLI or deliberately prepared local packages. Installing `@prisma/adapter-firebird` alone into an upstream Prisma release does not add provider support. Local prepared consumers use the stable aliases `prisma`, `@prisma/client` and `@prisma/adapter-firebird`; no public package release is implied by these names.

The Firebird CLI profile can scaffold a project with `prisma init --datasource-provider firebird`. Init writes placeholders and never connects, creates a database, installs a Firebird service, or starts a development server. Provision an existing database separately.

Put the provider in `schema.prisma` and connection settings in `prisma.config.ts`:

```prisma
generator client {
  provider            = "prisma-client"
  output              = "./generated"
  moduleFormat        = "esm"
  importFileExtension = "ts"
}

datasource db {
  provider = "firebird"
}

model Item {
  id     Int      @id @default(autoincrement())
  name   String   @db.VarChar(120)
  amount Decimal? @db.Decimal(18, 4)
}
```

```ts
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  migrations: { path: './migrations' },
  datasource: {
    url: env('DATABASE_URL'),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
```

This example reads variables from the process environment. Prisma 7 does not automatically load `.env`; load it explicitly when needed. The Firebird init template uses Node.js `loadEnvFile` for that purpose.

A datasource URL uses `firebird://USER:PASSWORD@HOST:PORT/ENCODED_ABSOLUTE_DATABASE_PATH`. Percent-encode the username, password and database path independently. The database path is interpreted by the Firebird server. A Windows path can be normalized to forward slashes before `encodeURIComponent`; a Unix absolute path keeps its leading slash inside the encoded value. Do not place credentials in committed configuration.

Application Client connections may instead pass the driver's connection object:

```ts
import { PrismaFirebird } from '@prisma/adapter-firebird'
import { PrismaClient } from './generated/client.ts'

const adapter = new PrismaFirebird(
  {
    host: '127.0.0.1',
    port: 3050,
    database: '/absolute/path/application.fdb',
    user: process.env.FIREBIRD_USER,
    password: process.env.FIREBIRD_PASSWORD,
  },
  { poolSize: 5 },
)
const prisma = new PrismaClient({ adapter })

try {
  await prisma.item.findMany()
} finally {
  await prisma.$disconnect()
}
```

## Transactions and value fidelity

The adapter owns attachment pooling and transaction completion. Standalone operations commit or roll back before returning an attachment; a connection whose transaction end cannot be confirmed is destroyed. Interactive transactions retain their attachment, and nested work uses savepoints. Use Prisma transaction APIs rather than SQL COMMIT/ROLLBACK.

The default isolation is READ COMMITTED RECORD_VERSION. The second constructor argument accepts `readCommittedRecordVersion: 'record-version' | 'no-record-version'`; omission preserves `'record-version'`. Explicit `'no-record-version'` selects READ COMMITTED NO RECORD_VERSION, which observes active writer conflicts rather than reading their previous committed record version. The option applies to default and explicit READ COMMITTED transactions on main and shadow adapters, including ordinary, internal, interactive, batch and script paths. Existing transactions/savepoints retain their selected policy. It has no datasource URL, schema or CLI option.

RepeatableRead and Snapshot map to Firebird SNAPSHOT; Serializable maps to SNAPSHOT TABLE STABILITY. ReadUncommitted is rejected. `transactionLockTimeout` independently selects unlimited WAIT when omitted, NOWAIT for `0`, or a bounded native wait of 1 through 32767 **seconds**. Prisma `maxWait` and `timeout` use **milliseconds** for transaction acquisition/lifetime. They do not select the native record-version policy or promise cancellation of a statement already blocked in Firebird.

Connections use UTF8 and positional `?` parameters. BigInt and fixed-point Decimal values retain exact integer/decimal strings across the driver boundary; supply BigInt as bigint/integer strings and Decimal as strings/Prisma Decimal rather than lossy JavaScript numbers. Firebird DATE/TIME/TIMESTAMP have no time zone; the adapter interprets their calendar fields as UTC. Raw temporal results retain four fractional digits, while JavaScript Date/Prisma DateTime expose milliseconds. Unsupported types and invalid UTF8 text BLOBs fail explicitly.

Firebird-specific `startsWith` and `notStartsWith` use literal STARTING WITH semantics: percent and underscore remain literal characters. A typed UTF8 parameter avoids binding a search term to the compared column's narrower width. The adapter checks each execution against the original maximum UTF8 text descriptor and rejects strings above 8191 Unicode code points, including trailing blanks, instead of allowing silent truncation. That parameter limit does not guarantee an indexed predicate accepts every value up to the limit; the database's index-key bound can still return a native error. `contains`, `endsWith` and generic LIKE behavior retain their existing contracts.

### Server DATE values in writes

With the matching schema and query-compiler Wasm builds, native `@db.Date` fields
accept `{ currentDate: true }` in model create/update data, including nested and
bulk input shapes. The fixed `CURRENT_DATE` expression is evaluated by Firebird
within the same INSERT or UPDATE as the other assignments. It requires no physical
column DEFAULT, preliminary clock query or client date calculation.

```typescript
await prisma.entry.create({
  data: { createdDate: { currentDate: true }, status: '1' },
})
await prisma.entry.update({
  where: { id },
  data: { usedDate: { currentDate: true }, status: '2' },
})
```

Use the names from your generated model. This operation preserves the existing
trigger, RETURNING and transaction paths; it does not add general SQL expressions
or a server-clock read API. Date/ISO values, nullable dates and ordinary `set`
updates retain their contracts. Plain strings such as `"CURRENT_DATE"` remain
invalid dates. The Boolean operation accepts only `true` at runtime; `false` is
rejected before SQL despite being admitted by the generated Boolean type.
TIMESTAMP, TIME and other providers do not expose this operation. Rebuild both
schema and query-compiler Wasm, rebuild the consuming CLI/Client packages and
regenerate the application Client together; an adapter-only update is insufficient.

## Introspection and migration boundaries

Online Firebird commands use [schema-engine Wasm with the JavaScript adapter](../packages/migrate/src/utils/firebirdSchemaEngine.ts). There is no native Prisma Firebird executable or Rust Firebird transport. Schema-only Empty/SchemaDatamodel migration diffs use the pure Wasm `diffDatamodels` export without an adapter or datasource connection.

Migration history replay requires an existing, separately provisioned shadow database. In adapter options, supply `shadowDatabase` and `shadowDatabaseFileSystem: 'local'`. For CLI use, configure `shadowDatabaseUrl` and append exactly one `shadowDatabaseFileSystem=local` query parameter to the **main** datasource URL. The CLI consumes that parameter before passing the connection to the driver.

The opt-in asserts that both Firebird servers and Node.js share one native local filesystem namespace. Shadow connections require numeric loopback hosts, locally resolvable absolute paths reported by `MON$DATABASE`, and distinct nonzero filesystem identities. The checks reject aliases without physical paths, the same file through hard links/junctions, remote paths, and missing/inaccessible/changing identities. Containers, VMs, tunnels and forwarded loopback ports do not satisfy this assertion. Remote Client queries and ordinary introspection do not acquire this local-shadow capability.

The migration ownership lock retains one transaction while schema work uses another attachment. Migration execution requires a pool capacity of at least two and bounded native lock waits. The CLI supplies `poolSize: 2` and `transactionLockTimeout: 0`; disposal awaits lock rollback and adapter cleanup. The adapter never creates/drops database files or substitutes the main database for a missing shadow.

The schema connector supports ordinary tables, supported scalar columns, defaults/NOT NULL, primary/unique/foreign-key constraints, ordinary indexes, and conservative type widening. Newly created integer identities are supported; converting existing columns to or from identity generation is rejected. Indexed widening requires planned dependency removal/recreation, and retained inbound foreign keys can require a reviewed SQL migration. Relations use native foreign keys: Cascade, NoAction, SetNull and SetDefault are supported, while Restrict is rejected. Standalone unique indexes remain distinct from unique constraints used as foreign-key targets.

Identifiers are limited conservatively to 31 UTF8 bytes, CHAR/VARCHAR to 8191 characters, and NUMERIC/DECIMAL precision to 18. Defaults permit supported literals, context variables and NULL; arbitrary `dbgenerated()` expressions such as sequence calls are rejected. Migration preflight rejects unsupported schema steps before rendering/execution. Filtered reset also rejects unmanaged sequences, triggers, domains, procedures/functions/packages and other unsupported catalog objects before destructive DDL; a table-only reset is not a general database reset. Inherited domain defaults/NOT NULL retain conservative guards. Database-file creation/deletion is unavailable.

## Tests and disposable databases

Keep [package unit/regression tests](../packages/adapter-firebird/src/firebird.test.ts), [CLI tests](../packages/cli/src/__tests__/firebird-build-profile.vitest.ts), [migration tests](../packages/migrate/src/__tests__/firebird-schema-engine.test.ts), and [database harnesses/fixtures](plans/firebird/tests/) with the source. General runner conventions are in [TESTING.md](../TESTING.md). Adapter unit tests do not require a database or network:

```powershell
pnpm --filter @prisma/adapter-firebird test
pnpm --filter prisma test firebird
pnpm --filter @prisma/migrate test firebird --runInBand
```

The CLI wrapper runs both Jest and Vitest. For adapter type changes, also run TypeScript using the package's `tsconfig.json` and the workspace's pinned compiler. In the companion engines checkout, run the affected native PSL/query-compiler/schema-connector tests and actual Wasm API tests; `node --test prisma-schema-wasm/tests/firebird-schema.test.cjs` exercises the built validator. Source tests, built Wasm APIs, generated Client/database tests, and installed-package tests establish different boundaries.

The Windows [database initialization](plans/firebird/scripts/initialize-firebird3-client-lab.ps1), [start](plans/firebird/scripts/start-firebird3-client-lab.ps1) and [stop](plans/firebird/scripts/stop-firebird3-client-lab.ps1) helpers use a separate owned laboratory, the pinned Firebird ZIP, private credentials and loopback port 3059. Initialization requires a new directory and never adopts an existing installation. Obtain the required ZIP separately; the [database bootstrap](plans/firebird/scripts/initialize-firebird3-lab.ps1) downloads only when explicitly given `-Download`. No helper installs a service. Inspect helper parameters before choosing the laboratory paths; several generated-Client harnesses expect the sibling names shown above.

For a new owned laboratory using the default layout and an already available pinned ZIP, run from the ORM root:

```powershell
./docs/plans/firebird/scripts/initialize-firebird3-client-lab.ps1
./docs/plans/firebird/scripts/start-firebird3-client-lab.ps1
try {
  ./node_modules/.bin/tsx.cmd docs/plans/firebird/scripts/generate-firebird-client.ts
  if ($LASTEXITCODE -ne 0) { throw 'Fixture Client generation failed.' }
  ./node_modules/.bin/tsx.cmd docs/plans/firebird/scripts/setup-firebird-identity-fixture.ts
  if ($LASTEXITCODE -ne 0) { throw 'Identity fixture setup failed.' }
  ./node_modules/.bin/tsx.cmd --tsconfig docs/plans/firebird/tests/tsconfig.integration.json --test --test-concurrency=1 docs/plans/firebird/tests/generated-client.test.ts docs/plans/firebird/tests/generated-client-identity.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Generated Client tests failed.' }
} finally {
  ./docs/plans/firebird/scripts/stop-firebird3-client-lab.ps1
}
```

These suites change synthetic tables and retain local output; use only the owned disposable database. The optional native smoke test expects empty tables and belongs before the first Client run. An existing owned lab can skip initialization after its ownership/component checks, but reused fixture state is not a clean-run guarantee.

[Schema database provisioning](plans/firebird/scripts/initialize-firebird-schema-databases.ps1) supplies separate main/shadow/replay/probe databases for [introspection](plans/firebird/tests/schema-introspection.test.ts) and [migration execution](plans/firebird/tests/schema-migrations.e2e.test.ts). The migration harness requires `FIREBIRD_SCHEMA_LAB_RUN=1`. Installed-consumer tests for [the public CLI](plans/firebird/tests/cli-consumer.e2e.test.cjs), [db push](plans/firebird/tests/db-push-consumer.e2e.test.cjs), and [identifier updates](plans/firebird/tests/id-update-consumer.e2e.test.cjs) require their own provisioned databases, explicit opt-ins, prepared installed packages, ownership markers and fresh output directories. The [literal-prefix fixtures](plans/firebird/tests/prefix-filter-fixtures/) are inputs to a separately retained local consumer runner. These harnesses depend on local provisioning and package/receipt inputs and are not a self-contained quickstart. Read each harness's input checks; do not run them against application databases or replace them with a unit test. Preserve failed attempts when comparing changed builds.

## Remaining limits and distribution

- Firebird 4/5, other Firebird 3 platforms/patch levels, general production use and broad legacy compatibility require separate validation. Prepared 4/5 matrix sources do not remove the schema-engine's Firebird 3 major guard.
- `createMany` uses transactional singleton INSERTs. `createManyAndReturn`, `skipDuplicates`, bulk RETURNING and relation joins are unsupported. Nonempty singleton updates return primary-key columns for the transactional post-read, preserving exact arithmetic and BEFORE UPDATE trigger key changes. This does not enable the general UpdateReturning capability or support primary keys changed indirectly by AFTER/recursive triggers.
- Json, enums, scalar lists/array parameters, views, unsupported BLOB types/keys/indexes, extended Firebird 4 numeric/time-zone types and Decimal AVG are unsupported. Mixed per-column index directions, prefix/partial/fulltext indexes and namespace operations are unsupported. Page-size/collation-specific index limits remain database constraints. TypedSQL query description is unsupported.
- Ordinary Prisma transactions/savepoints do not implement prepared/distributed transactions, reconnect/limbo recovery, a durable coordinator journal, or legacy 2PC equivalence.

Self-contained local packaging, installation collectors and historical provenance receipts are maintained separately from this source guide. They require already built files, matching license inventories and deliberately completed local configuration. Their existence does not provide a standalone fresh-clone release recipe. Keep generated metadata, database files, private configurations, logs and local review receipts out of source/package payloads.

Preserve the upstream [LICENSE](../LICENSE), [fork modification notice](../MODIFICATIONS.md), [adapter legal files](../packages/adapter-firebird/MODIFICATIONS.md), [Client notices and credits](../packages/client/THIRD_PARTY_NOTICES.txt), and [the retained node-firebird license](plans/firebird/licenses/node-firebird-2.18.2-LICENSE.txt). The unchanged driver remains MPL-2.0. Any local prepared manifest projection must preserve original legal texts and record its changes; source availability, successful builds and private installation do not establish release/legal approval or a selected public product identity.
