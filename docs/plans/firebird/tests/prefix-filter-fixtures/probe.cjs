/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const f = require('./fixture.cjs')
const trace = require('./trace.cjs')()
const role = 'filters-m7-fixed-2'
const callback = work => new Promise((resolve, reject) => work((error, result) => error ? reject(error) : resolve(result)))
function physical(file) {
  const real = fs.realpathSync(file)
  assert.equal(process.platform === 'win32' ? real.toLowerCase() : real,
    process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file), 'No physical alias accepted')
  return real
}

async function main() {
  const consumer = physical(process.env.FIREBIRD_CLI_CONSUMER_ROOT)
  assert.equal(globalThis[Symbol.for('firebird.cli.consumer.isolation')]?.consumer, consumer)
  assert.equal(process.env.FIREBIRD_CLI_ROLE, role)
  const connections = JSON.parse(fs.readFileSync(process.env.FIREBIRD_CLI_PRIVATE_CONNECTIONS, 'utf8'))
  assert.deepEqual(Object.keys(connections), [role])
  const config = connections[role]
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3059)
  assert.equal(path.basename(config.database).toLowerCase(), `${role}.fdb`)
  physical(config.database)
  const adapterRequire = createRequire(path.join(consumer, 'node_modules/@prisma/adapter-firebird/dist/index.js'))
  const driver = adapterRequire('node-firebird')
  const driverRoot = path.dirname(path.dirname(adapterRequire.resolve('node-firebird')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(driverRoot, 'package.json'), 'utf8')).version, '2.18.2')
  const { PrismaFirebird } = adapterRequire('@prisma/adapter-firebird')
  const { PrismaClient } = await import(pathToFileURL(process.env.FIREBIRD_CLI_CLIENT_MODULE).href)
  const nativeModule = adapterRequire('node-firebird/lib/wire/transaction.js')
  const restore = trace.installNative(nativeModule.default || nativeModule, adapterRequire('node-firebird/lib/callback.js'))
  const report = { schemaVersion: 1, milestone: 7, sourceVersion: 2, classification: 'PUBLIC_INSTALLED_PREFIX_FILTER_ACCEPTANCE',
    status: 'running', expectedScenarioCount: f.expectedScenarioCount, driverVersion: '2.18.2', scenarios: [],
    physicalProfiles: [], publicQueryEvents: [], diagnosticSelects: 0, cleanupFailures: [],
    setupDDLAndInsertsAreFixtureOnly: true, rawQueriesAreIndependentOraclesOnly: true,
    clientReadUsesRawFallback: false, applicationEscapingOrFiltering: false,
    databaseLifecycleManagedByProbe: false, supportsUnlimitedPrefixInput: false }
  let db, client
  const context = (caseId, layer, operation, term) => { trace.state.context = { caseId, layer, operation, term } }
  const publicQuery = (sql, args = []) => { trace.validate(sql); return callback(cb => db.query(sql, args, cb)) }
  async function nativeRead(sql, args) {
    trace.validate(sql)
    let transaction, statement
    try {
      transaction = await callback(cb => db.transaction({ isolation: driver.ISOLATION_READ_COMMITTED, readOnly: true, wait: false }, cb))
      statement = await transaction.newStatementAsync(sql)
      await statement.executeAsync(transaction, args, { namedPlaceholders: false })
      const rows = await statement.fetchAllAsync(transaction)
      await statement.releaseAsync(); statement = undefined
      await transaction.commitAsync(); transaction = undefined
      return rows
    } finally {
      if (statement) { statement._failed = true; await statement.releaseAsync().catch(error => report.cleanupFailures.push(trace.diagnostic(error))) }
      if (transaction) await transaction.rollbackAsync().catch(error => report.cleanupFailures.push(trace.diagnostic(error)))
    }
  }
  async function observe(action, format) {
    report.diagnosticSelects++
    let value
    try { value = await action() } catch (error) { return { status: 'error', error: trace.diagnostic(error) } }
    return { status: 'success', ...format(value) }
  }
  const count = rows => {
    assert.ok(Array.isArray(rows) && rows.length === 1 && rows[0].length === 1)
    const value = Number(rows[0][0]); assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= f.keys.length)
    return { count: value }
  }
  const nativeKeys = rows => {
    assert.ok(Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 1))
    return { count: rows.length, keys: rows.map(row => row[0]) }
  }
  async function scenario(id, action) {
    const result = { id, passed: false }
    report.scenarios.push(result)
    try { await action(result); result.passed = true }
    catch (error) { result.failure = trace.diagnostic(error) }
  }
  async function parity(id, modelName, key, table, physicalKey, where, predicate, args, options = {}) {
    await scenario(id, async result => {
      result.oracleKind = options.extended ? 'explicit-wide-diagnostic-contract' : 'original-application-predicate'
      result.oraclePredicate = predicate; result.input = options.input ?? args[0]
      context(id, 'original-driver-oracle', 'count', result.input)
      result.oracleCount = await observe(() => nativeRead(`SELECT COUNT(*) TOTAL FROM ${table} WHERE ${predicate}`, args), count)
      context(id, 'original-driver-oracle', 'rows', result.input)
      result.oracleRows = await observe(() => nativeRead(`SELECT ${physicalKey} FROM ${table} WHERE ${predicate} ORDER BY ${physicalKey}`, args), nativeKeys)
      context(id, 'client-public-model', 'count', result.input)
      result.clientCount = await observe(() => client[modelName].count({ where }), value => ({ count: value }))
      context(id, 'client-public-model', 'rows', result.input)
      result.clientRows = await observe(() => client[modelName].findMany({ where, select: { [key]: true }, orderBy: { [key]: 'asc' } }),
        rows => ({ count: rows.length, keys: rows.map(row => row[key]) }))
      if (options.nativeIndexedLimitParity) {
        // The independent oracle hit the same native index bound in attempt 1.
        // This branch applies ONLY to the two binary-index 8191-character cases.
        for (const value of [result.oracleCount, result.oracleRows, result.clientCount, result.clientRows]) {
          assert.equal(value.status, 'error')
          assert.deepEqual(value.error.nativeGds, [335544381], 'No unrelated error may satisfy native index-limit parity')
        }
        assert.equal(result.oracleCount.error.message, result.oracleRows.error.message)
        assert.match(result.oracleCount.error.message, /^Implementation limit exceeded, Key size exceeds implementation restriction for index "[^"]+"$/)
        for (const value of [result.clientCount, result.clientRows]) {
          assert.equal(value.error.name, 'PrismaClientKnownRequestError'); assert.equal(value.error.prismaCode, 'P2039')
          assert.ok(value.error.message.includes(result.oracleCount.error.message), 'Client must preserve the exact original native diagnostic')
        }
        for (const operation of ['count', 'rows']) for (const layer of ['original-driver-oracle', 'client-public-model']) {
          const events = trace.state.events.filter(event => event.caseId === id && event.operation === operation && event.layer === layer)
          const prepared = events.filter(event => event.stage === 'native-prepared-input-sqlda')
          assert.equal(prepared.length, 1)
          assert.equal(prepared[0].input[0].type, 448); assert.equal(prepared[0].input[0].length, 32764)
          assert.equal(prepared[0].input[0].charSetId, 4)
          const executes = events.filter(event => event.stage === 'native-statement-execute')
          assert.equal(executes.length, 1); assert.equal(executes[0].args[0].value, result.input)
          const statuses = events.filter(event => event.stage === 'native-status-vector')
          assert.equal(statuses.length, 1)
          assert.deepEqual(statuses[0].status.map(item => item.gdscode), [335544381, 335544434])
          const indexName = result.oracleCount.error.message.match(/index "([^"]+)"$/)[1]
          assert.deepEqual(statuses[0].status[1].params, [indexName])
          if (layer === 'original-driver-oracle') {
            assert.equal(prepared[0].input.length, 1); assert.deepEqual(executes[0].args.map(arg => arg.value), [result.input])
          } else {
            assert.equal(prepared[0].input.length, 2)
            assert.equal(prepared[0].input[1].type, 580); assert.equal(prepared[0].input[1].length, 8)
            assert.deepEqual(executes[0].args.map(arg => arg.value), [result.input, '0'])
          }
        }
        result.nativeIndexedLimitParity = { preserved: true, nativeGds: 335544381, secondaryGds: 335544434,
          prismaCode: 'P2039', notAnUnlimitedInputSuccessClaim: true }
      } else {
        for (const value of [result.oracleCount, result.oracleRows, result.clientCount, result.clientRows]) assert.equal(value.status, 'success')
        assert.equal(result.clientCount.count, result.oracleCount.count)
        assert.equal(result.clientRows.count, result.oracleRows.count)
        assert.deepEqual(result.clientRows.keys, result.oracleRows.keys)
        if (options.expected !== undefined) assert.equal(result.clientCount.count, options.expected)
      }
      const attempts = trace.state.events.filter(event => event.caseId === id && event.layer === 'client-public-model' && event.stage === 'delegated-adapter-attempt')
      assert.equal(attempts.length, 2)
      if (options.prefix || options.fieldReference) for (const event of attempts) {
        assert.match(event.sql, /STARTING\s+WITH/i)
        assert.doesNotMatch(event.sql, /\bLIKE\b|\bESCAPE\b/i)
        if (options.prefix) assert.ok(event.args.some(arg => arg.value === result.input), 'Unchanged original prefix must reach the adapter')
      }
      if (options.compatibility) for (const event of attempts) {
        assert.match(event.sql, /\bLIKE\b/i); assert.doesNotMatch(event.sql, /STARTING\s+WITH/i)
      }
    })
  }
  try {
    context('fixture', 'original-driver', 'attach')
    db = await callback(cb => driver.attach({ ...config, encoding: 'UTF8', defaultCharset: 'UTF8', lowercase_keys: false }, cb))
    const identity = await publicQuery(f.identitySql)
    assert.equal(identity.length, 1)
    assert.equal(physical(identity[0].DATABASE_PATH.trim()).toLowerCase(), physical(config.database).toLowerCase())
    assert.match(identity[0].ENGINE_VERSION, /^3\.0\./); assert.equal(identity[0].DIALECT, 3); assert.equal(identity[0].ODS_MAJOR, 12)
    report.engine = { version: identity[0].ENGINE_VERSION, dialect: 3, odsMajor: 12, ownedDatabaseIdentityVerified: true }
    assert.deepEqual(await publicQuery(f.emptyCatalogSql), [], 'Never adopt/reset an existing catalog')
    for (const step of f.setup) await publicQuery(step.sql, step.args)
    for (const table of f.tables) {
      const fields = await publicQuery(f.fieldSql(table)), keyRows = await publicQuery(f.keySql(table))
      const primaryKey = keyRows.map(row => row.FIELD_NAME)
      report.physicalProfiles.push({ table, fields, primaryKey })
      const profile = f.profiles.find(item => item.table === table)
      if (profile) {
        const field = fields.find(item => item.FIELD_NAME === 'COD_NCM')
        assert.equal(field.FIELD_TYPE, 37); assert.equal(field.LENGTH_BYTES, 40); assert.equal(field.LENGTH_CHARS, 10)
        assert.equal(field.CHARACTER_SET, 'UTF8'); assert.equal(field.COLLATION_NAME, profile.collation)
        assert.equal(field.NOT_NULL, 1); assert.deepEqual(primaryKey, ['COD_NCM'])
        for (const numeric of fields.filter(item => item.FIELD_NAME !== 'COD_NCM')) {
          assert.equal(numeric.FIELD_TYPE, 16); assert.equal(numeric.FIELD_PRECISION, 15); assert.equal(numeric.FIELD_SCALE, -2)
        }
      } else if (table === 'M7_PREFIX_BOUNDARY') {
        assert.deepEqual(primaryKey, ['ID'])
        const field = fields.find(item => item.FIELD_NAME === 'PREFIX_TEXT')
        assert.equal(field.LENGTH_CHARS, 8191); assert.equal(field.LENGTH_BYTES, 32764)
      } else {
        const city = f.cityProfiles.find(item => item.table === table)
        assert.deepEqual(primaryKey, ['COD_MUN'])
        for (const [name, width] of [['NOME_MUNICIPIO', city.municipioWidth], ['ESTADO', city.estadoWidth], ['SIGLA', 2]]) {
          const field = fields.find(item => item.FIELD_NAME === name)
          assert.equal(field.LENGTH_CHARS, width); assert.equal(field.LENGTH_BYTES, width * 4); assert.equal(field.CHARACTER_SET, 'UTF8')
        }
      }
    }
    client = new PrismaClient({ adapter: trace.observe(new PrismaFirebird(config, { poolSize: 1, transactionLockTimeout: 1 })),
      log: [{ level: 'query', emit: 'event' }] })
    client.$on('query', event => report.publicQueryEvents.push({ ...trace.state.context, sql: event.query, params: event.params, duration: event.duration }))
    for (const profile of f.profiles) {
      const predicate = 'COD_NCM STARTING WITH CAST(? AS VARCHAR(100))'
      for (const [id, term] of f.prefixCases)
        await parity(`${profile.id}-${id}`, profile.model, 'codigo', profile.table, 'COD_NCM',
          { codigo: { startsWith: term } }, predicate, [term], { prefix: true })
      await parity(`${profile.id}-extended-8191`, profile.model, 'codigo', profile.table, 'COD_NCM',
        { codigo: { startsWith: f.boundary } }, 'COD_NCM STARTING WITH CAST(? AS VARCHAR(8191) CHARACTER SET UTF8)',
        [f.boundary], { prefix: true, extended: true, expected: 0, nativeIndexedLimitParity: profile.id === 'utf8-binary' })
      const astralBoundary = '\u{1f600}'.repeat(8191)
      await parity(`${profile.id}-extended-8191-astral-codepoints`, profile.model, 'codigo', profile.table, 'COD_NCM',
        { codigo: { startsWith: astralBoundary } }, 'COD_NCM STARTING WITH CAST(? AS VARCHAR(8191) CHARACTER SET UTF8)',
        [astralBoundary], { prefix: true, extended: true, expected: 0, nativeIndexedLimitParity: profile.id === 'utf8-binary' })
      for (const [label, term] of [['percent', '%'], ['underscore', 'A_'], ['eleven', 'X1234567890'], ['empty', '']]) {
        await parity(`${profile.id}-nested-not-${label}`, profile.model, 'codigo', profile.table, 'COD_NCM',
          { codigo: { not: { startsWith: term } } }, `NOT (${predicate})`, [term], { prefix: true })
        await parity(`${profile.id}-top-NOT-${label}`, profile.model, 'codigo', profile.table, 'COD_NCM',
          { NOT: { codigo: { startsWith: term } } }, `NOT (${predicate})`, [term], { prefix: true })
      }
      await parity(`${profile.id}-field-reference`, profile.model, 'codigo', profile.table, 'COD_NCM',
        { codigo: { startsWith: client[profile.model].fields.codigo } }, 'COD_NCM STARTING WITH COD_NCM', [], { expected: f.keys.length, fieldReference: true })
      for (const operation of ['contains', 'endsWith']) for (const term of ['%', '_', 'A_'])
        await parity(`${profile.id}-${operation}-${term}`, profile.model, 'codigo', profile.table, 'COD_NCM',
          { codigo: { [operation]: term } }, `COD_NCM LIKE ('%' || ?${operation === 'contains' ? " || '%'" : ''})`, [term], { compatibility: true })
      await scenario(`${profile.id}-mode-insensitive-rejected`, async result => {
        context(result.id, 'client-validation', 'count', 'a')
        result.observed = await observe(() => client[profile.model].count({ where: { codigo: { startsWith: 'a', mode: 'insensitive' } } }), value => ({ count: value }))
        assert.equal(result.observed.status, 'error'); assert.equal(result.observed.error.name, 'PrismaClientValidationError')
        assert.match(result.observed.error.message, /Unknown argument [`'"]?mode/i)
        assert.equal(trace.state.events.filter(event => event.caseId === result.id && event.stage === 'delegated-adapter-attempt').length, 0)
      })
    }
    for (const city of f.cityProfiles) {
      for (const [label, term] of [['literal-percent', '%'], ['literal-underscore', '_'], ['internal-percent', 'A%'],
        ['internal-underscore', 'A_'], ['empty', ''], ['physical-width', 'M'.repeat(city.municipioWidth)],
        ['width-plus-one', 'M'.repeat(city.municipioWidth + 1)]])
        await parity(`${city.id}-municipio-${label}`, city.model, 'codigo', city.table, 'COD_MUN',
          { municipio: { startsWith: term } }, 'NOME_MUNICIPIO STARTING WITH CAST(? AS VARCHAR(200))', [term], { prefix: true })
      for (const term of ['PER', 'PE', '_', 'X'.repeat(26)])
        await parity(`${city.id}-UF-${term}`, city.model, 'codigo', city.table, 'COD_MUN',
          { OR: [{ sigla: { startsWith: term } }, { estado: { startsWith: term } }] },
          '(SIGLA STARTING WITH CAST(? AS VARCHAR(100)) OR ESTADO STARTING WITH CAST(? AS VARCHAR(100)))', [term, term],
          { prefix: true, ...(term === 'PER' ? { expected: 2 } : {}) })
      await parity(`${city.id}-nullable-is-null`, city.model, 'codigo', city.table, 'COD_MUN', { municipio: null }, 'NOME_MUNICIPIO IS NULL', [], { expected: 1 })
      await parity(`${city.id}-nullable-nested-not`, city.model, 'codigo', city.table, 'COD_MUN',
        { municipio: { not: { startsWith: '%' } } }, 'NOT (NOME_MUNICIPIO STARTING WITH CAST(? AS VARCHAR(200)))', ['%'], { prefix: true })
      await parity(`${city.id}-nullable-top-NOT`, city.model, 'codigo', city.table, 'COD_MUN',
        { NOT: { municipio: { startsWith: '_' } } }, 'NOT (NOME_MUNICIPIO STARTING WITH CAST(? AS VARCHAR(200)))', ['_'], { prefix: true })
      await parity(`${city.id}-nullable-field-reference`, city.model, 'codigo', city.table, 'COD_MUN',
        { municipio: { startsWith: client[city.model].fields.sigla } }, 'NOME_MUNICIPIO STARTING WITH SIGLA', [], { expected: 2, fieldReference: true })
    }
    for (const [label, term, expected] of [['8191-nonspace', f.boundary, 1], ['8191-trailing-blank', 'B'.repeat(8190) + ' ', 0]])
      await parity(`boundary-${label}`, 'prefixBoundary', 'id', 'M7_PREFIX_BOUNDARY', 'ID', { text: { startsWith: term } },
        'PREFIX_TEXT STARTING WITH CAST(? AS VARCHAR(8191) CHARACTER SET UTF8)', [term], { prefix: true, extended: true, expected })
    for (const [label, term] of [['8192-nonspace', f.boundary + 'X'], ['8192-trailing-blank', f.boundary + ' '],
      ['8192-astral-codepoints', '\u{1f600}'.repeat(8192)]])
      await scenario(`boundary-${label}-explicit-rejection`, async result => {
        result.inputLength = term.length; result.inputCodepoints = Array.from(term).length
        result.input = term; result.notAnUnlimitedInputContract = true
        for (const operation of ['count', 'rows']) {
          context(result.id, 'client-boundary-rejection', operation, term)
          const action = operation === 'count' ? () => client.prefixBoundary.count({ where: { text: { startsWith: term } } }) :
            () => client.prefixBoundary.findMany({ where: { text: { startsWith: term } }, select: { id: true }, orderBy: { id: 'asc' } })
          result[operation] = await observe(action, value => ({ returned: value }))
          assert.equal(result[operation].status, 'error', 'Over-limit input must reject; a successful trimmed result is a failure')
          assert.equal(result[operation].error.name, 'PrismaClientKnownRequestError')
          assert.equal(result[operation].error.prismaCode, 'P2007', 'InvalidInputValue maps to the existing P2007 contract')
          assert.match(result[operation].error.message, /8191/, 'Record the explicit supported maximum')
          assert.equal(trace.state.events.filter(event => event.caseId === result.id && event.operation === operation &&
            event.stage === 'native-statement-execute').length, 0, 'The oversized value must reject before native execute')
        }
        context(result.id, 'client-boundary-seed-proof', 'read')
        const row = await client.prefixBoundary.findUniqueOrThrow({ where: { id: 1 } })
        assert.equal(row.text, f.boundary)
        result.boundaryRowPreserved = true
      })
    assert.equal(report.scenarios.length, report.expectedScenarioCount)
    assert.equal(report.diagnosticSelects, 400)
    report.status = report.scenarios.every(result => result.passed) ? 'PASSED' : 'FAILED'
  } catch (error) { report.status = 'SETUP_OR_HARNESS_FAILURE'; report.failure = trace.diagnostic(error) }
  finally {
    trace.state.context = { caseId: 'cleanup' }
    if (client) await client.$disconnect().catch(error => report.cleanupFailures.push(trace.diagnostic(error)))
    if (db) await db.detachAsync().catch(error => report.cleanupFailures.push(trace.diagnostic(error)))
    restore(); report.trace = trace.state.events
    report.cleanupCompleted = report.cleanupFailures.length === 0
    if (!report.cleanupCompleted) report.status = 'CLEANUP_FAILURE'
  }
  report.passedScenarioCount = report.scenarios.filter(result => result.passed).length
  console.log(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
  if (report.status !== 'PASSED') process.exitCode = 1
}
main().catch(error => { console.error(JSON.stringify({ status: 'PREFLIGHT_FAILURE', error: trace.diagnostic(error) })); process.exitCode = 1 })
