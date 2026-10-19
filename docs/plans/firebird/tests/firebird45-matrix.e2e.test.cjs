/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test } = require('node:test')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const inside = (root, value) => {
  const relative = path.relative(root, path.resolve(value))
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
function required(name) { assert.ok(process.env[name], `Missing ${name}`); return process.env[name] }
async function directory(name) {
  const input = required(name)
  assert.ok(path.isAbsolute(input))
  const root = await fs.realpath(input)
  assert.ok((await fs.stat(root)).isDirectory())
  return root
}
function embeddedWasmPayload(bytes, file) {
  const prefix = Buffer.from('const wasm = "')
  const suffix = Buffer.from(file.endsWith('.mjs') ? '";\nexport { wasm }\n' : '";\nmodule.exports = { wasm }\n')
  assert.ok(bytes.length <= 128 * 1024 * 1024, 'Unexpected embedded Wasm wrapper size')
  assert.ok(bytes.subarray(0, prefix.length).equals(prefix), 'Unexpected data-only Wasm wrapper prefix')
  const end = bytes.indexOf(0x22, prefix.length)
  assert.ok(end >= prefix.length + 1000 && (end - prefix.length) % 4 === 0, 'Invalid embedded base64 payload length')
  assert.ok(bytes.subarray(end).equals(suffix), 'Expected exactly one payload and the known data-only wrapper suffix')
  const chunks = []
  for (let offset = prefix.length; offset < end; offset += 65536) {
    const encoded = bytes.subarray(offset, Math.min(offset + 65536, end)).toString('latin1')
    const chunk = Buffer.from(encoded, 'base64')
    assert.equal(chunk.toString('base64'), encoded, 'Embedded Wasm payload must be canonical base64')
    if (offset + 65536 < end) assert.equal(chunk.length, 49152, 'Base64 padding is allowed only at the end')
    chunks.push(chunk)
  }
  const payload = Buffer.concat(chunks)
  assert.equal(payload.subarray(0, 4).toString('hex'), '0061736d', 'Embedded Wasm has invalid magic')
  return payload
}
async function wasmProof(consumer) {
  const output = []
  async function visit(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Matrix consumer must not link into development repositories')
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && /(?:\.wasm|wasm-base64\.[cm]?js)$/i.test(file)) {
        const bytes = await fs.readFile(file)
        const raw = /\.wasm$/i.test(file)
        const payloads = raw ? [bytes] : [embeddedWasmPayload(bytes, file)]
        assert.equal(payloads.length, 1)
        assert.equal(payloads[0].subarray(0, 4).toString('hex'), '0061736d')
        output.push({ path: path.relative(consumer, file), bytes: bytes.length, sha256: digest(bytes), wasmBytes: payloads[0].length, wasmSha256: digest(payloads[0]) })
      }
    }
  }
  await visit(path.join(consumer, 'node_modules'))
  assert.ok(output.some((item) => /schema/i.test(item.path)))
  assert.ok(output.some((item) => /query.compiler|query_compiler/i.test(item.path)))
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

test('isolated Firebird 4/5 candidate matrix with the current Firebird 3 provider', {
  skip: process.env.RUN_FIREBIRD_45_MATRIX !== '1', timeout: 900_000,
}, async (t) => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24)
  assert.ok(!Object.keys(process.env).some((key) => key.toUpperCase() === 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION'))
  const major = Number(required('FIREBIRD_MATRIX_MAJOR'))
  const candidates = await readJson(path.join(__dirname, '..', 'matrix', 'firebird45-candidates.json'))
  const candidate = candidates.candidates.find((entry) => entry.major === major)
  assert.ok(candidate && [4, 5].includes(major))
  const phase = process.env.FIREBIRD_MATRIX_PHASE || 'offline'
  assert.ok(['offline', 'online'].includes(phase), 'Run one explicitly selected phase at a time')
  const consumer = await directory('FIREBIRD_MATRIX_CONSUMER_ROOT')
  const orm = await directory('FIREBIRD_MATRIX_ORM_ROOT')
  const engines = await directory('FIREBIRD_MATRIX_ENGINES_ROOT')
  const owner = await readJson(path.join(consumer, '.prisma-firebird-cli-consumer.json'))
  assert.equal(owner.root, consumer)
  assert.equal(owner.milestone, 4)
  assert.equal(owner.syntheticOnly, true)
  assert.match(owner.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.ok(![orm, engines].some((root) => inside(root, consumer) || inside(consumer, root)))
  const labInput = required('FIREBIRD_MATRIX_LAB_ROOT')
  assert.ok(path.isAbsolute(labInput))
  const lab = phase === 'online' ? await fs.realpath(labInput) : path.join(await fs.realpath(path.dirname(labInput)), path.basename(labInput))
  assert.ok(![consumer, orm, engines].some((root) => inside(root, lab) || inside(lab, root)))
  const evidenceInput = required('FIREBIRD_MATRIX_EVIDENCE_ROOT')
  assert.ok(path.isAbsolute(evidenceInput))
  const evidence = path.join(await fs.realpath(path.dirname(evidenceInput)), path.basename(evidenceInput))
  assert.ok(![consumer, lab, orm, engines].some((root) => inside(root, evidence) || inside(evidence, root)))
  assert.ok(!/(?:^|[\\/])(?:milestone-[234]|distribution|checkpoint[234])(?:[\\/]|$)/i.test(evidence))
  await fs.mkdir(evidence)
  await fs.mkdir(path.join(evidence, 'commands'))
  const state = path.join(consumer, '.state', `firebird${major}-matrix-${Date.now()}-${randomUUID()}`)
  const project = path.join(state, 'project')
  const traces = path.join(state, 'traces')
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(traces)
  await fs.mkdir(path.join(state, 'appdata'))
  await fs.mkdir(path.join(state, 'localappdata'))
  await fs.writeFile(path.join(project, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' })
  const source = path.join(__dirname, 'cli-consumer-fixtures')
  const schema = await fs.readFile(path.join(source, 'schema.prisma'))
  const originalHook = await fs.readFile(path.join(source, 'isolation-hook.cjs'), 'utf8')
  assert.ok(originalHook.includes('target.port !== 3059'), 'Re-review the M4 hook before adapting a changed network contract')
  // A consumer-local snapshot, not a runtime repository import. The sole port
  // substitution is explicitly recorded with both input/output source hashes.
  const matrixHook = originalHook.replaceAll('3059', String(candidate.port))
  const hook = path.join(state, 'matrix-isolation-hook.cjs')
  await fs.writeFile(hook, matrixHook, { flag: 'wx' })
  const fixture = await fs.readFile(path.join(__dirname, 'firebird45-fixtures', 'client.mjs'))
  const runner = path.join(state, 'client.mjs')
  await fs.writeFile(runner, fixture, { flag: 'wx' })
  await fs.writeFile(path.join(project, 'schema.prisma'), schema, { flag: 'wx' })
  await fs.writeFile(path.join(project, 'offline.config.ts'), "import { defineConfig } from 'prisma/config'\nexport default defineConfig({ schema: './schema.prisma', migrations: { path: './migrations' } })\n", { flag: 'wx' })
  await fs.writeFile(path.join(project, 'online.config.ts'), "import { defineConfig, env } from 'prisma/config'\nexport default defineConfig({ schema: './schema.prisma', migrations: { path: './migrations' }, datasource: { url: env('DATABASE_URL') } })\n", { flag: 'wx' })
  await fs.mkdir(path.join(project, 'migrations'))
  const cli = path.join(consumer, 'node_modules', 'prisma', 'build', 'index.js')
  assert.ok(inside(consumer, await fs.realpath(cli)))
  const lockBytes = await fs.readFile(path.join(consumer, 'package-lock.json'))
  const lock = JSON.parse(lockBytes.toString('utf8'))
  const packages = []
  for (const alias of ['prisma', '@prisma/client', '@prisma/adapter-firebird']) {
    const installed = lock.packages?.[`node_modules/${alias}`]
    assert.ok(installed && !installed.link && /^file:.*\.tgz$/i.test(installed.resolved || ''))
    const bytes = await fs.readFile(path.join(consumer, 'node_modules', ...alias.split('/'), 'package.json'))
    packages.push({ alias, name: JSON.parse(bytes).name, version: JSON.parse(bytes).version, integrity: installed.integrity, manifestSha256: digest(bytes) })
  }
  const drivers = Object.entries(lock.packages).filter(([key]) => /(?:^|\/)node-firebird$/.test(key))
  assert.ok(drivers.length > 0 && drivers.every(([, entry]) => entry.version === '2.18.2'))
  let connections, manifest
  let tokens = []
  if (phase === 'online') {
    assert.equal(process.env.FIREBIRD_MATRIX_PROVISION_GENERATED_DDL, '1', 'Explicit generated-fixture DDL authorization is required for this online test')
    manifest = await readJson(path.join(lab, 'manifest.json'))
    assert.equal(manifest.root, lab)
    assert.match(manifest.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert.equal((await fs.readFile(path.join(lab, '.prisma-firebird-matrix-lab'), 'utf8')).trim(), manifest.owner)
    assert.equal(manifest.syntheticOnly, true)
    assert.equal(manifest.nativeLocalFilesystem, true)
    assert.equal(manifest.major, major)
    assert.equal(manifest.host, '127.0.0.1')
    assert.equal(manifest.port, candidate.port)
    assert.equal(manifest.archiveSha256, candidate.sha256)
    const runtime = await fs.realpath(manifest.runtime)
    assert.ok(inside(path.join(lab, 'runtime'), runtime))
    assert.ok(Object.keys(manifest.immutableComponentHashes || {}).length >= 3)
    for (const requiredName of ['firebird.exe', 'isql.exe', 'fbclient.dll']) assert.ok(manifest.immutableComponentHashes[requiredName])
    for (const [relative, expected] of Object.entries(manifest.immutableComponentHashes)) {
      assert.ok(!/\.fdb$/i.test(relative), 'Mutable security/database files are not immutable component inputs')
      const file = await fs.realpath(path.join(runtime, relative))
      assert.ok(inside(runtime, file))
      assert.equal(digest(await fs.readFile(file)), expected)
    }
    connections = await readJson(path.join(lab, 'private', 'connections.json'))
    tokens = Object.values(connections).flatMap((value) => [value.user, value.password, value.database, value.database?.replaceAll('\\', '/'), value.password && encodeURIComponent(value.password)]).filter(Boolean).sort((a, b) => b.length - a.length)
    const fileIds = new Set()
    for (const role of ['client', 'guard']) {
      const config = connections[role]
      assert.equal(config.host, '127.0.0.1')
      assert.equal(config.port, candidate.port)
      assert.equal(path.resolve(config.database), path.join(lab, 'db', `matrix-${role}.fdb`))
      assert.ok(inside(path.join(lab, 'db'), await fs.realpath(config.database)))
      const info = await fs.stat(config.database, { bigint: true })
      assert.ok(info.isFile() && info.ino > 0n && info.dev > 0n)
      fileIds.add(`${info.dev}:${info.ino}`)
    }
    assert.equal(fileIds.size, 2)
    await fs.writeFile(path.join(state, 'connections.json'), JSON.stringify(connections), { flag: 'wx', mode: 0o600 })
  }
  const redact = (value) => {
    let output = String(value).replace(/firebird:\/\/[^\s"'<>]+/gi, '<REDACTED_FIREBIRD_URL>')
    for (const token of tokens) output = output.replaceAll(token, '<REDACTED>')
    return output
  }
  const beforeWasm = await wasmProof(consumer)
  const results = {
    schemaVersion: 1, status: 'running', classification: 'EXPERIMENTAL_OBSERVATIONS_NOT_FIREBIRD_45_SUPPORT_ACCEPTANCE',
    major, candidate, phase, node: process.version, startedAtUtc: new Date().toISOString(), supportAccepted: false,
    schemaEngineExpected: 'intentional-major-not-3-rejection', prismaMigrationsAccepted: false,
    packages, driver: 'node-firebird@2.18.2', lockSha256: digest(lockBytes), publicCliSha256: digest(await fs.readFile(cli)),
    harnessSha256: digest(await fs.readFile(__filename)), commonFirebird3SchemaSha256: digest(schema), clientFixtureSha256: digest(fixture),
    isolation: { baseM4HookSha256: digest(originalHook), copiedHookSha256: digest(matrixHook), substitution: `3059 -> ${candidate.port}`, port: candidate.port },
    wasmBefore: beforeWasm, passed: [], commands: [], scenarioCount: 0, observations: [], generatedFiles: [],
  }
  let sequence = 0
  async function run(args, options = {}) {
    const id = `${String(++sequence).padStart(3, '0')}-${options.label}`
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(?:NODE_OPTIONS|NODE_PATH|DATABASE_URL|SHADOW_DATABASE_URL|DIRECT_URL|DEBUG|PRISMA_.*(?:ENGINE|SCHEMA|QUERY_COMPILER|PATH).*)$/i.test(key)) delete env[key]
    const inheritedPath = env.Path || env.PATH || ''
    delete env.Path
    env.PATH = [path.dirname(process.execPath), ...inheritedPath.split(path.delimiter).filter((entry) => entry && !/node_modules[\\/]\.bin/i.test(entry) && ![orm, engines].some((root) => inside(root, entry)))].join(path.delimiter)
    Object.assign(env, {
      NODE_PATH: '', NODE_OPTIONS: `--require ${JSON.stringify(hook.replaceAll('\\', '/'))}`,
      FIREBIRD_CLI_CONSUMER_ROOT: consumer, FIREBIRD_CLI_BLOCKED_ROOTS: JSON.stringify([orm, engines]),
      FIREBIRD_CLI_TRACE_ROOT: traces, FIREBIRD_CLI_COMMAND_ID: id, FIREBIRD_CLI_NETWORK: options.online ? 'online' : 'offline',
      FIREBIRD_MATRIX_MAJOR: String(major), FIREBIRD_MATRIX_STATE: state, FIREBIRD_MATRIX_ROLE: options.role || 'client',
      FIREBIRD_MATRIX_CONNECTIONS: path.join(state, 'connections.json'), FIREBIRD_MATRIX_CLIENT_MODULE: path.join(project, 'generated', 'client.ts'),
      APPDATA: path.join(state, 'appdata'), LOCALAPPDATA: path.join(state, 'localappdata'),
      CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1',
    })
    if (options.online) {
      const config = connections[options.role || 'client']
      env.DATABASE_URL = `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:${candidate.port}/${encodeURIComponent(config.database.replaceAll('\\', '/'))}`
    }
    if (options.sql) { env.FIREBIRD_MATRIX_SQL = options.sql.file; env.FIREBIRD_MATRIX_SQL_SHA256 = options.sql.sha256 }
    const stdout = [], stderr = []
    let timedOut = false, tooLarge = false, byteCount = 0, spawnError
    const started = performance.now()
    const child = spawn(process.execPath, args, { cwd: project, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 120_000)
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (bytes) => {
      byteCount += bytes.length
      if (byteCount > 16 * 1024 * 1024) { tooLarge = true; child.kill('SIGTERM') } else chunks.push(Buffer.from(bytes))
    })
    child.on('error', (error) => { spawnError = error })
    const closed = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
    clearTimeout(timeout)
    const outBytes = Buffer.concat(stdout), errBytes = Buffer.concat(stderr)
    const out = redact(outBytes.toString('utf8')), err = redact(errBytes.toString('utf8'))
    await fs.writeFile(path.join(evidence, 'commands', `${id}.stdout.txt`), out, { flag: 'wx' })
    await fs.writeFile(path.join(evidence, 'commands', `${id}.stderr.txt`), err, { flag: 'wx' })
    const events = []
    for (const name of (await fs.readdir(traces)).filter((file) => file.startsWith(`${id}-`))) {
      const text = await fs.readFile(path.join(traces, name), 'utf8')
      events.push(...text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      await fs.writeFile(path.join(evidence, 'commands', name), redact(text), { flag: 'wx' })
    }
    const ready = events.filter((event) => event.type === 'hook-ready')
    const violations = events.filter((event) => event.type === 'violation')
    const tcp = events.filter((event) => event.type === 'tcp')
    const naturalExit = events.some((event) => event.type === 'before-exit' && event.pid === child.pid)
    const record = { id, args: args.map(redact), exitCode: closed.code, signal: closed.signal, naturalExit,
      closedWithoutHarnessTermination: !timedOut && !tooLarge && !spawnError && !closed.signal,
      elapsedMs: performance.now() - started, stdoutBytes: outBytes.length, stderrBytes: errBytes.length,
      stdoutSha256: digest(outBytes), stderrSha256: digest(errBytes), redactedStdoutSha256: digest(out),
      moduleLoadCount: events.filter((event) => event.type === 'module' && event.operation === 'load').length,
      assetReadCount: events.filter((event) => event.type === 'asset').length, tcpConnectionCount: tcp.length,
      unexpectedViolations: violations.length }
    results.commands.push(record)
    assert.ok(record.closedWithoutHarnessTermination, redact(spawnError?.message || 'Child did not close normally'))
    assert.ok(ready.length > 0 && ready.every((event) => event.cwdInsideConsumer && event.nodePathEmpty && event.dangerousConsentAbsent))
    assert.equal(violations.length, 0, 'No repository fallback or forbidden network access is accepted')
    assert.ok(tcp.every((event) => event.host === '127.0.0.1' && event.port === candidate.port && event.allowed))
    if (!options.online) assert.equal(tcp.length, 0)
    assert.equal(closed.code, options.exitCode ?? 0, redact(`${out}\n${err}`))
    if (closed.code === 0) assert.ok(naturalExit, 'Successful children must drain the event loop')
    return { ...record, stdout: out, text: `${out}\n${err}` }
  }
  const cliRun = (args, options = {}) => run([cli, ...args, '--config', path.join(project, options.online ? 'online.config.ts' : 'offline.config.ts'), ...(args[0] === 'generate' ? ['--no-hints'] : [])], options)
  const fixtureRun = async (mode, options = {}) => {
    const result = await run([runner, mode], { ...options, label: options.label || mode })
    if (options.online) assert.ok(result.tcpConnectionCount > 0)
    const observation = JSON.parse(result.stdout.trim())
    results.observations.push(observation)
    return observation
  }
  async function check(name, work) {
    results.scenarioCount++
    let failure
    await t.test(name, async () => {
      try { await work(); results.passed.push(name) } catch (error) { failure = new Error(redact(error.message || error)); throw failure }
    })
    if (failure) throw failure
  }
  try {
    await check('same Firebird 3 schema validates and generates through the installed public CLI offline', async () => {
      await cliRun(['validate'], { label: 'validate-offline' })
      await cliRun(['generate'], { label: 'generate-offline' })
      await fixtureRun('offline-import')
    })
    let sql
    await check('public offline Wasm diff produces the unchanged fixture DDL without a server', async () => {
      const result = await cliRun(['migrate', 'diff', '--from-empty', '--to-schema', './schema.prisma', '--script', '--exit-code'], { label: 'diff-offline', exitCode: 2 })
      const bytes = Buffer.from(result.stdout, 'utf8')
      assert.match(result.stdout, /GENERATED BY DEFAULT AS IDENTITY/)
      sql = { file: path.join(state, 'generated-schema.sql'), sha256: digest(bytes) }
      await fs.writeFile(sql.file, bytes, { flag: 'wx' })
      await fs.writeFile(path.join(evidence, 'generated-schema.sql'), bytes, { flag: 'wx' })
      results.generatedFiles.push({ path: 'generated-schema.sql', bytes: bytes.length, sha256: sql.sha256, commandLabel: 'diff-offline', commandId: result.id, sourceSha256: result.redactedStdoutSha256 })
    })
    if (phase === 'online') {
      let clientBefore, guardBefore
      await check('actual pinned candidate transport uses required encryption and fresh isolated databases', async () => {
        clientBefore = await fixtureRun('inspect', { online: true, role: 'client', label: 'inspect-client-before' })
        guardBefore = await fixtureRun('inspect', { online: true, role: 'guard', label: 'inspect-guard-before' })
        for (const observation of [clientBefore, guardBefore]) {
          assert.equal(observation.version, candidate.version)
          assert.deepEqual(observation.catalog, { tables: [], userGenerators: [] })
        }
      })
      await check('connected public schema commands retain the intentional Firebird 3 major guard', async () => {
        for (const args of [['db', 'pull'], ['migrate', 'status'], ['db', 'push']]) {
          const result = await cliRun(args, { online: true, role: 'guard', label: `expected-guard-${args.join('-')}`, exitCode: 1 })
          assert.match(result.text, /requires Firebird 3\.x/)
          assert.match(result.text, new RegExp(`${major}\\.`))
          assert.doesNotMatch(result.text, /unknown variant|deserializ|serde_wasm_bindgen/i)
        }
        const after = await fixtureRun('inspect', { online: true, role: 'guard', label: 'inspect-guard-after' })
        assert.deepEqual(after.catalog, guardBefore.catalog)
        results.schemaEngineObserved = 'expected-major-guard-rejection-with-unchanged-application-catalog'
      })
      await check('only the public adapter provisions unmodified generated SQL as a labeled Client fixture', async () => {
        await fixtureRun('provision-generated-ddl', { online: true, role: 'client', sql })
      })
      for (const mode of ['create', 'read-update', 'transaction', 'create-many', 'delete']) {
        await check(`actual generated Client common Firebird 3 subset: ${mode}`, () => fixtureRun(mode, { online: true, role: 'client' }))
      }
      results.runtimeInputs = { archiveSha256: manifest.archiveSha256, immutableComponentHashes: manifest.immutableComponentHashes }
    }
    results.wasmAfter = await wasmProof(consumer)
    assert.deepEqual(results.wasmAfter, beforeWasm)
    results.status = phase === 'offline' ? 'offline-prepared-no-server-compatibility-claim' : 'observed-client-subset-passed-with-intentional-schema-engine-rejection'
  } catch (error) {
    results.status = 'failed-observation-not-support-acceptance'
    results.failure = redact(error.message || error)
    throw new Error(results.failure)
  } finally {
    results.completedAtUtc = new Date().toISOString()
    results.passedCount = results.passed.length
    results.nodeTestCount = results.scenarioCount + 1
    results.positiveResetExecuted = false
    results.allSuccessfulCommandsExitedNaturally = results.commands.filter((entry) => entry.exitCode === 0).every((entry) => entry.naturalExit)
    await fs.writeFile(path.join(evidence, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx' })
  }
})
