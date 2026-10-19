/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const workspace = path.resolve(__dirname, '../../../../..')
const laboratory = path.join(workspace, 'firebird-client-lab')
const data = JSON.parse(fs.readFileSync(path.join(laboratory, 'private/schema-connections.json'), 'utf8'))
const tokens = []
for (const config of Object.values(data)) {
  const url = `firebird://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database.replaceAll('\\', '/'))}`
  for (const value of [url, config.user, config.password, config.database, config.database.replaceAll('\\', '/')]) {
    if (typeof value !== 'string' || value.length === 0) continue
    tokens.push(value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1))
  }
}
const ordered = [...new Set(tokens)].sort((a, b) => b.length - a.length)
const rawPath = path.join(laboratory, 'private/schema-migrations-test.raw.log')
let publicText = fs.readFileSync(rawPath, 'utf8').replace(/firebird:\/\/[^\s"'<>]+/gi, '<REDACTED_FIREBIRD_URL>')
for (const token of ordered) publicText = publicText.replaceAll(token, '<REDACTED>')
if (ordered.some((token) => token.length >= 3 && publicText.includes(token))) {
  throw new Error('Private token remains in log')
}
const destination = path.join(workspace, 'artifacts/firebird-schema-migrations-test.log')
fs.writeFileSync(destination, publicText)
process.stdout.write(JSON.stringify({ redacted: true, publicLogBytes: Buffer.byteLength(publicText) }) + '\n')
