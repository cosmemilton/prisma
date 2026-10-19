/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import { getConfig, loadSchemaContext } from '@prisma/internals'

import { DbPull } from '../commands/DbPull'
import { DbPush } from '../commands/DbPush'
import { MigrateDeploy } from '../commands/MigrateDeploy'
import { MigrateDev } from '../commands/MigrateDev'
import { Migrate } from '../Migrate'
import { ensureDatabaseExists } from '../utils/ensureDatabaseExists'
import { getMigrationName } from '../utils/promptForMigrationName'

jest.mock('@prisma/internals', () => ({
  ...jest.requireActual('@prisma/internals'),
  loadSchemaContext: jest.fn(),
  getConfig: jest.fn(),
  validate: jest.fn(),
  inferDirectoryConfig: jest.fn(() => ({ migrationsDirPath: 'migrations', viewsDirPath: 'views' })),
}))
jest.mock('../Migrate', () => ({ Migrate: { setup: jest.fn() } }))
jest.mock('../utils/ensureDatabaseExists', () => ({
  ensureDatabaseExists: jest.fn(),
  parseDatasourceInfo: jest.fn(() => ({ prettyProvider: 'Firebird' })),
}))
jest.mock('../utils/promptForMigrationName', () => ({ getMigrationName: jest.fn() }))

const schema = {
  primaryDatasource: { provider: 'firebird', activeProvider: 'firebird' },
  schemaFiles: [['schema.prisma', 'datasource db { provider = "firebird" }']],
  schemaRootDir: process.cwd(),
  loadedFromPathForLogMessages: 'schema.prisma',
}
const config = { datasource: { url: 'firebird://127.0.0.1/example.fdb' } } as never
const stop = jest.fn()
const migrate = {
  stop,
  reset: jest.fn(),
  engine: { introspect: jest.fn() },
  listMigrationDirectories: jest.fn(),
  devDiagnostic: jest.fn(),
  applyMigrations: jest.fn(),
  evaluateDataLoss: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  jest.mocked(loadSchemaContext).mockResolvedValue(schema as never)
  jest.mocked(getConfig).mockResolvedValue({} as never)
  jest.mocked(Migrate.setup).mockResolvedValue(migrate as never)
  jest.mocked(ensureDatabaseExists).mockResolvedValue(undefined)
  stop.mockResolvedValue(undefined)
})
afterEach(() => jest.restoreAllMocks())

test('db pull disposes its engine after printing a real introspection result', async () => {
  migrate.engine.introspect.mockResolvedValueOnce({
    schema: { files: [{ path: 'schema.prisma', content: 'model Example { id Int @id }' }] },
    warnings: null,
  })
  await DbPull.new('prisma').parse(['--print'], config)
  expect(stop).toHaveBeenCalledTimes(1)
})
test('db pull disposes its engine when introspection rejects', async () => {
  migrate.engine.introspect.mockRejectedValueOnce(new Error('introspection rejected'))
  await expect(DbPull.new('prisma').parse(['--print'], config)).rejects.toThrow('introspection rejected')
  expect(stop).toHaveBeenCalledTimes(1)
})
test('deploy disposes the eagerly connected engine when listing migration files rejects', async () => {
  migrate.listMigrationDirectories.mockRejectedValueOnce(new Error('files rejected'))
  await expect(MigrateDeploy.new('prisma').parse([], config, process.cwd())).rejects.toThrow('files rejected')
  expect(stop).toHaveBeenCalledTimes(1)
})
test('db push disposes the eagerly connected engine when preflight rejects', async () => {
  jest.mocked(ensureDatabaseExists).mockRejectedValueOnce(new Error('preflight rejected'))
  await expect(DbPush.new('prisma').parse([], config, process.cwd())).rejects.toThrow('preflight rejected')
  expect(stop).toHaveBeenCalledTimes(1)
})
test('db push preserves the AI safety checkpoint and disposes before propagating its refusal', async () => {
  const previousAgent = process.env.CODEX_THREAD_ID
  const previousConsent = process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION
  process.env.CODEX_THREAD_ID = 'unit-test-agent'
  delete process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION
  try {
    await expect(DbPush.new('prisma').parse(['--force-reset'], config, process.cwd())).rejects.toThrow(
      'Prisma Migrate detected',
    )
    expect(migrate.reset).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  } finally {
    if (previousAgent === undefined) delete process.env.CODEX_THREAD_ID
    else process.env.CODEX_THREAD_ID = previousAgent
    if (previousConsent === undefined) delete process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION
    else process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION = previousConsent
  }
})
test('migrate dev disposes its engine when migration-name acquisition rejects', async () => {
  migrate.devDiagnostic.mockResolvedValueOnce({ action: { tag: 'createMigration' } })
  migrate.applyMigrations.mockResolvedValueOnce({ appliedMigrationNames: [] })
  migrate.evaluateDataLoss.mockResolvedValueOnce({ migrationSteps: 1, warnings: [], unexecutableSteps: [] })
  jest.mocked(getMigrationName).mockRejectedValueOnce(new Error('name acquisition rejected'))
  await expect(MigrateDev.new('prisma').parse([], config, process.cwd())).rejects.toThrow('name acquisition rejected')
  expect(stop).toHaveBeenCalledTimes(1)
})
