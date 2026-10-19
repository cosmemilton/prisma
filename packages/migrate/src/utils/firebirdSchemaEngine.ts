/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import type { Datasource } from '@prisma/config'
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils'
import type { SchemaContext } from '@prisma/internals'

import { SchemaEngineWasm } from '../SchemaEngineWasm'

export function isFirebirdUrl(url: string | undefined): boolean {
  return url !== undefined && /^firebird:/i.test(url)
}

export async function setupFirebirdSchemaEngine({
  datasource,
  schemaContext,
  enabledPreviewFeatures,
}: {
  datasource: Datasource | undefined
  schemaContext?: SchemaContext
  enabledPreviewFeatures?: string[]
}): Promise<SchemaEngineWasm> {
  const url = datasource?.url
  if (url === undefined || !isFirebirdUrl(url)) {
    throw new Error('Firebird schema-engine Wasm requires datasource.url using the firebird: protocol.')
  }
  const shadowDatabaseUrl = datasource?.shadowDatabaseUrl
  if (shadowDatabaseUrl !== undefined && !isFirebirdUrl(shadowDatabaseUrl)) {
    throw new Error('The Firebird shadowDatabaseUrl must use the firebird: protocol.')
  }
  const provider = schemaContext?.primaryDatasource?.provider
  if (provider !== undefined && provider !== 'firebird') {
    throw new Error('A Firebird datasource URL requires provider = "firebird" in the Prisma schema.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('Invalid Firebird datasource URL.')
  }
  const fileSystemValues = parsedUrl.searchParams.getAll('shadowDatabaseFileSystem')
  if (fileSystemValues.length > 1 || (fileSystemValues.length === 1 && fileSystemValues[0] !== 'local')) {
    throw new Error('Firebird shadowDatabaseFileSystem must be specified once with the value local.')
  }
  const shadowDatabaseFileSystem = fileSystemValues.length === 1 ? ('local' as const) : undefined
  if (shadowDatabaseFileSystem !== undefined) {
    parsedUrl.searchParams.delete('shadowDatabaseFileSystem')
  }

  const { PrismaFirebird } = await import('@prisma/adapter-firebird')
  const adapter = new PrismaFirebird(shadowDatabaseFileSystem === undefined ? url : parsedUrl.toString(), {
    shadowDatabase: shadowDatabaseUrl,
    shadowDatabaseFileSystem,
    // The migration lock holds one attachment while schema queries use another.
    poolSize: 2,
    transactionLockTimeout: 0,
  })
  return SchemaEngineWasm.setup({
    adapter: bindMigrationAwareSqlAdapterFactory(adapter),
    schemaContext,
    enabledPreviewFeatures,
  })
}

/** Firebird uses the same JS adapter for preflight and migration commands. */
export async function ensureFirebirdConnection(datasource: Datasource & { url: string }): Promise<void> {
  const engine = await setupFirebirdSchemaEngine({ datasource })
  try {
    await engine.ensureConnectionValidity({ datasource: { tag: 'ConnectionString', url: datasource.url } })
  } finally {
    await engine.stop()
  }
}
