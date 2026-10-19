/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

// Public installed CLI only. The root agent provisions/stops the dedicated server.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { test } = require('node:test')
const task = path.resolve(__dirname, '../../../../..')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const relative = (file) => path.relative(task, file).replaceAll('\\', '/')
const inside = (root, file) => {
  const value = path.relative(root, path.resolve(file))
  return value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value))
}
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const consentName = 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION'

test(
  'public installed Firebird Client updates primary keys on a dedicated fresh database',
  {
    skip: process.env.RUN_FIREBIRD_ID_UPDATE_CONSUMER_E2E !== '1',
    timeout: 600_000,
  },
  async (t) => {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 24)
    assert.ok(
      !Object.keys(process.env).some((name) => name.toUpperCase() === consentName),
      'No inherited destructive authorization accepted',
    )
    const consumerInput = path.join(task, 'firebird-cli-consumer-m6')
    const consumer = await fs.realpath(consumerInput)
    assert.equal(
      process.platform === 'win32' ? consumer.toLowerCase() : consumer,
      process.platform === 'win32' ? consumerInput.toLowerCase() : consumerInput,
      'Reserved M6 consumer must not redirect through an alias/junction',
    )
    const consumerMilestone = 6
    const lab = await fs.realpath(path.join(task, 'firebird-client-lab'))
    const orm = await fs.realpath(path.join(task, 'prisma-firebird'))
    const engines = await fs.realpath(path.join(task, 'prisma-engines-firebird'))
    assert.ok(![lab, orm, engines].some((root) => inside(root, consumer) || inside(consumer, root)))
    const marker = await json(path.join(consumer, '.prisma-firebird-cli-consumer.json'))
    assert.equal(marker.root, consumer)
    assert.equal(marker.milestone, consumerMilestone)
    assert.equal(marker.syntheticOnly, true)
    const manifest = await json(path.join(lab, 'manifest.json'))
    assert.equal(manifest.root, lab)
    assert.equal((await fs.readFile(path.join(lab, '.prisma-firebird-client-lab'), 'utf8')).trim(), manifest.owner)
    const role = 'id-updates'
    const reservationName = 'id-updates-database.json'
    const reservation = await json(path.join(lab, reservationName))
    const database = path.join(lab, 'db', `${role}.fdb`)
    assert.equal(reservation.owner, manifest.owner)
    assert.equal(reservation.milestone, 6)
    assert.equal(reservation.syntheticOnly, true)
    assert.equal(reservation.freshDatabaseCreated, true)
    assert.equal(reservation.database, database)
    assert.equal(reservation.role, role)
    const canonicalDatabase = await fs.realpath(database)
    assert.equal(
      process.platform === 'win32' ? canonicalDatabase.toLowerCase() : canonicalDatabase,
      process.platform === 'win32' ? database.toLowerCase() : database,
      'No database alias/junction accepted',
    )
    const privateBytes = await fs.readFile(path.join(lab, 'private', `${role}-connection.json`))
    const connections = JSON.parse(privateBytes)
    assert.deepEqual(Object.keys(connections), [role])
    const config = connections[role]
    assert.equal(config.database, database)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 3059)
    assert.ok(config.user && config.password)
    const secrets = [config.password, config.user, database, database.replaceAll('\\', '/')]
      .flatMap((value) => [value, encodeURIComponent(value)])
      .sort((a, b) => b.length - a.length)
    const redact = (value) => {
      let text = String(value).replace(/firebird:\/\/[^\s"'<>]+/gi, '<REDACTED_FIREBIRD_URL>')
      for (const secret of secrets) text = text.replaceAll(secret, '<REDACTED>')
      return text
    }
    const installationRoot = path.join(task, 'artifacts/milestone-6')
    const installPath = path.resolve(
      process.env.FIREBIRD_ID_UPDATE_INSTALLATION_PROOF ||
        path.join(installationRoot, 'pack-install-attempt-1/installation.json'),
    )
    assert.ok(
      inside(installationRoot, installPath) && path.basename(installPath) === 'installation.json',
      'Installation proof must belong to the selected consumer milestone',
    )
    const installBytes = await fs.readFile(installPath)
    const installation = JSON.parse(installBytes)
    assert.equal(installation.passed, true)
    assert.equal(installation.milestone, 6)
    assert.equal(installation.consumer, relative(consumer))
    assert.equal(installation.owner, marker.owner)
    assert.equal(installation.updateNotifierDisabled, true)
    assert.equal(installation.npmNodeNetworkAPIsBlocked, true)
    const selectedInputs = installation.installedFiles.filter(
      (item) =>
        /node_modules\/(?:prisma|@prisma\/(?:client|adapter-firebird))\/package\.json$/.test(item.path) ||
        /node_modules\/prisma\/build\/(?:index\.js|cli\.js|schema_engine_bg\.wasm|prisma_schema_build_bg\.wasm|query_compiler_.*\.firebird\..*)$/.test(
          item.path,
        ) ||
        /node_modules\/@prisma\/client\/runtime\/(?:client\.[cm]?js|query_compiler_.*\.firebird\..*)$/.test(
          item.path,
        ) ||
        /node_modules\/@prisma\/adapter-firebird\/dist\/index\.[cm]?js$/.test(item.path),
    )
    assert.ok(selectedInputs.length >= 15, 'Missing immutable installed input proof')
    async function verifyInputs() {
      const observed = []
      for (const expected of selectedInputs) {
        const file = path.resolve(task, expected.path)
        assert.ok(inside(consumer, file) && inside(consumer, await fs.realpath(file)))
        const bytes = await fs.readFile(file)
        assert.equal(bytes.length, expected.bytes)
        assert.equal(hash(bytes), expected.sha256)
        observed.push({ path: expected.path, bytes: bytes.length, sha256: hash(bytes) })
      }
      return observed
    }
    const inputsBefore = await verifyInputs()
    const evidence = path.resolve(
      process.env.FIREBIRD_ID_UPDATE_EVIDENCE || path.join(task, 'artifacts/milestone-6/id-update-attempt-1'),
    )
    assert.ok(
      inside(path.join(task, 'artifacts/milestone-6'), evidence) &&
        evidence !== path.join(task, 'artifacts/milestone-6'),
    )
    await fs.mkdir(path.dirname(evidence), { recursive: true })
    await fs.mkdir(evidence)
    await fs.mkdir(path.join(evidence, 'commands'))
    const state = path.join(consumer, '.state', 'id-updates', `run-${Date.now()}-${randomUUID()}`)
    const fixtures = path.join(state, 'fixtures'),
      project = path.join(state, 'project'),
      traces = path.join(state, 'traces')
    for (const directory of [
      fixtures,
      project,
      traces,
      path.join(state, 'private'),
      path.join(state, 'appdata'),
      path.join(state, 'localappdata'),
    ])
      await fs.mkdir(directory, { recursive: true })
    const fixtureProof = []
    for (const [root, names] of [
      [path.join(__dirname, 'cli-consumer-fixtures'), ['isolation-hook.cjs']],
      [
        path.join(__dirname, 'id-update-fixtures'),
        ['client-runner.mjs', 'schema.prisma', 'prisma.config.ts', 'offline.config.ts'],
      ],
    ])
      for (const name of names) {
        const bytes = await fs.readFile(path.join(root, name))
        await fs.writeFile(path.join(fixtures, name), bytes, { flag: 'wx' })
        fixtureProof.push({ name, bytes: bytes.length, sha256: hash(bytes) })
      }
    const privatePath = path.join(state, 'private/connections.json')
    await fs.writeFile(privatePath, privateBytes, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(project, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' })
    await fs.copyFile(
      path.join(fixtures, 'prisma.config.ts'),
      path.join(project, 'prisma.config.ts'),
      fs.constants.COPYFILE_EXCL,
    )
    await fs.copyFile(
      path.join(fixtures, 'offline.config.ts'),
      path.join(project, 'offline.config.ts'),
      fs.constants.COPYFILE_EXCL,
    )
    const schemaPath = path.join(project, 'schema.prisma')
    await fs.copyFile(path.join(fixtures, 'schema.prisma'), schemaPath, fs.constants.COPYFILE_EXCL)
    const results = {
      schemaVersion: 1,
      milestone: 6,
      classification: 'PUBLIC_INSTALLED_CLIENT_UPDATEABLE_ID',
      status: 'running',
      startedAtUtc: new Date().toISOString(),
      owner: marker.owner,
      role,
      consumerRoot: consumer,
      consumerMilestone,
      installation: { path: relative(installPath), sha256: hash(installBytes) },
      inputsBefore,
      fixtureProof,
      harnessSha256: hash(await fs.readFile(__filename)),
      scenarioCount: 0,
      passed: [],
      commands: [],
      noRebuildOrInstall: true,
      dangerousConsentPresent: false,
      destructiveFlagsPassed: false,
      positiveResetExecuted: false,
    }
    let sequence = 0
    async function run(args, label, expected = 0, requireTcp = true, online = true) {
      assert.ok(!args.some((value) => ['--force', '--force-reset', '--accept-data-loss'].includes(value)))
      const id = `${String(++sequence).padStart(3, '0')}-${label}`
      const env = { ...process.env }
      for (const name of Object.keys(env))
        if (
          /^(?:NODE_OPTIONS|NODE_PATH|DATABASE_URL|SHADOW_DATABASE_URL|DIRECT_URL|DEBUG|PRISMA_.*(?:ENGINE|SCHEMA|QUERY_COMPILER|PATH).*|npm_(?:execpath|node_execpath|config_prefix)|PNPM_HOME)$/i.test(
            name,
          )
        )
          delete env[name]
      const inheritedPath = env.Path || env.PATH || ''
      delete env.Path
      env.PATH = [
        path.dirname(process.execPath),
        ...inheritedPath
          .split(path.delimiter)
          .filter(
            (part) =>
              part && !/node_modules[\\/]\.bin/i.test(part) && ![orm, engines].some((root) => inside(root, part)),
          ),
      ].join(path.delimiter)
      Object.assign(env, {
        NODE_PATH: '',
        NODE_OPTIONS: '--require ' + JSON.stringify(path.join(fixtures, 'isolation-hook.cjs').replaceAll('\\', '/')),
        FIREBIRD_CLI_CONSUMER_ROOT: consumer,
        FIREBIRD_CLI_BLOCKED_ROOTS: JSON.stringify([orm, engines]),
        FIREBIRD_CLI_TRACE_ROOT: traces,
        FIREBIRD_CLI_COMMAND_ID: id,
        FIREBIRD_CLI_NETWORK: online ? 'online' : 'offline',
        FIREBIRD_CLI_PRIVATE_CONNECTIONS: privatePath,
        FIREBIRD_CLI_ROLE: role,
        FIREBIRD_CLI_PROJECT: project,
        FIREBIRD_CLI_CLIENT_MODULE: path.join(project, 'generated/client.ts'),
        DATABASE_URL: `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:3059/${encodeURIComponent(database.replaceAll('\\', '/'))}`,
        APPDATA: path.join(state, 'appdata'),
        LOCALAPPDATA: path.join(state, 'localappdata'),
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        PRISMA_SKIP_POSTINSTALL_GENERATE: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CI: '1',
        TERM: 'dumb',
      })
      if (!online) delete env.DATABASE_URL
      assert.ok(!Object.keys(env).some((name) => name.toUpperCase() === consentName))
      const stdout = [],
        stderr = []
      let total = 0,
        killed = false,
        spawnError
      const started = performance.now()
      const child = spawn(process.execPath, args, {
        cwd: project,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        killed = true
        child.kill()
      }, 120_000)
      for (const [stream, chunks] of [
        [child.stdout, stdout],
        [child.stderr, stderr],
      ])
        stream.on('data', (chunk) => {
          total += chunk.length
          if (total > 16 * 1024 * 1024) {
            killed = true
            child.kill()
          } else chunks.push(Buffer.from(chunk))
        })
      child.once('error', (error) => {
        spawnError = error
      })
      const closed = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
      clearTimeout(timer)
      const out = redact(Buffer.concat(stdout).toString('utf8')),
        err = redact(Buffer.concat(stderr).toString('utf8'))
      await fs.writeFile(path.join(evidence, 'commands', `${id}.stdout.txt`), out, { flag: 'wx' })
      await fs.writeFile(path.join(evidence, 'commands', `${id}.stderr.txt`), err, { flag: 'wx' })
      const traceFiles = (await fs.readdir(traces)).filter(
        (name) => name.startsWith(id + '-') && name.endsWith('.jsonl'),
      )
      const entries = []
      for (const name of traceFiles) {
        const text = await fs.readFile(path.join(traces, name), 'utf8')
        entries.push(
          ...text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
        await fs.writeFile(path.join(evidence, 'commands', name), redact(text), { flag: 'wx' })
      }
      const ready = entries.filter((entry) => entry.type === 'hook-ready')
      const tcp = entries.filter((entry) => entry.type === 'tcp')
      const violations = entries.filter((entry) => entry.type === 'violation')
      const naturalExit =
        !killed &&
        !spawnError &&
        closed.signal === null &&
        entries.some((entry) => entry.type === 'before-exit' && entry.pid === child.pid)
      const record = {
        id,
        args: args.map(redact),
        exitCode: closed.code,
        signal: closed.signal,
        elapsedMs: performance.now() - started,
        naturalExit,
        harnessTermination: killed,
        stdoutSha256: hash(out),
        stderrSha256: hash(err),
        hookCount: ready.length,
        tcp: tcp.map(({ host, port, allowed }) => ({ host, port, allowed })),
        isolationViolations: violations.length,
      }
      results.commands.push(record)
      assert.ok(!killed && !spawnError && closed.signal === null, `Child failed to close normally: ${id}`)
      assert.ok(
        ready.length &&
          ready.every((entry) => entry.cwdInsideConsumer && entry.nodePathEmpty && entry.dangerousConsentAbsent),
      )
      assert.equal(violations.length, 0, 'Unexpected consumer isolation violation')
      assert.ok(tcp.every((entry) => entry.allowed && entry.host === '127.0.0.1' && entry.port === 3059))
      if (!online) {
        assert.equal(tcp.length, 0)
        assert.ok(ready.every((entry) => entry.databaseUrlAbsent))
      }
      if (requireTcp) assert.ok(tcp.length > 0, 'Expected a real laboratory TCP attachment')
      assert.equal(closed.code, expected, redact(`Unexpected exit for ${id}\n${out}\n${err}`))
      if (expected === 0) assert.ok(naturalExit, 'Successful child must drain its own event loop')
      return { stdout: out, text: out + '\n' + err }
    }
    const cli = path.join(consumer, 'node_modules/prisma/build/index.js')
    const cliRun = (args, label, online = true) =>
      run(
        [
          cli,
          ...args,
          '--config',
          path.join(project, online ? 'prisma.config.ts' : 'offline.config.ts'),
          ...(args[0] === 'generate' ? ['--no-hints'] : []),
        ],
        label,
        0,
        online && args[0] !== 'generate',
        online,
      )
    results.clientProofs = []
    const clientRun = async (mode) => {
      const output = await run([path.join(fixtures, 'client-runner.mjs'), mode], mode)
      const proof = JSON.parse(output.stdout)
      assert.equal(proof.mode, mode)
      if (!['empty-catalog', 'install-trigger'].includes(mode)) {
        assert.equal(proof.passed, true)
        if (mode === 'missing-and-noop') assert.equal(proof.observations.noMatchAndNoopVerified, true)
        else assert.equal(proof.adapterUpdateAttemptObserved, true)
        assert.equal(proof.rawCrudPerformed, false)
      }
      results.clientProofs.push(proof)
      return proof
    }
    async function check(name, work) {
      results.scenarioCount++
      let failure
      await t.test(name, async () => {
        try {
          await work()
          results.passed.push(name)
        } catch (error) {
          failure = new Error(redact(error.message))
          throw failure
        }
      })
      if (failure) throw failure
    }
    try {
      await check(
        'public db push and generator create the fresh ID-update fixture; default Cascade is rendered',
        async () => {
          await clientRun('empty-catalog')
          const ddl = await cliRun(
            ['migrate', 'diff', '--from-empty', '--to-schema', './schema.prisma', '--script'],
            'offline-ddl',
            false,
          )
          const implicitForeignKey = ddl.stdout
            .split(';')
            .find(
              (statement) =>
                /FOREIGN KEY/i.test(statement) && /"ImplicitKid"/.test(statement) && /"ImplicitParent"/.test(statement),
            )
          assert.ok(implicitForeignKey, 'Expected actual generated ImplicitKid FK DDL')
          assert.match(implicitForeignKey, /ON UPDATE CASCADE/i)
          await fs.writeFile(path.join(evidence, 'schema-ddl.sql'), ddl.stdout, { flag: 'wx' })
          results.generatedDDL = {
            path: 'schema-ddl.sql',
            sha256: hash(ddl.stdout),
            implicitOnUpdateCascadeObserved: true,
          }
          await cliRun(['db', 'push'], 'push-initial')
          await cliRun(['generate'], 'generate-client')
          await clientRun('install-trigger')
        },
      )
      const scenarios = [
        ['mapped-string', 'mapped String ID update returns and rereads the new key while the old key disappears'],
        ['duplicate-key', 'duplicate key rejection preserves both original rows'],
        ['cascade', 'explicit onUpdate Cascade propagates the parent ID to its child'],
        ['no-action', 'onUpdate NoAction rejects the parent rename and preserves parent and child'],
        ['set-null', 'onUpdate SetNull clears the child FK after the parent ID changes'],
        ['set-default-absent', 'SetDefault without a fallback parent rejects and preserves the original relation'],
        ['set-default-present', 'SetDefault with a fallback parent changes the child FK successfully'],
        ['implicit-cascade', 'omitted onUpdate uses the generated Cascade and updates the child relation'],
        ['compound', 'compound ID rename and numeric increment return and persist the new composite key'],
        ['numeric-and-upsert', 'numeric ID operator and upsert update path return their new keys'],
        ['integer-division', 'integer ID division returns actual Firebird truncation for positive and negative values'],
        ['precise-ids', 'BigInt and fixed-scale Decimal ID increments preserve exact precision'],
        [
          'missing-and-noop',
          'missing and additional-filter-mismatch updates reject P2025 while empty update preserves an existing row',
        ],
        ['nested', 'nested parent rename plus child create/update execute as one atomic plan'],
        ['interactive-rollback', 'interactive rollback restores a key and cascade observed inside the transaction'],
        ['batch-rollback', 'batch rollback restores the executed key update and cascade after duplicate rejection'],
        ['update-many', 'updateMany changes a String ID and increments two numeric IDs with correct counts'],
        ['trigger-rejection', 'named Firebird trigger exception proves UPDATE reached SQL and preserves the seed'],
        ['trigger-rewrite', 'a BEFORE UPDATE trigger rewrites the ID and Client returns the actual persisted key'],
      ]
      for (const [mode, name] of scenarios) await check(name, () => clientRun(mode))
      results.inputsAfter = await verifyInputs()
      assert.deepEqual(results.inputsAfter, inputsBefore)
      results.status = 'passed'
    } catch (error) {
      results.status = 'failed'
      results.failure = redact(error.message)
      throw new Error(results.failure)
    } finally {
      results.completedAtUtc = new Date().toISOString()
      results.passedCount = results.passed.length
      results.nodeTestCount = results.scenarioCount + 1
      results.allSuccessfulCommandsExitedNaturally = results.commands
        .filter((command) => command.exitCode === 0)
        .every((command) => command.naturalExit)
      results.unexpectedIsolationViolations = results.commands.reduce(
        (sum, command) => sum + command.isolationViolations,
        0,
      )
      await writeJson(path.join(evidence, 'results.json'), results)
    }
  },
)
