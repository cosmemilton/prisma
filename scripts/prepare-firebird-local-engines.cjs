/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
// Development packaging only. No registry package is published by this script.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const ormRoot = path.resolve(__dirname, '..')
const enginesRoot = path.resolve(ormRoot, '../prisma-engines-firebird')
const output = path.join(enginesRoot, 'target/query-compiler-wasm')
const pinnedVersion = '8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8'

async function filesBelow(directory, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(directory, entry.name), relative))
    else result.push(relative)
  }
  return result
}

async function main() {
  const officialMetadata = process.argv[2]
    ? path.resolve(process.argv[2], 'package.json')
    : require.resolve('@prisma/query-compiler-wasm/package.json', { paths: [path.join(ormRoot, 'packages/client')] })
  const source = path.dirname(officialMetadata)
  const metadata = JSON.parse(await fs.readFile(officialMetadata, 'utf8'))
  assert.equal(metadata.version, pinnedVersion, 'Use the exact unchanged paired upstream compiler package')
  assert.notEqual(source, output, 'The source must be the original upstream package')
  const localMetadata = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'))
  assert.equal(localMetadata.name, '@prisma/query-compiler-wasm')
  await fs.access(path.join(output, 'firebird/query_compiler_fast_bg.wasm'))
  const components = []
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!/^(?:licen[cs]e|notice|copying|copyright)/i.test(entry.name)) continue
    await fs.cp(path.join(source, entry.name), path.join(output, entry.name), { recursive: true })
  }
  for (const provider of ['postgresql', 'mysql', 'sqlite', 'sqlserver', 'cockroachdb']) {
    const providerSource = path.join(source, provider)
    await fs.cp(providerSource, path.join(output, provider), { recursive: true })
    for (const relative of await filesBelow(providerSource)) {
      const bytes = await fs.readFile(path.join(providerSource, relative))
      const copied = await fs.readFile(path.join(output, provider, relative))
      assert.ok(bytes.equals(copied), `Unchanged upstream bytes: ${provider}/${relative}`)
      components.push({ path: `${provider}/${relative}`, origin: 'unchanged upstream npm package', sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    }
  }
  for (const relative of await filesBelow(path.join(output, 'firebird'))) {
    const bytes = await fs.readFile(path.join(output, 'firebird', relative))
    components.push({ path: `firebird/${relative}`, origin: 'local modified engines build', sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  // Keep the original engine license beside the development artifacts as well.
  await fs.copyFile(path.join(enginesRoot, 'LICENSE'), path.join(output, 'LICENSE.prisma-engines'))
  try { await fs.access(path.join(output, 'LICENSE')) }
  catch { await fs.copyFile(path.join(enginesRoot, 'LICENSE'), path.join(output, 'LICENSE')) }
  await fs.copyFile(path.join(enginesRoot, 'LICENSE'), path.join(enginesRoot, 'target/prisma-schema-wasm/LICENSE'))
  const manifest = { upstreamVersion: pinnedVersion, localVersion: localMetadata.version, buildProfile: 'dev', separateFastSmallOptimization: false, studioIncluded: false, components }
  await fs.writeFile(path.join(output, 'firebird-provenance.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Prepared local development compiler package; ${components.length} artifacts verified. Studio excluded.`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
