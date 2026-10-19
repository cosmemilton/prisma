# @prisma/adapter-firebird

Experimental Prisma 7 driver adapter for the real `firebird` provider and Firebird 3.0, using the pure JavaScript `node-firebird` driver pinned to **2.18.2**. It requires the accompanying Firebird schema and query-compiler builds; installing this adapter alone does not add a provider to an upstream Prisma release.

```ts
import { PrismaFirebird } from '@prisma/adapter-firebird'
import { PrismaClient } from './generated/client'

const adapter = new PrismaFirebird({
  host: '127.0.0.1',
  port: 3050,
  database: '/absolute/path/application.fdb',
  user: process.env.FIREBIRD_USER,
  password: process.env.FIREBIRD_PASSWORD,
})
const prisma = new PrismaClient({ adapter })
```

The adapter connects to existing databases. Each standalone operation uses a transaction and returns its attachment to an owned pool after confirmed commit/rollback. An attachment whose transaction end cannot be confirmed is destroyed and removed from the pool. Interactive transactions own an attachment until completion. Savepoints are supported. The default pool size is 5; pass `{ poolSize: 10 }` as the second constructor argument to change it.

Migration history operations require the accompanying Firebird schema-engine build and an existing, separate **local** shadow database. Supply `{ shadowDatabase: shadowConfigOrUrl, shadowDatabaseFileSystem: 'local' }` in the second constructor argument. The filesystem option is an explicit assertion that both native Firebird servers use the same local filesystem namespace as the Node.js process. A loopback tunnel, forwarded port, container, VM, or remote filesystem namespace does not satisfy that assertion. It is never inferred from a loopback URL. The accompanying CLI requires the explicit `shadowDatabaseFileSystem=local` query parameter on the main URL and removes it before passing the connection to the driver.

`connectToShadowDb()` requires explicit numeric loopback hosts (`127.0.0.1` or `::1`) and absolute paths returned by `MON$DATABASE`. Firebird 3 may return an alias instead of a path; alias-only results are refused. It resolves the local paths and checks nonzero filesystem file IDs with BigInt `dev`/`ino`, rejecting the same file even through a junction or hard link. Missing, inaccessible, non-file, or changing identities fail closed. On failure both temporary pools are disposed. Remote Client connections and introspection are unaffected, but remote or unverifiable migration shadow connections are unsupported. The adapter never creates or drops a database, installs a service, or substitutes the main connection for a missing shadow connection.

Pass `{ transactionLockTimeout: 0 }` to use NOWAIT for transaction locks, or an integer from 1 to 32767 for a bounded wait in seconds. Omitting it preserves unlimited WAIT. Migration runners can use NOWAIT to fail promptly on concurrent migration ownership. Positive timeouts use native little-endian TPB bytes because the pinned driver's ordinary timeout writer changes byte order above 255; the external driver remains unchanged.

Connection metadata reports the configured pool capacity and whether transaction lock waits are bounded. The Firebird schema engine requires capacity of at least two and a bounded wait before acquiring its migration ownership lock; a single-connection pool remains usable for ordinary queries and introspection.

Connections use UTF8, exact string numeric decoding, and positional parameters. Int64 and Decimal parameters stay strings throughout adapter and driver encoding; they never pass through JavaScript `Number`. Supply exact decimals as strings/Prisma Decimal and BigInts as bigint/integer strings. NULL, Boolean, Unicode, binary/text BLOB, DATE, TIME, and TIMESTAMP are supported. Text BLOBs must use UTF8 storage; invalid UTF-8 fails explicitly. Unsupported native types fail explicitly. Relation joins and array parameters are unsupported. The adapter reports a conservative 1000 bind-value batching budget.

Firebird DATE/TIME/TIMESTAMP have no time zone; the adapter interprets their calendar fields as UTC. Raw results retain Firebird's four fractional second digits. JavaScript `Date` and Prisma Client `DateTime` expose millisecond precision, so the fourth fractional digit cannot be represented in those objects. Passing strings to raw queries can preserve all four digits. Nonzero fractional digits beyond four are rejected rather than silently rounded.

The default isolation is READ COMMITTED RECORD_VERSION. REPEATABLE READ and SNAPSHOT map to Firebird SNAPSHOT (`isc_tpb_concurrency`); SERIALIZABLE maps to SNAPSHOT TABLE STABILITY (`isc_tpb_consistency`). READ UNCOMMITTED is rejected because Firebird does not provide dirty reads. COMMIT/ROLLBACK must use Prisma transaction APIs. Firebird 3 DML `RETURNING` supports singleton writes only; matching multiple records raises the server's singleton-select error. Zero-match DML `RETURNING` is normalized using affected-record metadata, preserving genuine returned NULL values. Generated identity values come from `INSERT ... RETURNING`, including `INSERT ... DEFAULT VALUES RETURNING`; there is no connection-global `lastInsertId`. Ordinary `createMany` plans use multiple single-row INSERTs inside one transaction, and sum their affected-record counts. `createManyAndReturn` and `skipDuplicates` are unsupported.

Pass `{ readCommittedRecordVersion: 'no-record-version' }` as the second constructor argument when READ COMMITTED must observe active writer locks, matching the pinned driver's `ISOLATION_READ_COMMITTED` policy. Omitting this option, or passing `'record-version'`, keeps the default RECORD_VERSION policy, which can read the previous committed record version. The option applies to default and explicit READ COMMITTED transactions on that factory's main and shadow adapters, including ordinary Client operations, interactive and batch `$transaction`, and scripts. Other isolation levels retain their mappings. `transactionLockTimeout` independently controls WAIT, NOWAIT, or a bounded wait in seconds; Prisma's transaction `maxWait` and `timeout` remain separate settings in milliseconds.

The pinned driver exposes prepared statement and wire modules through its package exports. This adapter uses their statement-local descriptors, `statementInfo`, and BLOB primitives to preserve fixed-point and 100-microsecond values, avoid local-time `Date` conversion, and eagerly read/close BLOB handles inside the owning transaction. It snapshots/restores descriptors before releasing a cached statement. It does not modify global driver prototypes or rewrite SQL. Upgrading `node-firebird` requires reviewing these internal APIs and running adapter plus real generated-Client tests. No network access or database is needed for the package unit tests.

`executeScript` accepts SQL statements and complete PSQL bodies separated by semicolons, including Firebird 3 alternative string literals. It parses the complete script before acquiring an attachment, then executes every statement in one transaction. A later statement failure rolls back earlier transactional DDL. Omit `isql` client directives such as `SET TERM`, and use the adapter transaction APIs for COMMIT/ROLLBACK.
