/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
assert.equal(globalThis[Symbol.for('firebird.cli.consumer.isolation')]?.consumer, process.env.FIREBIRD_CLI_CONSUMER_ROOT)
const major = Number(process.env.FIREBIRD_MATRIX_MAJOR)
const port = major === 4 ? 3054 : major === 5 ? 3055 : NaN
assert.ok(Number.isSafeInteger(port))
const state = process.env.FIREBIRD_MATRIX_STATE
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const emit = (value) => console.log(JSON.stringify({ major, mode, supportAccepted: false, ...value }))
const clientModule = process.env.FIREBIRD_MATRIX_CLIENT_MODULE

if (mode === 'offline-import') {
  const generated = await import(pathToFileURL(clientModule).href)
  assert.equal(typeof generated.PrismaClient, 'function')
  assert.equal(typeof generated.Prisma.Decimal, 'function')
  emit({ offlineGeneratedClientImported: true, actualServerTest: false })
} else {
  const { PrismaFirebird } = await import('@prisma/adapter-firebird')
  const role = process.env.FIREBIRD_MATRIX_ROLE
  assert.ok(['client', 'guard'].includes(role))
  const connections = JSON.parse(await readFile(process.env.FIREBIRD_MATRIX_CONNECTIONS, 'utf8'))
  const config = connections[role]
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, port)
  const factory = new PrismaFirebird(config, { poolSize: 2, transactionLockTimeout: 0 })
  const catalog = async (adapter) => {
    const tables = await adapter.queryRaw({ sql: 'SELECT TRIM(TRAILING FROM RDB$RELATION_NAME) AS "name" FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0 ORDER BY RDB$RELATION_NAME', args: [], argTypes: [] })
    const generators = await adapter.queryRaw({ sql: 'SELECT TRIM(TRAILING FROM RDB$GENERATOR_NAME) AS "name" FROM RDB$GENERATORS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0 ORDER BY RDB$GENERATOR_NAME', args: [], argTypes: [] })
    return { tables: tables.rows.map((row) => row[0]), userGenerators: generators.rows.map((row) => row[0]) }
  }
  if (mode === 'inspect' || mode === 'provision-generated-ddl') {
    const adapter = await factory.connect()
    try {
      const info = await adapter.queryRaw({ sql: `SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS "version", RDB$GET_CONTEXT('SYSTEM','WIRE_ENCRYPTED') AS "encrypted", RDB$GET_CONTEXT('SYSTEM','NETWORK_PROTOCOL') AS "protocol" FROM RDB$DATABASE`, args: [], argTypes: [] })
      const [version, encrypted, protocol] = info.rows[0]
      assert.match(version, new RegExp(`^${major}\\.`))
      assert.equal(String(encrypted).toUpperCase(), 'TRUE', 'Keep required wire encryption for the candidate matrix')
      assert.equal(protocol, 'TCPv4')
      const before = await catalog(adapter)
      if (mode === 'provision-generated-ddl') {
        assert.equal(role, 'client')
        assert.equal(process.env.FIREBIRD_MATRIX_PROVISION_GENERATED_DDL, '1')
        assert.deepEqual(before, { tables: [], userGenerators: [] }, 'Only a fresh synthetic database can receive this fixture')
        const sql = await readFile(process.env.FIREBIRD_MATRIX_SQL)
        assert.equal(digest(sql), process.env.FIREBIRD_MATRIX_SQL_SHA256)
        assert.match(sql.toString('utf8'), /CREATE TABLE "CliUser"/)
        assert.match(sql.toString('utf8'), /CREATE TABLE "CliPost"/)
        assert.doesNotMatch(sql.toString('utf8'), /^\s*(?:DROP|RECREATE|DELETE|UPDATE|COMMIT|ROLLBACK|CONNECT|CREATE\s+DATABASE)\b/im)
        await adapter.executeScript(sql.toString('utf8'))
        const after = await catalog(adapter)
        assert.deepEqual(after.tables, ['CliPost', 'CliUser'])
        assert.deepEqual(after.userGenerators, [])
        emit({ role, version, encrypted, protocol, before, after, sqlSha256: digest(sql), fixtureSetup: 'public-adapter-only-unmodified-public-CLI-generated-DDL', prismaMigrationsAccepted: false })
      } else emit({ role, version, encrypted, protocol, catalog: before })
    } finally { await adapter.dispose() }
  } else {
    assert.equal(role, 'client')
    const { PrismaClient, Prisma } = await import(pathToFileURL(clientModule).href)
    const queries = []
    const client = new PrismaClient({ adapter: factory, log: [{ emit: 'event', level: 'query' }] })
    client.$on('query', (event) => queries.push(event.query))
    const seedFile = path.join(state, 'seed.json')
    try {
      if (mode === 'create') {
        assert.equal(await client.cliUser.count(), 0)
        const row = await client.cliUser.create({ data: {
          email: 'matrix-seed@example.invalid', name: 'ação 漢字 😀', balance: new Prisma.Decimal('90071992547409.1234'),
          big: 9007199254740993n, payload: new Uint8Array([0, 255, 128, 1]),
          posts: { create: { title: 'Common Firebird 3 schema subset' } },
        }, include: { posts: true } })
        assert.ok(row.id > 0)
        assert.equal(row.balance.toFixed(4), '90071992547409.1234')
        assert.equal(row.big, 9007199254740993n)
        assert.deepEqual([...row.payload], [0, 255, 128, 1])
        assert.equal(row.posts.length, 1)
        assert.equal(row.posts[0].authorId, row.id)
        await writeFile(seedFile, JSON.stringify({ id: row.id, postId: row.posts[0].id }), { flag: 'wx' })
        emit({ generatedIdentity: true, nested: true, decimal: true, bigint: true, blob: true, unicode: true })
      } else if (mode === 'read-update') {
        const seed = JSON.parse(await readFile(seedFile, 'utf8'))
        const before = await client.cliUser.findUniqueOrThrow({ where: { id: seed.id }, include: { posts: true } })
        assert.equal(before.posts[0].id, seed.postId)
        assert.equal(before.name, 'ação 漢字 😀')
        const row = await client.cliUser.update({ where: { id: seed.id }, data: { name: null, active: false, payload: null, balance: new Prisma.Decimal('-0.0001') } })
        assert.equal(row.name, null)
        assert.equal(row.payload, null)
        assert.equal(row.active, false)
        assert.equal(row.balance.toFixed(4), '-0.0001')
        assert.equal(row.big, 9007199254740993n)
        emit({ read: true, update: true, nullableAndFalse: true })
      } else if (mode === 'transaction') {
        await assert.rejects(client.$transaction(async (tx) => {
          await tx.cliUser.create({ data: { email: 'matrix-rollback@example.invalid' } })
          throw new Error('Expected matrix rollback')
        }), /Expected matrix rollback/)
        assert.equal(await client.cliUser.count({ where: { email: 'matrix-rollback@example.invalid' } }), 0)
        const seed = JSON.parse(await readFile(seedFile, 'utf8'))
        const result = await client.$transaction([
          client.cliUser.update({ where: { id: seed.id }, data: { name: 'batch' } }),
          client.cliPost.create({ data: { title: 'Batch transaction child', authorId: seed.id } }),
        ])
        assert.equal(result.length, 2)
        emit({ rollback: true, batchTransaction: true })
      } else if (mode === 'create-many') {
        const result = await client.cliUser.createMany({ data: [{ email: 'many-a@example.invalid' }, { email: 'many-b@example.invalid' }] })
        assert.equal(result.count, 2)
        const inserts = queries.filter((query) => query.startsWith('INSERT INTO "CliUser"'))
        assert.equal(inserts.length, 2)
        assert.ok(inserts.every((query) => !query.includes('RETURNING')))
        emit({ createMany: true, singletonInsertCount: inserts.length, returningCapabilityBroadened: false })
      } else if (mode === 'delete') {
        const seed = JSON.parse(await readFile(seedFile, 'utf8'))
        await client.cliUser.delete({ where: { id: seed.id } })
        assert.equal(await client.cliPost.count({ where: { authorId: seed.id } }), 0)
        assert.equal((await client.cliUser.deleteMany({ where: { email: { startsWith: 'many-' } } })).count, 2)
        assert.equal(await client.cliUser.count(), 0)
        assert.equal(await client.cliPost.count(), 0)
        emit({ delete: true, deleteMany: true, cascade: true, emptyApplicationRows: true })
      } else throw new Error('Unknown matrix fixture mode')
    } finally { await client.$disconnect() }
  }
}
