/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import fs from 'node:fs'
import vm from 'node:vm'

import { defaultConfig } from '@prisma/config'
import { ensureNeededBinariesExist } from '@prisma/engines'
import { transformSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CLI } from '../CLI'
import { runCheckpointClientCheck } from '../utils/checkpoint'
import { Version } from '../Version'

vi.mock('@prisma/engines', async (actual) => ({
  ...(await actual<typeof import('@prisma/engines')>()),
  ensureNeededBinariesExist: vi.fn(),
}))
vi.mock('../utils/checkpoint', () => ({ runCheckpointClientCheck: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../Version', () => ({ Version: { new: vi.fn(() => ({ parse: vi.fn().mockResolvedValue('Wasm version') })) } }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('local Firebird CLI profile', () => {
  it('executes the real command parser without downloading native engines or checking updates', async () => {
    vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'firebird')
    const parse = vi.fn().mockResolvedValue('valid')
    const cli = CLI.new({ validate: { parse } }, ['validate'], vi.fn(), 'prisma')
    expect(await cli.parse(['validate', '--schema=fixture.prisma'], defaultConfig())).toBe('valid')
    expect(parse).toHaveBeenCalled()
    expect(ensureNeededBinariesExist).not.toHaveBeenCalled()
    expect(runCheckpointClientCheck).not.toHaveBeenCalled()
  })
  it('reports version through the actual version command without native preflight', async () => {
    vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'firebird')
    const cli = CLI.new({}, [], vi.fn(), 'prisma')
    expect(await cli.parse(['--version'], defaultConfig())).toBe('Wasm version')
    expect(Version.new).toHaveBeenCalledWith('prisma')
    expect(ensureNeededBinariesExist).not.toHaveBeenCalled()
  })
  it('keeps the default native preflight for existing commands', async () => {
    const cli = CLI.new({ validate: { parse: vi.fn().mockResolvedValue('valid') } }, ['validate'], vi.fn(), 'prisma')
    await cli.parse(['validate'], defaultConfig())
    expect(ensureNeededBinariesExist).toHaveBeenCalledOnce()
  })
  it('advertises only commands present in the local profile', () => {
    vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'firebird')
    const help = CLI.new({}, [], vi.fn(), 'prisma').help()
    expect(help).toContain('init       Set up a Firebird project')
    expect(help).not.toContain('studio   Browse')
    expect(help).not.toContain('dev   Start')
    expect(help).not.toContain('complete   Generate shell completion scripts')
  })
  it('rejects the excluded completion command through the regular parser', async () => {
    vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'firebird')
    const result = await CLI.new({}, [], vi.fn(), 'prisma').parse(['complete', 'fish'], defaultConfig())
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('complete')
    expect(ensureNeededBinariesExist).not.toHaveBeenCalled()
  })
  it.each([
    ['firebird', 'complete', './cli.js'],
    ['firebird', 'validate', './cli.js'],
    ['default', 'complete', './completion.js'],
    ['default', 'validate', './cli.js'],
  ])('dispatches the actual %s entry for %s to %s', (profile, command, entry) => {
    const source = fs.readFileSync(new URL('../bin-dispatcher.ts', import.meta.url), 'utf8')
    const built = transformSync(source, {
      loader: 'ts',
      format: 'cjs',
      minify: true,
      define: { 'process.env.PRISMA_CLI_BUILD_PROFILE': JSON.stringify(profile) },
    })
    const load = vi.fn()
    vm.runInNewContext(built.code, { process: { argv: ['node', 'index.js', command] }, require: load })
    expect(load).toHaveBeenCalledExactlyOnceWith(entry)
    if (profile === 'firebird') expect(built.code).not.toContain('require("./completion.js")')
  })
})
