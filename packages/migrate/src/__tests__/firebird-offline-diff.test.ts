/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import { getSchemaWithPath, loadSchemaContext, processSchemaResult, wasmSchemaEngineLoader } from '@prisma/internals'

import { MigrateDiff } from '../commands/MigrateDiff'
import { Migrate } from '../Migrate'
import { CaptureStdout } from '../utils/captureStdout'

jest.mock('@prisma/internals', () => ({
  ...jest.requireActual('@prisma/internals'),
  getSchemaWithPath: jest.fn(),
  loadSchemaContext: jest.fn(),
  processSchemaResult: jest.fn(),
  wasmSchemaEngineLoader: { diffDatamodels: jest.fn() },
}))
jest.mock('../Migrate', () => ({ Migrate: { setup: jest.fn() } }))
const schema = {
  schemaPath: 'schema.prisma',
  schemaRootDir: process.cwd(),
  schemas: [['schema.prisma', 'datasource db { provider = "firebird" }']],
}
const context = { primaryDatasource: { provider: 'firebird' }, schemaFiles: schema.schemas }
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getSchemaWithPath).mockResolvedValue(schema as never)
  jest.mocked(processSchemaResult).mockResolvedValue(context as never)
  jest.mocked(loadSchemaContext).mockResolvedValue(context as never)
})
afterEach(() => jest.restoreAllMocks())

test('offline Firebird diff uses only target schemas and never reads a datasource or creates an engine', async () => {
  const config = {
    get datasource() {
      throw new Error('Datasource secret must not be read')
    },
  } as never
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  jest
    .mocked(wasmSchemaEngineLoader.diffDatamodels)
    .mockResolvedValueOnce({ exitCode: 0, stdout: '-- SQL from the real offline API\n' })
  await MigrateDiff.new('prisma').parse(
    ['--from-empty', '--to-schema', 'schema.prisma', '--script'],
    config,
    process.cwd(),
  )
  expect(Migrate.setup).not.toHaveBeenCalled()
  expect(wasmSchemaEngineLoader.diffDatamodels).toHaveBeenCalledWith(
    expect.objectContaining({
      from: { tag: 'empty' },
      to: expect.objectContaining({ tag: 'schemaDatamodel' }),
      script: true,
    }),
  )
  expect(write).toHaveBeenCalledWith('-- SQL from the real offline API\n')
})
test('connected Firebird diff retains the real migration factory route and disposes it', async () => {
  const stop = jest.fn().mockResolvedValue(undefined)
  jest
    .mocked(Migrate.setup)
    .mockResolvedValueOnce({ engine: { migrateDiff: jest.fn().mockResolvedValue({ exitCode: 0 }) }, stop } as never)
  await MigrateDiff.new('prisma').parse(
    ['--from-config-datasource', '--to-schema', 'schema.prisma'],
    { datasource: { url: 'firebird://127.0.0.1/example' } } as never,
    process.cwd(),
  )
  expect(Migrate.setup).toHaveBeenCalledWith(expect.objectContaining({ schemaContext: context }))
  expect(wasmSchemaEngineLoader.diffDatamodels).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledTimes(1)
})
test('offline failure restores stdout capture without constructing or disposing a fake engine', async () => {
  jest.spyOn(CaptureStdout.prototype, 'startCapture').mockImplementation(() => undefined)
  const restore = jest.spyOn(CaptureStdout.prototype, 'stopCapture').mockImplementation(() => undefined)
  jest.mocked(wasmSchemaEngineLoader.diffDatamodels).mockRejectedValueOnce(new Error('offline validation rejected'))
  await expect(
    MigrateDiff.new('prisma').parse(
      ['--from-empty', '--to-schema', 'schema.prisma', '--output', 'unused.sql'],
      {} as never,
      process.cwd(),
    ),
  ).rejects.toThrow('offline validation rejected')
  expect(restore).toHaveBeenCalledTimes(1)
  expect(Migrate.setup).not.toHaveBeenCalled()
})
