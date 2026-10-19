/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import type { QueryCompilerConstructor } from '@prisma/client-common'

import { wasmQueryCompilerLoader } from './WasmQueryCompilerLoader'

test('keeps Firebird compiler instances separate from other database providers', async () => {
  const module = new WebAssembly.Module(
    Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 20, 1, 16, 95, 95, 119, 98, 105, 110, 100, 103,
      101, 110, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
    ]),
  )
  const makeConstructor = (): QueryCompilerConstructor =>
    class {
      compile = jest.fn()
      compileBatch = jest.fn()
      free = jest.fn()
    }
  const firebirdConstructor = makeConstructor()
  const postgresConstructor = makeConstructor()
  const firebirdRuntime = { __wbg_set_wasm: jest.fn(), QueryCompiler: firebirdConstructor }
  const postgresRuntime = { __wbg_set_wasm: jest.fn(), QueryCompiler: postgresConstructor }
  const firebirdConfig = {
    activeProvider: 'firebird',
    clientVersion: '0.0.0',
    compilerWasm: {
      getRuntime: jest.fn().mockResolvedValue(firebirdRuntime),
      getQueryCompilerWasmModule: async () => module,
      importName: './query_compiler_fast_bg.js',
    },
  }
  const postgresConfig = {
    ...firebirdConfig,
    activeProvider: 'postgresql',
    compilerWasm: {
      ...firebirdConfig.compilerWasm,
      getRuntime: jest.fn().mockResolvedValue(postgresRuntime),
    },
  }

  expect(await wasmQueryCompilerLoader.loadQueryCompiler(firebirdConfig)).toBe(firebirdConstructor)
  expect(await wasmQueryCompilerLoader.loadQueryCompiler(postgresConfig)).toBe(postgresConstructor)
  expect(await wasmQueryCompilerLoader.loadQueryCompiler(firebirdConfig)).toBe(firebirdConstructor)
  expect(firebirdConfig.compilerWasm.getRuntime).toHaveBeenCalledTimes(1)
  expect(firebirdRuntime.__wbg_set_wasm).toHaveBeenCalledTimes(1)
  expect(postgresRuntime.__wbg_set_wasm).toHaveBeenCalledTimes(1)
})
