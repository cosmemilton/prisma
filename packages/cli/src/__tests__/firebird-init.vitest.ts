/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import fs from 'node:fs'

import { defaultConfig as config } from '@prisma/config'
import { canConnectToDatabase } from '@prisma/internals'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { defaultEnv, defaultPort, defaultURL, Init } from '../Init'
import { installSkills } from '../init/skill-install'
import { login } from '../management-api/auth'
import { createAuthenticatedManagementAPI } from '../management-api/auth-client'
import { FileTokenStorage } from '../management-api/token-storage'

const { writes } = vi.hoisted(() => ({ writes: new Map<string, string>() }))
vi.mock('@prisma/internals', async (actual) => ({
  ...(await actual<typeof import('@prisma/internals')>()),
  canConnectToDatabase: vi.fn(),
}))
vi.mock('../init/file-writer', () => ({
  FileWriter: vi.fn(function () {
    return { write: (file: string, content: string) => writes.set(file, content), format: () => 'generated files' }
  }),
}))
vi.mock('../init/skill-install', () => ({ installSkills: vi.fn() }))
vi.mock('../management-api/token-storage', () => ({
  FileTokenStorage: vi.fn(function () {
    return { getTokens: vi.fn().mockResolvedValue(null) }
  }),
}))
vi.mock('../management-api/auth', () => ({ login: vi.fn() }))
vi.mock('../management-api/auth-client', () => ({ createAuthenticatedManagementAPI: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  writes.clear()
  vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'firebird')
  vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
  vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('uses a non-connecting Firebird placeholder and the default port', async () => {
  expect(defaultPort('firebird')).toBe(3050)
  expect(defaultURL('firebird')).toBe('firebird://USER:PASSWORD@127.0.0.1:3050/ABSOLUTE_DATABASE_PATH')
  const result = await Init.new('prisma').parse(['--datasource-provider', 'firebird', '--with-model'], config())
  expect(result).toContain('No database or server was created')
  expect([...writes.values()].some((value) => value.includes('provider = "firebird"'))).toBe(true)
  expect([...writes.values()].some((value) => value.includes(defaultURL('firebird')!))).toBe(true)
  expect(canConnectToDatabase).not.toHaveBeenCalled()
  expect(installSkills).not.toHaveBeenCalled()
  expect(FileTokenStorage).not.toHaveBeenCalled()
  expect(login).not.toHaveBeenCalled()
  expect(createAuthenticatedManagementAPI).not.toHaveBeenCalled()
})
it('defaults to Firebird without starting a dev server', async () => {
  await Init.new('prisma').parse([], config())
  expect([...writes.values()].some((value) => value.includes('provider = "firebird"'))).toBe(true)
  await expect(defaultEnv(undefined, false, true, 'prisma')).rejects.toThrow(
    'never starts a development database server',
  )
})
it('scaffolds an explicit Firebird URL without any database connection', async () => {
  await Init.new('prisma').parse(['--url', 'firebird://user:placeholder@127.0.0.1:3050/example.fdb'], config())
  expect(canConnectToDatabase).not.toHaveBeenCalled()
})
it.each([['--db'], ['--datasource-provider', 'postgresql'], ['--url', 'postgresql://localhost/example']])(
  'rejects provisioning or a non-Firebird initialization before side effects: %j',
  async (...args) => {
    await expect(Init.new('prisma').parse(args, config())).rejects.toThrow(/local Firebird CLI profile/)
    expect(writes.size).toBe(0)
    expect(canConnectToDatabase).not.toHaveBeenCalled()
  },
)
it('preserves the default cloud authentication path before scaffolding', async () => {
  vi.stubEnv('PRISMA_CLI_BUILD_PROFILE', 'default')
  const result = await Init.new('prisma').parse(['--db', '--non-interactive'], config())
  expect(result).toBe('Please authenticate before creating a Prisma Postgres project.')
  expect(FileTokenStorage).toHaveBeenCalledOnce()
  expect(login).not.toHaveBeenCalled()
  expect(writes.size).toBe(0)
})
