/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import http from 'node:http'

const mode = process.argv[2]
const require = createRequire(import.meta.url)
assert.equal(globalThis[Symbol.for('firebird.cli.consumer.isolation')]?.consumer, process.env.FIREBIRD_CLI_CONSUMER_ROOT, 'Consumer fixture requires its isolation preload, including when launched by db seed')
if (mode === 'isolation-probe') {
  const blocked = JSON.parse(process.env.FIREBIRD_CLI_BLOCKED_ROOTS)
  const denied = (work) => assert.throws(work, { code: 'FIREBIRD_CONSUMER_ISOLATION' })
  for (const root of blocked) {
    denied(() => fs.readFileSync(path.join(root, 'AGENTS.md')))
    denied(() => fs.statSync(root))
    denied(() => fs.realpathSync(root))
    denied(() => require(path.join(root, 'package.json')))
    await assert.rejects(fsp.readFile(path.join(root, 'AGENTS.md')), { code: 'FIREBIRD_CONSUMER_ISOLATION' })
    await assert.rejects(import(pathToFileURL(path.join(root, 'AGENTS.md')).href), { code: 'FIREBIRD_CONSUMER_ISOLATION' })
  }
  denied(() => new net.Socket().connect({ host: '192.0.2.1', port: 443 }))
  denied(() => http.get('http://127.0.0.1:3059/'))
  await assert.rejects(fetch('https://example.invalid/'), { code: 'FIREBIRD_CONSUMER_ISOLATION' })
  console.log(JSON.stringify({ mode, blockedRoots: blocked.length, isolationProbesPassed: true }))
} else {
  const modulePath = path.resolve(process.env.FIREBIRD_CLI_CLIENT_MODULE)
  const { PrismaClient, Prisma } = await import(pathToFileURL(modulePath).href)
  assert.equal(typeof PrismaClient, 'function')
  assert.equal(typeof Prisma.Decimal, 'function')
  if (mode === 'offline-import') {
    console.log(JSON.stringify({ mode, generatedTypeScriptImported: true, node: process.version }))
  } else {
    const { PrismaFirebird } = await import('@prisma/adapter-firebird')
    const connections = JSON.parse(await fsp.readFile(process.env.FIREBIRD_CLI_PRIVATE_CONNECTIONS, 'utf8'))
    const role = process.env.FIREBIRD_CLI_ROLE
    const config = connections[role]
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 3059)
    const client = new PrismaClient({ adapter: new PrismaFirebird(config) })
    const seedFile = path.join(process.env.FIREBIRD_CLI_PROJECT, 'seed-proof.json')
    try {
      if (mode === 'seed') {
        assert.equal(await client.cliUser.count(), 0, 'Refuse a previously used application fixture')
        const row = await client.cliUser.create({
          data: {
            email: 'seed@example.invalid', name: 'before-widening', balance: new Prisma.Decimal('90071992547409.1234'),
            big: 9007199254740993n, payload: new Uint8Array([0, 255, 128, 1]),
            posts: { create: { title: 'Nested synthetic child' } },
          },
          include: { posts: true },
        })
        assert.ok(row.id > 0)
        assert.equal(row.posts.length, 1)
        assert.equal(row.posts[0].authorId, row.id)
        await fsp.writeFile(seedFile, JSON.stringify({ id: row.id, postId: row.posts[0].id }))
        console.log(JSON.stringify({ mode, role, nestedCreate: true, generatedIdentity: true }))
      } else if (mode === 'assert-preserved' || mode === 'assert-reset-preserved') {
        const seed = JSON.parse(await fsp.readFile(seedFile, 'utf8'))
        const row = await client.cliUser.findUniqueOrThrow({ where: { id: seed.id }, include: { posts: true } })
        assert.equal(row.email, 'seed@example.invalid')
        assert.equal(row.balance.toFixed(4), '90071992547409.1234')
        assert.equal(row.big, 9007199254740993n)
        assert.deepEqual([...row.payload], [0, 255, 128, 1])
        assert.equal(row.posts[0].id, seed.postId)
        console.log(JSON.stringify({ mode, role, seedPreserved: true }))
      } else if (mode === 'db-seed') {
        const row = await client.cliUser.create({ data: { email: 'public-seed@example.invalid' } })
        assert.ok(row.id > 0)
        console.log(JSON.stringify({ mode, role, configuredPublicSeedRan: true }))
      } else if (mode === 'crud') {
        const row = await client.cliUser.create({ data: {
          email: 'crud@example.invalid', name: 'Unicode ação 漢字 😀', balance: new Prisma.Decimal('-0.0001'),
          big: -9007199254740993n, payload: new Uint8Array([255, 0, 3]),
          posts: { create: { title: 'Created by installed generated Client' } },
        }, include: { posts: true } })
        assert.equal(row.balance.toFixed(4), '-0.0001')
        assert.equal(row.big, -9007199254740993n)
        assert.deepEqual([...row.payload], [255, 0, 3])
        assert.equal(row.posts[0].authorId, row.id)
        assert.equal(row.active, true)
        assert.equal(row.name, 'Unicode ação 漢字 😀')
        const unicodeRow = await client.cliUser.findUniqueOrThrow({ where: { id: row.id } })
        assert.equal(unicodeRow.name, 'Unicode ação 漢字 😀')
        const updated = await client.cliUser.update({ where: { id: row.id }, data: { name: 'Updated' } })
        assert.equal(updated.name, 'Updated')
        assert.equal((await client.cliUser.findUniqueOrThrow({ where: { email: row.email } })).id, row.id)
        await assert.rejects(client.$transaction(async (tx) => {
          await tx.cliUser.create({ data: { email: 'rollback@example.invalid' } })
          throw new Error('Expected synthetic rollback')
        }), /Expected synthetic rollback/)
        assert.equal(await client.cliUser.count({ where: { email: 'rollback@example.invalid' } }), 0)
        assert.equal((await client.cliUser.createMany({ data: [
          { email: 'many-a@example.invalid' }, { email: 'many-b@example.invalid' },
        ] })).count, 2)
        await client.cliUser.delete({ where: { id: row.id } })
        assert.equal(await client.cliPost.count({ where: { authorId: row.id } }), 0)
        assert.equal(await client.cliUser.count({ where: { id: row.id } }), 0)
        console.log(JSON.stringify({ mode, role, crud: true, decimal: true, bigint: true, blob: true, nested: true, rollback: true, createMany: true, cascade: true }))
      } else if (mode === 'empty') {
        assert.equal(await client.cliUser.count(), 0)
        assert.equal(await client.cliPost.count(), 0)
        console.log(JSON.stringify({ mode, role, emptyApplicationTables: true }))
      } else throw new Error('Unknown consumer Client fixture mode')
    } finally {
      await client.$disconnect()
    }
  }
}
