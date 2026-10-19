/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { realpath, stat } from 'node:fs/promises'
import type { Socket as NetSocket } from 'node:net'

import type {
  ConnectionInfo,
  IsolationLevel,
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils'
import { DriverAdapterError } from '@prisma/driver-adapter-utils'
import * as firebird from 'node-firebird'
import type WireDatabase from 'node-firebird/lib/wire/database.js'

import { name as packageName } from '../package.json'
import { convertDriverError } from './errors'
import { splitScript } from './script'
import { runQuery } from './statement'

export type PrismaFirebirdConfig = Omit<
  firebird.Options,
  'numericMode' | 'encoding' | 'blobAsText' | 'jsonAsObject' | 'typeCast' | 'namedPlaceholders'
>

export type PrismaFirebirdOptions = {
  /** Maximum number of physical attachments. Defaults to 5. */
  poolSize?: number
  /** Called for background pool/attachment errors. */
  onConnectionError?: (error: Error) => void
  /** Existing, separate database reserved for migration history replay. Never created or dropped by this adapter. */
  shadowDatabase?: PrismaFirebirdConfig | string
  /** Explicit assertion that both loopback servers use this process's local filesystem namespace. */
  shadowDatabaseFileSystem?: 'local'
  /** Lock wait in seconds, from 0 (NOWAIT) to 32767. Omit to preserve unlimited WAIT. */
  transactionLockTimeout?: number
  /** READ COMMITTED record policy. Defaults to RECORD_VERSION; NO_RECORD_VERSION observes active writer locks. */
  readCommittedRecordVersion?: 'record-version' | 'no-record-version'
}

type ReadCommittedRecordVersion = NonNullable<PrismaFirebirdOptions['readCommittedRecordVersion']>

/** Firebird TPB isolation bytes, with an explicit record policy for read committed. */
export function transactionIsolation(
  level?: IsolationLevel,
  readCommittedRecordVersion: ReadCommittedRecordVersion = 'record-version',
): number[] {
  switch (level) {
    case undefined:
    case 'READ COMMITTED':
      return [15, readCommittedRecordVersion === 'record-version' ? 17 : 18]
    case 'REPEATABLE READ':
    case 'SNAPSHOT':
      return [2]
    case 'SERIALIZABLE':
      return [1]
    default:
      throw new DriverAdapterError({ kind: 'InvalidIsolationLevel', level })
  }
}

class FirebirdTransaction implements Transaction {
  readonly provider = 'firebird'
  readonly adapterName = packageName
  readonly options = { usePhantomQuery: true }
  #state: 'open' | 'closing' | 'closed' = 'open'
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly transaction: firebird.Transaction,
    readonly release: (transactionEnded: boolean) => Promise<void>,
  ) {}

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    return this.#enqueue(() => runQuery(this.transaction, query))
  }

  executeRaw(query: SqlQuery): Promise<number> {
    return this.#enqueue(async () => (await runQuery(this.transaction, query)).affectedRows)
  }

  createSavepoint(name: string): Promise<void> {
    return this.#savepoint('SAVEPOINT', name)
  }

  rollbackToSavepoint(name: string): Promise<void> {
    return this.#savepoint('ROLLBACK TO SAVEPOINT', name)
  }

  releaseSavepoint(name: string): Promise<void> {
    return this.#savepoint('RELEASE SAVEPOINT', name)
  }

  async #savepoint(command: string, name: string): Promise<void> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(name)) {
      throw new DriverAdapterError({ kind: 'InvalidInputValue', message: 'Invalid Firebird savepoint name' })
    }
    await this.executeRaw({ sql: `${command} "${name}"`, args: [], argTypes: [] })
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#state !== 'open') return Promise.reject(transactionClosed())
    const result = this.#queue.then(work).catch(rethrow)
    this.#queue = result.catch(() => undefined)
    return result
  }

  commit(): Promise<void> {
    return this.#finish(true)
  }

  rollback(): Promise<void> {
    return this.#finish(false)
  }

  async #finish(commit: boolean): Promise<void> {
    if (this.#state !== 'open') throw transactionClosed()
    this.#state = 'closing'
    await this.#queue
    let failure: unknown
    let transactionEnded = false
    try {
      if (commit) await this.transaction.commitAsync()
      else await this.transaction.rollbackAsync()
      transactionEnded = true
    } catch (error) {
      failure = error
      if (commit) {
        try {
          await this.transaction.rollbackAsync()
          transactionEnded = true
        } catch {
          // The attachment must be quarantined when transaction state is unknown.
        }
      }
    } finally {
      this.#state = 'closed'
      try {
        await this.release(transactionEnded)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) rethrow(failure)
  }
}

class FirebirdAdapter implements SqlDriverAdapter {
  readonly provider = 'firebird'
  readonly adapterName = packageName
  #disposed = false
  #disposePromise?: Promise<void>
  readonly #readCommittedRecordVersion: ReadCommittedRecordVersion

  constructor(
    readonly pool: firebird.ConnectionPool,
    readonly onError: (error: Error) => void,
    readonly transactionLockTimeout?: number,
    readonly poolSize = 5,
    readCommittedRecordVersion: ReadCommittedRecordVersion = 'record-version',
  ) {
    this.#readCommittedRecordVersion = readCommittedRecordVersion
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      supportsRelationJoins: false,
      maxBindValues: 1000,
      maxConcurrentConnections: this.poolSize,
      supportsBoundedTransactionWait: this.transactionLockTimeout !== undefined,
    }
  }

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    return this.#withTransaction((transaction) => transaction.queryRaw(query))
  }

  executeRaw(query: SqlQuery): Promise<number> {
    return this.#withTransaction((transaction) => transaction.executeRaw(query))
  }

  async executeScript(script: string): Promise<void> {
    const statements = splitScript(script)
    await this.#withTransaction(async (transaction) => {
      for (const sql of statements) await transaction.executeRaw({ sql, args: [], argTypes: [] })
    })
  }

  async #withTransaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    const transaction = await this.startTransaction()
    try {
      const result = await work(transaction)
      await transaction.commit()
      return result
    } catch (error) {
      await transaction.rollback().catch(() => undefined)
      throw error
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (this.#disposed) throw new DriverAdapterError({ kind: 'ConnectionClosed' })
    const isolation = transactionIsolation(isolationLevel, this.#readCommittedRecordVersion)
    if (this.transactionLockTimeout !== undefined && this.transactionLockTimeout > 0) {
      // TPB numbers use little endian; the pinned driver's waitTimeout writer uses big endian
      // for values >= 256. Supply this attachment's native TPB bytes without changing the driver.
      const timeout = Buffer.alloc(4)
      timeout.writeInt32LE(this.transactionLockTimeout)
      isolation.push(21, timeout.length, ...timeout) // isc_tpb_lock_timeout
    }
    const database = await this.pool.getAsync().catch(rethrow)
    try {
      const transaction = await database.transactionAsync({
        isolation,
        wait: this.transactionLockTimeout !== 0,
        autoCommit: false,
      })
      return new FirebirdTransaction(transaction, async (transactionEnded) => {
        if (transactionEnded) await database.detachAsync()
        else quarantineDatabase(database)
      })
    } catch (error) {
      try {
        quarantineDatabase(database)
      } catch {
        // Preserve the failure that left transaction state unconfirmed.
      }
      rethrow(error)
    }
  }

  dispose(): Promise<void> {
    this.#disposed = true
    return (this.#disposePromise ??= this.pool.destroyAsync().finally(() => this.pool.off('error', this.onError)))
  }

  underlyingDriver(): firebird.ConnectionPool {
    return this.pool
  }
}

/** Creates a real Firebird attachment pool for Prisma's Firebird SQL provider. */
export class PrismaFirebirdAdapterFactory implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = 'firebird'
  readonly adapterName = packageName
  readonly #config: firebird.Options
  readonly #shadowConfig?: firebird.Options
  readonly #options: PrismaFirebirdOptions

  constructor(config: PrismaFirebirdConfig | string, options: PrismaFirebirdOptions = {}) {
    if (options.poolSize !== undefined && (!Number.isSafeInteger(options.poolSize) || options.poolSize < 1)) {
      throw new TypeError('poolSize must be a positive integer')
    }
    if (
      options.transactionLockTimeout !== undefined &&
      (!Number.isInteger(options.transactionLockTimeout) ||
        options.transactionLockTimeout < 0 ||
        options.transactionLockTimeout > 32767)
    ) {
      throw new TypeError('transactionLockTimeout must be an integer from 0 to 32767 seconds')
    }
    if (
      options.readCommittedRecordVersion !== undefined &&
      options.readCommittedRecordVersion !== 'record-version' &&
      options.readCommittedRecordVersion !== 'no-record-version'
    ) {
      throw new TypeError('readCommittedRecordVersion must be record-version or no-record-version')
    }
    this.#config = connectionConfig(config)
    this.#shadowConfig = options.shadowDatabase === undefined ? undefined : connectionConfig(options.shadowDatabase)
    this.#options = { ...options }
  }

  connect(): Promise<FirebirdAdapter> {
    return this.#connect(this.#config)
  }

  async connectToShadowDb(): Promise<FirebirdAdapter> {
    if (!this.#shadowConfig) {
      throw new DriverAdapterError({
        kind: 'InvalidInputValue',
        message: 'Firebird migration history requires an explicit, separate shadowDatabase connection',
      })
    }
    if (
      this.#options.shadowDatabaseFileSystem !== 'local' ||
      ![this.#config.host, this.#shadowConfig.host].every((host) => host === '127.0.0.1' || host === '::1')
    ) {
      throw unverifiedDatabaseIdentity()
    }
    let main: FirebirdAdapter | undefined
    let shadow: FirebirdAdapter | undefined
    try {
      main = await this.connect()
      shadow = await this.#connect(this.#shadowConfig)
      const mainIdentity = await databaseIdentity(main)
      const shadowIdentity = await databaseIdentity(shadow)
      if (mainIdentity === shadowIdentity) {
        throw new DriverAdapterError({
          kind: 'InvalidInputValue',
          message: 'Firebird shadow database must be different from the main database',
        })
      }
      await main.dispose()
      main = undefined
      return shadow
    } catch (error) {
      await shadow?.dispose().catch(() => undefined)
      await main?.dispose().catch(() => undefined)
      throw error
    }
  }

  async #connect(config: firebird.Options): Promise<FirebirdAdapter> {
    const pool = firebird.pool(this.#options.poolSize ?? 5, config)
    const onError = (error: Error) => this.#options.onConnectionError?.(error)
    pool.on('error', onError)
    try {
      const database = await pool.getAsync()
      await database.detachAsync()
      return new FirebirdAdapter(
        pool,
        onError,
        this.#options.transactionLockTimeout,
        this.#options.poolSize ?? 5,
        this.#options.readCommittedRecordVersion,
      )
    } catch (error) {
      await pool.destroyAsync().catch(() => undefined)
      pool.off('error', onError)
      rethrow(error)
    }
  }
}

function connectionConfig(config: PrismaFirebirdConfig | string): firebird.Options {
  let parsed: PrismaFirebirdConfig
  try {
    parsed = typeof config === 'string' ? firebird.parseConnectionString(config) : config
  } catch {
    // URL parser errors may retain the rejected URL, including its password.
    throw new TypeError('Invalid Firebird connection string')
  }
  return {
    ...parsed,
    encoding: 'UTF8',
    numericMode: 'string',
    blobAsText: false,
    jsonAsObject: false,
    typeCast: undefined,
    namedPlaceholders: false,
  }
}

async function databaseIdentity(adapter: FirebirdAdapter): Promise<string> {
  const result = await adapter.queryRaw({ sql: 'SELECT MON$DATABASE_NAME FROM MON$DATABASE', args: [], argTypes: [] })
  const name = result.rows[0]?.[0]
  // Firebird 3 may report a database alias here. Different alias strings do not prove
  // different databases, and absolute paths alone do not distinguish hard links/junctions.
  const absoluteLocalPath =
    typeof name === 'string' && (process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(name) : name.startsWith('/'))
  if (result.rows.length !== 1 || !absoluteLocalPath) throw unverifiedDatabaseIdentity()
  try {
    const canonical = await realpath(name)
    const originalFile = await stat(name, { bigint: true })
    const canonicalFile = await stat(canonical, { bigint: true })
    if (
      !originalFile.isFile() ||
      !canonicalFile.isFile() ||
      originalFile.dev <= 0n ||
      canonicalFile.dev <= 0n ||
      originalFile.ino <= 0n ||
      canonicalFile.ino <= 0n ||
      originalFile.dev !== canonicalFile.dev ||
      originalFile.ino !== canonicalFile.ino
    )
      throw unverifiedDatabaseIdentity()
    return `${canonicalFile.dev}:${canonicalFile.ino}`
  } catch {
    // Never return an unverifiable connection to a caller that may reset its schema.
    throw unverifiedDatabaseIdentity()
  }
}

function unverifiedDatabaseIdentity(): DriverAdapterError {
  return new DriverAdapterError({
    kind: 'InvalidInputValue',
    message:
      'Could not verify the physical Firebird database identity; shadow connections require shadowDatabaseFileSystem: local, explicit numeric loopback hosts and absolute local file paths with distinct filesystem identities',
  })
}

function transactionClosed(): DriverAdapterError {
  return new DriverAdapterError({
    kind: 'TransactionAlreadyClosed',
    cause: 'Firebird transaction has already finished',
  })
}

function quarantineDatabase(database: firebird.Database): void {
  const attachment = database as unknown as WireDatabase
  const connection = attachment.connection
  // The pinned pool removes detached attachments with these flags. _isDetach also prevents
  // the socket-close handler from reconnecting and resurrecting unknown transaction state.
  connection._pooled = false
  connection._isDetach = true
  connection._isClosed = true
  try {
    // The driver's Socket Proxy forwards net.Socket methods but omits destroy from its types.
    const socket = connection._socket as unknown as Pick<NetSocket, 'destroy'>
    socket.destroy()
  } finally {
    attachment.emit('detach', false)
  }
}

function rethrow(error: unknown): never {
  if (error instanceof DriverAdapterError) throw error
  throw new DriverAdapterError(convertDriverError(error))
}
