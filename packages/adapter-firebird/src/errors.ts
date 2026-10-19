/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { DriverAdapterError, type Error as AdapterError, type MappedError } from '@prisma/driver-adapter-utils'

type FirebirdError = {
  message: string
  gdscode?: number
  code?: string
  gdsparams?: unknown[]
  status?: { gdscode: number; params?: unknown[] }[]
}

/** Maps Firebird ISC status codes while retaining the original diagnostic. */
export function convertDriverError(error: unknown): AdapterError {
  if (error instanceof DriverAdapterError) return error.cause
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') throw error
  const driverError = error as FirebirdError
  const code = driverError.gdscode ?? driverError.status?.[0]?.gdscode
  if (code === undefined) {
    if (/^Connection is closed\.?$/i.test(driverError.message)) {
      return { kind: 'ConnectionClosed', originalMessage: driverError.message }
    }
    const network: Record<string, MappedError> = {
      ECONNREFUSED: { kind: 'DatabaseNotReachable' },
      ENOTFOUND: { kind: 'DatabaseNotReachable' },
      EHOSTUNREACH: { kind: 'DatabaseNotReachable' },
      ECONNRESET: { kind: 'ConnectionClosed' },
      EPIPE: { kind: 'ConnectionClosed' },
      ETIMEDOUT: { kind: 'SocketTimeout' },
    }
    const mapped = driverError.code && network[driverError.code]
    if (!mapped) throw error
    return { ...mapped, originalCode: driverError.code, originalMessage: driverError.message }
  }
  return { ...mapFirebirdError(driverError, code), originalCode: String(code), originalMessage: driverError.message }
}

function mapFirebirdError(error: FirebirdError, code: number): MappedError {
  const index = quotedAfter(error.message, /(?:constraint|index)\s+["']([^"']+)["']/i)
  const constraint = index ? { index } : undefined
  switch (code) {
    case 335544349: // no_dup
    case 335544665: // unique_key_violation
      return {
        kind: 'UniqueConstraintViolation',
        constraint,
        table: quotedAfter(error.message, /table\s+["']([^"']+)["']/i),
      }
    case 335544466: // foreign_key
    case 335544838: // foreign_key_target_doesnt_exist
    case 335544839: // foreign_key_references_present
      return { kind: 'ForeignKeyConstraintViolation', constraint }
    case 335544347: // not_valid also covers CHECK/validation failures, so require a NULL diagnostic.
      if (/\bnull\b/i.test(error.message)) {
        const column =
          quotedAfter(error.message, /column\s+(?:(?:"[^"]+"|'[^']+'|[\w$]+)\.)?["']([^"']+)["']/i) ??
          String(error.gdsparams?.[0] ?? '')
        return { kind: 'NullConstraintViolation', constraint: column ? { fields: [column] } : undefined }
      }
      break
    case 335544336: // deadlock
    case 335544345: // lock_conflict
    case 335544451: // update_conflict
    case 335544510: // lock_timeout
      return { kind: 'TransactionWriteConflict' }
    case 335544472:
      return { kind: 'AuthenticationFailed' }
    case 335544352:
      return { kind: 'DatabaseAccessDenied' }
    case 335544324:
    case 335544528:
    case 335544856:
    case 335544726:
    case 335544727:
      return { kind: 'ConnectionClosed' }
    case 335544721:
      return { kind: 'DatabaseNotReachable' }
    case 335544332:
      return { kind: 'TransactionAlreadyClosed', cause: error.message }
    case 335544395:
      return { kind: 'TableDoesNotExist', table: String(error.gdsparams?.[0] ?? '') || undefined }
    case 335544396:
    case 335544578:
      return { kind: 'ColumnNotFound', column: String(error.gdsparams?.[0] ?? '') || undefined }
    case 335544321:
      if (/string right truncation|string.*length/i.test(error.message)) return { kind: 'LengthMismatch' }
      return { kind: 'ValueOutOfRange', cause: error.message }
    case 335544914:
    case 335544915:
      return { kind: 'LengthMismatch' }
    case 335544916:
      return { kind: 'ValueOutOfRange', cause: error.message }
    case 335544334:
      return { kind: 'InvalidInputValue', message: error.message }
  }
  // The driver keeps only the first GDS code in its Error; DSQL wrappers carry the useful
  // nested status in their rendered message rather than in a machine-readable vector.
  if (/Table unknown/i.test(error.message)) {
    return { kind: 'TableDoesNotExist', table: error.message.match(/Table unknown[\s,]+([^,\r\n]+)/i)?.[1]?.trim() }
  }
  if (/Column unknown/i.test(error.message)) {
    return { kind: 'ColumnNotFound', column: error.message.match(/Column unknown[\s,]+([^,\r\n]+)/i)?.[1]?.trim() }
  }
  if (/validation error.*(?:null|\*\*\* null \*\*\*)/i.test(error.message)) return { kind: 'NullConstraintViolation' }
  if (
    (code === 335544344 || code === 335544375) &&
    /cannot find the file|no such file|file not found/i.test(error.message)
  ) {
    return { kind: 'DatabaseDoesNotExist' }
  }
  return { kind: 'firebird', code, message: error.message }
}

function quotedAfter(message: string, pattern: RegExp): string | undefined {
  return pattern.exec(message)?.[1]
}
