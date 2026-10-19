/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

const { createHash } = require('node:crypto')
const f = require('./fixture.cjs')
const sha = value => createHash('sha256').update(value).digest('hex')
const metadata = fields => (fields || []).map(field => Object.fromEntries(
  ['type', 'length', 'nativeLength', 'charSetId', 'subType', 'scale']
    .filter(key => Number.isInteger(field[key])).map(key => [key, field[key]]),
))
function diagnostic(error) {
  const pending = [[error, 0]], seen = new Set(), nativeGds = new Set(), sqlCodes = new Set()
  while (pending.length) {
    const [value, depth] = pending.pop()
    if (typeof value === 'string') {
      for (const code of value.match(/\b33554\d{4}\b/g) || []) nativeGds.add(Number(code))
      for (const match of value.matchAll(/SQL(?:\s*error\s*)?code\s*[:=]?\s*(-\d+)/gi)) sqlCodes.add(Number(match[1]))
      continue
    }
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 7) continue
    seen.add(value)
    for (const key of Object.getOwnPropertyNames(value).slice(0, 128)) {
      if (key === 'stack') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) continue
      const item = descriptor.value
      if (/gds|originalCode/i.test(key) && /^33554\d{4}$/.test(String(item))) nativeGds.add(Number(item))
      if (/sqlcode/i.test(key) && Number.isInteger(item)) sqlCodes.add(item)
      pending.push([item, depth + 1])
    }
  }
  return { name: error?.name, prismaCode: /^P\d{4}$/.test(error?.code || '') ? error.code : undefined,
    message: String(error?.message || error), nativeGds: [...nativeGds].sort(), sqlCodes: [...sqlCodes].sort() }
}

module.exports = function createTrace() {
  const state = { context: null, events: [], captures: new Map() }
  const record = (stage, details = {}) => state.events.push({ ...state.context, stage, ...details })
  const shape = value => ({ value, jsType: typeof value,
    ...(typeof value === 'string' ? { utf16Units: value.length, utf8Bytes: Buffer.byteLength(value), sameAsInput: value === state.context?.term } : {}) })
  function validate(sql) {
    if ([...f.setup.map(item => item.sql), f.identitySql, f.emptyCatalogSql, ...f.tables.map(f.fieldSql), ...f.tables.map(f.keySql)].includes(sql)) return
    if (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql) || !f.tables.some(table => sql.includes(table)) ||
        /\b(?:INSERT|UPDATE|DELETE|EXECUTE|CREATE|ALTER|DROP|GRANT|REVOKE|EXTERNAL)\b/i.test(sql))
      throw new Error('M7_PREFIX_UNREVIEWED_SQL')
    for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+(?:"([\w$]+)"|([\w$]+))/gi))
      if (!f.tables.includes((match[1] || match[2]).toUpperCase())) throw new Error('M7_PREFIX_UNREVIEWED_TABLE')
  }
  function observe(source) {
    return new Proxy(source, { get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'connect' || key === 'startTransaction')
        return async (...args) => observe(await Reflect.apply(value, target, args))
      if (key === 'queryRaw' || key === 'executeRaw') return async (query, ...rest) => {
        validate(query.sql)
        record('delegated-adapter-attempt', { sql: query.sql, sqlSha256: sha(query.sql),
          args: query.args.map(shape), argTypes: query.argTypes })
        if (state.context?.captureKey) state.captures.set(state.context.captureKey, { sql: query.sql, args: [...query.args] })
        try { return await Reflect.apply(value, target, [query, ...rest]) }
        catch (error) { record('delegated-adapter-error', { error: diagnostic(error) }); throw error }
      }
      return value.bind(target)
    } })
  }
  function installNative(Transaction, callbackModule) {
    const prototype = Transaction.prototype, prepare = prototype.newStatementAsync, callback = callbackModule.doCallback
    const instrumented = new WeakSet()
    if (typeof prepare !== 'function' || typeof callback !== 'function') throw new Error('M7_REPRO_DRIVER_API_MISSING')
    prototype.newStatementAsync = async function (sql, ...args) {
      validate(sql)
      const statement = await Reflect.apply(prepare, this, [sql, ...args])
      record('native-prepared-input-sqlda', { sql, input: metadata(statement.input) })
      if (!instrumented.has(statement)) {
        instrumented.add(statement)
        const execute = statement.executeAsync
        statement.executeAsync = function (...values) {
          record('native-statement-execute', { args: (values[1] || []).map(shape) })
          const result = Reflect.apply(execute, this, values)
          result.then(() => undefined, error => record('native-statement-execute-error', { error: diagnostic(error) }))
          return result
        }
      }
      return statement
    }
    callbackModule.doCallback = function (response, ...args) {
      if (Array.isArray(response?.status)) record('native-status-vector', {
        sqlcode: Number.isInteger(response.sqlcode) ? response.sqlcode : undefined,
        status: response.status.slice(0, 32).map(item => ({ gdscode: item.gdscode, params: item.params })),
      })
      return Reflect.apply(callback, this, [response, ...args])
    }
    return () => { prototype.newStatementAsync = prepare; callbackModule.doCallback = callback }
  }
  return { state, record, validate, observe, installNative, diagnostic }
}
