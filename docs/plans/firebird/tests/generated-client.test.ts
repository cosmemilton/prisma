/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Prisma, PrismaClient } from '../../../../../firebird-client-lab/generated/client.ts'
import { PrismaFirebird } from '../../../../packages/adapter-firebird/dist/index.mjs'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const laboratory = path.join(workspace, 'firebird-client-lab')
const configPath = process.env.FIREBIRD_CLIENT_LAB_CONFIG ?? path.join(laboratory, 'private', 'connection.json')

test('generated Prisma Client on disposable Firebird 3', { timeout: 120_000 }, async (t) => {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const database = path.resolve(config.database)
  assert.ok(
    database.toLowerCase().startsWith(laboratory.toLowerCase() + path.sep),
    'Use only the disposable laboratory database',
  )
  assert.equal(config.host, '127.0.0.1', 'Use only the private loopback server')
  assert.notEqual(config.port, 3050, 'Do not use the installed Firebird service')

  const queries: Array<{ query: string; params: string }> = []
  const client = new PrismaClient({
    adapter: new PrismaFirebird(config),
    log: [{ emit: 'event', level: 'query' }],
  })
  client.$on('query', (event) => queries.push({ query: event.query, params: event.params }))
  const passed: string[] = []
  let attempted = 0
  const check = async (name: string, run: () => Promise<void>) => {
    attempted++
    await t.test(name, async () => {
      await run()
      passed.push(name)
    })
  }
  const timestamp = new Date('2024-03-31T01:30:20.123Z')
  const date = new Date('2024-02-29T00:00:00.000Z')
  const time = new Date('1970-01-01T23:59:58.987Z')
  const email = "sintético+' OR 1=1 --@example.invalid"
  const name = 'Ação 日本語 🐦'
  const decimal = '90071992547409.1234'
  const bigint = 9007199254740993n
  let engineVersion: string | undefined
  try {
    await client.$connect()
    await client.post.deleteMany()
    await client.user.deleteMany()

    await check('actual server is Firebird 3', async () => {
      const rows = await client.$queryRawUnsafe<Array<{ VERSION: string }>>(
        "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS VERSION FROM RDB$DATABASE",
      )
      engineVersion = rows[0]?.VERSION
      assert.match(engineVersion ?? '', /^3\.0\./)
    })
    await check('UTF8 CHAR parameters preserve supplementary Unicode', async () => {
      const rows = await client.$queryRawUnsafe<Array<{ value: string }>>(
        'SELECT CAST(? AS CHAR(1) CHARACTER SET UTF8) AS "value" FROM RDB$DATABASE',
        '🚀',
      )
      assert.equal(rows[0]?.value, '🚀')
    })
    await check('create returns exact scalars through generated model API', async () => {
      const row = await client.user.create({
        data: {
          id: 100,
          email,
          name,
          balance: new Prisma.Decimal(decimal),
          bigValue: bigint,
          createdAt: timestamp,
          dateValue: date,
          timeValue: time,
          active: true,
          bytes: new Uint8Array([0, 1, 127, 128, 255]),
        },
      })
      assert.equal(row.id, 100)
      assert.equal(row.name, name)
      assert.equal(row.balance?.toFixed(4), decimal)
      assert.equal(row.bigValue, bigint)
      assert.equal(row.createdAt?.toISOString(), timestamp.toISOString())
      assert.equal(row.dateValue?.toISOString(), date.toISOString())
      assert.equal(row.timeValue?.toISOString(), time.toISOString())
      assert.equal(row.active, true)
      assert.deepEqual(Array.from(row.bytes ?? []), [0, 1, 127, 128, 255])
    })
    await check('findUnique resolves both primary and unique keys', async () => {
      assert.equal((await client.user.findUnique({ where: { email } }))?.id, 100)
      assert.equal((await client.user.findUnique({ where: { id: 100 } }))?.email, email)
      assert.equal(await client.user.findUnique({ where: { id: -1 } }), null)
    })
    await check('null and false survive create and read', async () => {
      const row = await client.user.create({ data: { id: 101, email: 'null@example.invalid', active: false } })
      assert.equal(row.name, null)
      assert.equal(row.balance, null)
      assert.equal(row.bigValue, null)
      assert.equal(row.active, false)
    })
    await check('integer aggregates preserve fractional averages and expected result types', async () => {
      const result = await client.user.aggregate({
        where: { id: { in: [100, 101] } },
        _count: { id: true },
        _sum: { id: true },
        _avg: { id: true },
      })
      assert.equal(result._count.id, 2)
      assert.equal(result._sum.id, 201)
      assert.equal(result._avg.id, 100.5)
    })
    await check('Decimal averages reject unsupported exact precision explicitly', async () => {
      await assert.rejects(client.user.aggregate({ _avg: { balance: true } }), /(?:Decimal.*AVG|AVG.*Decimal)/i)
    })
    await check('empty BLOBs and zero are distinct from null', async () => {
      const row = await client.user.create({
        data: {
          id: 103,
          email: 'zero@example.invalid',
          name: '',
          balance: new Prisma.Decimal(0),
          bigValue: 0n,
          active: false,
          bytes: new Uint8Array(),
        },
      })
      assert.equal(row.name, '')
      assert.equal(row.balance?.toFixed(4), '0.0000')
      assert.equal(row.bigValue, 0n)
      assert.equal(row.active, false)
      assert.deepEqual(Array.from(row.bytes ?? [1]), [])
      const post = await client.post.create({ data: { id: 203, title: 'Vazio', content: '', authorId: 103 } })
      assert.equal(post.content, '')
      await client.post.delete({ where: { id: 203 } })
      await client.user.delete({ where: { id: 103 } })
    })
    await check('signed INT64 extrema and negative exact Decimal survive round trips', async () => {
      const row = await client.user.create({
        data: {
          id: 104,
          email: 'limits@example.invalid',
          balance: new Prisma.Decimal('-99999999999999.9999'),
          bigValue: -9223372036854775808n,
        },
      })
      assert.equal(row.balance?.toFixed(4), '-99999999999999.9999')
      assert.equal(row.bigValue, -9223372036854775808n)
      const updated = await client.user.update({ where: { id: 104 }, data: { bigValue: 9223372036854775807n } })
      assert.equal(updated.bigValue, 9223372036854775807n)
      await client.user.delete({ where: { id: 104 } })
    })
    await check('update returns changed scalars without losing precision', async () => {
      const row = await client.user.update({
        where: { id: 100 },
        data: { name: 'Atualização é 🐦', balance: { increment: new Prisma.Decimal('0.0001') } },
      })
      assert.equal(row.name, 'Atualização é 🐦')
      assert.equal(row.balance?.toFixed(4), '90071992547409.1235')
      assert.equal(row.bigValue, bigint)
    })
    await check('relations create, include and nested reads use real foreign keys', async () => {
      await client.post.create({
        data: {
          id: 200,
          title: 'Relação',
          content: 'Texto 日本語 🐦',
          published: false,
          author: { connect: { id: 100 } },
        },
      })
      const user = await client.user.findUniqueOrThrow({ where: { id: 100 }, include: { posts: true } })
      assert.equal(user.posts.length, 1)
      assert.equal(user.posts[0].content, 'Texto 日本語 🐦')
      const post = await client.post.findUniqueOrThrow({ where: { id: 200 }, include: { author: true } })
      assert.equal(post.author.email, email)
    })
    await check('nested create writes related models atomically', async () => {
      const row = await client.user.create({
        data: {
          id: 120,
          email: 'nested@example.invalid',
          posts: { create: [{ id: 220, title: 'Aninhado', published: true }] },
        },
        include: { posts: true },
      })
      assert.equal(row.posts[0].authorId, 120)
      await client.post.delete({ where: { id: 220 } })
      await client.user.delete({ where: { id: 120 } })
    })
    await check('transactional upsert creates and then updates the same model', async () => {
      const create = { id: 130, email: 'upsert@example.invalid', name: 'Novo' }
      assert.equal(
        (await client.user.upsert({ where: { id: 130 }, create, update: { name: 'Existente' } })).name,
        'Novo',
      )
      assert.equal(
        (await client.user.upsert({ where: { id: 130 }, create, update: { name: 'Existente' } })).name,
        'Existente',
      )
      await client.user.delete({ where: { id: 130 } })
    })
    await check('filters, order and parameterized pagination return expected rows', async () => {
      await client.user.create({ data: { id: 102, email: 'page@example.invalid', name: 'Paginação' } })
      const rows = await client.user.findMany({ where: { id: { gte: 100 } }, orderBy: { id: 'asc' }, skip: 1, take: 1 })
      assert.deepEqual(
        rows.map((row) => row.id),
        [101],
      )
      assert.equal((await client.user.findMany({ where: { name: { contains: 'Atualização' } } })).length, 1)
    })
    await check('successful interactive transaction commits', async () => {
      await client.$transaction(async (tx) => {
        await tx.user.create({ data: { id: 110, email: 'commit@example.invalid' } })
        await tx.user.update({ where: { id: 110 }, data: { name: 'Confirmado' } })
      })
      assert.equal((await client.user.findUniqueOrThrow({ where: { id: 110 } })).name, 'Confirmado')
    })
    await check('parallel reads retain parameters and statement ownership', async () => {
      const ids = [100, 101, 100, 101, 100, 101, 100, 101]
      const rows = await Promise.all(ids.map((id) => client.user.findUniqueOrThrow({ where: { id } })))
      assert.deepEqual(
        rows.map((row) => row.id),
        ids,
      )
      await client.$transaction(async (tx) => {
        const transactional = await Promise.all(ids.map((id) => tx.user.findUniqueOrThrow({ where: { id } })))
        assert.deepEqual(
          transactional.map((row) => row.id),
          ids,
        )
      })
    })
    await check('failed interactive transaction rolls back all writes', async () => {
      await assert.rejects(
        client.$transaction(async (tx) => {
          await tx.user.create({ data: { id: 111, email: 'rollback@example.invalid' } })
          await tx.post.create({ data: { id: 211, title: 'Descartado', authorId: 111 } })
          throw new Error('synthetic rollback')
        }),
        /synthetic rollback/,
      )
      assert.equal(await client.user.findUnique({ where: { id: 111 } }), null)
      assert.equal(await client.post.findUnique({ where: { id: 211 } }), null)
    })
    await check('batch transaction rolls back when a later unique constraint fails', async () => {
      await assert.rejects(
        client.$transaction([
          client.user.create({ data: { id: 112, email: 'batch@example.invalid' } }),
          client.user.create({ data: { id: 113, email } }),
        ]),
        (error: any) => error.code === 'P2002',
      )
      assert.equal(await client.user.findUnique({ where: { id: 112 } }), null)
    })
    await check('a handled constraint error leaves the explicit transaction usable', async () => {
      await client.$transaction(async (tx) => {
        await tx.user.create({ data: { id: 114, email: 'handled@example.invalid' } })
        await assert.rejects(tx.user.create({ data: { id: 115, email } }), (error: any) => error.code === 'P2002')
        await tx.user.update({ where: { id: 114 }, data: { name: 'Após erro' } })
      })
      assert.equal((await client.user.findUniqueOrThrow({ where: { id: 114 } })).name, 'Após erro')
      assert.equal(await client.user.findUnique({ where: { id: 115 } }), null)
    })
    for (const isolationLevel of ['ReadCommitted', 'RepeatableRead', 'Snapshot', 'Serializable'] as const) {
      await check(`transaction isolation ${isolationLevel}`, async () => {
        const row = await client.$transaction((tx) => tx.user.findUnique({ where: { id: 100 } }), { isolationLevel })
        assert.equal(row?.id, 100)
      })
    }
    await check('large binary and text BLOBs are materialized before transaction end', async () => {
      const bytes = new Uint8Array(70_000).map((_, index) => index % 256)
      const content = 'Ação 🐦 日本語 '.repeat(6000)
      await client.user.update({ where: { id: 100 }, data: { bytes } })
      await client.post.update({ where: { id: 200 }, data: { content } })
      assert.deepEqual((await client.user.findUniqueOrThrow({ where: { id: 100 } })).bytes, bytes)
      assert.equal((await client.post.findUniqueOrThrow({ where: { id: 200 } })).content, content)
    })
    await check('bulk update and delete report affected row counts', async () => {
      assert.equal(
        (await client.user.updateMany({ where: { id: { in: [101, 102] } }, data: { name: 'Em lote' } })).count,
        2,
      )
      assert.equal((await client.user.deleteMany({ where: { id: { in: [101, 102] } } })).count, 2)
    })
    await check('not-found writes surface Prisma P2025', async () => {
      await assert.rejects(
        client.user.update({ where: { id: -1 }, data: { name: 'Ausente' } }),
        (error: any) => error.code === 'P2025',
      )
      await assert.rejects(client.user.delete({ where: { id: -1 } }), (error: any) => error.code === 'P2025')
    })
    await check('foreign key violations surface Prisma P2003', async () => {
      await assert.rejects(
        client.post.create({ data: { id: 299, title: 'Inválido', authorId: -1 } }),
        (error: any) => error.code === 'P2003',
      )
    })
    await check('delete returns the removed model and preserves relation ordering', async () => {
      assert.equal((await client.post.delete({ where: { id: 200 } })).id, 200)
      assert.equal((await client.user.delete({ where: { id: 100 } })).id, 100)
      assert.equal(await client.user.findUnique({ where: { id: 100 } }), null)
    })
    await check('the generated Client reconnects and retains committed data', async () => {
      await client.$disconnect()
      await client.$connect()
      assert.equal((await client.user.findUniqueOrThrow({ where: { id: 110 } })).name, 'Confirmado')
    })
    await check('generated model queries use bound parameters', async () => {
      assert.ok(queries.some(({ query }) => /INSERT INTO "User"/.test(query) && query.includes('?')))
      assert.ok(queries.some(({ query }) => /OFFSET \? ROWS FETCH NEXT \? ROWS ONLY/.test(query)))
      assert.ok(queries.some(({ params }) => params.includes('OR 1=1')))
      assert.ok(queries.every(({ query }) => !query.includes(email) && !query.includes(name)))
    })
    await writeFile(
      path.join(laboratory, 'generated-client-results.json'),
      JSON.stringify(
        {
          engineVersion,
          provider: 'firebird',
          generatedClient: true,
          attempted,
          passed,
          successful: passed.length === attempted,
          queries: queries.map(({ query }) => query),
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    )
    assert.equal(passed.length, attempted, 'All generated Client scenarios must pass')
  } finally {
    await client.$disconnect()
  }
})
