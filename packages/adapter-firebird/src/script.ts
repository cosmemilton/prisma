/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { DriverAdapterError } from '@prisma/driver-adapter-utils'

/** Splits SQL scripts on unquoted delimiters, retaining complete PSQL bodies. */
export function splitScript(script: string): string[] {
  const statements: string[] = []
  let start = 0
  let index = 0
  let depth = 0
  let quote: string | undefined
  let routine = false
  let sawBegin = false
  let hasContent = false
  let tokens: string[] = []
  while (index < script.length) {
    const char = script[index]
    if (quote) {
      if (char === quote) {
        if (script[index + 1] === quote) index++
        else quote = undefined
      }
    } else if (char === "'" || char === '"') {
      quote = char
      hasContent = true
    } else if (char === '-' && script[index + 1] === '-') {
      index = script.indexOf('\n', index + 2)
      if (index === -1) index = script.length
    } else if (char === '/' && script[index + 1] === '*') {
      const end = script.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Unterminated SQL comment')
      index = end + 1
    } else if ((char === 'q' || char === 'Q') && script[index + 1] === "'") {
      const opener = script[index + 2]
      const closer = ({ '(': ')', '{': '}', '[': ']', '<': '>' } as Record<string, string>)[opener] ?? opener
      const end = closer === undefined ? -1 : script.indexOf(`${closer}'`, index + 3)
      if (end === -1) throw new Error('Unterminated alternative SQL string')
      index = end + 1
      hasContent = true
    } else if (/[a-z_]/i.test(char)) {
      const match = /^[a-z_][a-z_0-9$]*/i.exec(script.slice(index))![0]
      const token = match.toUpperCase()
      tokens.push(token)
      hasContent = true
      if (tokens.length === 2 && tokens[0] === 'SET' && token === 'TERM') {
        throw new DriverAdapterError({
          kind: 'InvalidInputValue',
          message: 'SET TERM is an isql directive; omit it from adapter scripts',
        })
      }
      if (token === 'AS' && isRoutineDefinition(tokens)) routine = true
      if (token === 'BEGIN') {
        depth++
        sawBegin = true
      } else if (token === 'CASE') depth++
      else if (token === 'END') depth--
      index += match.length - 1
    } else if (char === ';' && depth === 0 && (!routine || sawBegin)) {
      const statement = script.slice(start, index).trim()
      if (hasContent) statements.push(statement)
      start = index + 1
      routine = false
      sawBegin = false
      hasContent = false
      tokens = []
    } else if (!/\s/.test(char)) {
      hasContent = true
    }
    index++
  }
  if (quote || depth !== 0) throw new Error('Unterminated SQL string or PSQL block')
  const remainder = script.slice(start).trim()
  if (hasContent) statements.push(remainder)
  return statements
}

function isRoutineDefinition(tokens: string[]): boolean {
  const prefix = tokens.slice(0, 4).join(' ')
  return /^(?:(?:CREATE(?: OR ALTER)?|ALTER|RECREATE) (?:PROCEDURE|TRIGGER|FUNCTION)|EXECUTE BLOCK)(?: |$)/.test(prefix)
}
