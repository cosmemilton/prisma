/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

// Test-only preload. Copy this file into the owned consumer before using it.
// No repository module or package is imported by this hook.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { registerHooks, syncBuiltinESMExports, isBuiltin } = require('node:module')
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
const http2 = require('node:http2')
const tls = require('node:tls')
const dgram = require('node:dgram')

if (typeof registerHooks !== 'function') throw new Error('Consumer isolation requires Node 24 registerHooks')
const originals = {
  realpathSync: (typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync).bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
}
const canonical = (value) => originals.realpathSync(value)
const consumer = canonical(required('FIREBIRD_CLI_CONSUMER_ROOT'))
const blocked = JSON.parse(required('FIREBIRD_CLI_BLOCKED_ROOTS')).map(canonical)
if (blocked.length !== 2) throw new Error('Exactly two forbidden monorepo roots are required')
const stateRoot = path.resolve(required('FIREBIRD_CLI_TRACE_ROOT'))
const command = required('FIREBIRD_CLI_COMMAND_ID')
const online = process.env.FIREBIRD_CLI_NETWORK === 'online'
if (!inside(consumer, stateRoot) || !/^[a-zA-Z0-9_-]+$/.test(command)) throw new Error('Invalid consumer trace scope')
if (blocked.some((root) => inside(root, consumer) || inside(consumer, root))) throw new Error('Overlapping isolation roots')
originals.mkdirSync(stateRoot, { recursive: true })
if (!inside(consumer, canonical(stateRoot))) throw new Error('Trace directory escaped its consumer owner')
const trace = path.join(stateRoot, `${command}-${process.pid}.jsonl`)
// One exclusively created file per command/PID. A synchronous descriptor and
// buffered writes do not keep Node alive; the OS closes it on process exit.
// Keep it open through all exit listeners so their guarded I/O remains audited.
const traceDescriptor = originals.openSync(trace, 'wx', 0o600)
let traceChunks = []
let traceBytes = 0
let exiting = false

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`)
  return process.env[name]
}
function inside(root, candidate) {
  const relative = path.relative(root, path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
function asPath(value) {
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value !== 'string') return undefined
  if (value.startsWith('file:')) return fileURLToPath(value)
  return path.resolve(value)
}
function flushTrace() {
  if (traceBytes === 0) return
  const bytes = Buffer.concat(traceChunks, traceBytes)
  let offset = 0
  while (offset < bytes.length) {
    const written = originals.writeSync(traceDescriptor, bytes, offset, bytes.length - offset)
    if (written === 0) throw new Error('Isolation trace write made no progress')
    offset += written
  }
  traceChunks = []
  traceBytes = 0
}
function record(type, data = {}) {
  const bytes = Buffer.from(`${JSON.stringify({ type, command, pid: process.pid, ...data })}\n`, 'utf8')
  traceChunks.push(bytes)
  traceBytes += bytes.length
  if (traceBytes >= 65536 || exiting || type === 'violation' || type === 'hook-ready') flushTrace()
}
function deny(kind, detail) {
  record('violation', { kind, detail, blocked: true })
  const error = new Error(`FIREBIRD_CONSUMER_ISOLATION: ${kind}`)
  error.code = 'FIREBIRD_CONSUMER_ISOLATION'
  throw error
}
function guardPath(value, operation) {
  const candidate = asPath(value)
  if (!candidate) return
  const wasmAsset = /(?:\.wasm|wasm-base64\.[cm]?js)$/i.test(candidate)
  if (blocked.some((root) => inside(root, candidate))) deny('repository-filesystem', { operation, path: candidate })
  // Detect an outside spelling that resolves through a junction into a repository.
  try {
    const resolved = originals.realpathSync(candidate)
    if (blocked.some((root) => inside(root, resolved))) deny('repository-filesystem', { operation, path: resolved })
    if (wasmAsset && !inside(consumer, resolved)) deny('wasm-outside-consumer', { operation, path: resolved })
  } catch (error) {
    if (error.code === 'FIREBIRD_CONSUMER_ISOLATION') throw error
  }
  if (wasmAsset && !inside(consumer, candidate)) deny('wasm-outside-consumer', { operation, path: candidate })
  if (inside(consumer, candidate) && (wasmAsset || /package\.json$/i.test(candidate))) {
    record('asset', { operation, path: path.relative(consumer, candidate) })
  }
}

const synchronous = ['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'accessSync', 'existsSync', 'openSync', 'readdirSync', 'readlinkSync', 'opendirSync', 'createReadStream']
const asynchronous = ['readFile', 'stat', 'lstat', 'realpath', 'access', 'open', 'readdir', 'readlink', 'opendir']
for (const name of synchronous) {
  if (typeof fs[name] !== 'function') continue
  const original = fs[name]
  const wrapped = function (...args) {
    guardPath(args[0], name)
    return Reflect.apply(original, this, args)
  }
  if (typeof original.native === 'function') {
    wrapped.native = function (...args) {
      guardPath(args[0], `${name}.native`)
      return Reflect.apply(original.native, this, args)
    }
  }
  fs[name] = wrapped
}
for (const name of asynchronous) {
  if (typeof fs[name] === 'function') {
    const original = fs[name]
    const wrapped = function (...args) {
      guardPath(args[0], name)
      return Reflect.apply(original, this, args)
    }
    if (typeof original.native === 'function') {
      wrapped.native = function (...args) {
        guardPath(args[0], `${name}.native`)
        return Reflect.apply(original.native, this, args)
      }
    }
    fs[name] = wrapped
  }
  if (typeof fsp[name] === 'function') {
    const original = fsp[name]
    fsp[name] = async function (...args) {
      guardPath(args[0], `promises.${name}`)
      return Reflect.apply(original, this, args)
    }
  }
}

function moduleUrl(url, operation) {
  if (url.startsWith('node:')) return
  if (!url.startsWith('file:')) deny('module-url', { operation, url })
  const candidate = fileURLToPath(url)
  guardPath(candidate, operation)
  const resolved = originals.realpathSync(candidate)
  if (!inside(consumer, resolved)) deny('module-outside-consumer', { operation, path: resolved })
  record('module', { operation, path: path.relative(consumer, resolved) })
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && (path.isAbsolute(specifier) || specifier.startsWith('file:'))) guardPath(specifier, 'resolve-specifier')
    const result = nextResolve(specifier, context)
    moduleUrl(result.url, 'resolve')
    return result
  },
  load(url, context, nextLoad) {
    moduleUrl(url, 'load')
    return nextLoad(url, context)
  },
})

function endpoint(args) {
  let value = args[0]
  if (Array.isArray(value)) return endpoint(value)
  if (value && typeof value === 'object') return { host: value.host, port: Number(value.port), path: value.path }
  return { port: Number(value), host: typeof args[1] === 'string' ? args[1] : undefined }
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const target = endpoint(args)
  if (!online || target.path || target.host !== '127.0.0.1' || target.port !== 3059) deny('tcp', target)
  record('tcp', { ...target, allowed: true })
  return Reflect.apply(originalConnect, this, args)
}
for (const [object, methods, kind] of [
  [http, ['request', 'get'], 'http'],
  [https, ['request', 'get'], 'https'],
  [http2, ['connect'], 'http2'],
  [tls, ['connect'], 'tls'],
  [dgram, ['createSocket'], 'udp'],
]) {
  for (const name of methods) object[name] = () => deny(kind, { operation: name })
}
if (globalThis.fetch) globalThis.fetch = async () => deny('fetch', {})
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { deny('websocket', {}) } }
syncBuiltinESMExports()
Object.defineProperty(globalThis, Symbol.for('firebird.cli.consumer.isolation'), {
  value: Object.freeze({ consumer, command, online }), configurable: false, writable: false,
})
// Observe lifecycle without changing the public CLI's own exit behavior. Expected
// nonzero CLI diagnostics use process.exit upstream and do not emit beforeExit.
process.on('beforeExit', (code) => { record('before-exit', { code }); flushTrace() })
process.on('exit', (code) => { exiting = true; record('process-exit', { code }); flushTrace() })
record('hook-ready', {
  node: process.version,
  network: online ? '127.0.0.1:3059 only' : 'disabled',
  cwdInsideConsumer: inside(consumer, process.cwd()),
  nodePathEmpty: !process.env.NODE_PATH,
  databaseUrlAbsent: !process.env.DATABASE_URL && !process.env.SHADOW_DATABASE_URL,
  dangerousConsentAbsent: !Object.keys(process.env).some((name) => name.toUpperCase() === 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION'),
  agentMarkerNames: Object.keys(process.env).filter((name) => /^(CODEX|CLAUDECODE|GEMINI_CLI|AGENT|QWEN_CODE|CLINE_ACTIVE|COPILOT_CLI|OPENCODE)/.test(name)),
})
