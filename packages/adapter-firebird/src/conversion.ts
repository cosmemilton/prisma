/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import type { ArgType, ColumnType, ResultValue } from '@prisma/driver-adapter-utils'
import { ColumnTypeEnum, DriverAdapterError } from '@prisma/driver-adapter-utils'
import type { FieldMetadata } from 'node-firebird'

export const SqlType = {
  Varying: 448,
  Text: 452,
  Double: 480,
  Float: 482,
  Long: 496,
  Short: 500,
  Timestamp: 510,
  Blob: 520,
  Quad: 550,
  Time: 560,
  Date: 570,
  Int64: 580,
  Boolean: 32764,
  Null: 32766,
} as const

export function baseType(type: number): number {
  return type & ~1
}

export function mapColumnType(field: FieldMetadata): ColumnType {
  const type = baseType(field.type)
  if ([SqlType.Short, SqlType.Long, SqlType.Int64].includes(type as never)) {
    return field.subType || field.scale
      ? ColumnTypeEnum.Numeric
      : type === SqlType.Int64
        ? ColumnTypeEnum.Int64
        : ColumnTypeEnum.Int32
  }
  switch (type) {
    case SqlType.Text:
    case SqlType.Varying:
      return field.subType === 1 ? ColumnTypeEnum.Bytes : ColumnTypeEnum.Text
    case SqlType.Float:
      return ColumnTypeEnum.Float
    case SqlType.Double:
      if (field.subType) break
      return ColumnTypeEnum.Double
    case SqlType.Boolean:
      return ColumnTypeEnum.Boolean
    case SqlType.Timestamp:
      return ColumnTypeEnum.DateTime
    case SqlType.Date:
      return ColumnTypeEnum.Date
    case SqlType.Time:
      return ColumnTypeEnum.Time
    case SqlType.Blob:
      if (field.subType === 0 || field.subType === undefined) return ColumnTypeEnum.Bytes
      if (field.subType === 1) return ColumnTypeEnum.Text
      break
    case SqlType.Null:
      return ColumnTypeEnum.Int32
  }
  throw new DriverAdapterError({ kind: 'UnsupportedNativeDataType', type: field.typeName || String(type) })
}

export function mapArg(value: unknown, type: ArgType): unknown {
  if (value === null) return null
  if (type.arity === 'list') throw invalidInput('Firebird does not support array parameters')
  if (value === undefined) throw invalidInput('Undefined is not a SQL parameter value')
  switch (type.scalarType) {
    case 'bigint': {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw invalidInput('BigInt parameters must be supplied as bigint or exact integer strings')
      }
      const text = String(value)
      if (!/^[+-]?\d+$/.test(text)) throw invalidInput('Invalid BigInt parameter')
      const integer = BigInt(text)
      if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
        throw new DriverAdapterError({ kind: 'ValueOutOfRange', cause: 'BigInt parameter exceeds signed 64-bit range' })
      }
      // The driver's bigint parameter uses INT128 BLR, which Firebird 3 cannot read.
      return text
    }
    case 'decimal': {
      const text = String(value)
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
        throw invalidInput('Invalid Decimal parameter')
      }
      return expandDecimalExponent(text)
    }
    case 'datetime':
      return formatDateArgument(value, type.dbType)
    case 'bytes':
      if (typeof value === 'string') return Buffer.from(value, 'base64')
      if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      if (value instanceof ArrayBuffer) return Buffer.from(value)
      throw invalidInput('Bytes parameters must be a byte array or a base64 string')
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value)
    default:
      if (value instanceof Date) return formatDateArgument(value, type.dbType)
      if (typeof value === 'bigint') return mapArg(value, { ...type, scalarType: 'bigint' })
      if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      return value
  }
}

export function mapValue(value: unknown, field: FieldMetadata): ResultValue {
  if (value === null) return null
  const columnType = mapColumnType(field)
  if (columnType === ColumnTypeEnum.Numeric || columnType === ColumnTypeEnum.Int64) {
    if (typeof value !== 'string') throw invalidInput('The Firebird exact numeric codec did not return a string')
    return value
  }
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  throw invalidInput(`Unexpected value returned for Firebird type ${field.typeName}`)
}

export function formatScaledInteger(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? '-' : ''
  let digits = (coefficient < 0n ? -coefficient : coefficient).toString()
  if (scale >= 0) return sign + digits + '0'.repeat(scale)
  digits = digits.padStart(-scale + 1, '0')
  return sign + digits.slice(0, scale) + '.' + digits.slice(scale)
}

export function formatDateArgument(value: unknown, dbType?: string): string {
  const text = value instanceof Date ? value.toISOString() : String(value)
  const nativeType = dbType?.toUpperCase()
  if (nativeType === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (nativeType === 'TIME' && /^\d{2}:\d{2}:\d{2}(?:\.\d{1,4})?$/.test(text)) return text
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(text)
  if (!match) throw invalidInput('Invalid DateTime parameter; expected an ISO date and time')
  if (match[3]?.slice(4).replace(/0/g, '')) {
    throw invalidInput('Firebird 3 timestamps support at most four fractional second digits')
  }
  const fraction = (match[3] ?? '').slice(0, 4).padEnd(4, '0')
  const calendarDate = new Date(`${match[1]}T00:00:00Z`)
  const [hours, minutes, seconds] = match[2].split(':').map(Number)
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1] ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    throw invalidInput('Invalid calendar date or time in DateTime parameter')
  }
  const instant = new Date(`${match[1]}T${match[2]}${match[4] ?? 'Z'}`)
  if (!Number.isFinite(instant.getTime())) throw invalidInput('Invalid DateTime parameter')
  const iso = instant.toISOString()
  if (nativeType === 'DATE') return iso.slice(0, 10)
  if (nativeType === 'TIME') return iso.slice(11, 19) + '.' + fraction
  return iso.slice(0, 19).replace('T', ' ') + '.' + fraction
}

function invalidInput(message: string): DriverAdapterError {
  return new DriverAdapterError({ kind: 'InvalidInputValue', message })
}

function expandDecimalExponent(text: string): string {
  if (!/[eE]/.test(text)) return text
  const [mantissa, exponentText] = text.toLowerCase().split('e')
  const exponent = Number(exponentText)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) {
    throw new DriverAdapterError({ kind: 'ValueOutOfRange', cause: 'Decimal exponent exceeds the supported range' })
  }
  const sign = /^[+-]/.test(mantissa) ? mantissa[0] : ''
  const unsigned = sign ? mantissa.slice(1) : mantissa
  const [integer, fraction = ''] = unsigned.split('.')
  const digits = integer + fraction
  const position = integer.length + exponent
  if (position <= 0) return sign + '0.' + '0'.repeat(-position) + digits
  if (position >= digits.length) return sign + digits + '0'.repeat(position - digits.length)
  return sign + digits.slice(0, position) + '.' + digits.slice(position)
}
