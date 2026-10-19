/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { describe, expect, it } from 'vitest'

import { convertDriverError } from './errors'

describe('Firebird error mapping', () => {
  it.each([
    [335544665, 'violation of PRIMARY or UNIQUE KEY constraint "U_EMAIL" on table "User"', 'UniqueConstraintViolation'],
    [335544466, 'violation of FOREIGN KEY constraint "FK_USER"', 'ForeignKeyConstraintViolation'],
    [335544347, 'validation error for column "NAME", value "*** null ***"', 'NullConstraintViolation'],
    [335544336, 'deadlock', 'TransactionWriteConflict'],
    [335544451, 'update conflicts with concurrent update', 'TransactionWriteConflict'],
    [335544510, 'lock time-out', 'TransactionWriteConflict'],
    [335544472, 'Your user name and password are not defined', 'AuthenticationFailed'],
    [335544569, 'Dynamic SQL Error, SQL error code = -204, Table unknown, Missing, At line 1', 'TableDoesNotExist'],
    [335544569, 'Dynamic SQL Error, SQL error code = -206, Column unknown, MISSING', 'ColumnNotFound'],
    [
      335544321,
      'arithmetic exception, numeric overflow, or string truncation, string right truncation',
      'LengthMismatch',
    ],
    [335544916, 'numeric value is out of range', 'ValueOutOfRange'],
  ])('maps ISC %s', (gdscode, message, kind) => {
    expect(convertDriverError({ gdscode, message })).toMatchObject({
      kind,
      originalCode: String(gdscode),
      originalMessage: message,
    })
  })

  it('retains unknown database errors and does not mislabel CHECK failures as null violations', () => {
    expect(
      convertDriverError({
        gdscode: 335544347,
        message: 'validation error for column "User"."NAME", value "*** null ***"',
      }),
    ).toMatchObject({ kind: 'NullConstraintViolation', constraint: { fields: ['NAME'] } })
    expect(
      convertDriverError({ gdscode: 335544347, message: 'validation error for column AGE, value -1' }),
    ).toMatchObject({ kind: 'firebird', code: 335544347 })
    expect(convertDriverError({ gdscode: 12345, message: 'new status' })).toEqual({
      kind: 'firebird',
      code: 12345,
      message: 'new status',
      originalCode: '12345',
      originalMessage: 'new status',
    })
    const error = new Error('programmer error')
    expect(() => convertDriverError(error)).toThrow(error)
  })

  it('maps network diagnostics', () => {
    expect(convertDriverError(new Error('Connection is closed.'))).toMatchObject({ kind: 'ConnectionClosed' })
    expect(convertDriverError({ code: 'ECONNREFUSED', message: 'connect failed' })).toMatchObject({
      kind: 'DatabaseNotReachable',
    })
    expect(convertDriverError({ code: 'ECONNRESET', message: 'socket closed' })).toMatchObject({
      kind: 'ConnectionClosed',
    })
  })
})
