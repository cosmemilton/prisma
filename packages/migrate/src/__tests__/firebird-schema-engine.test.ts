/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { PrismaFirebird } from '@prisma/adapter-firebird'
import type { DataSource } from '@prisma/generator'
import type { PrismaConfigWithDatasource, SchemaContext } from '@prisma/internals'
import { canConnectToDatabase, createDatabase, loadSchemaContext } from '@prisma/internals'

import { MigrateStatus } from '../commands/MigrateStatus'
import { Migrate } from '../Migrate'
import { SchemaEngineCLI } from '../SchemaEngineCLI'
import { SchemaEngineWasm } from '../SchemaEngineWasm'
import { ensureCanConnectToDatabase, ensureDatabaseExists, parseDatasourceInfo } from '../utils/ensureDatabaseExists'
import { ensureFirebirdConnection, setupFirebirdSchemaEngine } from '../utils/firebirdSchemaEngine'
import { getDatabaseVersionSafe } from '../utils/getDatabaseVersionSafe'

jest.mock('@prisma/adapter-firebird', () => ({
  PrismaFirebird: jest.fn().mockImplementation(() => ({
    provider: 'firebird',
    adapterName: '@prisma/adapter-firebird',
    connect: jest.fn(),
    connectToShadowDb: jest.fn(),
  })),
}))
jest.mock('@prisma/internals', () => ({
  ...jest.requireActual('@prisma/internals'),
  canConnectToDatabase: jest.fn(),
  createDatabase: jest.fn(),
  loadSchemaContext: jest.fn(),
  inferDirectoryConfig: jest.fn(() => ({ migrationsDirPath: 'migrations' })),
}))
jest.mock('../SchemaEngineCLI', () => ({ SchemaEngineCLI: { setup: jest.fn() } }))
jest.mock('../SchemaEngineWasm', () => ({ SchemaEngineWasm: { setup: jest.fn() } }))

const url = 'firebird://127.0.0.1:3059/C:%5Clab%5Cmain.fdb'
const shadowDatabaseUrl = 'firebird://127.0.0.1:3059/C:%5Clab%5Cshadow.fdb'
const datasource = { url, shadowDatabaseUrl }
const schemaContext = {
  primaryDatasource: { provider: 'firebird' },
  schemaFiles: [['schema.prisma', 'datasource db { provider = "firebird" }']],
} as SchemaContext

const wasmEngine = {
  ensureConnectionValidity: jest.fn(),
  stop: jest.fn(),
  getDatabaseVersion: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(SchemaEngineWasm.setup).mockResolvedValue(wasmEngine as unknown as SchemaEngineWasm)
  wasmEngine.ensureConnectionValidity.mockResolvedValue(undefined)
  wasmEngine.stop.mockResolvedValue(undefined)
})

test('the local Firebird profile refuses native transport before setup', async () => {
  const previous = process.env.PRISMA_CLI_BUILD_PROFILE
  process.env.PRISMA_CLI_BUILD_PROFILE = 'firebird'
  try {
    await expect(
      Migrate.setup({
        schemaEngineConfig: { datasource: { url: 'postgresql://localhost/example' } },
        baseDir: process.cwd(),
      }),
    ).rejects.toThrow('supports only Firebird database commands')
    expect(SchemaEngineCLI.setup).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.PRISMA_CLI_BUILD_PROFILE
    else process.env.PRISMA_CLI_BUILD_PROFILE = previous
  }
})

test('the migration wrapper delegates cleanup on every lifecycle rather than caching an old native child', async () => {
  const migrate = await Migrate.setup({ schemaEngineConfig: { datasource }, schemaContext, baseDir: process.cwd() })
  await Promise.all([migrate.stop(), migrate.stop()])
  await migrate.stop()
  expect(wasmEngine.stop).toHaveBeenCalledTimes(3)
})

test('safe database version cleanup includes eagerly connected Wasm even before isRunning', async () => {
  wasmEngine.getDatabaseVersion.mockRejectedValueOnce(new Error('version failed'))
  expect(await getDatabaseVersionSafe(undefined, { datasource } as never, process.cwd())).toBeUndefined()
  expect(wasmEngine.stop).toHaveBeenCalledTimes(1)
})

test('routes Firebird migration commands through a bound Wasm factory with the explicit shadow URL', async () => {
  const migrate = await Migrate.setup({ schemaEngineConfig: { datasource }, schemaContext, baseDir: process.cwd() })

  expect(migrate.engine).toBe(wasmEngine)
  expect(SchemaEngineCLI.setup).not.toHaveBeenCalled()
  expect(PrismaFirebird).toHaveBeenCalledWith(url, {
    shadowDatabase: shadowDatabaseUrl,
    shadowDatabaseFileSystem: undefined,
    poolSize: 2,
    transactionLockTimeout: 0,
  })
  expect(SchemaEngineWasm.setup).toHaveBeenCalledWith({
    adapter: expect.objectContaining({
      provider: 'firebird',
      errorRegistry: expect.any(Object),
      connect: expect.any(Function),
      connectToShadowDb: expect.any(Function),
    }),
    schemaContext,
    enabledPreviewFeatures: undefined,
  })
})

test('retains the native engine for existing providers', async () => {
  const nativeDatasource = { url: 'postgresql://127.0.0.1/example' }
  await Migrate.setup({ schemaEngineConfig: { datasource: nativeDatasource }, baseDir: process.cwd() })

  expect(SchemaEngineCLI.setup).toHaveBeenCalledWith(expect.objectContaining({ datasource: nativeDatasource }))
  expect(SchemaEngineWasm.setup).not.toHaveBeenCalled()
  expect(PrismaFirebird).not.toHaveBeenCalled()
})

test('requires a real URL for Firebird Wasm even for schema-only operations', async () => {
  await expect(Migrate.setup({ schemaEngineConfig: {}, schemaContext, baseDir: process.cwd() })).rejects.toThrow(
    'requires datasource.url',
  )
  expect(SchemaEngineCLI.setup).not.toHaveBeenCalled()
  expect(PrismaFirebird).not.toHaveBeenCalled()
})

test('rejects a mismatched schema provider before creating an adapter', async () => {
  await expect(
    setupFirebirdSchemaEngine({
      datasource,
      schemaContext: { ...schemaContext, primaryDatasource: { provider: 'postgresql' } } as SchemaContext,
    }),
  ).rejects.toThrow('requires provider = "firebird"')
  expect(PrismaFirebird).not.toHaveBeenCalled()
})

test('rejects a non-Firebird shadow URL without including the URL in the error', async () => {
  await expect(
    setupFirebirdSchemaEngine({ datasource: { url, shadowDatabaseUrl: 'postgresql://127.0.0.1/shadow' } }),
  ).rejects.toThrow('The Firebird shadowDatabaseUrl must use the firebird: protocol.')
  expect(PrismaFirebird).not.toHaveBeenCalled()
})

test('passes an explicit local filesystem opt-in separately from the driver URL', async () => {
  await setupFirebirdSchemaEngine({
    datasource: { url: `${url}?shadowDatabaseFileSystem=local`, shadowDatabaseUrl },
  })
  expect(PrismaFirebird).toHaveBeenCalledWith(url, {
    shadowDatabase: shadowDatabaseUrl,
    shadowDatabaseFileSystem: 'local',
    poolSize: 2,
    transactionLockTimeout: 0,
  })
})

test.each(['remote', 'local&shadowDatabaseFileSystem=remote'])(
  'rejects unsupported or repeated shadow filesystem opt-ins',
  async (option) => {
    await expect(
      setupFirebirdSchemaEngine({
        datasource: { url: `${url}?shadowDatabaseFileSystem=${option}`, shadowDatabaseUrl },
      }),
    ).rejects.toThrow('Firebird shadowDatabaseFileSystem must be specified once with the value local.')
    expect(PrismaFirebird).not.toHaveBeenCalled()
  },
)

test('preflight checks the existing Firebird database through Wasm and always releases the engine', async () => {
  await ensureFirebirdConnection(datasource)
  expect(wasmEngine.ensureConnectionValidity).toHaveBeenCalledWith({
    datasource: { tag: 'ConnectionString', url },
  })
  expect(wasmEngine.stop).toHaveBeenCalledTimes(1)
})

test('preflight releases Wasm after a failed connection check', async () => {
  wasmEngine.ensureConnectionValidity.mockRejectedValueOnce(new Error('connection rejected'))
  await expect(ensureFirebirdConnection(datasource)).rejects.toThrow('connection rejected')
  expect(wasmEngine.stop).toHaveBeenCalledTimes(1)
})

test('Firebird ensureDatabaseExists never invokes native creation or connection commands', async () => {
  const config = { datasource } as PrismaConfigWithDatasource
  await ensureDatabaseExists(process.cwd(), 'firebird', config)
  await ensureCanConnectToDatabase(process.cwd(), config)

  expect(wasmEngine.ensureConnectionValidity).toHaveBeenCalledTimes(2)
  expect(canConnectToDatabase).not.toHaveBeenCalled()
  expect(createDatabase).not.toHaveBeenCalled()
})

test('migrate status closes its initialized engine when its separate preflight fails', async () => {
  const commandEngine = { stop: jest.fn().mockResolvedValue(undefined) }
  const preflightEngine = {
    ensureConnectionValidity: jest.fn().mockRejectedValue(new Error('preflight rejected')),
    stop: jest.fn().mockResolvedValue(undefined),
  }
  jest.mocked(loadSchemaContext).mockResolvedValue(schemaContext)
  jest
    .mocked(SchemaEngineWasm.setup)
    .mockResolvedValueOnce(commandEngine as unknown as SchemaEngineWasm)
    .mockResolvedValueOnce(preflightEngine as unknown as SchemaEngineWasm)

  await expect(MigrateStatus.new('prisma7').parse([], { datasource } as PrismaConfigWithDatasource)).rejects.toThrow(
    'preflight rejected',
  )
  expect(commandEngine.stop).toHaveBeenCalledTimes(1)
  expect(preflightEngine.stop).toHaveBeenCalledTimes(1)
})

test('formats the Firebird provider and database path for datasource display', () => {
  const info = parseDatasourceInfo(
    { name: 'db', provider: 'firebird', sourceFilePath: 'schema.prisma', schemas: [] } as unknown as DataSource,
    { datasource } as PrismaConfigWithDatasource,
  )
  expect(info).toMatchObject({ prettyProvider: 'Firebird', dbLocation: '127.0.0.1:3059', dbName: 'C:\\lab\\main.fdb' })
})
