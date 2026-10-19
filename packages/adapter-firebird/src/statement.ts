/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { DriverAdapterError, type SqlQuery, type SqlResultSet } from '@prisma/driver-adapter-utils'
import type { FieldMetadata, RecordCounts, Transaction } from 'node-firebird'
import type Statement from 'node-firebird/lib/wire/statement.js'
import { BlrReader, type XdrReader } from 'node-firebird/lib/wire/serialize.js'
import { describeFields, parseRecordCounts, type SQLVarBase } from 'node-firebird/lib/wire/xsqlvar.js'

import { baseType, formatScaledInteger, mapArg, mapColumnType, mapValue, SqlType } from './conversion'

type ExecutionResult = { data?: unknown[][] }
type WireTransaction = Parameters<Statement['executeAsync']>[0]
const UTF8_CHARSET_ID = 4
const MAX_UTF8_TEXT_CODE_POINTS = 8191
const MAX_UTF8_TEXT_DESCRIPTOR_BYTES = MAX_UTF8_TEXT_CODE_POINTS * 4

/** Executes one prepared statement using the pinned driver's statement-local codecs. */
export async function runQuery(
  transaction: Transaction,
  query: SqlQuery,
): Promise<SqlResultSet & { affectedRows: number }> {
  if (query.args.length !== query.argTypes.length) {
    throw new DriverAdapterError({ kind: 'InvalidInputValue', message: 'SQL parameters and argument types must match' })
  }
  const statement = (await transaction.newStatementAsync(query.sql)) as unknown as Statement
  const originalInput = statement.input
  const originalOutput = statement.output
  const wireTransaction = transaction as unknown as WireTransaction
  let failed = true
  try {
    if ([9, 10, 11].includes(statement.type)) {
      throw new DriverAdapterError({
        kind: 'InvalidInputValue',
        message: 'Use Prisma transactions for transaction control statements',
      })
    }
    const fields: FieldMetadata[] = describeFields(statement.output)
    const columnTypes = fields.map(mapColumnType)
    configureCodecs(statement)
    const args = query.args.map((value, index) => {
      const inputType = originalInput[index] && baseType(originalInput[index].type)
      const dbType =
        inputType === SqlType.Date
          ? 'DATE'
          : inputType === SqlType.Time
            ? 'TIME'
            : inputType === SqlType.Timestamp
              ? 'TIMESTAMP'
              : undefined
      const mapped = mapArg(
        value,
        dbType ? { ...query.argTypes[index], scalarType: 'datetime', dbType } : query.argTypes[index],
      )
      validateMaximumUtf8Text(mapped, originalInput[index])
      return mapped
    })
    const execution = (await statement.executeAsync(wireTransaction, args, { namedPlaceholders: false })) as
      | ExecutionResult
      | undefined
    let rows: unknown[][] = []
    if (statement.type === 1 || statement.type === 12) {
      rows = (await statement.fetchAllAsync(wireTransaction)) as unknown[][]
    } else if (fields.length) {
      rows = execution?.data ?? ((await statement.fetchAsync(wireTransaction, 1)) as ExecutionResult)?.data ?? []
    }
    const counts = [2, 3, 4, 8].includes(statement.type) ? await recordCounts(statement) : undefined
    const affectedRows = counts ? counts.insertCount + counts.updateCount + counts.deleteCount : rows.length
    // Firebird 3 singleton DML RETURNING emits one NULL row when no record matched.
    if (
      counts &&
      affectedRows === 0 &&
      (statement.type !== 8 || /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(UPDATE|DELETE|INSERT)\b/i.test(query.sql))
    ) {
      rows = []
    }
    for (const row of rows) {
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]
        const value = row[index]
        if (value !== null && baseType(field.type) === SqlType.Blob) {
          const bytes = await readBlob(statement, transaction, value as { high: number; low: number })
          if (field.subType === 1) {
            try {
              row[index] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
              throw new DriverAdapterError({
                kind: 'InconsistentColumnData',
                cause: 'Text BLOB contains invalid UTF-8; this adapter requires UTF8 text BLOB storage',
              })
            }
          } else {
            row[index] = bytes
          }
        }
        row[index] = mapValue(row[index], field)
      }
    }
    failed = false
    return {
      columnNames: fields.map((field, index) => field.alias ?? field.field ?? `column_${index}`),
      columnTypes,
      rows,
      affectedRows,
    }
  } finally {
    statement.input = originalInput
    statement.output = originalOutput
    statement._failed = failed
    if (failed) {
      await statement.releaseAsync().catch(() => undefined)
    } else {
      await statement.releaseAsync()
    }
  }
}

/** Firebird can silently discard trailing spaces when casting beyond its maximum UTF8 VARCHAR capacity. */
function validateMaximumUtf8Text(value: unknown, field: SQLVarBase | undefined): void {
  if (
    typeof value !== 'string' ||
    !field ||
    ![SqlType.Text, SqlType.Varying].includes(baseType(field.type) as never) ||
    (field.charSetId ?? field.subType & 0xff) !== UTF8_CHARSET_ID ||
    field.length !== MAX_UTF8_TEXT_DESCRIPTOR_BYTES ||
    value.length <= MAX_UTF8_TEXT_CODE_POINTS
  ) {
    return
  }
  let length = 0
  for (let index = 0; index < value.length; index++) {
    length++
    if ((value.codePointAt(index) ?? 0) > 0xffff) index++
  }
  if (length > MAX_UTF8_TEXT_CODE_POINTS) {
    throw new DriverAdapterError({
      kind: 'InvalidInputValue',
      message: `Firebird UTF8 text parameter length ${length} exceeds the prepared descriptor maximum of ${MAX_UTF8_TEXT_CODE_POINTS} Unicode code points`,
    })
  }
}

/** Keeps raw date, fixed-point, and BLOB values exact without changing shared driver prototypes. */
export function configureCodecs(statement: Pick<Statement, 'input' | 'output'>): void {
  statement.input = statement.input.map((field) => {
    if (![SqlType.Timestamp, SqlType.Date, SqlType.Time].includes(baseType(field.type) as never)) return field
    // The ordinary driver path parses date parameters into local JS Dates. Let the server parse
    // UTC-formatted SQL text instead, retaining DST-gap values and 100-microsecond precision.
    return Object.assign(Object.create(field) as SQLVarBase, { type: SqlType.Text })
  })
  statement.output = statement.output.map((field) => {
    const type = baseType(field.type)
    const codec = Object.create(field) as SQLVarBase
    if (type === SqlType.Text && field.subType !== 1) {
      // CHAR capacities count Unicode code points; the pinned driver trims UTF-16 code units.
      codec.decode = (reader: XdrReader, legacy: boolean) => {
        const value = reader.readText(field.length, 'utf8')
        const characters = Array.from(value)
        const capacity = Math.floor(field.length / 4)
        return nullable(reader, legacy, characters.length > capacity ? characters.slice(0, capacity).join('') : value)
      }
    } else if (type === SqlType.Blob) {
      // QUAD has the same wire format as BLOB. Suppressing the driver's deferred BLOB wrapper
      // lets us close every handle inside the owning transaction, including failed reads.
      codec.type = SqlType.Quad
    } else if ([SqlType.Short, SqlType.Long, SqlType.Int64].includes(type as never)) {
      if (type === SqlType.Int64 || field.subType || field.scale) {
        codec.decode = (reader: XdrReader, legacy: boolean) => {
          const coefficient = type === SqlType.Int64 ? reader.readInt64BigInt() : BigInt(reader.readInt())
          return nullable(reader, legacy, formatScaledInteger(coefficient, field.scale))
        }
      }
    } else if ([SqlType.Timestamp, SqlType.Date, SqlType.Time].includes(type as never)) {
      codec.decode = (reader: XdrReader, legacy: boolean) => {
        const days = type !== SqlType.Time ? reader.readInt() : 40587
        const ticks = type !== SqlType.Date ? reader.readUInt() : 0
        const date = new Date((days - 40587) * 86400000).toISOString().slice(0, 10)
        const seconds = Math.floor(ticks / 10000)
        const time = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
          .map((part) => String(part).padStart(2, '0'))
          .join(':')
        const fraction = String(ticks % 10000).padStart(4, '0')
        const value =
          type === SqlType.Date
            ? date
            : type === SqlType.Time
              ? `${time}.${fraction}`
              : `${date}T${time}.${fraction}+00:00`
        return nullable(reader, legacy, value)
      }
    }
    return codec
  })
}

function nullable(reader: XdrReader, legacy: boolean, value: string): string | null {
  return legacy && reader.readInt() ? null : value
}

async function recordCounts(statement: Statement): Promise<RecordCounts> {
  const info = await new Promise<{ buffer?: Buffer }>((resolve, reject) => {
    statement.connection.statementInfo(statement, [23], (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
  if (!info?.buffer?.length || info.buffer[0] !== 23) {
    throw new Error('Firebird did not return affected record metadata')
  }
  return parseRecordCounts(info.buffer)
}

async function readBlob(
  statement: Statement,
  transaction: Transaction,
  id: { high: number; low: number },
): Promise<Buffer> {
  const connection = statement.connection
  const blob = await new Promise<{ handle: number }>((resolve, reject) => {
    connection.openBlob(id, transaction as unknown as WireTransaction, (error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
  let failed = true
  try {
    const chunks: Buffer[] = []
    while (true) {
      const segment = await new Promise<{ buffer?: Buffer; handle: number }>((resolve, reject) => {
        connection.getSegment(blob, (error, value) => {
          if (error) reject(error)
          else resolve(value)
        })
      })
      if (segment.buffer) chunks.push(new BlrReader(segment.buffer).readSegment())
      if (segment.handle === 2) break
    }
    failed = false
    return Buffer.concat(chunks)
  } finally {
    const close = new Promise<void>((resolve, reject) => {
      connection.closeBlob(blob, (error: unknown) => (error ? reject(error) : resolve()), false)
    })
    if (failed) await close.catch(() => undefined)
    else await close
  }
}
