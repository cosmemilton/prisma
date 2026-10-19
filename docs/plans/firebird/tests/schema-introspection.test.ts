/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PrismaFirebird } from '../../../../packages/adapter-firebird/dist/index.mjs'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const lab = path.join(workspace, 'firebird-client-lab')
const orm = path.join(workspace, 'prisma-firebird')
const requireMigrate = createRequire(path.join(orm, 'packages/migrate/package.json'))
const { Migrate, SchemaEngineWasm } = requireMigrate('./dist/index.js')
const { toSchemasContainer } = requireMigrate('@prisma/internals')
const requireGenerator = createRequire(path.join(orm, 'packages/client-generator-ts/package.json'))
const { getDMMF, generateClient } = requireGenerator('@prisma/client-generator-ts')
const baseSchema = `generator client {
  provider = "prisma-client"
  output = "./catalog-generated"
}
datasource db {
  provider = "firebird"
}
`

function urlFor(config: any): string {
  return `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database.replaceAll('\\', '/'))}`
}

test('actual Firebird 3 catalog -> schema engine Wasm -> PSL -> generated Client', { timeout: 180_000 }, async (t) => {
  const connections = JSON.parse(await readFile(path.join(lab, 'private/schema-connections.json'), 'utf8'))
  const config = connections['schema-probe']
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3059)
  assert.equal(path.resolve(config.database), path.join(lab, 'db/schema-probe.fdb'))
  const wasmPath = path.join(orm, 'packages/internals/build/schema_engine_bg.wasm')
  const executedWasm = await readFile(wasmPath)
  const wasmSha256 = createHash('sha256').update(executedWasm).digest('hex')
  const sourcePath = path.join(
    workspace,
    'prisma-engines-firebird/schema-engine/sql-schema-describer/tests/fixtures/firebird/catalog.sql',
  )
  const fixture = await readFile(sourcePath, 'utf8')
  const db = await new PrismaFirebird(config).connect()
  const migrate = await Migrate.setup({
    schemaEngineConfig: { datasource: { url: urlFor(config) } },
    baseDir: lab,
  })
  const passed: string[] = []
  let attempted = 0
  let schema = ''
  let warnings: unknown
  let client: any
  let version: unknown
  const check = async (name: string, fn: () => Promise<void>) => {
    attempted++
    await t.test(name, async () => {
      await fn()
      passed.push(name)
    })
  }
  const query = async (sql: string) => db.queryRaw({ sql, args: [], argTypes: [] })
  try {
    await check('fixture is provisioned only in the owned probe database', async () => {
      const count = await query(
        `SELECT COUNT(*) AS "count" FROM RDB$RELATIONS WHERE RDB$RELATION_NAME IN ('CatalogParent','CatalogChild','CatalogLegacy')`,
      )
      const existing = Number(count.rows[0]?.[0])
      assert.ok(existing === 0 || existing === 3, 'Refuse an incomplete catalog fixture')
      if (existing === 0) await db.executeScript(fixture)
    })
    await check('Firebird route loads a real schema engine and validates connection', async () => {
      assert.ok(migrate.engine instanceof SchemaEngineWasm)
      await migrate.engine.ensureConnectionValidity({ datasource: { tag: 'ConnectionString', url: urlFor(config) } })
      version = await migrate.engine.getDatabaseVersion()
      assert.match(String(version), /3\.0\./)
    })
    await check('real system catalog introspection produces valid Firebird PSL', async () => {
      const result = await migrate.engine.introspect({
        schema: toSchemasContainer([['schema.prisma', baseSchema]]),
        baseDirectoryPath: lab,
        viewsDirectoryPath: path.join(lab, 'catalog-views'),
        force: true,
      })
      schema = result.schema.files.map((file: any) => file.content).join('\n')
      warnings = result.warnings
      assert.match(schema, /model CatalogParent/)
      assert.match(schema, /model CatalogChild/)
      assert.match(schema, /model CatalogLegacy/)
      const dmmf = await getDMMF({ datamodel: schema })
      assert.equal(dmmf.datamodel.models.length, 3)
      await writeFile(path.join(lab, 'catalog-introspected.prisma'), schema)
    })
    await check('identity, native types, defaults and composite relations preserve catalog semantics', async () => {
      const { datamodel } = await getDMMF({ datamodel: schema })
      const parent = datamodel.models.find((model: any) => model.name === 'CatalogParent')
      const child = datamodel.models.find((model: any) => model.name === 'CatalogChild')
      const legacy = datamodel.models.find((model: any) => model.name === 'CatalogLegacy')
      const field = (model: any, name: string) => model.fields.find((item: any) => item.name === name)
      assert.equal(field(parent, 'id').default.name, 'autoincrement')
      assert.equal(field(child, 'id').type, 'BigInt')
      assert.equal(field(child, 'id').default.name, 'autoincrement')
      assert.equal(field(legacy, 'id').hasDefaultValue, false, 'A trigger is not an identity or SQL DEFAULT')
      assert.equal(field(parent, 'amount').type, 'Decimal')
      // Introspection omits the connector's default native type: Decimal(18, 6).
      assert.equal(field(parent, 'amount').nativeType, null)
      assert.deepEqual(field(parent, 'numericValue').nativeType, ['Numeric', ['9', '2']])
      assert.equal(field(parent, 'title').default, "it's a value  ")
      assert.equal(field(parent, 'active').isRequired, true)
      assert.equal(field(parent, 'active').default, true)
      assert.equal(field(parent, 'createdAt').default.name, 'now')
      assert.equal(field(parent, 'notes').type, 'String')
      assert.equal(field(parent, 'payload').type, 'Bytes')
      assert.deepEqual(parent.uniqueFields, [['tenant', 'externalId']])
      const relation = child.fields.find((item: any) => item.relationFromFields?.length)
      assert.deepEqual(relation.relationFromFields, ['tenant', 'parentExternalId'])
      assert.deepEqual(relation.relationToFields, ['tenant', 'externalId'])
      assert.match(schema, /@@index\(\[tenant\(sort: Desc\), parentExternalId\(sort: Desc\)\]/)
      assert.match(String(warnings), /check constraint/i)
    })
    await check('public generator builds a Client directly from introspected PSL', async () => {
      const outputDir = path.join(lab, 'catalog-generated')
      const schemaPath = path.join(lab, 'catalog-introspected.prisma')
      const dmmf = await getDMMF({ datamodel: schema })
      await generateClient({
        datamodel: schema,
        schemaPath,
        outputDir,
        dmmf,
        runtimeBase: '@prisma/client/runtime',
        generator: {
          name: 'client',
          provider: { value: 'prisma-client', fromEnvVar: null },
          output: { value: outputDir, fromEnvVar: null },
          config: {},
          binaryTargets: [],
          previewFeatures: [],
          sourceFilePath: schemaPath,
          isCustomOutput: true,
        },
        datasources: [
          { name: 'db', provider: 'firebird', activeProvider: 'firebird', schemas: [], sourceFilePath: schemaPath },
        ],
        binaryPaths: {},
        engineVersion: requireGenerator('@prisma/engines-version').enginesVersion,
        clientVersion: '7.10.1-firebird-local',
        activeProvider: 'firebird',
        target: 'nodejs',
        generatedFileExtension: 'ts',
        importFileExtension: 'ts',
        moduleFormat: 'esm',
        tsNoCheckPreamble: true,
        compilerBuild: 'fast',
      })
      await writeFile(path.join(outputDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
      const modules = path.join(outputDir, 'node_modules/@prisma')
      await mkdir(modules, { recursive: true })
      const link = path.join(modules, 'client')
      const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (existing) assert.equal(await realpath(link), await realpath(path.join(orm, 'packages/client')))
      else await symlink(path.join(orm, 'packages/client'), link, process.platform === 'win32' ? 'junction' : 'dir')
      const { PrismaClient } = await import(pathToFileURL(path.join(outputDir, 'client.ts')).href)
      client = new PrismaClient({ adapter: new PrismaFirebird(config) })
      await client.$connect()
    })
    await check('introspected model CRUD returns exact scalars and ordered composite relation', async () => {
      await client.catalogChild.deleteMany()
      await client.catalogParent.deleteMany()
      const externalId = 9007199254740993n
      const parent = await client.catalogParent.create({
        data: {
          tenant: 11,
          externalId,
          title: 'introspected synthetic',
          amount: '123456789012.123456',
          notes: 'Firebird catalog synthetic',
          payload: new Uint8Array([0, 128, 255]),
        },
      })
      assert.ok(parent.id > 0)
      assert.equal(parent.amount.toFixed(6), '123456789012.123456')
      assert.equal(parent.externalId, externalId)
      assert.equal(parent.active, true)
      assert.deepEqual([...parent.payload], [0, 128, 255])
      const child = await client.catalogChild.create({
        data: { tenant: 11, parentExternalId: externalId, fixedText: 'abc' },
      })
      assert.equal(typeof child.id, 'bigint')
      const { datamodel } = await getDMMF({ datamodel: schema })
      const model = datamodel.models.find((item: any) => item.name === 'CatalogChild')
      const relation = model.fields.find((item: any) => item.relationFromFields?.length).name
      const loaded = await client.catalogChild.findUnique({ where: { id: child.id }, include: { [relation]: true } })
      assert.equal(loaded[relation].id, parent.id)
      await client.catalogChild.update({ where: { id: child.id }, data: { fixedText: 'changed' } })
      assert.equal((await client.catalogChild.findUnique({ where: { id: child.id } })).fixedText, 'changed')
      await client.catalogChild.delete({ where: { id: child.id } })
      await client.catalogParent.delete({ where: { id: parent.id } })
    })
    await check('unsupported computed columns fail explicitly and do not invalidate the existing fixture', async () => {
      await db.executeScript(
        'CREATE TABLE "UnsupportedComputed" ("id" INTEGER NOT NULL PRIMARY KEY, "computed" COMPUTED BY ("id" + 1));',
      )
      try {
        await assert.rejects(
          migrate.engine.introspect({
            schema: toSchemasContainer([['schema.prisma', baseSchema]]),
            baseDirectoryPath: lab,
            viewsDirectoryPath: path.join(lab, 'catalog-views'),
            force: true,
          }),
          /computed column/i,
        )
      } finally {
        await db.executeScript('DROP TABLE "UnsupportedComputed";')
      }
      assert.equal(Number((await query('SELECT COUNT(*) FROM "CatalogParent"')).rows[0][0]), 0)
    })
  } finally {
    if (client) await client.$disconnect()
    await migrate.stop()
    await db.dispose()
    assert.equal(
      createHash('sha256')
        .update(await readFile(wasmPath))
        .digest('hex'),
      wasmSha256,
    )
    await writeFile(
      path.join(lab, 'schema-introspection-results.json'),
      JSON.stringify(
        {
          syntheticOnly: true,
          provider: 'firebird',
          nodeVersion: process.version,
          engineVersion: version,
          actualWasm: true,
          wasm: { bytes: executedWasm.length, sha256: wasmSha256 },
          attempted,
          passed: passed.length,
          scenarios: passed,
          fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
          schemaSha256: createHash('sha256').update(schema).digest('hex'),
          warnings,
          firebird4: 'not tested',
          firebird5: 'not tested',
        },
        null,
        2,
      ) + '\n',
    )
  }
})
