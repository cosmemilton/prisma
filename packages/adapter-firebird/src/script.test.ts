/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import { describe, expect, it } from 'vitest'

import { splitScript } from './script'

describe('Firebird scripts', () => {
  it('keeps delimiters in strings, identifiers and comments', () => {
    expect(
      splitScript("INSERT INTO \"a;b\" VALUES ('it''s;fine'); -- ignored;\n SELECT 1 FROM RDB$DATABASE; /* ; */"),
    ).toEqual(["INSERT INTO \"a;b\" VALUES ('it''s;fine')", '-- ignored;\n SELECT 1 FROM RDB$DATABASE'])
  })

  it('retains nested PSQL bodies including variable declarations', () => {
    const block = 'EXECUTE BLOCK AS DECLARE VARIABLE n INTEGER; BEGIN n = 1; BEGIN n = 2; END END'
    expect(splitScript(`${block}; SELECT 1 FROM RDB$DATABASE;`)).toEqual([block, 'SELECT 1 FROM RDB$DATABASE'])
  })

  it('splits DROP routine statements and ALTER TRIGGER activation statements', () => {
    const statements = [
      'DROP TRIGGER t',
      'DROP PROCEDURE p',
      'DROP FUNCTION f',
      'ALTER TRIGGER t ACTIVE',
      'ALTER TRIGGER t INACTIVE',
      'CREATE TABLE X (id INT)',
    ]
    expect(splitScript(statements.join('; ') + ';')).toEqual(statements)
  })

  it('recognizes actual routine definitions and waits for BEGIN after declarations', () => {
    const procedure =
      'CREATE OR ALTER PROCEDURE p AS DECLARE VARIABLE n INTEGER = CASE WHEN 1 = 1 THEN 1 ELSE 2 END; BEGIN n = 3; END'
    expect(splitScript(`${procedure}; DROP PROCEDURE p;`)).toEqual([procedure, 'DROP PROCEDURE p'])
    const trigger = "ALTER TRIGGER t AS BEGIN POST_EVENT 'changed;now'; END"
    expect(splitScript(`${trigger}; ALTER TRIGGER t ACTIVE;`)).toEqual([trigger, 'ALTER TRIGGER t ACTIVE'])
  })

  it('rejects isql directives and unfinished literals before execution', () => {
    expect(() => splitScript('SET TERM ^ ;')).toThrow('SET TERM')
    expect(() => splitScript('-- directive follows\n SET /* delimiter */ TERM ^ ;')).toThrow('SET TERM')
    expect(() => splitScript("SELECT 'unterminated")).toThrow()
  })

  it('does not mistake strings or comments containing SET TERM for client directives', () => {
    const statement = "INSERT INTO t (s) VALUES ('text\nSET TERM ^;\ntext')"
    expect(splitScript(`/* SET TERM ^; */ ${statement}; -- SET TERM ^;`)).toEqual([`/* SET TERM ^; */ ${statement}`])
  })

  it.each([
    "q'{That's; a string}'",
    "Q'[That's; a string]'",
    "q'(That's; a string)'",
    "q'<That's; a string>'",
    "q'!That's; a string!'",
  ])('retains Firebird 3 alternative quoted strings %s', (literal) => {
    const statement = `INSERT INTO t (s) VALUES (${literal})`
    expect(splitScript(`${statement}; SELECT 1 FROM RDB$DATABASE;`)).toEqual([statement, 'SELECT 1 FROM RDB$DATABASE'])
  })

  it('rejects unfinished alternative strings and ignores comment-only statements', () => {
    expect(() => splitScript("INSERT INTO t VALUES (q'{unfinished');")).toThrow('Unterminated alternative SQL string')
    expect(splitScript('/* comment */; -- comment\n;')).toEqual([])
  })
})
