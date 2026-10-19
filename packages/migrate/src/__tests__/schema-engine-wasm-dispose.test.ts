/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import type { ErrorCapturingSqlMigrationAwareDriverAdapterFactory } from '@prisma/driver-adapter-utils'
import { wasm, wasmSchemaEngineLoader } from '@prisma/internals'

import { SchemaEngineWasm } from '../SchemaEngineWasm'

jest.mock('@prisma/internals', () => ({
  ...jest.requireActual('@prisma/internals'),
  wasmSchemaEngineLoader: { loadSchemaEngine: jest.fn() },
}))

const adapter = {
  errorRegistry: {},
} as ErrorCapturingSqlMigrationAwareDriverAdapterFactory

beforeEach(() => {
  jest.clearAllMocks()
})

test('awaits asynchronous connector disposal before freeing Wasm and shares concurrent stops', async () => {
  let completeDisposal!: () => void
  const disposal = new Promise<void>((resolve) => {
    completeDisposal = resolve
  })
  const engine = { dispose: jest.fn(() => disposal), free: jest.fn() }
  jest.mocked(wasmSchemaEngineLoader.loadSchemaEngine).mockResolvedValue(engine as unknown as wasm.SchemaEngineWasm)
  const wrapper = await SchemaEngineWasm.setup({ adapter })

  const firstStop = wrapper.stop()
  expect(wrapper.stop()).toBe(firstStop)
  expect(engine.dispose).toHaveBeenCalledTimes(1)
  expect(engine.free).not.toHaveBeenCalled()

  completeDisposal()
  await firstStop
  expect(engine.free).toHaveBeenCalledTimes(1)
  await wrapper.stop()
  expect(engine.free).toHaveBeenCalledTimes(1)
})

test('still frees Wasm when explicit connector disposal fails', async () => {
  const engine = { dispose: jest.fn().mockRejectedValue(new Error('dispose rejected')), free: jest.fn() }
  jest.mocked(wasmSchemaEngineLoader.loadSchemaEngine).mockResolvedValue(engine as unknown as wasm.SchemaEngineWasm)
  const wrapper = await SchemaEngineWasm.setup({ adapter })

  await expect(wrapper.stop()).rejects.toThrow('dispose rejected')
  expect(engine.free).toHaveBeenCalledTimes(1)
})

test('retains compatibility with an engine that only exposes free', async () => {
  const engine = { free: jest.fn() }
  jest.mocked(wasmSchemaEngineLoader.loadSchemaEngine).mockResolvedValue(engine as unknown as wasm.SchemaEngineWasm)
  const wrapper = await SchemaEngineWasm.setup({ adapter })

  await wrapper.stop()
  expect(engine.free).toHaveBeenCalledTimes(1)
})
