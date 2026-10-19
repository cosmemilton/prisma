/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const repository = path.join(workspace, 'prisma-firebird')
const laboratory = path.join(workspace, 'firebird-client-lab')
const resultPath = path.join(workspace, 'artifacts', 'firebird-schema-migrations-results.json')
const require = createRequire(import.meta.url)
const digest = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex')

type LabConnection = {
  host: string
  port: number
  database: string
  user: string
  password: string
  [key: string]: unknown
}

const schemaV1 = `datasource db {
  provider = "firebird"
}

model SchemaItem {
  id     Int     @id @default(autoincrement())
  name   String  @unique @db.VarChar(80)
  amount Decimal @default(0) @db.Decimal(18, 4)
  active Boolean @default(true)
}
`
const schemaV2 = schemaV1.replace(
  '  active Boolean @default(true)',
  '  active Boolean @default(true)\n  note   String? @db.VarChar(120)',
)
const schemaV3 = schemaV2.replace('@db.VarChar(80)', '@db.VarChar(120)')

test(
  'actual Schema Engine Wasm migrations on three disposable Firebird databases',
  { timeout: 180_000, skip: process.env.FIREBIRD_SCHEMA_LAB_RUN !== '1' },
  async (t) => {
    // Credentials are read only after the explicit Wasm/adapter acceptance gate.
    process.env.DEBUG = ''
    let connections: Record<string, LabConnection>
    try {
      connections = JSON.parse(await readFile(path.join(laboratory, 'private/schema-connections.json'), 'utf8'))
    } catch {
      throw new Error('Could not read the private schema laboratory configuration.')
    }
    const roles = ['schema-main', 'schema-shadow', 'schema-replay'] as const
    for (const role of roles) {
      const config = connections[role]
      assert.ok(config && typeof config.database === 'string', `Missing disposable fixture ${role}`)
      assert.equal(config.host, '127.0.0.1', 'Use only the verified private loopback server')
      assert.equal(config.port, 3059, 'Use only the verified private laboratory port')
      const relative = path.relative(laboratory, path.resolve(config.database))
      assert.ok(
        relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative),
        'Use only laboratory files',
      )
    }
    assert.equal(
      new Set(roles.map((role) => path.resolve(connections[role].database).toLowerCase())).size,
      roles.length,
    )

    const urlFor = (config: LabConnection) =>
      `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database.replaceAll('\\', '/'))}`
    const urls = Object.fromEntries(roles.map((role) => [role, urlFor(connections[role])]))
    const secretTokens = roles
      .flatMap((role) => {
        const config = connections[role]
        return [
          urls[role],
          config.user,
          config.password,
          config.database,
          config.database.replaceAll('\\', '/'),
          encodeURIComponent(config.database),
          encodeURIComponent(config.database.replaceAll('\\', '/')),
          encodeURIComponent(config.user),
          encodeURIComponent(config.password),
        ]
      })
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    const sanitize = (value: string) => {
      let text = value.replace(/firebird:\/\/[^\s"'<>]+/gi, '<REDACTED_FIREBIRD_URL>')
      for (const token of secretTokens) text = text.replaceAll(token, '<REDACTED>')
      return text
    }
    const safeError = (error: unknown) => new Error(sanitize(error instanceof Error ? error.message : String(error)))
    const rejectsClearly = (operation: Promise<unknown> | (() => Promise<unknown>), matcher: RegExp) =>
      assert.rejects(operation, (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.doesNotMatch(message, /unknown variant|deserialize|deserialization|serde_wasm_bindgen/i)
        assert.match(message, matcher)
        return true
      })
    const activeTimers = new Map<number, { delayMs: number; stack: string }>()
    const diagnosticHook = createHook({
      init(id, type, _trigger, resource: any) {
        if (type === 'Timeout') {
          activeTimers.set(id, {
            delayMs: resource._idleTimeout,
            stack: sanitize(new Error('Timer created').stack ?? ''),
          })
        }
      },
      destroy(id) {
        activeTimers.delete(id)
      },
    })
    if (process.env.FIREBIRD_SCHEMA_LAB_DIAGNOSTICS === '1') diagnosticHook.enable()

    // Resolve built packages directly. The isolated NodeNext tsconfig must not
    // inherit the repository's source aliases or replace actual compiled modules.
    const { Migrate, SchemaEngineWasm } = require('../../../../packages/migrate')
    const { createSchemaPathInput, loadSchemaContext, toSchemasContainer } = require('../../../../packages/internals')
    const { PrismaFirebird } = require('../../../../packages/adapter-firebird')
    const { bindMigrationAwareSqlAdapterFactory } = require('../../../../packages/driver-adapter-utils')
    const runDirectory = path.join(laboratory, 'generated', `schema-migrations-${Date.now()}`)
    const migrationsDirPath = path.join(runDirectory, 'migrations')
    const schemaPath = path.join(runDirectory, 'schema.prisma')
    await mkdir(runDirectory, { recursive: true })

    const startedAtUtc = new Date().toISOString()
    const passed: string[] = []
    const migrationFiles: Array<{ name: string; bytes: number; sha256: string }> = []
    const negativeFixtureDdl: string[] = []
    const schemaPushResults: Array<{
      phase: string
      executedSteps: number
      warnings: string[]
      unexecutable: string[]
    }> = []
    const diffFiles: Array<{ name: string; bytes: number; sha256: string; exitCode: number }> = []
    const open = new Set<any>()
    let attempted = 0
    let lockContentionMs: number | undefined
    let failure: Error | undefined
    let actualWasm = false
    let ownedSchemaResets = 0
    let fixtureId: number | undefined
    let lifecycle: unknown
    let migrationLockError: { originalCode: string; message: string } | undefined

    const check = async (name: string, work: () => Promise<void>) => {
      attempted++
      let rejected = false
      await t.test(name, async () => {
        try {
          await work()
          passed.push(name)
        } catch (error) {
          rejected = true
          throw safeError(error)
        }
      })
      if (rejected) throw new Error(`Migration scenario failed: ${name}`)
    }
    const contextFor = async (schema: string) => {
      await writeFile(schemaPath, schema)
      return loadSchemaContext({
        schemaPath: createSchemaPathInput({ schemaPathFromArgs: schemaPath, baseDir: runDirectory }),
        printLoadMessage: false,
      })
    }
    const openMigrate = async (
      role: (typeof roles)[number],
      schema: string,
      options: { local?: boolean; shadowUrl?: string | null } = {},
    ) => {
      const schemaContext = await contextFor(schema)
      const url = urls[role] + (options.local === false ? '' : '?shadowDatabaseFileSystem=local')
      const shadowDatabaseUrl = options.shadowUrl === null ? undefined : (options.shadowUrl ?? urls['schema-shadow'])
      const migrate = await Migrate.setup({
        schemaEngineConfig: { datasource: { url, shadowDatabaseUrl } },
        schemaContext,
        migrationsDirPath,
        baseDir: runDirectory,
      })
      open.add(migrate)
      assert.ok(migrate.engine instanceof SchemaEngineWasm, 'Firebird must use the compiled Wasm engine wrapper')
      actualWasm = true
      return migrate
    }
    const stop = async (migrate: any) => {
      try {
        await migrate.stop()
      } finally {
        open.delete(migrate)
      }
    }
    const withMigrate = async (
      role: (typeof roles)[number],
      schema: string,
      work: (migrate: any) => Promise<void>,
      options: { local?: boolean; shadowUrl?: string | null } = {},
    ) => {
      const migrate = await openMigrate(role, schema, options)
      try {
        await work(migrate)
      } finally {
        await stop(migrate)
      }
    }
    // Raw queries below only verify fixture/catalog state and persisted data.
    // Supported schema changes use real Wasm-generated migrations or schemaPush.
    // The explicit unmanaged sequence below is only a negative reset fixture.
    const rows = async (role: (typeof roles)[number], sql: string) => {
      const adapter = await new PrismaFirebird(connections[role], { poolSize: 2, transactionLockTimeout: 0 }).connect()
      try {
        return (await adapter.queryRaw({ sql, args: [], argTypes: [] })).rows as unknown[][]
      } finally {
        await adapter.dispose()
      }
    }
    const schemaContainer = (schema: string) => toSchemasContainer([[schemaPath, schema]])
    const create = async (migrate: any, schema: string, migrationName: string) => {
      const result = await migrate.createMigration({ schema: schemaContainer(schema), draft: false, migrationName })
      assert.equal(typeof result.generatedMigrationName, 'string', 'Expected a real generated migration')
      const content = await readFile(path.join(migrationsDirPath, result.generatedMigrationName, 'migration.sql'))
      assert.doesNotMatch(content.toString(), /\b(?:CREATE|DROP)\s+DATABASE\b/i)
      migrationFiles.push({ name: result.generatedMigrationName, bytes: content.length, sha256: digest(content) })
      return content.toString()
    }
    const persisted = async () => {
      const data = await rows('schema-main', 'SELECT "id", "name", "amount", "active", "note" FROM "SchemaItem"')
      assert.equal(data.length, 1)
      assert.equal(Number(data[0][0]), fixtureId, 'The existing identity must survive every schema change')
      assert.equal(data[0][1], 'persistent-fixture')
      assert.equal(Number(data[0][2]), 12.34)
      assert.equal(data[0][3], true)
      assert.equal(data[0][4], null)
    }
    const migrationList = async () => ({
      baseDir: migrationsDirPath,
      lockfile: {
        path: 'migration_lock.toml',
        content: await readFile(path.join(migrationsDirPath, 'migration_lock.toml'), 'utf8'),
      },
      shadowDbInitScript: '',
      migrationDirectories: await Promise.all(
        migrationFiles.map(async (file) => ({
          path: file.name,
          migrationFile: {
            path: 'migration.sql',
            content: {
              tag: 'ok',
              value: await readFile(path.join(migrationsDirPath, file.name, 'migration.sql'), 'utf8'),
            },
          },
        })),
      ),
    })
    const rejectUnsafeFactory = async (
      options: { poolSize: number; transactionLockTimeout?: number },
      matcher: RegExp,
    ) => {
      let engine: any
      const start = performance.now()
      try {
        await rejectsClearly(async () => {
          engine = await SchemaEngineWasm.setup({
            adapter: bindMigrationAwareSqlAdapterFactory(
              new PrismaFirebird(connections['schema-main'], {
                ...options,
                shadowDatabase: connections['schema-shadow'],
                shadowDatabaseFileSystem: 'local',
              }),
            ),
            schemaContext: await contextFor(schemaV2),
          })
          open.add(engine)
          await engine.applyMigrations({
            migrationsList: await migrationList(),
            filters: { externalTables: [], externalEnums: [] },
          })
        }, matcher)
        assert.ok(
          performance.now() - start < 15_000,
          'Unsafe migration factory must reject before waiting for a pool/lock',
        )
      } finally {
        if (engine) await stop(engine)
      }
      await persisted()
    }
    const captureDiff = async (engine: any, input: any, name: string) => {
      const write = process.stdout.write
      const chunks: string[] = []
      let result: { exitCode: number }
      try {
        process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
          const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined
          callback?.()
          return true
        }) as typeof process.stdout.write
        result = await engine.migrateDiff(input)
      } finally {
        process.stdout.write = write
      }
      const content = sanitize(chunks.join(''))
      await writeFile(path.join(runDirectory, name), content)
      diffFiles.push({ name, bytes: Buffer.byteLength(content), sha256: digest(content), exitCode: result.exitCode })
      return { content, exitCode: result.exitCode }
    }

    try {
      await check('reserved databases have fresh application schemas and distinct files', async () => {
        for (const role of roles) {
          let tables = await rows(
            role,
            'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL',
          )
          const names = tables.map((row) => String(row[0]).trim().toLowerCase())
          if (
            process.env.FIREBIRD_SCHEMA_LAB_RESET_OWNED === '1' &&
            names.some((name) => name !== '_prisma_migrate_lock')
          ) {
            assert.ok(
              names.every((name) => ['schemaitem', '_prisma_migrations', '_prisma_migrate_lock'].includes(name)),
              'Only the known disposable fixture may be reset',
            )
            // Explicit reruns may reset this suite's known schema through the real
            // API. Firebird refuses unmanaged objects before any destructive step.
            await withMigrate(
              role,
              schemaV1,
              async (migrate) => {
                await migrate.reset()
                ownedSchemaResets++
              },
              { shadowUrl: null },
            )
            tables = await rows(
              role,
              'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL',
            )
          }
          const applicationTables = tables.filter(
            (row) => String(row[0]).trim().toLowerCase() !== '_prisma_migrate_lock',
          )
          assert.equal(
            applicationTables.length,
            0,
            `${role} must be fresh; unknown schema is preserved for investigation`,
          )
        }
      })
      await check('Migrate.setup selects actual Firebird Wasm and reports Firebird 3', async () => {
        await withMigrate('schema-main', schemaV1, async (migrate) => {
          assert.match(await migrate.engine.getDatabaseVersion(), /3\.0\./)
        })
      })
      await check('createMigration generates Firebird table and identity DDL', async () => {
        await withMigrate('schema-main', schemaV1, async (migrate) => {
          const sql = await create(migrate, schemaV1, 'initial')
          assert.match(sql, /CREATE TABLE[\s\S]*SchemaItem/i)
          assert.match(sql, /GENERATED BY DEFAULT AS IDENTITY/i)
        })
        assert.match(
          await readFile(path.join(migrationsDirPath, 'migration_lock.toml'), 'utf8'),
          /provider\s*=\s*"firebird"/,
        )
      })
      await check('applyMigrations persists history and repeats as a no-op', async () => {
        await withMigrate('schema-main', schemaV1, async (migrate) => {
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [migrationFiles[0].name])
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [])
          const history = await migrate.diagnoseMigrationHistory({ optInToShadowDatabase: false })
          assert.equal(history.hasMigrationsTable, true)
          assert.equal(history.failedMigrationNames.length, 0)
        })
      })
      await check('Wasm dbExecute inserts a synthetic row using the generated identity', async () => {
        await withMigrate('schema-main', schemaV1, async (migrate) => {
          await migrate.engine.dbExecute({
            datasourceType: { tag: 'url', url: urls['schema-main'] },
            script:
              'INSERT INTO "SchemaItem" ("name", "amount", "active") VALUES (\'persistent-fixture\', 12.3400, TRUE);',
          })
        })
        const data = await rows('schema-main', 'SELECT "id" FROM "SchemaItem"')
        assert.equal(data.length, 1)
        fixtureId = Number(data[0][0])
        assert.ok(fixtureId > 0)
      })
      await check('a schema alteration is generated from actual migration history in shadow', async () => {
        await withMigrate('schema-main', schemaV2, async (migrate) => {
          const sql = await create(migrate, schemaV2, 'add_note')
          assert.match(sql, /ALTER TABLE[\s\S]*SchemaItem[\s\S]*ADD[\s\S]*note/i)
        })
      })
      await check('applying the alteration preserves existing identity and scalar data', async () => {
        await withMigrate('schema-main', schemaV2, async (migrate) => {
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [migrationFiles[1].name])
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [])
        })
        await persisted()
      })
      await check(
        'shadow drift diagnostics and devDiagnostic replay real history without touching main data',
        async () => {
          await withMigrate('schema-main', schemaV2, async (migrate) => {
            const diagnostic = await migrate.diagnoseMigrationHistory({ optInToShadowDatabase: true })
            assert.ok(diagnostic.history === null, 'Expected synchronized migration history')
            assert.equal(
              diagnostic.drift,
              undefined,
              `Expected no schema drift after shadow replay: ${JSON.stringify(diagnostic.drift)}`,
            )
            assert.equal(diagnostic.failedMigrationNames.length, 0)
            assert.equal((await migrate.devDiagnostic()).action.tag, 'createMigration')
          })
          assert.equal(Number((await rows('schema-shadow', 'SELECT COUNT(*) FROM "SchemaItem"'))[0][0]), 0)
          await persisted()
        },
      )
      await check('the same migration files replay into the fresh replay database', async () => {
        await withMigrate('schema-replay', schemaV2, async (migrate) => {
          assert.deepEqual(
            (await migrate.applyMigrations()).appliedMigrationNames,
            migrationFiles.map((file) => file.name),
          )
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [])
          const introspected = await migrate.engine.introspect({
            schema: schemaContainer(schemaV2),
            force: true,
            baseDirectoryPath: runDirectory,
            viewsDirectoryPath: path.join(runDirectory, 'views'),
          })
          const text = introspected.schema.files.map((file: { content: string }) => file.content).join('\n')
          assert.match(text, /model SchemaItem/)
          assert.match(text, /note\s+String\?/)
          assert.match(text, /@default\(autoincrement\(\)\)/)
        })
        assert.equal(Number((await rows('schema-replay', 'SELECT COUNT(*) FROM "SchemaItem"'))[0][0]), 0)
      })
      await check('shadow operations fail closed without explicit local filesystem opt-in', async () => {
        await withMigrate(
          'schema-main',
          schemaV2,
          async (migrate) => {
            await rejectsClearly(
              migrate.createMigration({
                schema: schemaContainer(schemaV2),
                draft: false,
                migrationName: 'without_opt_in',
              }),
              /Could not verify the physical Firebird database identity; shadow connections require shadowDatabaseFileSystem: local/i,
            )
          },
          { local: false },
        )
        await persisted()
      })
      await check('shadow operations fail closed when the shadow connection is absent', async () => {
        await withMigrate(
          'schema-main',
          schemaV2,
          async (migrate) => {
            await rejectsClearly(
              migrate.createMigration({
                schema: schemaContainer(schemaV2),
                draft: false,
                migrationName: 'without_shadow',
              }),
              /Firebird migration history requires an explicit, separate shadowDatabase connection/i,
            )
          },
          { shadowUrl: null },
        )
        await persisted()
      })
      await check('the same physical main and shadow database is rejected before reset', async () => {
        await withMigrate(
          'schema-main',
          schemaV2,
          async (migrate) => {
            await rejectsClearly(
              migrate.createMigration({
                schema: schemaContainer(schemaV2),
                draft: false,
                migrationName: 'same_database',
              }),
              /Firebird shadow database must be different from the main database/i,
            )
          },
          { shadowUrl: urls['schema-main'] },
        )
        await persisted()
      })
      await check('unsupported Json DDL is rejected without producing a migration or altering data', async () => {
        await withMigrate('schema-main', schemaV2, async (migrate) => {
          await rejectsClearly(
            migrate.createMigration({
              schema: schemaContainer(
                schemaV2.replace(
                  '  note   String? @db.VarChar(120)',
                  '  note   String? @db.VarChar(120)\n  payload Json?',
                ),
              ),
              draft: false,
              migrationName: 'unsupported_json',
            }),
            /Json|JSON|unsupported|not supported/i,
          )
        })
        const directories = (await readdir(migrationsDirPath, { withFileTypes: true })).filter((entry) =>
          entry.isDirectory(),
        )
        assert.equal(directories.length, 2)
        await persisted()
      })
      await check('migration lock contention is bounded and dispose releases the owned lock', async () => {
        const first = await openMigrate('schema-main', schemaV2)
        const second = await openMigrate('schema-main', schemaV2)
        try {
          assert.deepEqual((await first.applyMigrations()).appliedMigrationNames, [])
          const start = performance.now()
          let lockMessage = ''
          await rejectsClearly(
            second.applyMigrations().catch((error: unknown) => {
              lockMessage = sanitize(error instanceof Error ? error.message : String(error))
              throw error
            }),
            /lock|deadlock|concurrent|contention|timeout/i,
          )
          const originalCode = /Driver error code: (\d+)\./.exec(lockMessage)?.[1]
          assert.ok(originalCode, 'Lock failure must preserve the real driver error code')
          migrationLockError = { originalCode, message: lockMessage }
          lockContentionMs = performance.now() - start
          assert.ok(lockContentionMs < 15_000, 'Migration lock contention must not wait indefinitely')
          await stop(first)
          assert.deepEqual((await second.applyMigrations()).appliedMigrationNames, [])
        } finally {
          await stop(first)
          await stop(second)
        }
        await withMigrate('schema-main', schemaV2, async (migrate) => {
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [])
        })
        await persisted()
      })
      await check('unchanged schemas converge without creating another migration', async () => {
        await withMigrate('schema-main', schemaV2, async (migrate) => {
          const result = await migrate.createMigration({
            schema: schemaContainer(schemaV2),
            draft: false,
            migrationName: 'unchanged',
          })
          assert.equal(result.generatedMigrationName, undefined)
        })
        assert.equal(
          (await readdir(migrationsDirPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length,
          2,
        )
        await persisted()
      })
      await check('a direct migration factory with one attachment rejects before pool starvation', async () => {
        await rejectUnsafeFactory(
          { poolSize: 1, transactionLockTimeout: 0 },
          /migration locking requires adapter maxConcurrentConnections >= 2; configure poolSize at least 2/i,
        )
      })
      await check('a direct migration factory with default unbounded WAIT rejects before locking', async () => {
        await rejectUnsafeFactory(
          { poolSize: 2 },
          /migration locking requires supportsBoundedTransactionWait; configure transactionLockTimeout/i,
        )
      })
      await check('an indexed VARCHAR can widen through a generated migration while preserving data', async () => {
        await withMigrate('schema-main', schemaV3, async (migrate) => {
          const sql = await create(migrate, schemaV3, 'widen_indexed_name')
          assert.match(sql, /ALTER TABLE[\s\S]*VARCHAR\(120\)/i)
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [migrationFiles[2].name])
          assert.equal(
            (
              await migrate.createMigration({
                schema: schemaContainer(schemaV3),
                draft: false,
                migrationName: 'unchanged_after_widen',
              })
            ).generatedMigrationName,
            undefined,
          )
          await rejectsClearly(
            migrate.engine.dbExecute({
              datasourceType: { tag: 'url', url: urls['schema-main'] },
              script:
                'INSERT INTO "SchemaItem" ("name", "amount", "active") VALUES (\'persistent-fixture\', 99, TRUE);',
            }),
            /unique|duplicate|constraint/i,
          )
        })
        await persisted()
        await withMigrate('schema-replay', schemaV3, async (migrate) => {
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [migrationFiles[2].name])
          assert.deepEqual((await migrate.applyMigrations()).appliedMigrationNames, [])
        })
      })
      const pushSchema = schemaV3.replace(
        '  note   String? @db.VarChar(120)',
        '  note   String? @db.VarChar(120)\n  pushNote String? @db.VarChar(40)',
      )
      const push = async (engine: any, schema: string, phase: string) => {
        const result = await engine.schemaPush({
          schema: schemaContainer(schema),
          force: false,
          filters: { externalTables: [], externalEnums: [] },
        })
        schemaPushResults.push({ phase, ...result })
        assert.deepEqual(result.warnings, [])
        assert.deepEqual(result.unexecutable, [])
        return result.executedSteps as number
      }
      await check('schemaPush converges and adds an optional column on the disposable replay schema', async () => {
        await withMigrate('schema-replay', schemaV3, async (migrate) => {
          assert.equal(await push(migrate.engine, schemaV3, 'unchanged'), 0)
          assert.ok((await push(migrate.engine, pushSchema, 'add_optional_column')) > 0)
          assert.equal(await push(migrate.engine, pushSchema, 'unchanged_after_add'), 0)
        })
        assert.equal(
          Number((await rows('schema-replay', 'SELECT COUNT(*) FROM "SchemaItem" WHERE "pushNote" IS NOT NULL'))[0][0]),
          0,
        )
        await persisted()
      })
      await check(
        'Wasm diff captures both database/datamodel directions and schemaPush restores the verified empty column',
        async () => {
          await withMigrate('schema-replay', pushSchema, async (migrate) => {
            const filters = { externalTables: [], externalEnums: [] }
            // Prisma 7 diff reads the configured adapter through schemaDatasource;
            // its legacy raw-URL diff target deliberately rejects in the engine.
            const live = { tag: 'schemaDatasource', ...schemaContainer(pushSchema), configDir: runDirectory }
            const desired = { tag: 'schemaDatamodel', ...schemaContainer(schemaV3) }
            const forward = await captureDiff(
              migrate.engine,
              { from: live, to: desired, script: true, exitCode: true, filters },
              'diff-database-to-datamodel.sql',
            )
            assert.equal(forward.exitCode, 2)
            assert.match(forward.content, /ALTER TABLE[\s\S]*DROP[\s\S]*"pushNote"/i)
            const reverse = await captureDiff(
              migrate.engine,
              { from: desired, to: live, script: true, exitCode: true, filters },
              'diff-datamodel-to-database.sql',
            )
            assert.equal(reverse.exitCode, 2)
            assert.match(reverse.content, /ALTER TABLE[\s\S]*ADD[\s\S]*"pushNote"/i)
            // Only the suite-created, verified empty optional column is removed.
            assert.equal(
              Number(
                (await rows('schema-replay', 'SELECT COUNT(*) FROM "SchemaItem" WHERE "pushNote" IS NOT NULL'))[0][0],
              ),
              0,
            )
            assert.ok((await push(migrate.engine, schemaV3, 'restore_empty_optional_column')) > 0)
            assert.equal(await push(migrate.engine, schemaV3, 'unchanged_after_restore'), 0)
            const equal = await captureDiff(
              migrate.engine,
              { from: live, to: desired, script: true, exitCode: true, filters },
              'diff-restored-schema.sql',
            )
            assert.equal(equal.exitCode, 0)
            assert.doesNotMatch(equal.content, /\b(?:CREATE|ALTER|DROP)\b/i)
          })
          await persisted()
        },
      )
      await check('reset rejects an unmanaged sequence before dropping tables or persisted data', async () => {
        await withMigrate('schema-main', schemaV3, async (migrate) => {
          // This deliberate unsupported fixture is not a migration replacement.
          await migrate.engine.dbExecute({
            datasourceType: { tag: 'url', url: urls['schema-main'] },
            script: 'CREATE SEQUENCE "ExternalSequence";',
          })
          negativeFixtureDdl.push('CREATE SEQUENCE "ExternalSequence"')
          try {
            await rejectsClearly(migrate.reset(), /cannot manage sequence\s+"ExternalSequence"/i)
            await persisted()
            assert.equal(
              Number(
                (
                  await rows('schema-main', 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL')
                )[0][0],
              ),
              migrationFiles.length,
            )
          } finally {
            const existing = await rows(
              'schema-main',
              "SELECT COUNT(*) FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = 'ExternalSequence'",
            )
            if (Number(existing[0][0]) > 0) {
              await migrate.engine.dbExecute({
                datasourceType: { tag: 'url', url: urls['schema-main'] },
                script: 'DROP SEQUENCE "ExternalSequence";',
              })
              negativeFixtureDdl.push('DROP SEQUENCE "ExternalSequence"')
            }
          }
        })
      })
    } catch (error) {
      failure = safeError(error)
    } finally {
      const cleanup = await Promise.allSettled([...open].map(stop))
      const rejected = cleanup.find((entry) => entry.status === 'rejected')
      if (rejected?.status === 'rejected' && failure === undefined) failure = safeError(rejected.reason)
      if (process.env.FIREBIRD_SCHEMA_LAB_DIAGNOSTICS === '1') {
        await new Promise<void>((resolve) => setImmediate(resolve))
        lifecycle = {
          trackedEngines: open.size,
          resources: process.getActiveResourcesInfo(),
          handles: (process as any)._getActiveHandles().map((handle: any) => ({
            type: handle.constructor?.name,
            remoteAddress: handle.remoteAddress,
            remotePort: handle.remotePort,
            localAddress: handle.localAddress,
            localPort: handle.localPort,
            destroyed: handle.destroyed,
            connecting: handle.connecting,
            pending: handle.pending,
            hasRef: handle.hasRef?.() ?? handle._handle?.hasRef?.(),
          })),
          timers: [...activeTimers.values()],
        }
        console.info(`Firebird migration lifecycle: ${JSON.stringify(lifecycle)}`)
      }
      diagnosticHook.disable()
      const wasm = await readFile(path.join(repository, 'packages/internals/build/schema_engine_bg.wasm'))
      await writeFile(
        resultPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            status: failure === undefined && attempted === passed.length ? 'passed' : 'failed',
            startedAtUtc,
            completedAtUtc: new Date().toISOString(),
            nodeVersion: process.version,
            roles,
            attempted,
            scenarioCount: passed.length,
            passed,
            actualWasm,
            wasm: { bytes: wasm.length, sha256: digest(wasm) },
            migrationFiles,
            lockContentionMs,
            ownedSchemaResets,
            fixtureDirectory: path.relative(laboratory, runDirectory).split(path.sep).join('/'),
            negativeFixtureDdl,
            schemaPushResults,
            diffFiles,
            lifecycle,
            migrationLockError,
            failure: failure?.message,
            scope:
              'Real compiled Migrate/SchemaEngineWasm API; no DB creation/drop or service control. Files in migrationFiles are generated by Wasm; schemaPushResults and diffFiles record separate real APIs. Manual sequence DDL is only an unsupported reset fixture; direct adapter queries inspect catalog/data. Explicit reruns can reset only the known fixture schema through Migrate.reset. Local shadow filesystem opt-in is explicit.',
          },
          null,
          2,
        ) + '\n',
      )
    }
    if (failure) throw failure
    assert.equal(passed.length, 21)
  },
)
