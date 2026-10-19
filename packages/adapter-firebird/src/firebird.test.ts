/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { EventEmitter } from 'node:events'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import * as firebird from 'node-firebird'
import WireConnection from 'node-firebird/lib/wire/connection.js'
import WireDatabase from 'node-firebird/lib/wire/database.js'
import { BlrWriter, XdrWriter } from 'node-firebird/lib/wire/serialize.js'
import WireSocket from 'node-firebird/lib/wire/socket.js'
import type { SQLVarBase } from 'node-firebird/lib/wire/xsqlvar.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PrismaFirebirdAdapterFactory, type PrismaFirebirdOptions, transactionIsolation } from './firebird'
import { SqlType } from './conversion'

vi.mock('node-firebird', async (importOriginal) => ({ ...(await importOriginal<typeof firebird>()), pool: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  realpath: vi.fn(),
  stat: vi.fn(),
}))

const localMain = join(process.cwd(), '.tmp', 'identity-main.fdb')
const localShadow = join(process.cwd(), '.tmp', 'identity-shadow.fdb')
const mainConfig = { host: '127.0.0.1', database: 'main_alias' }
const shadowConfig = { host: '127.0.0.1', database: 'shadow_alias' }
const shadowOptions = { shadowDatabase: shadowConfig, shadowDatabaseFileSystem: 'local' as const }
const recordPolicies = ['record-version', 'no-record-version'] as const

function fileStat(ino: bigint, dev = 1n) {
  return { ino, dev, isFile: () => true } as Awaited<ReturnType<typeof stat>>
}

function fixture() {
  const statement = {
    input: [],
    output: [] as SQLVarBase[],
    type: 14,
    executeAsync: vi.fn().mockResolvedValue(undefined),
    fetchAllAsync: vi.fn().mockResolvedValue([]),
    releaseAsync: vi.fn().mockResolvedValue(undefined),
  }
  const transaction = {
    newStatementAsync: vi.fn().mockResolvedValue(statement),
    commitAsync: vi.fn().mockResolvedValue(undefined),
    rollbackAsync: vi.fn().mockResolvedValue(undefined),
  }
  const transport = { destroy: vi.fn() }
  const socketHandler = Object.create(WireSocket.prototype) as ProxyHandler<typeof transport> & {
    _socket: typeof transport
  }
  socketHandler._socket = transport
  const connection = {
    _pooled: true,
    _isClosed: false,
    _isDetach: false,
    _socket: new Proxy(transport, socketHandler),
  }
  const database = Object.assign(new EventEmitter(), {
    connection,
    transactionAsync: vi.fn().mockResolvedValue(transaction),
    detachAsync: vi.fn().mockResolvedValue(undefined),
  })
  const detachEvent = vi.spyOn(database, 'emit')
  const pool = Object.assign(new EventEmitter(), {
    getAsync: vi.fn().mockResolvedValue(database),
    destroyAsync: vi.fn().mockResolvedValue(undefined),
  })
  vi.mocked(firebird.pool).mockReturnValue(pool as unknown as firebird.ConnectionPool)
  return { transaction, statement, database, pool, connection, transport, detachEvent }
}

function identityFixture(name: unknown) {
  const current = fixture()
  current.statement.type = 1
  current.statement.output = [
    { type: SqlType.Varying, subType: 4, scale: 0, length: 1024, alias: 'MON$DATABASE_NAME' } as SQLVarBase,
  ]
  current.statement.fetchAllAsync.mockResolvedValue([[name]])
  return current
}

async function captureTransactionTpb(options?: firebird.TransactionOptions | firebird.Isolation): Promise<number[]> {
  const packets: Buffer[] = []
  type ResponseCallback = ((error: null, transaction: firebird.Transaction) => void) & {
    response: firebird.Transaction
  }
  const callbacks: ResponseCallback[] = []
  // The connection constructor opens a real socket; only its transport and response are replaced here.
  const connection = Object.assign(Object.create(WireConnection.prototype), {
    _isClosed: false,
    _pending: [],
    _queue: callbacks,
    _blr: new BlrWriter(),
    _msg: new XdrWriter(),
    _socket: { write: (packet: Buffer) => packets.push(Buffer.from(packet)) },
    dbhandle: 73,
  })
  const database = new WireDatabase(connection)
  const pending = database.transactionAsync(options)
  const callback = callbacks.shift()
  if (!callback) throw new Error('Expected a transaction response callback')
  connection._pending.shift()
  callback(null, callback.response)
  await pending
  expect(packets).toHaveLength(1)
  const packet = packets[0]
  expect(packet.readInt32BE(0)).toBe(29) // op_transaction
  expect(packet.readInt32BE(4)).toBe(73)
  const length = packet.readInt32BE(8)
  expect(packet.length).toBe(12 + Math.ceil(length / 4) * 4)
  return [...packet.subarray(12, 12 + length)]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(firebird.pool).mockReset()
  vi.mocked(realpath)
    .mockReset()
    .mockImplementation(async (path) => String(path))
  vi.mocked(stat)
    .mockReset()
    .mockImplementation(async (path) => fileStat(String(path).includes('shadow') ? 2n : 1n))
})

describe('Firebird isolation', () => {
  it('uses native Firebird semantics and refuses dirty-read isolation', () => {
    expect(transactionIsolation()).toEqual([15, 17])
    expect(transactionIsolation('READ COMMITTED')).toEqual([15, 17])
    expect(transactionIsolation('REPEATABLE READ')).toEqual([2])
    expect(transactionIsolation('SNAPSHOT')).toEqual([2])
    expect(transactionIsolation('SERIALIZABLE')).toEqual([1])
    expect(() => transactionIsolation('READ UNCOMMITTED')).toThrow('InvalidIsolationLevel')
  })

  it.each([
    [0, [15, 17], false],
    [10, [15, 17, 21, 4, 10, 0, 0, 0], true],
    [256, [15, 17, 21, 4, 0, 1, 0, 0], true],
    [32767, [15, 17, 21, 4, 255, 127, 0, 0], true],
  ])(
    'encodes a bounded transaction lock timeout of %s seconds in native TPB order',
    async (timeout, isolation, wait) => {
      const current = fixture()
      const adapter = await new PrismaFirebirdAdapterFactory(
        { database: 'test.fdb' },
        { transactionLockTimeout: timeout },
      ).connect()
      const transaction = await adapter.startTransaction('READ COMMITTED')
      expect(current.database.transactionAsync).toHaveBeenCalledWith({ isolation, wait, autoCommit: false })
      await transaction.rollback()
      await adapter.dispose()
    },
  )

  it.each([-1, 0.5, 32768, NaN, Infinity])(
    'rejects invalid transaction lock timeout %s before connecting',
    (transactionLockTimeout) => {
      expect(() => new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }, { transactionLockTimeout })).toThrow(
        'transactionLockTimeout',
      )
      expect(firebird.pool).not.toHaveBeenCalled()
    },
  )

  it.each(recordPolicies)('applies %s only to READ COMMITTED', (policy) => {
    const readCommitted = [15, policy === 'record-version' ? 17 : 18]
    expect(transactionIsolation(undefined, policy)).toEqual(readCommitted)
    expect(transactionIsolation('READ COMMITTED', policy)).toEqual(readCommitted)
    expect(transactionIsolation('REPEATABLE READ', policy)).toEqual([2])
    expect(transactionIsolation('SNAPSHOT', policy)).toEqual([2])
    expect(transactionIsolation('SERIALIZABLE', policy)).toEqual([1])
    expect(() => transactionIsolation('READ UNCOMMITTED', policy)).toThrow('InvalidIsolationLevel')
  })

  it.each([null, true, false, 0, 17, '', 'SENSITIVE_RECORD_POLICY', [], {}])(
    'rejects invalid READ COMMITTED record policy %j before connecting',
    (readCommittedRecordVersion) => {
      expect(
        () =>
          new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }, {
            readCommittedRecordVersion,
          } as PrismaFirebirdOptions),
      ).toThrow(new TypeError('readCommittedRecordVersion must be record-version or no-record-version'))
      expect(firebird.pool).not.toHaveBeenCalled()
    },
  )

  it.each(recordPolicies)('rejects dirty reads before acquiring a transaction attachment with %s', async (policy) => {
    const current = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory(
      { database: 'test.fdb' },
      { readCommittedRecordVersion: policy },
    ).connect()
    await expect(adapter.startTransaction('READ UNCOMMITTED')).rejects.toMatchObject({
      cause: { kind: 'InvalidIsolationLevel' },
    })
    expect(current.pool.getAsync).toHaveBeenCalledOnce()
    expect(current.database.transactionAsync).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it.each(
    recordPolicies.flatMap((policy) =>
      [
        { timeout: undefined, suffix: [], wait: true },
        { timeout: 0, suffix: [], wait: false },
        { timeout: 256, suffix: [21, 4, 0, 1, 0, 0], wait: true },
        { timeout: 32767, suffix: [21, 4, 255, 127, 0, 0], wait: true },
      ].map((options) => ({ policy, ...options })),
    ),
  )('keeps $policy independent of lock timeout $timeout', async ({ policy, timeout, suffix, wait }) => {
    const current = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory(
      { database: 'test.fdb' },
      { readCommittedRecordVersion: policy, transactionLockTimeout: timeout },
    ).connect()
    const transaction = await adapter.startTransaction('READ COMMITTED')
    expect(current.database.transactionAsync).toHaveBeenCalledWith({
      isolation: [15, policy === 'record-version' ? 17 : 18, ...suffix],
      wait,
      autoCommit: false,
    })
    expect(adapter.getConnectionInfo()).toMatchObject({ supportsBoundedTransactionWait: timeout !== undefined })
    await transaction.rollback()
    await adapter.dispose()
  })

  it.each(recordPolicies)('uses a fresh isolation array for every %s transaction', async (policy) => {
    const current = fixture()
    const isolations: number[][] = []
    current.database.transactionAsync.mockImplementation(async (options: firebird.TransactionOptions) => {
      isolations.push(options.isolation!)
      return current.transaction
    })
    const adapter = await new PrismaFirebirdAdapterFactory(
      { database: 'test.fdb' },
      { readCommittedRecordVersion: policy, transactionLockTimeout: 256 },
    ).connect()
    await (await adapter.startTransaction()).rollback()
    isolations[0].push(99)
    await (await adapter.startTransaction()).rollback()
    expect(isolations[1]).toEqual([15, policy === 'record-version' ? 17 : 18, 21, 4, 0, 1, 0, 0])
    expect(isolations[1]).not.toBe(isolations[0])
    expect(firebird.ISOLATION_READ_COMMITTED).toEqual([15, 18])
    await adapter.dispose()
  })
})

describe('Firebird transaction wire encoding', () => {
  it('captures the pinned driver default through its real async entry point and XDR writer', async () => {
    expect(await captureTransactionTpb()).toEqual([3, 15, 18, 9, 6])
    expect(await captureTransactionTpb(firebird.ISOLATION_READ_COMMITTED)).toEqual([3, 15, 18, 9, 6])
  })

  it.each([
    { policy: undefined, timeout: undefined, expected: [3, 15, 17, 9, 6] },
    { policy: 'record-version' as const, timeout: undefined, expected: [3, 15, 17, 9, 6] },
    { policy: 'no-record-version' as const, timeout: undefined, expected: [3, 15, 18, 9, 6] },
    { policy: 'record-version' as const, timeout: 0, expected: [3, 15, 17, 9, 7] },
    { policy: 'no-record-version' as const, timeout: 0, expected: [3, 15, 18, 9, 7] },
    { policy: 'record-version' as const, timeout: 256, expected: [3, 15, 17, 21, 4, 0, 1, 0, 0, 9, 6] },
    { policy: 'no-record-version' as const, timeout: 256, expected: [3, 15, 18, 21, 4, 0, 1, 0, 0, 9, 6] },
    { policy: 'record-version' as const, timeout: 32767, expected: [3, 15, 17, 21, 4, 255, 127, 0, 0, 9, 6] },
    { policy: 'no-record-version' as const, timeout: 32767, expected: [3, 15, 18, 21, 4, 255, 127, 0, 0, 9, 6] },
  ])('encodes adapter policy $policy and timeout $timeout in the actual TPB', async ({ policy, timeout, expected }) => {
    const current = fixture()
    const tpbs: number[][] = []
    current.database.transactionAsync.mockImplementation(async (options: firebird.TransactionOptions) => {
      tpbs.push(await captureTransactionTpb(options))
      return current.transaction
    })
    const adapter = await new PrismaFirebirdAdapterFactory(
      { database: 'test.fdb' },
      { readCommittedRecordVersion: policy, transactionLockTimeout: timeout },
    ).connect()
    await (await adapter.startTransaction()).rollback()
    expect(tpbs).toEqual([expected])
    await adapter.dispose()
  })
})

describe('Firebird lifecycle', () => {
  it.each([
    ['C:%5Cpath%5Cfile.fdb', 'C:\\path\\file.fdb'],
    ['%2Fvar%2Fdata%2Ffile.fdb', '/var/data/file.fdb'],
  ])('decodes URL credentials and database path %s without changing the pinned driver', async (path, database) => {
    fixture()
    const adapter = await new PrismaFirebirdAdapterFactory(
      `firebird://user%40domain:p%40ss%3Aword@127.0.0.1:3059/${path}`,
    ).connect()
    expect(firebird.pool).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ host: '127.0.0.1', port: 3059, user: 'user@domain', password: 'p@ss:word', database }),
    )
    await adapter.dispose()
  })

  it('does not expose credentials from rejected connection strings', () => {
    try {
      new PrismaFirebirdAdapterFactory('firebird://user:SENSITIVE_PASSWORD@[broken')
      throw new Error('Expected the URL parser to reject the malformed URL')
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError)
      expect(String(error)).toBe('TypeError: Invalid Firebird connection string')
      expect(JSON.stringify(error)).not.toContain('SENSITIVE_PASSWORD')
    }
  })

  it('pins conversion settings and commits a standalone operation before releasing its attachment', async () => {
    const { transaction, database, pool } = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb', statementCacheSize: 8 }).connect()
    expect(firebird.pool).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        encoding: 'UTF8',
        numericMode: 'string',
        blobAsText: false,
        jsonAsObject: false,
        namedPlaceholders: false,
      }),
    )
    expect(adapter.provider).toBe('firebird')
    expect(adapter.getConnectionInfo()).toEqual({
      supportsRelationJoins: false,
      maxBindValues: 1000,
      maxConcurrentConnections: 5,
      supportsBoundedTransactionWait: false,
    })
    await adapter.executeRaw({ sql: 'SAVEPOINT example', args: [], argTypes: [] })
    expect(database.transactionAsync).toHaveBeenCalledWith({ isolation: [15, 17], wait: true, autoCommit: false })
    expect(transaction.commitAsync).toHaveBeenCalledOnce()
    expect(database.detachAsync).toHaveBeenCalledTimes(2)
    await adapter.dispose()
    await adapter.dispose()
    expect(pool.destroyAsync).toHaveBeenCalledOnce()
    await expect(adapter.startTransaction()).rejects.toMatchObject({ cause: { kind: 'ConnectionClosed' } })
  })

  it.each(['queryRaw', 'executeRaw', 'executeScript'] as const)(
    'uses the explicit record policy for standalone %s',
    async (operation) => {
      const current = fixture()
      const adapter = await new PrismaFirebirdAdapterFactory(
        { database: 'test.fdb' },
        { readCommittedRecordVersion: 'no-record-version' },
      ).connect()
      if (operation === 'executeScript') await adapter.executeScript('SAVEPOINT example; SAVEPOINT another;')
      else await adapter[operation]({ sql: 'SAVEPOINT example', args: [], argTypes: [] })
      expect(current.database.transactionAsync).toHaveBeenCalledExactlyOnceWith({
        isolation: [15, 18],
        wait: true,
        autoCommit: false,
      })
      expect(current.transaction.commitAsync).toHaveBeenCalledOnce()
      expect(current.transaction.rollbackAsync).not.toHaveBeenCalled()
      await adapter.dispose()
    },
  )

  it('snapshots record policy options across connects and keeps opposite factories independent', async () => {
    const first = fixture()
    const opposite = fixture()
    const second = fixture()
    vi.mocked(firebird.pool)
      .mockReturnValueOnce(first.pool as unknown as firebird.ConnectionPool)
      .mockReturnValueOnce(opposite.pool as unknown as firebird.ConnectionPool)
      .mockReturnValueOnce(second.pool as unknown as firebird.ConnectionPool)
    const options: PrismaFirebirdOptions = { readCommittedRecordVersion: 'no-record-version' }
    const factory = new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }, options)
    options.readCommittedRecordVersion = 'record-version'
    const oppositeFactory = new PrismaFirebirdAdapterFactory(
      { database: 'other.fdb' },
      { readCommittedRecordVersion: 'record-version' },
    )
    const adapters = [await factory.connect(), await oppositeFactory.connect(), await factory.connect()]
    for (const adapter of adapters) await (await adapter.startTransaction()).rollback()
    for (const current of [first, second]) {
      expect(current.database.transactionAsync).toHaveBeenCalledWith({
        isolation: [15, 18],
        wait: true,
        autoCommit: false,
      })
    }
    expect(opposite.database.transactionAsync).toHaveBeenCalledWith({
      isolation: [15, 17],
      wait: true,
      autoCommit: false,
    })
    for (const adapter of adapters) await adapter.dispose()
  })

  it('rolls back failed standalone statements and retains the query diagnostic', async () => {
    const { transaction, statement, database } = fixture()
    statement.executeAsync.mockRejectedValue(Object.assign(new Error('duplicate'), { gdscode: 335544665 }))
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    await expect(adapter.executeRaw({ sql: 'INSERT INTO x VALUES (1)', args: [], argTypes: [] })).rejects.toMatchObject(
      { cause: { kind: 'UniqueConstraintViolation' } },
    )
    expect(transaction.rollbackAsync).toHaveBeenCalledOnce()
    expect(transaction.commitAsync).not.toHaveBeenCalled()
    expect(database.detachAsync).toHaveBeenCalledTimes(2)
  })

  it('keeps savepoints within an owned transaction and rejects finished transactions', async () => {
    const { transaction, database } = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    const tx = await adapter.startTransaction('SNAPSHOT')
    expect(tx.options.usePhantomQuery).toBe(true)
    await tx.createSavepoint!('prisma_sp_1')
    await tx.rollbackToSavepoint!('prisma_sp_1')
    await tx.releaseSavepoint!('prisma_sp_1')
    expect(transaction.newStatementAsync.mock.calls.map(([sql]) => sql)).toEqual([
      'SAVEPOINT "prisma_sp_1"',
      'ROLLBACK TO SAVEPOINT "prisma_sp_1"',
      'RELEASE SAVEPOINT "prisma_sp_1"',
    ])
    expect(database.detachAsync).toHaveBeenCalledOnce()
    await tx.rollback()
    expect(database.detachAsync).toHaveBeenCalledTimes(2)
    await expect(tx.executeRaw({ sql: 'SELECT 1 FROM RDB$DATABASE', args: [], argTypes: [] })).rejects.toMatchObject({
      cause: { kind: 'TransactionAlreadyClosed' },
    })
    await expect(tx.commit()).rejects.toMatchObject({ cause: { kind: 'TransactionAlreadyClosed' } })
  })

  it('attempts rollback and releases the attachment after commit failure', async () => {
    const { transaction, database, transport } = fixture()
    transaction.commitAsync.mockRejectedValue(Object.assign(new Error('deadlock'), { gdscode: 335544336 }))
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    const tx = await adapter.startTransaction()
    await expect(tx.commit()).rejects.toMatchObject({ cause: { kind: 'TransactionWriteConflict' } })
    expect(transaction.rollbackAsync).toHaveBeenCalledOnce()
    expect(database.detachAsync).toHaveBeenCalledTimes(2)
    expect(transport.destroy).not.toHaveBeenCalled()
  })

  it('quarantines only its attachment when rollback fails and retains the rollback diagnostic', async () => {
    const { transaction, database, connection, pool, transport, detachEvent } = fixture()
    const rollbackError = Object.assign(new Error('rollback connection failure'), { gdscode: 335544324 })
    transaction.rollbackAsync.mockRejectedValue(rollbackError)
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    const tx = await adapter.startTransaction()
    await expect(tx.rollback()).rejects.toMatchObject({
      cause: { kind: 'ConnectionClosed', originalMessage: rollbackError.message },
    })
    expect(transport.destroy).toHaveBeenCalledOnce()
    expect(connection).toMatchObject({ _pooled: false, _isClosed: true, _isDetach: true })
    expect(detachEvent).toHaveBeenCalledWith('detach', false)
    expect(database.detachAsync).toHaveBeenCalledOnce()
    expect(pool.destroyAsync).not.toHaveBeenCalled()
  })

  it('quarantines after failed commit and rollback without replacing the commit error', async () => {
    const { transaction, database, transport, pool } = fixture()
    const commitError = Object.assign(new Error('commit deadlock'), { gdscode: 335544336 })
    transaction.commitAsync.mockRejectedValue(commitError)
    transaction.rollbackAsync.mockRejectedValue(Object.assign(new Error('rollback failed'), { gdscode: 335544324 }))
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    const tx = await adapter.startTransaction()
    await expect(tx.commit()).rejects.toMatchObject({
      cause: { kind: 'TransactionWriteConflict', originalMessage: commitError.message },
    })
    expect(transport.destroy).toHaveBeenCalledOnce()
    expect(database.detachAsync).toHaveBeenCalledOnce()
    expect(pool.destroyAsync).not.toHaveBeenCalled()
  })

  it('quarantines the attachment when starting a transaction fails', async () => {
    const { database, transport } = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    database.transactionAsync.mockRejectedValue(Object.assign(new Error('closed'), { gdscode: 335544324 }))
    await expect(adapter.startTransaction()).rejects.toMatchObject({ cause: { kind: 'ConnectionClosed' } })
    expect(database.detachAsync).toHaveBeenCalledOnce()
    expect(transport.destroy).toHaveBeenCalledOnce()
  })

  it('executes a DDL script in one transaction and commits only after every statement', async () => {
    const { transaction, statement, database } = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    const sql = [
      'CREATE TABLE "Auto" ("ID" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)',
      'CREATE INDEX "Auto_ID" ON "Auto" ("ID")',
    ]
    await adapter.executeScript(sql.join('; ') + ';')
    expect(database.transactionAsync).toHaveBeenCalledOnce()
    expect(transaction.newStatementAsync.mock.calls.map(([query]) => query)).toEqual(sql)
    expect(statement.releaseAsync).toHaveBeenCalledTimes(2)
    expect(transaction.commitAsync).toHaveBeenCalledOnce()
    expect(transaction.commitAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      statement.releaseAsync.mock.invocationCallOrder[1],
    )
    expect(transaction.rollbackAsync).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it('rolls back all DDL on a later failure and validates scripts before acquiring an attachment', async () => {
    const { transaction, statement, database } = fixture()
    const adapter = await new PrismaFirebirdAdapterFactory({ database: 'test.fdb' }).connect()
    await expect(adapter.executeScript("CREATE TABLE x (id INTEGER); SELECT 'unfinished")).rejects.toThrow()
    expect(database.transactionAsync).not.toHaveBeenCalled()
    statement.executeAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('Table unknown'), { gdscode: 335544580 }))
    await expect(
      adapter.executeScript('CREATE TABLE x (id INTEGER); CREATE INDEX bad ON absent(id);'),
    ).rejects.toThrow()
    expect(transaction.newStatementAsync).toHaveBeenCalledTimes(2)
    expect(transaction.commitAsync).not.toHaveBeenCalled()
    expect(transaction.rollbackAsync).toHaveBeenCalledOnce()
    await adapter.dispose()
  })
})

describe('Firebird migration lock connection metadata', () => {
  it.each([
    [1, undefined, false],
    [2, undefined, false],
    [2, 0, true],
    [10, 10, true],
  ])(
    'reports pool capacity %s and bounded wait %s without starting a transaction',
    async (poolSize, transactionLockTimeout, supportsBoundedTransactionWait) => {
      const current = fixture()
      const adapter = await new PrismaFirebirdAdapterFactory(
        { database: 'test.fdb' },
        { poolSize, transactionLockTimeout },
      ).connect()
      expect(adapter.getConnectionInfo()).toMatchObject({
        maxConcurrentConnections: poolSize,
        supportsBoundedTransactionWait,
      })
      expect(firebird.pool).toHaveBeenCalledWith(poolSize, expect.any(Object))
      expect(current.database.transactionAsync).not.toHaveBeenCalled()
      await adapter.dispose()
    },
  )
})

describe('Firebird explicit shadow database', () => {
  it('fails before connecting when no shadow connection is configured', async () => {
    await expect(
      new PrismaFirebirdAdapterFactory({ database: 'main_alias' }).connectToShadowDb(),
    ).rejects.toMatchObject({
      cause: { kind: 'InvalidInputValue', message: expect.stringContaining('shadowDatabase') },
    })
    expect(firebird.pool).not.toHaveBeenCalled()
  })

  it('returns only the distinct shadow adapter and disposes the main identity-check connection', async () => {
    const main = identityFixture(localMain)
    const shadow = identityFixture(localShadow)
    vi.mocked(firebird.pool)
      .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
      .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
    const adapter = await new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb()
    expect(adapter.underlyingDriver()).toBe(shadow.pool)
    for (const current of [main, shadow]) {
      expect(current.transaction.newStatementAsync).toHaveBeenCalledWith('SELECT MON$DATABASE_NAME FROM MON$DATABASE')
      expect(current.transaction.commitAsync).toHaveBeenCalledOnce()
    }
    expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
    expect(shadow.pool.destroyAsync).not.toHaveBeenCalled()
    await adapter.dispose()
    expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
  })

  it.each([undefined, ...recordPolicies])(
    'propagates %s through both identity checks and the shadow adapter',
    async (policy) => {
      const main = identityFixture(localMain)
      const shadow = identityFixture(localShadow)
      vi.mocked(firebird.pool)
        .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
        .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
      const adapter = await new PrismaFirebirdAdapterFactory(mainConfig, {
        ...shadowOptions,
        readCommittedRecordVersion: policy,
      }).connectToShadowDb()
      await adapter.queryRaw({ sql: 'SELECT MON$DATABASE_NAME FROM MON$DATABASE', args: [], argTypes: [] })
      const expected = { isolation: [15, policy === 'no-record-version' ? 18 : 17], wait: true, autoCommit: false }
      expect(main.database.transactionAsync).toHaveBeenCalledExactlyOnceWith(expected)
      expect(shadow.database.transactionAsync).toHaveBeenCalledTimes(2)
      expect(shadow.database.transactionAsync).toHaveBeenNthCalledWith(1, expected)
      expect(shadow.database.transactionAsync).toHaveBeenNthCalledWith(2, expected)
      expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
      expect(shadow.pool.destroyAsync).not.toHaveBeenCalled()
      await adapter.dispose()
      expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
    },
  )

  it.each([
    [localMain, localMain],
    [localMain, localShadow],
  ])('rejects equal physical file identities even when MON paths differ: %s', async (mainName, shadowName) => {
    const main = identityFixture(mainName)
    const shadow = identityFixture(shadowName)
    vi.mocked(stat).mockResolvedValue(fileStat(100n))
    vi.mocked(firebird.pool)
      .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
      .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
    await expect(new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb()).rejects.toMatchObject(
      {
        cause: { kind: 'InvalidInputValue', message: expect.stringContaining('different from the main') },
      },
    )
    expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
    expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
  })

  it('fails closed and releases both pools when physical identity cannot be verified', async () => {
    const main = identityFixture(localMain)
    const shadow = identityFixture(null)
    vi.mocked(firebird.pool)
      .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
      .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
    await expect(new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb()).rejects.toMatchObject(
      {
        cause: { kind: 'InvalidInputValue', message: expect.stringContaining('physical Firebird database identity') },
      },
    )
    expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
    expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
  })

  it.each([
    ['main_alias', 'shadow_alias'],
    [localMain, 'shadow_alias'],
    ['main_alias', localShadow],
    ['relative/main.fdb', localShadow],
  ])(
    'rejects alias-only or relative identity results before filesystem proof: %s / %s',
    async (mainName, shadowName) => {
      const main = identityFixture(mainName)
      const shadow = identityFixture(shadowName)
      vi.mocked(firebird.pool)
        .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
        .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
      await expect(
        new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb(),
      ).rejects.toMatchObject({
        cause: { kind: 'InvalidInputValue', message: expect.stringContaining('physical Firebird database identity') },
      })
      expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
      expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
    },
  )

  it.each([undefined, 'localhost', 'db.example.test', '192.0.2.1'])(
    'refuses unverifiable server host %s before connecting',
    async (host) => {
      await expect(
        new PrismaFirebirdAdapterFactory({ ...mainConfig, host }, shadowOptions).connectToShadowDb(),
      ).rejects.toMatchObject({ cause: { kind: 'InvalidInputValue' } })
      expect(firebird.pool).not.toHaveBeenCalled()
      expect(stat).not.toHaveBeenCalled()
    },
  )

  it.each(['missing', 'zero', 'zero-device', 'directory', 'changed'])(
    'fails closed when filesystem identity is %s',
    async (failure) => {
      const main = identityFixture(localMain)
      const shadow = identityFixture(localShadow)
      if (failure === 'missing') vi.mocked(stat).mockRejectedValue(new Error('Unavailable fixture file'))
      if (failure === 'zero') vi.mocked(stat).mockResolvedValue(fileStat(0n))
      if (failure === 'zero-device') vi.mocked(stat).mockResolvedValue(fileStat(1n, 0n))
      if (failure === 'directory')
        vi.mocked(stat).mockResolvedValue({ ...fileStat(1n), isFile: () => false } as Awaited<ReturnType<typeof stat>>)
      if (failure === 'changed') vi.mocked(stat).mockResolvedValueOnce(fileStat(1n)).mockResolvedValueOnce(fileStat(2n))
      vi.mocked(firebird.pool)
        .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
        .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
      await expect(
        new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb(),
      ).rejects.toMatchObject({ cause: { kind: 'InvalidInputValue' } })
      expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
      expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
    },
  )

  it.each([true, false])(
    'verifies actual filesystem IDs with equivalent paths = %s without opening a database',
    async (sameFile) => {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const directory = await fs.mkdtemp(join(tmpdir(), 'firebird-identity-'))
      const original = join(directory, 'ordinary-fixture.txt')
      const different = join(directory, 'different-fixture.txt')
      try {
        await fs.writeFile(original, 'Ordinary unit-test fixture, not a database')
        await fs.writeFile(different, 'Another ordinary unit-test fixture')
        vi.mocked(realpath).mockImplementation(fs.realpath)
        vi.mocked(stat).mockImplementation(fs.stat)
        const main = identityFixture(original)
        const shadow = identityFixture(sameFile ? `${directory}${sep}.${sep}ordinary-fixture.txt` : different)
        vi.mocked(firebird.pool)
          .mockReturnValueOnce(main.pool as unknown as firebird.ConnectionPool)
          .mockReturnValueOnce(shadow.pool as unknown as firebird.ConnectionPool)
        const connection = new PrismaFirebirdAdapterFactory(mainConfig, shadowOptions).connectToShadowDb()
        if (sameFile) {
          await expect(connection).rejects.toMatchObject({
            cause: { kind: 'InvalidInputValue', message: expect.stringContaining('different from the main') },
          })
        } else {
          const adapter = await connection
          expect(adapter.underlyingDriver()).toBe(shadow.pool)
          await adapter.dispose()
        }
        expect(main.pool.destroyAsync).toHaveBeenCalledOnce()
        expect(shadow.pool.destroyAsync).toHaveBeenCalledOnce()
      } finally {
        await fs.unlink(different).catch(() => undefined)
        await fs.unlink(original).catch(() => undefined)
        await fs.rmdir(directory)
      }
    },
  )

  it('requires the explicit local filesystem assertion even for numeric loopback connections', async () => {
    await expect(
      new PrismaFirebirdAdapterFactory(mainConfig, { shadowDatabase: shadowConfig }).connectToShadowDb(),
    ).rejects.toMatchObject({
      cause: { kind: 'InvalidInputValue', message: expect.stringContaining('shadowDatabaseFileSystem') },
    })
    expect(firebird.pool).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
})
