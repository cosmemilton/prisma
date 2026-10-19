/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import type * as esbuild from 'esbuild'
import fs from 'fs'
import lineReplace from 'line-replace'
import path from 'path'

import type { BuildOptions } from '../../../helpers/compile/build'
import { build } from '../../../helpers/compile/build'
import { copyFilePlugin } from '../../../helpers/compile/plugins/copyFilePlugin'

const profile = process.env.PRISMA_CLI_BUILD_PROFILE ?? 'default'
if (profile !== 'default' && profile !== 'firebird') {
  throw new Error('PRISMA_CLI_BUILD_PROFILE must be default or firebird.')
}
const profileDefine = { 'process.env.PRISMA_CLI_BUILD_PROFILE': JSON.stringify(profile) }

/**
 * Manages the extra actions that are needed for the CLI to work
 */
const cliLifecyclePlugin: esbuild.Plugin = {
  name: 'cliLifecyclePlugin',
  setup(build) {
    build.onEnd(async () => {
      // we copy the contents from checkpoint-client to build
      await fs.promises.copyFile(
        path.join(path.dirname(require.resolve('checkpoint-client')), 'child.js'),
        './build/child.js',
      )

      // we copy the contents from xdg-open to build
      await fs.promises.copyFile(path.join(path.dirname(require.resolve('open')), 'xdg-open'), './build/xdg-open')

      // the schema Wasm packages are dependencies of @prisma/internals, so we resolve them from there
      const internalsPath = path.join(__dirname, '..', '..', 'internals')

      const prismaWasmFile = require.resolve('@prisma/prisma-schema-wasm/src/prisma_schema_build_bg.wasm', {
        paths: [internalsPath],
      })
      await fs.promises.copyFile(prismaWasmFile, './build/prisma_schema_build_bg.wasm')

      // the package's `exports` map exposes the JS bindings but not the .wasm file, so we resolve
      // the former and derive the latter
      const schemaEngineRuntimePath = require.resolve('@prisma/schema-engine-wasm/schema_engine_bg', {
        paths: [internalsPath],
      })
      const prismaSchemaEngineWasmFile = path.join(path.dirname(schemaEngineRuntimePath), 'schema_engine_bg.wasm')
      await fs.promises.copyFile(prismaSchemaEngineWasmFile, './build/schema_engine_bg.wasm')

      await copyClientWasmRuntime()

      await replaceFirstLine('./build/index.js', '#!/usr/bin/env node\n')

      chmodX('./build/index.js')
    })
  },
}

async function copyClientWasmRuntime() {
  const clientPath = path.join(__dirname, '..', '..', 'client')
  const clientRuntimePath = path.join(clientPath, 'runtime')
  const allProviders = ['cockroachdb', 'mysql', 'postgresql', 'sqlite', 'sqlserver', 'firebird']
  const providers = profile === 'firebird' ? ['firebird'] : allProviders

  for (const provider of allProviders) {
    for (const build of ['fast', 'small']) {
      const baseName = `query_compiler_${build}_bg.${provider}`
      if (!providers.includes(provider)) {
        // Remove only known assets from a previous default-profile build.
        await Promise.all(
          ['js', 'mjs', 'wasm'].map((extension) => fs.promises.rm(`./build/${baseName}.${extension}`, { force: true })),
        )
        continue
      }

      for (const file of [`${baseName}.js`, `${baseName}.mjs`]) {
        await fs.promises.copyFile(path.join(clientRuntimePath, file), `./build/${file}`)
      }

      // @prisma/query-compiler-wasm is a dependency of @prisma/client, so we resolve it from there
      const wasmFilePath = require.resolve(`@prisma/query-compiler-wasm/${provider}/query_compiler_${build}_bg.wasm`, {
        paths: [clientPath],
      })

      await fs.promises.copyFile(wasmFilePath, `./build/${baseName}.wasm`)
    }
  }
}

async function buildStudioFrontend() {
  const { build } = await import('esbuild')

  await build({
    bundle: true,
    entryPoints: ['src/studio-entry.ts'],
    format: 'esm',
    logLevel: 'error',
    minify: true,
    outfile: 'build/studio.js',
    platform: 'browser',
    target: 'ES2022',
    tsconfig: 'tsconfig.build.json',
  })

  await fs.promises.copyFile(require.resolve('@prisma/studio-core/ui/index.css'), './build/studio.css')
}

/**
 * Setup `import type { ... } from 'prisma'`.
 */
const cliTypesBuildConfig: BuildOptions = {
  name: 'cliTypes',
  entryPoints: ['src/types.ts'],
  outfile: 'build/types',
  bundle: false,
  emitTypes: true,
  minify: false,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

/**
 * Setup `import { ... } from 'prisma/config'`.
 */
const cliConfigBuildConfig: BuildOptions = {
  name: 'cliConfig',
  entryPoints: ['src/config.ts'],

  /**
   * We store `./config.js` and `./config.d.ts` in the root of the package to avoid TypeScript
   * errors for:
   * - users with default `"moduleResolution"` settings in their `tsconfig.json`
   * - users with old and inconsistent bundlers, like `webpack`
   */
  outdir: '.',
  plugins: [copyFilePlugin([{ from: 'dist/cli/src/config.d.ts', to: './config.d.ts' }])],

  bundle: false,
  emitTypes: true,
  minify: false,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

const cliDispatcherBuildConfig: BuildOptions = {
  name: 'cli-dispatcher',
  entryPoints: ['src/bin-dispatcher.ts'],
  outfile: 'build/index',
  plugins: [cliLifecyclePlugin],
  bundle: true,
  external: ['./cli.js', './completion.js'],
  emitTypes: false,
  minify: true,
  define: profileDefine,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

const cliBuildConfig: BuildOptions = {
  name: 'cli',
  entryPoints: ['src/cli-entry.ts'],
  outfile: 'build/cli',
  bundle: true,
  external: ['better-sqlite3', 'esbuild'],
  emitTypes: false,
  minify: true,
  define: profileDefine,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

const cliCompletionBuildConfig: BuildOptions = {
  name: 'cli-completion',
  entryPoints: ['src/completions/completion-entry.ts'],
  outfile: 'build/completion',
  bundle: true,
  emitTypes: false,
  minify: true,
  define: profileDefine,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

// Setup preinstall
const preinstallBuildConfig: BuildOptions = {
  name: 'preinstall',
  entryPoints: ['scripts/preinstall.ts'],
  outfile: 'preinstall/index',
  bundle: true,
  emitTypes: false,
  minify: true,
  emitMetafile: process.env.PRISMA_BUILD_METAFILE === 'true',
}

const optionalPlugins = process.env.DEV === 'true' ? [] : [cliTypesBuildConfig, cliConfigBuildConfig]

build([
  ...optionalPlugins,
  cliDispatcherBuildConfig,
  cliBuildConfig,
  ...(profile === 'default' ? [cliCompletionBuildConfig] : []),
  preinstallBuildConfig,
])
  .then(async () => {
    if (profile === 'default') {
      await buildStudioFrontend()
    } else {
      // A profile rebuild must not retain a previous default build's UI assets.
      await Promise.all(
        ['build/studio.js', 'build/studio.css', 'build/completion.js', 'build/cli-completion.meta.json'].map((file) =>
          fs.promises.rm(file, { force: true }),
        ),
      )
    }
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })

// Utils ::::::::::::::::::::::::::::::::::::::::::::::::::

function chmodX(filename: string) {
  const s = fs.statSync(filename)
  const newMode = s.mode | 64 | 8 | 1
  if (s.mode === newMode) return
  const base8 = newMode.toString(8).slice(-3)
  fs.chmodSync(filename, base8)
}

function replaceFirstLine(filename: string, line: string) {
  return new Promise((resolve) => {
    lineReplace({
      file: filename,
      line: 1,
      text: line,
      addNewLine: false,
      callback: resolve,
    })
  })
}
