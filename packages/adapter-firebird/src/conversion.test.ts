/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { ColumnTypeEnum } from '@prisma/driver-adapter-utils'
import { describe, expect, it } from 'vitest'

import { formatDateArgument, formatScaledInteger, mapArg, mapColumnType, SqlType } from './conversion'

const argument = (scalarType: Parameters<typeof mapArg>[1]['scalarType'], dbType?: string) => ({
  scalarType,
  dbType,
  arity: 'scalar' as const,
})

describe('Firebird parameters', () => {
  it('preserves signed 64-bit boundaries and fixed-point strings', () => {
    expect(mapArg(9223372036854775807n, argument('bigint'))).toBe('9223372036854775807')
    expect(mapArg('-9223372036854775808', argument('bigint'))).toBe('-9223372036854775808')
    expect(mapArg('900719925474099.123', argument('decimal'))).toBe('900719925474099.123')
    expect(mapArg('-0.000000000000000001', argument('decimal'))).toBe('-0.000000000000000001')
    expect(mapArg('1e-18', argument('decimal'))).toBe('0.000000000000000001')
    expect(mapArg('-1.234e2', argument('decimal'))).toBe('-123.4')
    expect(() => mapArg(9223372036854775807, argument('bigint'))).toThrow()
    expect(() => mapArg('9223372036854775808', argument('bigint'))).toThrow()
    expect(() => mapArg('NaN', argument('decimal'))).toThrow()
  })

  it('preserves null, Unicode, booleans and typed-array offsets', () => {
    expect(mapArg(null, argument('int'))).toBeNull()
    expect(mapArg('Ol\u00e1 \u6771\u4eac \ud83d\ude80', argument('string'))).toBe('Ol\u00e1 \u6771\u4eac \ud83d\ude80')
    expect(mapArg(false, argument('boolean'))).toBe(false)
    const data = new Uint8Array([9, 0, 255, 9])
    expect(mapArg(data.subarray(1, 3), argument('bytes'))).toEqual(Buffer.from([0, 255]))
    expect(mapArg('AP8=', argument('bytes'))).toEqual(Buffer.from([0, 255]))
  })

  it('formats UTC date/time values without losing the fourth fractional digit', () => {
    expect(formatDateArgument('2024-03-10T02:30:00.1234Z')).toBe('2024-03-10 02:30:00.1234')
    expect(formatDateArgument('2024-01-01T00:30:00.9999+01:00')).toBe('2023-12-31 23:30:00.9999')
    expect(formatDateArgument(new Date('2024-01-02T03:04:05.123Z'), 'DATE')).toBe('2024-01-02')
    expect(formatDateArgument('2024-01-02T03:04:05.1234Z', 'TIME')).toBe('03:04:05.1234')
    expect(formatDateArgument('23:59:59.9999', 'TIME')).toBe('23:59:59.9999')
    expect(() => formatDateArgument('2024-01-01T00:00:00.12345Z')).toThrow()
    expect(() => formatDateArgument('2024-02-31T00:00:00Z')).toThrow()
    expect(() => formatDateArgument('2024-01-01T24:00:00Z')).toThrow()
  })
})

describe('Firebird metadata', () => {
  it.each([
    [SqlType.Short, 0, 0, ColumnTypeEnum.Int32],
    [SqlType.Int64, 0, 0, ColumnTypeEnum.Int64],
    [SqlType.Long, 1, 0, ColumnTypeEnum.Numeric],
    [SqlType.Int64, 2, -18, ColumnTypeEnum.Numeric],
    [SqlType.Blob, 0, 0, ColumnTypeEnum.Bytes],
    [SqlType.Blob, 1, 0, ColumnTypeEnum.Text],
    [SqlType.Text, 1, 0, ColumnTypeEnum.Bytes],
    [SqlType.Boolean, 0, 0, ColumnTypeEnum.Boolean],
    [SqlType.Date, 0, 0, ColumnTypeEnum.Date],
    [SqlType.Time, 0, 0, ColumnTypeEnum.Time],
    [SqlType.Timestamp, 0, 0, ColumnTypeEnum.DateTime],
  ])('maps type %s subtype %s scale %s', (type, subType, scale, expected) => {
    expect(mapColumnType({ type, subType, scale, typeName: String(type) })).toBe(expected)
  })

  it('rejects unhandled BLOB subtypes and floating-point decimal storage', () => {
    expect(() => mapColumnType({ type: SqlType.Blob, subType: 2, typeName: 'BLOB' })).toThrow()
    expect(() => mapColumnType({ type: SqlType.Double, subType: 1, typeName: 'DOUBLE' })).toThrow()
  })

  it('formats scaled coefficients without floating-point arithmetic', () => {
    expect(formatScaledInteger(-9223372036854775808n, -3)).toBe('-9223372036854775.808')
    expect(formatScaledInteger(1n, -18)).toBe('0.000000000000000001')
    expect(formatScaledInteger(123n, 2)).toBe('12300')
    expect(formatScaledInteger(0n, -4)).toBe('0.0000')
  })
})
