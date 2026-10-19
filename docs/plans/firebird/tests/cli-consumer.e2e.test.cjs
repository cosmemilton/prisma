/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

// Public installed-consumer acceptance only. This parent imports Node builtins;
// every CLI/Client child loads only files copied/installed inside the consumer.
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test } = require('node:test')

const roles = ['cli-main', 'cli-shadow', 'cli-replay', 'cli-pull', 'cli-reset']
const consentName = 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION'
// Version.ts embeds the CLI source manifest value, independently of the private tarball version.
const expectedCliDisplayVersion = '0.0.0'
const expectedCliVersionLine = new RegExp(`^prisma\\s*:\\s*${expectedCliDisplayVersion.replaceAll('.', '\\.')}\\s*$`, 'mi')
const fixtureNames = ['isolation-hook.cjs', 'client-runner.mjs', 'schema.prisma', 'offline.config.ts', 'online.config.ts']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const inside = (root, target) => {
  const relative = path.relative(root, path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : process.env[`FIREBIRD_CLI_${name.toUpperCase().replaceAll('-', '_')}`]
}
async function json(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw new Error(`Cannot read required JSON: ${path.basename(file)}`) }
}
async function writeJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }) }
async function canonicalDirectory(value, name) {
  assert.ok(value && path.isAbsolute(value), `${name} must be an explicit absolute directory`)
  const resolved = await fs.realpath(value)
  assert.ok((await fs.stat(resolved)).isDirectory(), `${name} is not a directory`)
  return resolved
}
async function filesBelow(root) {
  const output = []
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Consumer packages and fixtures must not contain symlinks/junctions')
      const resolved = await fs.realpath(file)
      assert.ok(inside(root, resolved), 'Installed consumer file escaped its root')
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) output.push(file)
    }
  }
  await visit(root)
  return output
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
async function installedWasmProof(consumer) {
  const files = await filesBelow(path.join(consumer, 'node_modules'))
  const output = []
  for (const file of files.filter((name) => /(?:\.wasm|wasm-base64\.[cm]?js)$/i.test(name))) {
    const bytes = await fs.readFile(file)
    const record = { path: path.relative(consumer, file), bytes: bytes.length, sha256: hash(bytes) }
    if (/\.wasm$/i.test(file)) {
      assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d', 'Installed Wasm has invalid magic')
      record.wasmBytes = bytes.length
      record.wasmSha256 = record.sha256
    } else {
      const payload = embeddedWasmPayload(bytes, file)
      record.wasmBytes = payload.length
      record.wasmSha256 = hash(payload)
    }
    output.push(record)
  }
  assert.ok(output.some((item) => /schema/i.test(item.path)), 'Missing installed schema Wasm asset proof')
  assert.ok(output.some((item) => /query.compiler|query_compiler/i.test(item.path)), 'Missing installed query-compiler Wasm asset proof')
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

test('public installed Firebird CLI and external consumer', {
  skip: process.env.RUN_FIREBIRD_CLI_CONSUMER_E2E !== '1',
  timeout: 1_500_000,
}, async (t) => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required')
  assert.ok(!Object.keys(process.env).some((name) => name.toUpperCase() === consentName), 'Refuse inherited authorization env for destructive AI actions, including empty values')
  const consumer = await canonicalDirectory(option('consumer-root'), 'consumer-root')
  const lab = await canonicalDirectory(option('lab-root'), 'lab-root')
  const orm = await canonicalDirectory(option('orm-root'), 'orm-root')
  const engines = await canonicalDirectory(option('engines-root'), 'engines-root')
  const phase = option('phase') || 'all'
  assert.ok(['offline', 'online', 'all'].includes(phase), 'phase must be offline, online or all')
  assert.ok(![orm, engines, lab].some((root) => inside(root, consumer) || inside(consumer, root)), 'Consumer must be separate from repositories and lab')
  const marker = await json(path.join(consumer, '.prisma-firebird-cli-consumer.json'))
  assert.equal(marker.root, consumer)
  assert.equal(marker.syntheticOnly, true)
  const consumerMilestone = Number(process.env.FIREBIRD_CLI_CONSUMER_MILESTONE || '4')
  assert.ok([4, 5].includes(consumerMilestone), 'Only accepted consumer milestones 4 and 5 are supported')
  assert.equal(marker.milestone, consumerMilestone)
  assert.match(marker.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const manifest = await json(path.join(lab, 'manifest.json'))
  assert.equal(manifest.root, lab)
  assert.equal((await fs.readFile(path.join(lab, '.prisma-firebird-client-lab'), 'utf8')).trim(), manifest.owner)
  assert.equal(manifest.host, '127.0.0.1')
  assert.equal(manifest.port, 3059)

  const evidenceInput = option('evidence-root')
  assert.ok(evidenceInput && path.isAbsolute(evidenceInput), 'evidence-root is required and absolute')
  const evidence = path.join(await fs.realpath(path.dirname(evidenceInput)), path.basename(evidenceInput))
  assert.ok(![consumer, lab, orm, engines].some((root) => inside(root, evidence) || inside(evidence, root)), 'Evidence root must be separate')
  assert.ok(!/(?:^|[\\/])(?:milestone-[23]|distribution|checkpoint[23])(?:[\\/]|$)/i.test(evidence), 'Do not reuse an earlier checkpoint')
  await fs.mkdir(evidence) // Existing evidence is never adopted or overwritten.
  await writeJson(path.join(evidence, 'ownership.json'), { owner: marker.owner, consumerRoot: consumer, syntheticOnly: true, milestone: consumerMilestone })
  const runId = `run-${Date.now()}-${randomUUID()}`
  const state = path.join(consumer, '.state', 'cli-consumer', runId)
  const fixtures = path.join(state, 'fixtures')
  const projects = path.join(state, 'projects')
  const traces = path.join(state, 'traces')
  await fs.mkdir(fixtures, { recursive: true })
  await fs.mkdir(projects)
  await fs.mkdir(traces)
  await fs.mkdir(path.join(state, 'appdata'))
  await fs.mkdir(path.join(state, 'localappdata'))
  await fs.mkdir(path.join(evidence, 'commands'))
  await fs.mkdir(path.join(evidence, 'generated-sql'))
  const copiedFixtures = []
  for (const name of fixtureNames) {
    const bytes = await fs.readFile(path.join(__dirname, 'cli-consumer-fixtures', name))
    const target = path.join(fixtures, name)
    await fs.writeFile(target, bytes, { flag: 'wx' })
    copiedFixtures.push({ name, bytes: bytes.length, sha256: hash(bytes) })
  }
  const cli = path.join(consumer, 'node_modules', 'prisma', 'build', 'index.js')
  assert.ok((await fs.stat(cli)).isFile(), 'Install the public prisma tarball alias before running')
  assert.ok(inside(consumer, await fs.realpath(cli)))
  const packages = []
  for (const alias of ['prisma', '@prisma/client', '@prisma/adapter-firebird']) {
    const packageFile = path.join(consumer, 'node_modules', ...alias.split('/'), 'package.json')
    assert.ok(inside(consumer, await fs.realpath(packageFile)))
    const bytes = await fs.readFile(packageFile)
    const info = JSON.parse(bytes.toString('utf8'))
    packages.push({ alias, installedName: info.name, version: info.version, manifestSha256: hash(bytes) })
  }
  const lock = await json(path.join(consumer, 'package-lock.json'))
  for (const alias of ['prisma', '@prisma/client', '@prisma/adapter-firebird']) {
    const entry = lock.packages?.[`node_modules/${alias}`]
    assert.ok(entry && !entry.link && /^file:.*\.tgz$/i.test(entry.resolved || ''), `Alias ${alias} must be installed from a private local tarball, without links`)
    packages.find((item) => item.alias === alias).integrity = entry.integrity
  }
  const wasmBefore = await installedWasmProof(consumer)
  let connections
  let secretTokens = []
  const redact = (value) => {
    let text = String(value).replace(/firebird:\/\/[^\s"'<>]+/gi, '<REDACTED_FIREBIRD_URL>')
    for (const token of secretTokens) text = text.replaceAll(token, '<REDACTED>')
    return text
  }
  if (phase !== 'offline') {
    connections = await json(path.join(lab, 'private', 'cli-connections.json'))
    secretTokens = roles.flatMap((role) => {
      const config = connections[role] || {}
      return [config.password, config.user, config.database, config.database?.replaceAll('\\', '/'),
        config.password && encodeURIComponent(config.password), config.user && encodeURIComponent(config.user),
        config.database && encodeURIComponent(config.database), config.database && encodeURIComponent(config.database.replaceAll('\\', '/'))]
    }).filter(Boolean).sort((a, b) => b.length - a.length)
    const identities = new Set()
    for (const role of roles) {
      const config = connections[role]
      assert.ok(config && typeof config.user === 'string' && typeof config.password === 'string', 'Incomplete private CLI fixture')
      assert.equal(config.host, '127.0.0.1')
      assert.equal(config.port, 3059)
      const expected = path.join(lab, 'db', `${role}.fdb`)
      assert.equal(path.resolve(config.database), expected, 'Only the five newly reserved database files are allowed')
      const canonical = await fs.realpath(expected)
      assert.ok(inside(path.join(lab, 'db'), canonical))
      const stat = await fs.stat(expected, { bigint: true })
      assert.ok(stat.isFile() && stat.ino > 0n && stat.dev > 0n)
      identities.add(`${stat.dev}:${stat.ino}`)
    }
    assert.equal(identities.size, roles.length, 'Disposable database roles must be distinct files')
    await fs.mkdir(path.join(state, 'private'))
    await fs.writeFile(path.join(state, 'private', 'connections.json'), JSON.stringify(connections), { flag: 'wx', mode: 0o600 })
  }
  const privateConnections = path.join(state, 'private', 'connections.json')
  const urlFor = (role) => {
    const config = connections[role]
    return `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:3059/${encodeURIComponent(config.database.replaceAll('\\', '/'))}`
  }
  const baseEnvironment = () => {
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (/^(?:NODE_OPTIONS|NODE_PATH|DATABASE_URL|SHADOW_DATABASE_URL|DIRECT_URL|DEBUG|PRISMA_.*(?:ENGINE|SCHEMA|QUERY_COMPILER|PATH).*|npm_(?:execpath|node_execpath|config_prefix)|PNPM_HOME)$/i.test(name)) delete env[name]
    }
    assert.ok(!Object.keys(env).some((name) => name.toUpperCase() === consentName))
    const inheritedPath = env.Path || env.PATH || ''
    delete env.Path
    const allowedPath = inheritedPath.split(path.delimiter).filter((part) => part && !/node_modules[\\/]\.bin/i.test(part) && ![orm, engines].some((root) => inside(root, part)))
    env.PATH = [path.dirname(process.execPath), ...allowedPath].join(path.delimiter)
    env.NODE_PATH = ''
    env.NODE_OPTIONS = `--require ${JSON.stringify(path.join(fixtures, 'isolation-hook.cjs').replaceAll('\\', '/'))}`
    env.FIREBIRD_CLI_CONSUMER_ROOT = consumer
    env.FIREBIRD_CLI_BLOCKED_ROOTS = JSON.stringify([orm, engines])
    env.FIREBIRD_CLI_TRACE_ROOT = traces
    env.FIREBIRD_CLI_PRIVATE_CONNECTIONS = privateConnections
    env.APPDATA = path.join(state, 'appdata')
    env.LOCALAPPDATA = path.join(state, 'localappdata')
    env.CHECKPOINT_DISABLE = '1'
    env.PRISMA_HIDE_UPDATE_MESSAGE = '1'
    env.PRISMA_HIDE_PREVIEW_FLAG_WARNINGS = '1'
    env.PRISMA_SKIP_POSTINSTALL_GENERATE = '1'
    env.PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = '0'
    env.NO_COLOR = '1'
    env.FORCE_COLOR = '0'
    env.CI = '1'
    env.TERM = 'dumb'
    return env
  }
  const results = {
    schemaVersion: 1, status: 'running', owner: marker.owner, consumerRoot: consumer, milestone: consumerMilestone,
    classification: 'PUBLIC_INSTALLED_CLI_AND_EXTERNAL_CONSUMER', phase, node: process.version,
      startedAtUtc: new Date().toISOString(), packages, expectedCliDisplayVersion, fixtureHashes: copiedFixtures, wasmBefore,
    publicEntry: 'node_modules/prisma/build/index.js', roles: phase === 'offline' ? [] : roles,
    harnessSha256: hash(await fs.readFile(__filename)),
    agentMarkersPreserved: true, destructiveConsentPresent: false, positiveResetExecuted: false,
    scenarioCount: 0, passed: [], skipped: [], commands: [], moduleNetworkProofs: [], generatedFiles: [],
  }
  let sequence = 0
  async function run(args, options = {}) {
    const id = `${String(++sequence).padStart(3, '0')}-${options.label || 'command'}`
    const cwd = options.project || consumer
    assert.ok(inside(consumer, cwd))
    assert.ok(!args.some((arg) => ['--force', '--accept-data-loss', '--force-reset'].includes(arg)), 'Data-loss flags are forbidden in this harness')
    const env = baseEnvironment()
    env.FIREBIRD_CLI_COMMAND_ID = id
    env.FIREBIRD_CLI_NETWORK = options.online ? 'online' : 'offline'
    if (options.role) {
      env.FIREBIRD_CLI_ROLE = options.role
      env.FIREBIRD_CLI_PROJECT = cwd
      env.FIREBIRD_CLI_CLIENT_MODULE = path.join(cwd, 'generated', 'client.ts')
    }
    if (options.online) {
      env.DATABASE_URL = `${urlFor(options.role)}?shadowDatabaseFileSystem=local`
      env.SHADOW_DATABASE_URL = urlFor('cli-shadow')
    }
    if (options.clientModule) env.FIREBIRD_CLI_CLIENT_MODULE = options.clientModule
    const executable = options.executable || process.execPath
    const started = performance.now()
    const stdout = [], stderr = []
    let bytes = 0, timedOut = false, oversized = false, spawnError
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: options.verbatim || false })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, options.timeout || 120_000)
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) { oversized = true; child.kill('SIGTERM') }
      else chunks.push(Buffer.from(chunk))
    })
    child.on('error', (error) => { spawnError = error })
    const closed = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
    clearTimeout(timer)
    const rawOut = Buffer.concat(stdout), rawErr = Buffer.concat(stderr)
    const out = redact(rawOut.toString('utf8')), err = redact(rawErr.toString('utf8'))
    await fs.writeFile(path.join(evidence, 'commands', `${id}.stdout.txt`), out, { flag: 'wx' })
    await fs.writeFile(path.join(evidence, 'commands', `${id}.stderr.txt`), err, { flag: 'wx' })
    const traceFiles = (await fs.readdir(traces)).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.jsonl'))
    const entries = []
    for (const name of traceFiles) {
      const text = await fs.readFile(path.join(traces, name), 'utf8')
      entries.push(...text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      await fs.writeFile(path.join(evidence, 'commands', name), redact(text), { flag: 'wx' })
    }
    const violations = entries.filter((entry) => entry.type === 'violation')
    const ready = entries.filter((entry) => entry.type === 'hook-ready')
    const primary = ready.find((entry) => entry.pid === child.pid) || ready[0] // .cmd starts its own Node child.
    const drained = entries.some((entry) => entry.type === 'before-exit' && entry.pid === primary?.pid)
    const closedWithoutHarnessTermination = !timedOut && !oversized && !spawnError && closed.signal === null
    const proof = {
      id, traces: traceFiles.length, hooks: ready.length,
      modules: entries.filter((entry) => entry.type === 'module').length,
      loadedModules: [...new Set(entries.filter((entry) => entry.type === 'module' && entry.operation === 'load').map((entry) => entry.path))].sort(),
      assets: entries.filter((entry) => entry.type === 'asset').length,
      tcp: entries.filter((entry) => entry.type === 'tcp').map(({ host, port, allowed }) => ({ host, port, allowed })),
      violations: violations.map(({ kind, blocked }) => ({ kind, blocked })), intentionalNegativeProbe: options.probe || false,
      lifecycle: entries.filter((entry) => ['before-exit', 'process-exit'].includes(entry.type)).map(({ type, pid, code }) => ({ type, pid, code })),
    }
    const record = {
      id, executable: redact(executable), args: args.map(redact), exitCode: closed.code, signal: closed.signal,
      elapsedMs: performance.now() - started, closedWithoutHarnessTermination,
      naturalExit: closedWithoutHarnessTermination && drained,
      exitMode: drained ? 'event-loop-drained' : 'cli-exit-without-beforeExit',
      stdoutBytes: rawOut.length, stderrBytes: rawErr.length, stdoutSha256: hash(rawOut), stderrSha256: hash(rawErr),
      redactedStdoutSha256: hash(out), redactedStderrSha256: hash(err),
    }
    results.commands.push(record)
    results.moduleNetworkProofs.push(proof)
    assert.ok(closedWithoutHarnessTermination, redact(`Child was terminated or failed to spawn: ${id}: ${spawnError?.message || closed.signal || 'timeout/output limit'}`))
    assert.ok(ready.length > 0, `Missing isolation hook proof for ${id}`)
    assert.ok(ready.every((entry) => entry.cwdInsideConsumer && entry.nodePathEmpty && entry.dangerousConsentAbsent))
    if (!options.online) assert.ok(ready.every((entry) => entry.databaseUrlAbsent), 'Offline subprocess inherited a database URL')
    assert.ok(proof.tcp.every((entry) => entry.allowed && entry.host === '127.0.0.1' && entry.port === 3059))
    if (!options.online) assert.equal(proof.tcp.length, 0, 'Offline command attempted TCP')
    if (options.probe) assert.ok(violations.length >= 12 && violations.every((entry) => entry.blocked))
    else assert.equal(violations.length, 0, `Unexpected isolation violation in ${id}: ${redact(JSON.stringify(proof.violations))}`)
    const expected = options.expected || [0]
    assert.ok(expected.includes(closed.code), redact(`Unexpected exit ${closed.code} for ${id}\n${out}\n${err}`))
    if (closed.code === 0) assert.ok(record.naturalExit, `Successful command must drain its event loop: ${id}`)
    return { ...record, stdout: out, stderr: err, text: `${out}\n${err}`, proof }
  }
  async function cliRun(args, options = {}) {
    const command = [...args]
    if (options.config !== false) command.push('--config', path.join(options.project, 'prisma.config.ts'))
    if (args[0] === 'generate') command.push('--no-hints')
    return run([cli, ...command], options)
  }
  async function clientRun(mode, project, role, label = mode) {
    const result = await run([path.join(fixtures, 'client-runner.mjs'), mode], { label, project, role, online: true })
    assert.ok(result.proof.tcp.length > 0, 'Client fixture needs a traced real laboratory TCP connection')
    assert.ok(result.proof.loadedModules.some((file) => /generated[\\/]client\.ts$/.test(file)), 'Missing generated TypeScript module load proof')
    assert.ok(result.proof.loadedModules.some((file) => /node_modules[\\/]@prisma[\\/]adapter-firebird[\\/]/.test(file)), 'Missing installed adapter module load proof')
    return result
  }
  async function project(name, schema, online) {
    const root = path.join(projects, name)
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' })
    await fs.writeFile(path.join(root, 'schema.prisma'), schema, { flag: 'wx' })
    await fs.copyFile(path.join(fixtures, online ? 'online.config.ts' : 'offline.config.ts'), path.join(root, 'prisma.config.ts'), fs.constants.COPYFILE_EXCL)
    return root
  }
  async function migrations(root) {
    const directory = path.join(root, 'migrations')
    const names = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    return Promise.all(names.map(async (name) => {
      const file = path.join(directory, name, 'migration.sql'), bytes = await fs.readFile(file)
      return { name, file, bytes: bytes.length, sha256: hash(bytes) }
    }))
  }
  async function copyMigrations(source, target, selected) {
    await fs.mkdir(path.join(target, 'migrations'))
    await fs.copyFile(path.join(source, 'migrations', 'migration_lock.toml'), path.join(target, 'migrations', 'migration_lock.toml'))
    for (const migration of selected) {
      const directory = path.join(target, 'migrations', migration.name)
      await fs.mkdir(directory)
      await fs.copyFile(migration.file, path.join(directory, 'migration.sql'))
    }
  }
  async function check(name, work) {
    results.scenarioCount++
    let failure
    await t.test(name, async (context) => {
      try {
        const value = await work(context)
        if (value?.skipped) results.skipped.push({ name, reason: value.reason })
        else results.passed.push(name)
      } catch (error) {
        failure = new Error(redact(error instanceof Error ? error.message : String(error)))
        throw failure
      }
    })
    if (failure) throw failure
  }

  try {
    const schemaV1 = await fs.readFile(path.join(fixtures, 'schema.prisma'), 'utf8')
    const schemaV2 = schemaV1.replace('  active  Boolean   @default(true)', '  active  Boolean   @default(true)\n  note    String?   @db.VarChar(120)')
    assert.notEqual(schemaV1, schemaV2)
    const schemaV3 = schemaV2.replace('@db.VarChar(40)', '@db.VarChar(80)')
    assert.notEqual(schemaV2, schemaV3)
    if (phase !== 'online') {
      const offline = await project('offline', schemaV1, false)
      await check('isolation rejects repository imports/assets and forbidden network APIs', async () => {
        await run([path.join(fixtures, 'client-runner.mjs'), 'isolation-probe'], { project: offline, label: 'isolation-probe', probe: true })
      })
      await check('public installed CLI version exits naturally without a database URL', async () => {
        const result = await cliRun(['--version'], { project: offline, label: 'version', config: false })
        assert.match(result.text, expectedCliVersionLine)
      })
      await check('public installed CLI help exits naturally offline', async () => {
        assert.match((await cliRun(['--help'], { project: offline, label: 'help', config: false })).text, /migrate|generate|validate/i)
      })
      await check('Windows installed prisma.cmd shim reaches the public CLI', async (context) => {
        if (process.platform !== 'win32') { context.skip('Windows .cmd smoke'); return { skipped: true, reason: 'Windows .cmd smoke' } }
        const shim = path.join(consumer, 'node_modules', '.bin', 'prisma.cmd')
        assert.ok((await fs.stat(shim)).isFile())
        assert.doesNotMatch(shim, /["\r\n%&|<>^!]/)
        const executable = process.env.ComSpec || path.join(process.env.SystemRoot, 'System32', 'cmd.exe')
        const result = await run(['/d', '/s', '/c', `""${shim}" --version"`], { project: offline, label: 'cmd-shim', executable, verbatim: true })
        assert.match(result.text, expectedCliVersionLine)
      })
      await check('Firebird init uses the public advertised provider when implemented', async (context) => {
        const help = await cliRun(['init', '--help'], { project: offline, label: 'init-help', config: false })
        if (!/firebird/i.test(help.text) && process.env.FIREBIRD_CLI_EXPECT_INIT !== '1') {
          context.skip('Public init help does not advertise Firebird')
          return { skipped: true, reason: 'Public init help does not advertise Firebird' }
        }
        const init = path.join(projects, 'init')
        await fs.mkdir(init)
        await cliRun(['init', '--datasource-provider', 'firebird', '--output', './generated'], { project: init, label: 'init', config: false })
        assert.match(await fs.readFile(path.join(init, 'prisma', 'schema.prisma'), 'utf8'), /provider\s*=\s*"firebird"/)
      })
      await check('public format and validate accept Firebird without a database URL', async () => {
        await cliRun(['format'], { project: offline, label: 'format' })
        const once = await fs.readFile(path.join(offline, 'schema.prisma'))
        await cliRun(['format'], { project: offline, label: 'format-repeat' })
        assert.deepEqual(await fs.readFile(path.join(offline, 'schema.prisma')), once)
        assert.match((await cliRun(['validate'], { project: offline, label: 'validate' })).text, /valid/i)
      })
      await check('public validate and format return schema diagnostics for invalid Firebird PSL', async () => {
        await fs.writeFile(path.join(offline, 'invalid.prisma'), `${schemaV1}\nmodel Invalid {\n id Int @id\n broken MissingType\n}\n`)
        for (const command of ['validate', 'format']) {
          const result = await cliRun([command, '--schema', './invalid.prisma'], { project: offline, label: `${command}-invalid`, expected: [1] })
          assert.match(result.text, /P1012|MissingType|not.*(?:type|model)|not found/i)
        }
      })
      await check('public generate creates importable ESM TypeScript Client offline', async () => {
        await cliRun(['generate'], { project: offline, label: 'generate-offline' })
        const clientModule = path.join(offline, 'generated', 'client.ts')
        assert.ok((await fs.stat(clientModule)).isFile())
        await run([path.join(fixtures, 'client-runner.mjs'), 'offline-import'], { project: offline, label: 'import-generated-ts', clientModule })
      })
      await check('public migrate diff renders Firebird DDL using real Wasm offline', async () => {
        const result = await cliRun(['migrate', 'diff', '--from-empty', '--to-schema', './schema.prisma', '--script', '--exit-code'], { project: offline, label: 'diff-offline', expected: [2] })
        assert.match(result.stdout, /CREATE TABLE "CliUser"/)
        assert.match(result.stdout, /GENERATED BY DEFAULT AS IDENTITY/)
        assert.doesNotMatch(result.stdout, /SERIAL|AUTO_INCREMENT|\$[1-9]/)
        const bytes = Buffer.from(result.stdout, 'utf8')
        await fs.writeFile(path.join(evidence, 'generated-sql', 'offline-diff.sql'), bytes, { flag: 'wx' })
        results.generatedFiles.push({ path: 'generated-sql/offline-diff.sql', bytes: bytes.length, sha256: hash(bytes), commandLabel: 'diff-offline', commandId: result.id, source: `commands/${result.id}.stdout.txt`, sourceSha256: result.redactedStdoutSha256 })
      })
    }
    if (phase !== 'offline') {
      const main = await project('main', schemaV1, true)
      let generated
      await check('public migrate dev generates and applies the initial Firebird migration', async () => {
        await cliRun(['migrate', 'dev', '--name', 'initial'], { project: main, role: 'cli-main', online: true, label: 'dev-initial' })
        generated = await migrations(main)
        assert.equal(generated.length, 1)
        assert.match(await fs.readFile(generated[0].file, 'utf8'), /GENERATED BY DEFAULT AS IDENTITY/)
        await cliRun(['generate'], { project: main, role: 'cli-main', online: true, label: 'generate-main' })
      })
      await check('installed generated Client seeds exact scalars and nested identity rows', () => clientRun('seed', main, 'cli-main'))
      await check('public migrate dev adds an optional column and preserves data', async () => {
        await fs.writeFile(path.join(main, 'schema.prisma'), schemaV2)
        await cliRun(['migrate', 'dev', '--name', 'add_note'], { project: main, role: 'cli-main', online: true, label: 'dev-add-note' })
        assert.equal((await migrations(main)).length, 2)
        await cliRun(['generate'], { project: main, role: 'cli-main', online: true, label: 'generate-note' })
        await clientRun('assert-preserved', main, 'cli-main', 'preserved-after-note')
      })
      await check('public migrate dev widens an unindexed VARCHAR and preserves data', async () => {
        await fs.writeFile(path.join(main, 'schema.prisma'), schemaV3)
        await cliRun(['migrate', 'dev', '--name', 'widen_name'], { project: main, role: 'cli-main', online: true, label: 'dev-widen' })
        generated = await migrations(main)
        assert.equal(generated.length, 3)
        assert.match(await fs.readFile(generated[2].file, 'utf8'), /ALTER.*TYPE VARCHAR\(80\)/s)
        await cliRun(['generate'], { project: main, role: 'cli-main', online: true, label: 'generate-widened' })
        await clientRun('assert-preserved', main, 'cli-main', 'preserved-after-widen')
      })
      await check('public migrate status and repeated dev report no pending changes', async () => {
        assert.match((await cliRun(['migrate', 'status'], { project: main, role: 'cli-main', online: true, label: 'status-main' })).text, /up to date|in sync/i)
        await cliRun(['migrate', 'dev', '--name', 'no_change'], { project: main, role: 'cli-main', online: true, label: 'dev-noop' })
        assert.equal((await migrations(main)).length, 3)
      })
      await check('public db push is a safe no-op after migration convergence', async () => {
        assert.match((await cliRun(['db', 'push'], { project: main, role: 'cli-main', online: true, label: 'push-noop' })).text, /already in sync|no changes|in sync/i)
        await clientRun('assert-preserved', main, 'cli-main', 'preserved-after-push')
      })
      await check('public db seed invokes the configured consumer Node script', async () => {
        assert.match((await cliRun(['db', 'seed'], { project: main, role: 'cli-main', online: true, label: 'db-seed' })).text, /configuredPublicSeedRan/)
      })
      const replay = await project('replay', schemaV3, true)
      await copyMigrations(main, replay, generated)
      await check('public migrate deploy replays the actual generated migrations into cli-replay', async () => {
        await cliRun(['migrate', 'deploy'], { project: replay, role: 'cli-replay', online: true, label: 'deploy-replay' })
        await cliRun(['migrate', 'deploy'], { project: replay, role: 'cli-replay', online: true, label: 'deploy-replay-noop' })
        await cliRun(['generate'], { project: replay, role: 'cli-replay', online: true, label: 'generate-replay' })
        await clientRun('empty', replay, 'cli-replay')
      })
      await check('public database-to-schema diff converges with exit code zero', async () => {
        const result = await cliRun(['migrate', 'diff', '--from-config-datasource', '--to-schema', './schema.prisma', '--script', '--exit-code'], { project: replay, role: 'cli-replay', online: true, label: 'diff-converged' })
        assert.doesNotMatch(result.stdout, /CREATE TABLE|ALTER TABLE|DROP TABLE/)
      })
      const pull = await project('pull', schemaV1, true)
      await copyMigrations(main, pull, generated.slice(0, 1))
      await check('public db execute plus migrate resolve records a generated baseline on cli-pull', async () => {
        const initial = path.join(pull, 'migrations', generated[0].name, 'migration.sql')
        await cliRun(['db', 'execute', '--file', initial], { project: pull, role: 'cli-pull', online: true, label: 'execute-generated-baseline' })
        await cliRun(['migrate', 'resolve', '--applied', generated[0].name], { project: pull, role: 'cli-pull', online: true, label: 'resolve-baseline' })
        assert.match((await cliRun(['migrate', 'status'], { project: pull, role: 'cli-pull', online: true, label: 'status-baseline' })).text, /up to date|in sync/i)
      })
      await check('public db pull writes real catalog PSL then public generate builds its Client', async () => {
        const pullResult = await cliRun(['db', 'pull'], { project: pull, role: 'cli-pull', online: true, label: 'db-pull' })
        const introspectedBytes = await fs.readFile(path.join(pull, 'schema.prisma'))
        const introspected = introspectedBytes.toString('utf8')
        assert.match(introspected, /model CliUser/)
        assert.match(introspected, /autoincrement\(\)/)
        assert.match(introspected, /Decimal\(18, 4\)/)
        await cliRun(['validate'], { project: pull, role: 'cli-pull', online: true, label: 'validate-pulled' })
        await cliRun(['generate'], { project: pull, role: 'cli-pull', online: true, label: 'generate-pulled' })
        await fs.writeFile(path.join(evidence, 'introspected.prisma'), introspectedBytes, { flag: 'wx' })
        results.generatedFiles.push({ path: 'introspected.prisma', bytes: introspectedBytes.length, sha256: hash(introspectedBytes), commandLabel: 'db-pull', commandId: pullResult.id, source: path.relative(consumer, path.join(pull, 'schema.prisma')), sourceSha256: hash(introspectedBytes) })
      })
      await check('pulled installed Client performs CRUD, exact types, nested writes and rollback', () => clientRun('crud', pull, 'cli-pull'))
      await check('main installed Client performs CRUD and retains its earlier migration seed', async () => {
        await clientRun('crud', main, 'cli-main', 'crud-main')
        await clientRun('assert-preserved', main, 'cli-main', 'preserved-after-crud')
      })
      const reset = await project('reset-negative', schemaV3, true)
      await copyMigrations(main, reset, generated)
      await check('negative-reset fixture is installed only by public migrate deploy', async () => {
        await cliRun(['migrate', 'deploy'], { project: reset, role: 'cli-reset', online: true, label: 'deploy-reset-fixture' })
        await cliRun(['generate'], { project: reset, role: 'cli-reset', online: true, label: 'generate-reset-fixture' })
        await clientRun('seed', reset, 'cli-reset', 'seed-reset-fixture')
      })
      await check('public migrate reset refuses without authorization and preserves its seed', async () => {
        const result = await cliRun(['migrate', 'reset'], { project: reset, role: 'cli-reset', online: true, label: 'reset-negative', expected: [1] })
        assert.match(result.text, /non.interactive|not interactive|invoked by|forbidden|explicit consent/i)
        results.resetRefusalStage = /non.interactive|not interactive/i.test(result.text) ? 'noninteractive-before-agent-checkpoint' : 'agent-checkpoint'
        await clientRun('assert-reset-preserved', reset, 'cli-reset')
      })
      results.generatedMigrations = generated.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
      for (const migration of generated) await fs.copyFile(migration.file, path.join(evidence, 'generated-sql', `${migration.name}.sql`))
    }
    results.wasmAfter = await installedWasmProof(consumer)
    assert.deepEqual(results.wasmAfter, wasmBefore, 'Installed engine inputs changed during the run')
    results.status = 'passed'
  } catch (error) {
    results.status = 'failed'
    results.failure = redact(error instanceof Error ? error.message : String(error))
    throw new Error(results.failure)
  } finally {
    results.completedAtUtc = new Date().toISOString()
    results.passedCount = results.passed.length
    results.skippedCount = results.skipped.length
    results.nodeTestCount = results.scenarioCount + 1
    results.allSuccessfulCommandsExitedNaturally = results.commands.filter((command) => command.exitCode === 0).every((command) => command.naturalExit)
    results.allCommandsClosedWithoutHarnessTermination = results.commands.every((command) => command.closedWithoutHarnessTermination)
    results.expectedNonzeroCLIExits = results.commands.filter((command) => command.exitCode !== 0).map(({ id, exitCode, exitMode }) => ({ id, exitCode, exitMode }))
    results.unexpectedIsolationViolations = results.moduleNetworkProofs.filter((proof) => !proof.intentionalNegativeProbe).reduce((sum, proof) => sum + proof.violations.length, 0)
    await fs.writeFile(path.join(evidence, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx' })
  }
})
