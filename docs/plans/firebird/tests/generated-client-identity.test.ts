/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Prisma, PrismaClient } from '../../../../../firebird-client-lab/generated/client.ts'
import { PrismaFirebird } from '../../../../packages/adapter-firebird/dist/index.mjs'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const laboratory = path.join(workspace, 'firebird-client-lab')

test('generated Client identity and createMany on disposable Firebird 3', { timeout: 120_000 }, async (t) => {
  const config = JSON.parse(await readFile(path.join(laboratory, 'private/connection.json'), 'utf8'))
  assert.equal(config.host, '127.0.0.1')
  assert.notEqual(config.port, 3050)
  assert.ok(
    path
      .resolve(config.database)
      .toLowerCase()
      .startsWith(laboratory.toLowerCase() + path.sep),
  )
  const client = new PrismaClient({ adapter: new PrismaFirebird(config), log: [{ emit: 'event', level: 'query' }] })
  const queries: string[] = []
  client.$on('query', (event) => queries.push(event.query))
  const passed: string[] = []
  let attempted = 0
  const check = async (name: string, run: () => Promise<void>) => {
    attempted++
    await t.test(name, async () => {
      await run()
      passed.push(name)
    })
  }
  let automaticId: number
  try {
    await client.autoPost.deleteMany()
    await client.autoUser.deleteMany()
    await client.bigAuto.deleteMany()
    await client.identityOnly.deleteMany()
    await client.legacyAuto.deleteMany()

    await check('Int identity is omitted and returned by create', async () => {
      const row = await client.autoUser.create({ data: { email: 'identity@example.invalid' } })
      assert.ok(Number.isSafeInteger(row.id) && row.id > 0)
      assert.equal(row.tag, 'db-default')
      assert.equal(row.active, true)
      automaticId = row.id
    })
    await check('nested create returns generated parent and child foreign keys', async () => {
      const row = await client.autoUser.create({
        data: { email: 'nested-identity@example.invalid', posts: { create: { title: 'Synthetic child' } } },
        include: { posts: true },
      })
      assert.ok(row.id > 0)
      assert.ok(row.posts[0].id > 0)
      assert.equal(row.posts[0].authorId, row.id)
    })
    await check('BigInt identity returns bigint and preserves explicit large overrides', async () => {
      const generated = await client.bigAuto.create({ data: { note: 'generated' } })
      assert.equal(typeof generated.id, 'bigint')
      assert.ok(generated.id > 0n)
      const explicitId = 9007199254740993n
      const explicit = await client.bigAuto.create({ data: { id: explicitId, note: 'explicit' } })
      assert.equal(explicit.id, explicitId)
    })
    await check('identity-only model uses DEFAULT VALUES and returns its key', async () => {
      const row = await client.identityOnly.create({ data: {} })
      assert.ok(row.id > 0)
    })
    await check('legacy sequence and BEFORE INSERT trigger work with dbgenerated ID', async () => {
      const row = await client.legacyAuto.create({ data: { note: 'synthetic legacy sequence' } })
      assert.ok(row.id > 0)
      assert.equal((await client.legacyAuto.findUniqueOrThrow({ where: { id: row.id } })).note, row.note)
    })
    await check('createMany executes parameterized single-row INSERTs with exact types', async () => {
      const queryStart = queries.length
      const result = await client.autoUser.createMany({
        data: [
          { email: 'many-a@example.invalid', balance: new Prisma.Decimal('90071992547409.1234') },
          { email: 'many-b@example.invalid', balance: new Prisma.Decimal('-0.0001') },
        ],
      })
      assert.equal(result.count, 2)
      const inserts = queries.slice(queryStart).filter((query) => query.startsWith('INSERT INTO "AutoUser"'))
      assert.equal(inserts.length, 2, 'One real INSERT is emitted per input row')
      assert.ok(inserts.every((query) => query.includes('?') && !query.includes('RETURNING')))
      const rows = await client.autoUser.findMany({
        where: { email: { in: ['many-a@example.invalid', 'many-b@example.invalid'] } },
        orderBy: { email: 'asc' },
      })
      assert.equal(rows[0].balance?.toFixed(4), '90071992547409.1234')
      assert.equal(rows[1].balance?.toFixed(4), '-0.0001')
      assert.notEqual(rows[0].id, rows[1].id)
    })
    await check('mixed createMany shapes preserve omitted defaults and explicit IDs', async () => {
      assert.equal(
        (
          await client.autoUser.createMany({
            data: [
              { email: 'shape-default@example.invalid' },
              { id: 1000000, email: 'shape-explicit@example.invalid', tag: 'explicit', name: 'value', active: false },
              { email: 'shape-null@example.invalid', name: null, balance: null },
            ],
          })
        ).count,
        3,
      )
      const rows = await client.autoUser.findMany({
        where: { email: { startsWith: 'shape-' } },
        orderBy: { email: 'asc' },
      })
      assert.equal(rows[0].tag, 'db-default')
      assert.equal(rows[1].id, 1000000)
      assert.equal(rows[1].tag, 'explicit')
      assert.equal(rows[1].active, false)
      assert.equal(rows[2].name, null)
      assert.equal(rows[2].balance, null)
    })
    await check('empty createMany returns zero without writes', async () => {
      const before = await client.autoUser.count()
      assert.equal((await client.autoUser.createMany({ data: [] })).count, 0)
      assert.equal(await client.autoUser.count(), before)
    })
    await check('identity-only createMany uses one DEFAULT VALUES per row', async () => {
      const before = await client.identityOnly.count()
      assert.equal((await client.identityOnly.createMany({ data: [{}, {}] })).count, 2)
      assert.equal(await client.identityOnly.count(), before + 2)
    })
    await check('later uniqueness failure rolls back every createMany insertion', async () => {
      await assert.rejects(
        client.autoUser.createMany({
          data: [{ email: 'many-rollback@example.invalid' }, { email: 'identity@example.invalid' }],
        }),
        (error: { code?: string }) => error.code === 'P2002',
      )
      assert.equal(await client.autoUser.count({ where: { email: 'many-rollback@example.invalid' } }), 0)
    })
    await check('interactive transaction rollback includes createMany and generated IDs', async () => {
      await assert.rejects(
        client.$transaction(async (transaction) => {
          await transaction.autoUser.createMany({
            data: [{ email: 'tx-many-a@example.invalid' }, { email: 'tx-many-b@example.invalid' }],
          })
          throw new Error('synthetic rollback')
        }),
        /synthetic rollback/,
      )
      assert.equal(await client.autoUser.count({ where: { email: { startsWith: 'tx-many-' } } }), 0)
    })
    await check('nested createMany uses the generated parent ID', async () => {
      const row = await client.autoUser.create({
        data: {
          email: 'nested-many@example.invalid',
          posts: { createMany: { data: [{ title: 'first' }, { title: 'second' }] } },
        },
        include: { posts: { orderBy: { id: 'asc' } } },
      })
      assert.equal(row.posts.length, 2)
      assert.ok(row.posts.every((post) => post.authorId === row.id && post.id > 0))
    })
    await check('unsupported skipDuplicates rejects explicitly', async () => {
      await assert.rejects(
        client.autoUser.createMany({ data: [{ email: 'skip@example.invalid' }], skipDuplicates: true } as never),
        /skipDuplicates/,
      )
      assert.equal(await client.autoUser.count({ where: { email: 'skip@example.invalid' } }), 0)
    })
    await check('unsupported createManyAndReturn is omitted from types and rejects a forged runtime call', async () => {
      const modelSource = await readFile(path.join(laboratory, 'generated/models/AutoUser.ts'), 'utf8')
      assert.equal(/\bcreateManyAndReturn\s*</.test(modelSource), false)
      const delegate = client.autoUser as unknown as {
        createManyAndReturn: (args: { data: Array<{ email: string }> }) => Promise<unknown>
      }
      await assert.rejects(
        delegate.createManyAndReturn({ data: [{ email: 'returning@example.invalid' }] }),
        /createManyAndReturn/,
      )
      assert.equal(await client.autoUser.count({ where: { email: 'returning@example.invalid' } }), 0)
    })
    await check('createMany uses no multirow VALUES or RETURNING', async () => {
      const writes = queries.filter(
        (query) => query.startsWith('INSERT INTO "AutoUser"') && !query.includes('RETURNING'),
      )
      assert.ok(writes.length >= 2)
      assert.ok(writes.every((query) => !/\)\s*,\s*\(/.test(query)))
      assert.ok(writes.every((query) => query.includes('?')))
      assert.ok(queries.some((query) => query.includes('"IdentityOnly" DEFAULT VALUES')))
      assert.ok(Number.isSafeInteger(automaticId!) && automaticId! > 0)
    })
  } finally {
    await client.$disconnect()
    await writeFile(
      path.join(laboratory, 'generated-client-identity-results.json'),
      JSON.stringify(
        {
          provider: 'firebird',
          generatedClient: true,
          attempted,
          passed,
          successful: passed.length === attempted,
          queries,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    )
  }
})
