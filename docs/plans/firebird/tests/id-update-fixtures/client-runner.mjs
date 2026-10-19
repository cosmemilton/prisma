/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PrismaFirebird } from '@prisma/adapter-firebird'

assert.equal(
  globalThis[Symbol.for('firebird.cli.consumer.isolation')]?.consumer,
  process.env.FIREBIRD_CLI_CONSUMER_ROOT,
)
assert.equal(process.env.FIREBIRD_CLI_ROLE, 'id-updates')
const connections = JSON.parse(await fs.readFile(process.env.FIREBIRD_CLI_PRIVATE_CONNECTIONS, 'utf8'))
assert.deepEqual(Object.keys(connections), ['id-updates'])
const config = connections['id-updates']
assert.equal(config.host, '127.0.0.1')
assert.equal(config.port, 3059)
const mode = process.argv[2]

if (mode === 'empty-catalog' || mode === 'install-trigger') {
  const adapter = await new PrismaFirebird(config).connect()
  try {
    if (mode === 'empty-catalog') {
      const result = await adapter.queryRaw({
        sql: 'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0',
        args: [],
        argTypes: [],
      })
      assert.equal(result.rows.length, 0, 'Fresh database only; never reset/adopt existing application tables')
      console.log(JSON.stringify({ mode, emptyUserCatalog: true }))
    } else {
      const statements = [
        `CREATE EXCEPTION "M6_UPDATE_REJECT" 'M6_UPDATE_REJECT: synthetic update reached the database'`,
        `CREATE TRIGGER "M6_REJECT_ID" FOR "M6_TriggerKey" ACTIVE BEFORE UPDATE POSITION 0 AS BEGIN IF (NEW."trigger_code" = 'trigger-rejected') THEN EXCEPTION "M6_UPDATE_REJECT"; END`,
        `CREATE TRIGGER "M6_REWRITE_ID" FOR "M6_TriggerKey" ACTIVE BEFORE UPDATE POSITION 1 AS BEGIN IF (NEW."trigger_code" = 'trigger-requested') THEN NEW."trigger_code" = 'trigger-actual'; IF (NEW."value" = 'rewrite-on-value') THEN NEW."trigger_code" = 'value-trigger-actual'; END`,
      ]
      for (const sql of statements) await adapter.executeRaw({ sql, args: [], argTypes: [] })
      console.log(JSON.stringify({ mode, explicitFixtureDDLOnly: true, statements, rawCrudPerformed: false }))
    }
  } finally {
    await adapter.dispose()
  }
} else {
  const { PrismaClient, Prisma } = await import(pathToFileURL(process.env.FIREBIRD_CLI_CLIENT_MODULE).href)
  const queries = []
  const adapterAttempts = []
  const client = new PrismaClient({
    adapter: observe(new PrismaFirebird(config)),
    log: [{ level: 'query', emit: 'event' }],
  })
  client.$on('query', (event) => queries.push({ query: event.query, params: event.params, duration: event.duration }))
  const diagnostics = []
  const observations = {}
  function diagnostic(error) {
    assert.notEqual(error.name, 'PrismaClientValidationError')
    return JSON.parse(
      JSON.stringify(
        { name: error.name, code: error.code, message: error.message, meta: error.meta, cause: error.cause },
        (_key, value) => (typeof value === 'bigint' ? String(value) : value),
      ),
    )
  }
  function observe(source) {
    return new Proxy(source, {
      get(target, key) {
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        if (key === 'connect' || key === 'startTransaction')
          return async (...args) => observe(await Reflect.apply(value, target, args))
        if (key === 'queryRaw' || key === 'executeRaw')
          return async (query) => {
            const record = { source: 'delegated-adapter-attempt', method: key, query: query.sql, outcome: 'pending' }
            try {
              record.params = JSON.stringify(query.args, (_key, item) =>
                typeof item === 'bigint' ? String(item) : item,
              )
            } catch (error) {
              record.captureError = error.message
            }
            adapterAttempts.push(record)
            try {
              const result = await Reflect.apply(value, target, [query])
              record.outcome = 'resolved'
              return result
            } catch (error) {
              record.outcome = 'rejected'
              try {
                record.error = diagnostic(error)
              } catch (captureError) {
                record.captureError = captureError.message
              }
              throw error
            }
          }
        return value.bind(target)
      },
    })
  }
  async function rejected(work, pattern) {
    let caught
    try {
      await work()
    } catch (error) {
      caught = error
    }
    assert.ok(caught, 'Expected database rejection')
    const details = diagnostic(caught)
    assert.match(JSON.stringify(details), pattern)
    diagnostics.push(details)
    return details
  }
  const oldAbsent = async (model, id) => assert.equal(await model.findUnique({ where: { id } }), null)
  const parentWithKid = (id, kid) =>
    client.cascadeParent.create({ data: { id, kids: { create: { id: kid, note: 'seed' } } } })
  try {
    if (mode === 'mapped-string') {
      await client.mappedKey.create({ data: { id: 'mapped-old', value: 'original' } })
      const row = await client.mappedKey.update({
        where: { id: 'mapped-old' },
        data: { id: 'mapped-new', value: 'renamed' },
      })
      assert.equal(row.id, 'mapped-new')
      assert.equal(row.value, 'renamed')
      await oldAbsent(client.mappedKey, 'mapped-old')
      assert.equal((await client.mappedKey.findUniqueOrThrow({ where: { id: 'mapped-new' } })).value, 'renamed')
      assert.ok(
        queries.some((event) => /UPDATE\s+"M6_MappedKey"/i.test(event.query) && /"physical_code"/.test(event.query)),
      )
    } else if (mode === 'duplicate-key') {
      await client.mappedKey.create({ data: { id: 'duplicate-target', value: 'target-intact' } })
      await rejected(
        () => client.mappedKey.update({ where: { id: 'mapped-new' }, data: { id: 'duplicate-target' } }),
        /P2002|unique|335544(?:349|665)/i,
      )
      assert.equal((await client.mappedKey.findUniqueOrThrow({ where: { id: 'mapped-new' } })).value, 'renamed')
      assert.equal(
        (await client.mappedKey.findUniqueOrThrow({ where: { id: 'duplicate-target' } })).value,
        'target-intact',
      )
    } else if (mode === 'cascade') {
      await parentWithKid('cascade-old', 1)
      const row = await client.cascadeParent.update({
        where: { id: 'cascade-old' },
        data: { id: 'cascade-new' },
        include: { kids: true },
      })
      assert.equal(row.id, 'cascade-new')
      assert.equal(row.kids[0].parentId, 'cascade-new')
      await oldAbsent(client.cascadeParent, 'cascade-old')
      assert.equal((await client.cascadeKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, 'cascade-new')
    } else if (mode === 'no-action') {
      await client.noActionParent.create({ data: { id: 'noaction-old', kids: { create: { id: 1 } } } })
      await rejected(
        () => client.noActionParent.update({ where: { id: 'noaction-old' }, data: { id: 'noaction-new' } }),
        /P2003|foreign.key|335544(?:466|838|839)/i,
      )
      assert.equal((await client.noActionKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, 'noaction-old')
      await client.noActionParent.findUniqueOrThrow({ where: { id: 'noaction-old' } })
      await oldAbsent(client.noActionParent, 'noaction-new')
    } else if (mode === 'set-null') {
      await client.nullParent.create({ data: { id: 'null-old', kids: { create: { id: 1 } } } })
      const row = await client.nullParent.update({ where: { id: 'null-old' }, data: { id: 'null-new' } })
      assert.equal(row.id, 'null-new')
      await oldAbsent(client.nullParent, 'null-old')
      assert.equal((await client.nullKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, null)
    } else if (mode === 'set-default-absent') {
      await client.defaultParent.create({ data: { id: 'default-old', kids: { create: { id: 1 } } } })
      await rejected(
        () => client.defaultParent.update({ where: { id: 'default-old' }, data: { id: 'default-new' } }),
        /P2003|foreign.key|335544(?:466|838|839)/i,
      )
      await client.defaultParent.findUniqueOrThrow({ where: { id: 'default-old' } })
      await oldAbsent(client.defaultParent, 'default-new')
      assert.equal((await client.defaultKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, 'default-old')
    } else if (mode === 'set-default-present') {
      await client.defaultParent.create({ data: { id: 'fallback' } })
      const row = await client.defaultParent.update({ where: { id: 'default-old' }, data: { id: 'default-new' } })
      assert.equal(row.id, 'default-new')
      await oldAbsent(client.defaultParent, 'default-old')
      assert.equal((await client.defaultKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, 'fallback')
      await client.defaultParent.findUniqueOrThrow({ where: { id: 'fallback' } })
    } else if (mode === 'implicit-cascade') {
      await client.implicitParent.create({ data: { id: 'implicit-old', kids: { create: { id: 1 } } } })
      const row = await client.implicitParent.update({ where: { id: 'implicit-old' }, data: { id: 'implicit-new' } })
      assert.equal(row.id, 'implicit-new')
      await oldAbsent(client.implicitParent, 'implicit-old')
      assert.equal((await client.implicitKid.findUniqueOrThrow({ where: { id: 1 } })).parentId, 'implicit-new')
    } else if (mode === 'compound') {
      await client.compoundKey.create({ data: { region: 'region-old', number: 1, value: 'compound-seed' } })
      const row = await client.compoundKey.update({
        where: { region_number: { region: 'region-old', number: 1 } },
        data: { region: 'region-new', number: { increment: 2 } },
      })
      assert.equal(row.region, 'region-new')
      assert.equal(row.number, 3)
      assert.equal(
        await client.compoundKey.findUnique({ where: { region_number: { region: 'region-old', number: 1 } } }),
        null,
      )
      assert.equal(
        (await client.compoundKey.findUniqueOrThrow({ where: { region_number: { region: 'region-new', number: 3 } } }))
          .value,
        'compound-seed',
      )
    } else if (mode === 'numeric-and-upsert') {
      await client.numericKey.create({ data: { id: 10, amount: 7, bucket: 'single' } })
      const row = await client.numericKey.update({ where: { id: 10 }, data: { id: { increment: 5 } } })
      assert.equal(row.id, 15)
      await oldAbsent(client.numericKey, 10)
      const upsert = await client.numericKey.upsert({
        where: { id: 15 },
        update: { id: { increment: 1 }, amount: { increment: 2 } },
        create: { id: 15, amount: 0, bucket: 'single' },
      })
      assert.equal(upsert.id, 16)
      assert.equal(upsert.amount, 9)
      await oldAbsent(client.numericKey, 15)
      assert.equal((await client.numericKey.findUniqueOrThrow({ where: { id: 16 } })).amount, 9)
    } else if (mode === 'integer-division') {
      await client.numericKey.create({ data: { id: 41, bucket: 'divide-positive' } })
      const positive = await client.numericKey.update({ where: { id: 41 }, data: { id: { divide: 2 } } })
      assert.equal(positive.id, 20)
      await oldAbsent(client.numericKey, 41)
      await client.numericKey.findUniqueOrThrow({ where: { id: 20 } })
      await client.numericKey.create({ data: { id: -41, bucket: 'divide-negative' } })
      const negative = await client.numericKey.update({ where: { id: -41 }, data: { id: { divide: 2 } } })
      assert.equal(negative.id, -20)
      await oldAbsent(client.numericKey, -41)
      await client.numericKey.findUniqueOrThrow({ where: { id: -20 } })
      observations.integerDivision = { positive: positive.id, negative: negative.id }
    } else if (mode === 'precise-ids') {
      const before = 9007199254740993n,
        after = 9007199254740995n
      await client.bigIntKey.create({ data: { id: before, value: 'exact-bigint' } })
      const big = await client.bigIntKey.update({ where: { id: before }, data: { id: { increment: 2n } } })
      assert.equal(big.id, after)
      await oldAbsent(client.bigIntKey, before)
      assert.equal((await client.bigIntKey.findUniqueOrThrow({ where: { id: after } })).value, 'exact-bigint')
      const oldDecimal = new Prisma.Decimal('123456789012.123456'),
        newDecimal = new Prisma.Decimal('123456789012.123457')
      await client.decimalKey.create({ data: { id: oldDecimal, value: 'exact-decimal' } })
      const decimal = await client.decimalKey.update({
        where: { id: oldDecimal },
        data: { id: { increment: new Prisma.Decimal('0.000001') } },
      })
      assert.equal(decimal.id.toFixed(6), newDecimal.toFixed(6))
      await oldAbsent(client.decimalKey, oldDecimal)
      assert.equal((await client.decimalKey.findUniqueOrThrow({ where: { id: newDecimal } })).value, 'exact-decimal')
      observations.exactIds = { bigint: String(big.id), decimal: decimal.id.toFixed(6) }
    } else if (mode === 'missing-and-noop') {
      await rejected(
        () => client.mappedKey.update({ where: { id: 'missing-id' }, data: { id: 'missing-result' } }),
        /P2025/,
      )
      await rejected(
        () =>
          client.mappedKey.update({
            where: { id: 'mapped-new', value: 'filter-does-not-match' },
            data: { id: 'filter-result' },
          }),
        /P2025/,
      )
      const existing = await client.mappedKey.update({ where: { id: 'mapped-new' }, data: {} })
      assert.equal(existing.id, 'mapped-new')
      assert.equal(existing.value, 'renamed')
      await rejected(() => client.mappedKey.update({ where: { id: 'missing-noop' }, data: {} }), /P2025/)
      await oldAbsent(client.mappedKey, 'missing-result')
      await oldAbsent(client.mappedKey, 'filter-result')
      assert.equal((await client.mappedKey.findUniqueOrThrow({ where: { id: 'mapped-new' } })).value, 'renamed')
      observations.noMatchAndNoopVerified = true
    } else if (mode === 'nested') {
      await parentWithKid('nested-old', 10)
      const row = await client.cascadeParent.update({
        where: { id: 'nested-old' },
        data: {
          id: 'nested-new',
          kids: {
            create: { id: 11, note: 'new-child' },
            update: { where: { id: 10 }, data: { note: 'updated-child' } },
          },
        },
        include: { kids: { orderBy: { id: 'asc' } } },
      })
      assert.equal(row.id, 'nested-new')
      assert.deepEqual(
        row.kids.map((kid) => [kid.id, kid.parentId, kid.note]),
        [
          [10, 'nested-new', 'updated-child'],
          [11, 'nested-new', 'new-child'],
        ],
      )
      await oldAbsent(client.cascadeParent, 'nested-old')
      assert.equal(await client.cascadeKid.count({ where: { parentId: 'nested-new' } }), 2)
    } else if (mode === 'interactive-rollback') {
      await parentWithKid('interactive-old', 20)
      await assert.rejects(
        client.$transaction(async (tx) => {
          const row = await tx.cascadeParent.update({
            where: { id: 'interactive-old' },
            data: { id: 'interactive-new' },
          })
          assert.equal(row.id, 'interactive-new')
          await tx.cascadeParent.findUniqueOrThrow({ where: { id: 'interactive-new' } })
          assert.equal((await tx.cascadeKid.findUniqueOrThrow({ where: { id: 20 } })).parentId, 'interactive-new')
          throw new Error('M6_EXPECTED_INTERACTIVE_ROLLBACK')
        }),
        /M6_EXPECTED_INTERACTIVE_ROLLBACK/,
      )
      await client.cascadeParent.findUniqueOrThrow({ where: { id: 'interactive-old' } })
      await oldAbsent(client.cascadeParent, 'interactive-new')
      assert.equal((await client.cascadeKid.findUniqueOrThrow({ where: { id: 20 } })).parentId, 'interactive-old')
    } else if (mode === 'batch-rollback') {
      await parentWithKid('batch-old', 21)
      const start = queries.length
      await rejected(
        () =>
          client.$transaction([
            client.cascadeParent.update({ where: { id: 'batch-old' }, data: { id: 'batch-new' } }),
            client.mappedKey.create({ data: { id: 'duplicate-target', value: 'must-not-overwrite' } }),
          ]),
        /P2002|unique|335544(?:349|665)/i,
      )
      assert.ok(queries.slice(start).some((event) => /UPDATE\s+"CascadeParent"/i.test(event.query)))
      await client.cascadeParent.findUniqueOrThrow({ where: { id: 'batch-old' } })
      await oldAbsent(client.cascadeParent, 'batch-new')
      assert.equal((await client.cascadeKid.findUniqueOrThrow({ where: { id: 21 } })).parentId, 'batch-old')
      assert.equal(
        (await client.mappedKey.findUniqueOrThrow({ where: { id: 'duplicate-target' } })).value,
        'target-intact',
      )
    } else if (mode === 'update-many') {
      await client.mappedKey.create({ data: { id: 'many-old', value: 'many-seed' } })
      assert.equal(
        (await client.mappedKey.updateMany({ where: { id: 'many-old' }, data: { id: 'many-new' } })).count,
        1,
      )
      await oldAbsent(client.mappedKey, 'many-old')
      assert.equal((await client.mappedKey.findUniqueOrThrow({ where: { id: 'many-new' } })).value, 'many-seed')
      await client.numericKey.createMany({
        data: [
          { id: 100, bucket: 'many' },
          { id: 200, bucket: 'many' },
        ],
      })
      assert.equal(
        (await client.numericKey.updateMany({ where: { bucket: 'many' }, data: { id: { increment: 1 } } })).count,
        2,
      )
      await oldAbsent(client.numericKey, 100)
      await oldAbsent(client.numericKey, 200)
      assert.deepEqual(
        (await client.numericKey.findMany({ where: { bucket: 'many' }, orderBy: { id: 'asc' } })).map((row) => row.id),
        [101, 201],
      )
    } else if (mode === 'trigger-rejection') {
      await client.triggerKey.create({ data: { id: 'trigger-old', value: 'trigger-seed' } })
      const start = adapterAttempts.length
      const details = await rejected(
        () =>
          client.triggerKey.update({
            where: { id: 'trigger-old' },
            data: { id: 'trigger-rejected', value: 'must-not-persist' },
          }),
        /M6_UPDATE_REJECT/,
      )
      const failedUpdate = adapterAttempts
        .slice(start)
        .find(
          (event) =>
            /UPDATE\s+"M6_TriggerKey"/i.test(event.query) &&
            /"trigger_code"/.test(event.query) &&
            event.outcome === 'rejected',
        )
      assert.ok(failedUpdate, 'Actual rejected UPDATE must be visible in delegated adapter attempts')
      assert.match(JSON.stringify(failedUpdate.error), /M6_UPDATE_REJECT/)
      assert.match(JSON.stringify(failedUpdate.error), /335544\d{3}/)
      observations.triggerError = { client: details, adapter: failedUpdate.error }
      assert.equal((await client.triggerKey.findUniqueOrThrow({ where: { id: 'trigger-old' } })).value, 'trigger-seed')
      await oldAbsent(client.triggerKey, 'trigger-rejected')
    } else if (mode === 'trigger-rewrite') {
      await client.triggerKey.create({ data: { id: 'rewrite-old', value: 'rewrite-seed' } })
      const start = queries.length
      const row = await client.triggerKey.update({ where: { id: 'rewrite-old' }, data: { id: 'trigger-requested' } })
      assert.equal(row.id, 'trigger-actual')
      assert.equal(row.value, 'rewrite-seed')
      await oldAbsent(client.triggerKey, 'rewrite-old')
      await oldAbsent(client.triggerKey, 'trigger-requested')
      assert.equal(
        (await client.triggerKey.findUniqueOrThrow({ where: { id: 'trigger-actual' } })).value,
        'rewrite-seed',
      )
      assert.ok(
        queries
          .slice(start)
          .some((event) => /UPDATE\s+"M6_TriggerKey"/i.test(event.query) && /RETURNING/i.test(event.query)),
      )
      observations.triggerId = { requested: 'trigger-requested', returned: row.id }
      await client.triggerKey.create({ data: { id: 'value-trigger-old', value: 'value-seed' } })
      const valueOnly = await client.triggerKey.update({
        where: { id: 'value-trigger-old' },
        data: { value: 'rewrite-on-value' },
      })
      assert.equal(valueOnly.id, 'value-trigger-actual')
      assert.equal(valueOnly.value, 'rewrite-on-value')
      await oldAbsent(client.triggerKey, 'value-trigger-old')
      assert.equal(
        (await client.triggerKey.findUniqueOrThrow({ where: { id: 'value-trigger-actual' } })).value,
        'rewrite-on-value',
      )
      observations.triggerFromValueOnly = { original: 'value-trigger-old', returned: valueOnly.id }
    } else throw new Error('Unknown ID-update scenario')
    const publicSuccessUpdateObserved = queries.some((event) => /UPDATE\s+/i.test(event.query))
    const adapterUpdateAttemptObserved = adapterAttempts.some((event) => /UPDATE\s+/i.test(event.query))
    if (mode !== 'missing-and-noop')
      assert.ok(adapterUpdateAttemptObserved, 'An actual Client UPDATE must reach the delegated adapter')
    console.log(
      JSON.stringify({
        mode,
        passed: true,
        publicSuccessUpdateObserved,
        adapterUpdateAttemptObserved,
        queryProofSources: {
          queries: 'public-success-only-query-event',
          adapterAttempts: 'transparent-delegation-attempt-and-original-error',
        },
        observations,
        diagnostics,
        queries,
        adapterAttempts,
        rawCrudPerformed: false,
      }),
    )
  } catch (error) {
    console.error(JSON.stringify({ mode, failure: error.message, diagnostics, queries, adapterAttempts }))
    throw error
  } finally {
    await client.$disconnect()
  }
}
