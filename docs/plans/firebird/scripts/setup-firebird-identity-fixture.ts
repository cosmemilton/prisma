/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { PrismaFirebird } from '../../../../packages/adapter-firebird/dist/index.js'

async function main() {
  const root = path.resolve(__dirname, '../../../../..')
  const laboratory = path.join(root, 'firebird-client-lab')
  const config = JSON.parse(await readFile(path.join(laboratory, 'private/connection.json'), 'utf8'))
  assert.equal(config.host, '127.0.0.1')
  assert.notEqual(config.port, 3050)
  assert.ok(
    path
      .resolve(config.database)
      .toLowerCase()
      .startsWith(laboratory.toLowerCase() + path.sep),
  )
  const connection = await new PrismaFirebird(config).connect()
  try {
    const result = await connection.queryRaw({
      sql: 'SELECT COUNT(*) AS "count" FROM RDB$RELATIONS WHERE RDB$RELATION_NAME IN (?, ?, ?, ?, ?)',
      args: ['AutoUser', 'AutoPost', 'BigAuto', 'IdentityOnly', 'LegacyAuto'],
      argTypes: Array.from({ length: 5 }, () => ({
        scalarType: 'string' as const,
        dbType: 'VARCHAR(31)',
        arity: 'scalar' as const,
      })),
    })
    const count = Number(result.rows[0][0])
    if (count === 5) {
      console.log(JSON.stringify({ fixture: 'identity-createMany', created: false, reusedOwnedFixture: true }))
      return
    }
    assert.equal(count, 0, 'An incomplete fixture must be inspected; do not overwrite existing tables')
    const sql = await readFile(path.join(__dirname, '../tests/identity-fixture.sql'), 'utf8')
    await connection.executeScript(sql)
    console.log(JSON.stringify({ fixture: 'identity-createMany', created: true, tables: 5, syntheticOnly: true }))
  } finally {
    await connection.dispose()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
