/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import { expect, test } from 'vitest'

import { buildGetWasmModule, buildWasmFileMap } from './wasm'

test.each(['fast', 'small'] as const)('loads the Firebird %s compiler without provider aliases', (compilerBuild) => {
  for (const moduleFormat of ['cjs', 'esm'] as const) {
    const extension = moduleFormat === 'cjs' ? 'js' : 'mjs'
    const source = buildGetWasmModule({
      runtimeName: 'client',
      runtimeBase: '@prisma/client/runtime',
      target: 'nodejs',
      activeProvider: 'firebird',
      moduleFormat,
      compilerBuild,
    })

    expect(source).toContain(
      `import("@prisma/client/runtime/query_compiler_${compilerBuild}_bg.firebird.${extension}")`,
    )
    expect(source).toContain(
      `import("@prisma/client/runtime/query_compiler_${compilerBuild}_bg.firebird.wasm-base64.${extension}")`,
    )
    expect(source).toContain(`importName: "./query_compiler_${compilerBuild}_bg.js"`)
  }
})

test('the Node.js Firebird client loads packaged compiler assets without copying edge assets', () => {
  expect(buildWasmFileMap({ activeProvider: 'firebird', runtimeName: 'client', compilerBuild: 'fast' })).toEqual({})
})
