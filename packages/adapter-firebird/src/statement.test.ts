/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { ColumnTypeEnum, DriverAdapterError } from '@prisma/driver-adapter-utils'
import type { Transaction } from 'node-firebird'
import type { XdrReader } from 'node-firebird/lib/wire/serialize.js'
import type { SQLVarBase } from 'node-firebird/lib/wire/xsqlvar.js'
import { describe, expect, it, vi } from 'vitest'

import { SqlType } from './conversion'
import { configureCodecs, runQuery } from './statement'

function field(type: number, extra: Partial<SQLVarBase> = {}): SQLVarBase {
  return { type, subType: 0, scale: 0, nullable: true, length: 8, alias: 'value', ...extra } as SQLVarBase
}

function counts(count: number, kind = 15): Buffer {
  // isc_info_sql_records -> requested per-verb count (4-byte integer) -> end.
  const buffer = Buffer.from([23, 7, 0, kind, 4, 0, 0, 0, 0, 0, 1])
  buffer.writeUInt32LE(count, 6)
  return buffer
}

function fakeStatement(output: SQLVarBase[], type = 1) {
  return {
    input: [] as SQLVarBase[],
    output,
    type,
    executeAsync: vi.fn().mockResolvedValue(undefined),
    fetchAllAsync: vi.fn().mockResolvedValue([]),
    fetchAsync: vi.fn().mockResolvedValue({ data: [] }),
    releaseAsync: vi.fn().mockResolvedValue(undefined),
    connection: {
      statementInfo: vi.fn((_statement, _items, callback) => callback(null, { buffer: counts(0) })),
      openBlob: vi.fn((_id, _transaction, callback) => callback(null, { handle: 7 })),
      getSegment: vi.fn((_blob, callback) => callback(null, { buffer: Buffer.from([0, 0]), handle: 2 })),
      closeBlob: vi.fn((_blob, callback) => callback(null)),
    },
  }
}

function fakeTransaction(statement: ReturnType<typeof fakeStatement>): Transaction {
  return { newStatementAsync: vi.fn().mockResolvedValue(statement) } as unknown as Transaction
}

describe('statement codecs', () => {
  it('preserves supplementary Unicode characters at CHAR capacity boundaries', () => {
    const statement = {
      input: [],
      output: [field(SqlType.Text, { subType: 4, length: 4 }), field(SqlType.Text, { subType: 4, length: 12 })],
    }
    configureCodecs(statement)
    expect(statement.output[0].decode({ readText: () => '\ud83d\ude80' } as unknown as XdrReader, false)).toBe(
      '\ud83d\ude80',
    )
    expect(
      statement.output[1].decode({ readText: () => '\ud83d\ude80x         ' } as unknown as XdrReader, false),
    ).toBe('\ud83d\ude80x ')
  })

  it('decodes short/long decimal coefficients and INT64 boundaries exactly', () => {
    const statement = { input: [], output: [field(SqlType.Long, { subType: 1, scale: -9 }), field(SqlType.Int64)] }
    configureCodecs(statement)
    expect(statement.output[0].decode({ readInt: () => 2147483647 } as XdrReader, false)).toBe('2.147483647')
    expect(statement.output[1].decode({ readInt64BigInt: () => -9223372036854775808n } as XdrReader, false)).toBe(
      '-9223372036854775808',
    )
    const nullReader = { readInt: () => 1, readInt64BigInt: () => 0n } as XdrReader
    expect(statement.output[1].decode(nullReader, true)).toBeNull()
  })

  it('decodes calendar dates and 100-microsecond times without local Date construction', () => {
    const days = Math.round(Date.UTC(2024, 2, 10) / 86400000) + 40587
    const ticks = (2 * 3600 + 30 * 60) * 10000 + 1234
    const original = field(SqlType.Timestamp)
    const statement = { input: [original], output: [original] }
    configureCodecs(statement)
    expect(statement.input[0].type).toBe(SqlType.Text)
    expect(statement.output[0].decode({ readInt: () => days, readUInt: () => ticks } as XdrReader, false)).toBe(
      '2024-03-10T02:30:00.1234+00:00',
    )
    expect(original.type).toBe(SqlType.Timestamp)
    expect(Object.hasOwn(original, 'decode')).toBe(false)
  })
})

describe('prepared execution', () => {
  it.each([SqlType.Text, SqlType.Varying])(
    'preserves maximum-capacity UTF8 strings for original prepared type %i',
    async (type) => {
      const statement = fakeStatement([])
      const input = [field(type + 1, { subType: 4, length: 32764 })]
      statement.input = input
      const transaction = fakeTransaction(statement)
      const sql = 'SELECT 1 FROM RDB$DATABASE WHERE CAST(? AS VARCHAR(8191) CHARACTER SET UTF8) IS NOT NULL'
      for (const value of ['a'.repeat(8191), '\ud83d\ude80'.repeat(8191), '\u6771'.repeat(8190) + ' ']) {
        await runQuery(transaction, { sql, args: [value], argTypes: [{ scalarType: 'string', arity: 'scalar' }] })
        expect(statement.executeAsync.mock.lastCall?.[1]).toEqual([value])
        expect(statement.input).toBe(input)
        expect(input[0]).toMatchObject({ type: type + 1, subType: 4, length: 32764 })
      }
      expect(transaction.newStatementAsync).toHaveBeenCalledWith(sql)
      expect(statement.executeAsync).toHaveBeenCalledTimes(3)
    },
  )

  it.each([
    ['ASCII', 'x'.repeat(8192)],
    ['trailing space', 'x'.repeat(8191) + ' '],
    ['only spaces', ' '.repeat(8192)],
    ['supplementary Unicode', '\ud83d\ude80'.repeat(8192)],
    ['multibyte Unicode with trailing spaces', '\u6771'.repeat(8190) + '  '],
  ])('rejects oversized %s before binding without exposing or clipping content', async (_label, value) => {
    const output = [field(SqlType.Long)]
    const statement = fakeStatement(output)
    const input = [field(SqlType.Varying, { subType: 4, length: 32764 })]
    statement.input = input
    const query = {
      sql: 'SELECT 1 FROM RDB$DATABASE WHERE ? IS NOT NULL',
      args: [value],
      argTypes: [{ scalarType: 'string', arity: 'scalar' }] as const,
    }
    const error = await runQuery(fakeTransaction(statement), { ...query, argTypes: [...query.argTypes] }).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(DriverAdapterError)
    expect((error as DriverAdapterError).cause).toEqual({
      kind: 'InvalidInputValue',
      message:
        'Firebird UTF8 text parameter length 8192 exceeds the prepared descriptor maximum of 8191 Unicode code points',
    })
    expect(statement.executeAsync).not.toHaveBeenCalled()
    expect(statement.fetchAllAsync).not.toHaveBeenCalled()
    expect(statement.releaseAsync).toHaveBeenCalledOnce()
    expect(statement.input).toBe(input)
    expect(statement.output).toBe(output)
    expect(query.args).toEqual([value])
    expect(input[0]).toMatchObject({ type: SqlType.Varying, subType: 4, length: 32764 })
  })

  it('recognizes UTF8 independently of packed collation bits in original metadata', async () => {
    const statement = fakeStatement([])
    const input = [field(SqlType.Varying + 1, { subType: (3 << 8) | 4, charSetId: 4, length: 32764 })]
    statement.input = input
    const transaction = fakeTransaction(statement)
    const execute = (value: string) =>
      runQuery(transaction, {
        sql: 'SELECT 1 FROM RDB$DATABASE WHERE ? IS NOT NULL',
        args: [value],
        argTypes: [{ scalarType: 'string', arity: 'scalar' }],
      })
    await expect(execute('x'.repeat(8191) + ' ')).rejects.toBeInstanceOf(DriverAdapterError)
    const value = '\ud83d\ude80'.repeat(8191)
    await execute(value)
    expect(statement.executeAsync.mock.calls.map((call) => call[1])).toEqual([[value]])
    expect(statement.input).toBe(input)
    expect(input[0]).toMatchObject({ type: SqlType.Varying + 1, subType: (3 << 8) | 4, charSetId: 4, length: 32764 })
  })

  it.each([
    ['smaller UTF8 descriptor', SqlType.Varying, 4, 400],
    ['different charset', SqlType.Varying, 3, 32764],
    ['OCTETS', SqlType.Text, 1, 32764],
    ['text BLOB', SqlType.Blob, 1, 32764],
  ] as const)('leaves %s to existing binding semantics', async (_label, type, subType, length) => {
    const statement = fakeStatement([])
    statement.input = [field(type, { subType, length })]
    const value = 'x'.repeat(8192)
    await runQuery(fakeTransaction(statement), {
      sql: 'SELECT 1 FROM RDB$DATABASE WHERE ? IS NOT NULL',
      args: [value],
      argTypes: [{ scalarType: 'string', arity: 'scalar' }],
    })
    expect(statement.executeAsync.mock.calls[0][1]).toEqual([value])
  })

  it('revalidates current values when prepared metadata is reused without controlling the caller transaction', async () => {
    const statement = fakeStatement([])
    const input = [field(SqlType.Text, { subType: 4, length: 32764 })]
    statement.input = input
    const transaction = Object.assign(fakeTransaction(statement), { commitAsync: vi.fn(), rollbackAsync: vi.fn() })
    const sql = 'SELECT 1 FROM RDB$DATABASE WHERE ? IS NOT NULL'
    const execute = (value: string | null) =>
      runQuery(transaction, { sql, args: [value], argTypes: [{ scalarType: 'string', arity: 'scalar' }] })
    await execute('short')
    await expect(execute('x'.repeat(8191) + ' ')).rejects.toBeInstanceOf(DriverAdapterError)
    const supplementary = '\ud83d\ude80'.repeat(8191)
    await execute(supplementary)
    await execute(null)
    expect(statement.executeAsync.mock.calls.map((call) => call[1])).toEqual([['short'], [supplementary], [null]])
    expect(statement.executeAsync.mock.calls.every((call) => call[0] === transaction)).toBe(true)
    expect(statement.input).toBe(input)
    expect(statement.releaseAsync).toHaveBeenCalledTimes(4)
    expect(transaction.commitAsync).not.toHaveBeenCalled()
    expect(transaction.rollbackAsync).not.toHaveBeenCalled()
  })

  it.each([
    'INSERT INTO "FB_AUTO" ("CODE") VALUES (?) RETURNING "ID"',
    'INSERT INTO "FB_AUTO_ONLY" DEFAULT VALUES RETURNING "ID"',
  ])('preserves identity RETURNING metadata and exact generated IDs for %s', async (sql) => {
    const statement = fakeStatement([field(SqlType.Int64, { alias: 'ID' })], 8)
    statement.executeAsync.mockResolvedValue({ data: [['9007199254740993']] })
    statement.connection.statementInfo.mockImplementation((_statement, _items, callback) =>
      callback(null, { buffer: counts(1, 14) }),
    )
    const args = sql.includes('?') ? ['record'] : []
    const result = await runQuery(fakeTransaction(statement), {
      sql,
      args,
      argTypes: args.map(() => ({ scalarType: 'string', arity: 'scalar' })),
    })
    expect(result).toEqual({
      columnNames: ['ID'],
      columnTypes: [ColumnTypeEnum.Int64],
      rows: [['9007199254740993']],
      affectedRows: 1,
    })
    expect(result).not.toHaveProperty('lastInsertId')
  })

  it.each(['INSERT INTO "FB_AUTO" ("CODE") VALUES (?)', 'INSERT INTO "FB_AUTO_ONLY" DEFAULT VALUES'])(
    'reports insert metadata without result rows for createMany statement %s',
    async (sql) => {
      const statement = fakeStatement([], 2)
      statement.connection.statementInfo.mockImplementation((_statement, _items, callback) =>
        callback(null, { buffer: counts(1, 14) }),
      )
      const args = sql.includes('?') ? ['record'] : []
      expect(
        await runQuery(fakeTransaction(statement), {
          sql,
          args,
          argTypes: args.map(() => ({ scalarType: 'string', arity: 'scalar' })),
        }),
      ).toMatchObject({ rows: [], affectedRows: 1 })
    },
  )

  it('uses metadata rather than null content to normalize zero-match RETURNING', async () => {
    const statement = fakeStatement([field(SqlType.Text)], 8)
    statement.executeAsync.mockResolvedValue({ data: [[null]] })
    const transaction = fakeTransaction(statement)
    const query = {
      sql: '/* Prisma query tag */ UPDATE "User" SET "name" = NULL WHERE "id" = 0 RETURNING "name"',
      args: [],
      argTypes: [],
    }
    expect(await runQuery(transaction, query)).toMatchObject({ rows: [], affectedRows: 0 })
    statement.connection.statementInfo.mockImplementation((_statement, _items, callback) =>
      callback(null, { buffer: counts(1) }),
    )
    expect(await runQuery(transaction, query)).toMatchObject({ rows: [[null]], affectedRows: 1 })
  })

  it('materializes binary and split UTF-8 text BLOBs inside the same transaction and restores metadata', async () => {
    const original = [field(SqlType.Blob), field(SqlType.Blob, { subType: 1 })]
    const statement = fakeStatement(original)
    statement.fetchAllAsync.mockResolvedValue([
      [
        { high: 0, low: 1 },
        { high: 0, low: 2 },
      ],
    ])
    const chunks = [Buffer.from([0, 255]), Buffer.from([0xe6, 0x9d]), Buffer.from([0xb1])]
    statement.connection.getSegment
      .mockImplementationOnce((_blob, callback) =>
        callback(null, { buffer: Buffer.from([1, 0, 0, 1, 0, 255]), handle: 2 }),
      )
      .mockImplementationOnce((_blob, callback) =>
        callback(null, { buffer: Buffer.concat([Buffer.from([2, 0]), chunks[1]]), handle: 0 }),
      )
      .mockImplementationOnce((_blob, callback) =>
        callback(null, { buffer: Buffer.concat([Buffer.from([1, 0]), chunks[2]]), handle: 2 }),
      )
    const transaction = fakeTransaction(statement)
    const result = await runQuery(transaction, { sql: 'SELECT binary, text FROM records', args: [], argTypes: [] })
    expect(result.rows).toEqual([[Buffer.from([0, 255]), '\u6771']])
    expect(result.columnTypes).toEqual([ColumnTypeEnum.Bytes, ColumnTypeEnum.Text])
    expect(statement.connection.openBlob.mock.calls[0][1]).toBe(transaction)
    expect(statement.connection.closeBlob).toHaveBeenCalledTimes(2)
    expect(statement.output).toBe(original)
    expect(statement.releaseAsync).toHaveBeenCalledOnce()
  })

  it('closes failed BLOB reads without rolling back the caller transaction or masking the read error', async () => {
    const original = [field(SqlType.Blob)]
    const statement = fakeStatement(original)
    statement.fetchAllAsync.mockResolvedValue([[{ high: 0, low: 1 }]])
    const error = new Error('read failed')
    statement.connection.getSegment.mockImplementation((_blob, callback) => callback(error, { handle: 2 }))
    statement.connection.closeBlob.mockImplementation((_blob, callback) => callback(new Error('close failed')))
    await expect(
      runQuery(fakeTransaction(statement), { sql: 'SELECT binary FROM records', args: [], argTypes: [] }),
    ).rejects.toBe(error)
    expect(statement.connection.closeBlob).toHaveBeenCalledOnce()
    expect(statement.releaseAsync).toHaveBeenCalledOnce()
    expect(statement.output).toBe(original)
  })

  it('restores prepared descriptors on execution failure', async () => {
    const original = [field(SqlType.Timestamp)]
    const statement = fakeStatement(original)
    const error = new Error('execute failed')
    statement.executeAsync.mockRejectedValue(error)
    await expect(
      runQuery(fakeTransaction(statement), { sql: 'SELECT timestamp FROM records', args: [], argTypes: [] }),
    ).rejects.toBe(error)
    expect(statement.output).toBe(original)
    expect(statement.releaseAsync).toHaveBeenCalledOnce()
  })

  it('infers DATE/TIME parameter formatting from native prepared metadata', async () => {
    const statement = fakeStatement([], 14)
    const input = [field(SqlType.Date), field(SqlType.Time), field(SqlType.Timestamp)]
    statement.input = input
    const date = new Date('2024-01-02T03:04:05.123Z')
    await runQuery(fakeTransaction(statement), {
      sql: 'test ?, ?, ?',
      args: [date, date, date],
      argTypes: Array.from({ length: 3 }, () => ({ scalarType: 'unknown', arity: 'scalar' })),
    })
    expect(statement.executeAsync.mock.calls[0][1]).toEqual(['2024-01-02', '03:04:05.1230', '2024-01-02 03:04:05.1230'])
    expect(statement.input).toBe(input)
  })

  it('materializes empty BLOBs and propagates close failures after successful reads', async () => {
    const statement = fakeStatement([field(SqlType.Blob)])
    statement.fetchAllAsync.mockResolvedValue([[{ high: 0, low: 1 }]])
    expect(
      (await runQuery(fakeTransaction(statement), { sql: 'SELECT binary FROM records', args: [], argTypes: [] })).rows,
    ).toEqual([[Buffer.alloc(0)]])
    statement.connection.closeBlob.mockImplementation((_blob, callback) => callback(new Error('close failed')))
    await expect(
      runQuery(fakeTransaction(statement), { sql: 'SELECT binary FROM records', args: [], argTypes: [] }),
    ).rejects.toThrow('close failed')
  })
})
