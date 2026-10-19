/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PrismaFirebird } from '@prisma/adapter-firebird'

assert.equal(
  globalThis[Symbol.for('firebird.cli.consumer.isolation')]?.consumer,
  process.env.FIREBIRD_CLI_CONSUMER_ROOT,
)
const connections = JSON.parse(await fs.readFile(process.env.FIREBIRD_CLI_PRIVATE_CONNECTIONS, 'utf8'))
const role = process.env.FIREBIRD_CLI_ROLE
assert.ok(['cli-push', 'cli-push-minimal'].includes(role))
assert.deepEqual(Object.keys(connections), [role])
const config = connections[role]
assert.equal(config.host, '127.0.0.1')
assert.equal(config.port, 3059)
const mode = process.argv[2]
if (mode === 'empty-catalog') {
  const adapter = await new PrismaFirebird(config).connect()
  try {
    const result = await adapter.queryRaw({
      sql: 'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0',
      args: [],
      argTypes: [],
    })
    assert.equal(result.rows.length, 0, 'Only a fresh database with no user relations is accepted')
    console.log(JSON.stringify({ mode, emptyUserCatalog: true }))
  } finally {
    await adapter.dispose()
  }
} else {
  const { PrismaClient } = await import(pathToFileURL(process.env.FIREBIRD_CLI_CLIENT_MODULE).href)
  const client = new PrismaClient({ adapter: new PrismaFirebird(config) })
  const seed = JSON.parse(await fs.readFile(path.join(process.env.FIREBIRD_CLI_PROJECT, 'seed-proof.json'), 'utf8'))
  const note = 'Populated column protected by the public db push refusal'
  const longName = 'W'.repeat(64)
  try {
    if (mode === 'note-added') {
      const row = await client.cliUser.findUniqueOrThrow({ where: { id: seed.id } })
      assert.equal(row.note, null)
      await client.cliUser.update({ where: { id: seed.id }, data: { note } })
    } else if (mode === 'widened') {
      await client.cliUser.update({ where: { id: seed.id }, data: { name: longName } })
    } else assert.equal(mode, 'assert-protected')
    const row = await client.cliUser.findUniqueOrThrow({ where: { id: seed.id }, include: { posts: true } })
    assert.equal(row.note, note)
    if (mode !== 'note-added') assert.equal(row.name, longName)
    assert.equal(row.balance.toFixed(4), '90071992547409.1234')
    assert.equal(row.big, 9007199254740993n)
    assert.deepEqual([...row.payload], [0, 255, 128, 1])
    assert.equal(row.active, true)
    assert.equal(row.posts.length, 1)
    assert.equal(row.posts[0].id, seed.postId)
    assert.equal(await client.cliUser.count(), 1)
    assert.equal(await client.cliPost.count(), 1)
    console.log(
      JSON.stringify({
        mode,
        nullableColumnPresent: true,
        populatedNotePreserved: true,
        longNamePreserved: mode !== 'note-added',
        exactTypesPreserved: true,
      }),
    )
  } finally {
    await client.$disconnect()
  }
}
