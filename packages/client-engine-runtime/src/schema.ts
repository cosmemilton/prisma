/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
/**
 * `provider` property as defined in Prisma Schema (may differ from {@link @prisma/driver-adapter-utils#Provider}).
 */
export type SchemaProvider =
  | 'cockroachdb'
  | 'firebird'
  | 'mongodb'
  | 'mysql'
  | 'postgres'
  | 'postgresql'
  | 'prisma+postgres'
  | 'sqlite'
  | 'sqlserver'
