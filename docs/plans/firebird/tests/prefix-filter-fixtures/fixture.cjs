/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
'use strict'

// Only synthetic fixture data. Each key fits the original physical VARCHAR(10).
const keys = ['%P1', '_U1', 'A%P2', 'A_U2', 'X123456789', 'A\\E3', "O'Neil", '',
  'Ab01', 'ab02', '\u00c1c03', 'ac04', '\u00e905', 'e\u030106', '\u{1f600}07', '\u{10400}08', '\u{10428}09']
const profiles = [
  { id: 'utf8-binary', model: 'aliquotaIbpt', table: 'IBPT', collation: 'UTF8' },
  { id: 'utf8-ci-ai', model: 'aliquotaIbptCiAi', table: 'IBPT_CI_AI', collation: 'UNICODE_CI_AI' },
]
const prefixCases = [
  ['literal-percent', '%'], ['literal-underscore', '_'], ['internal-percent', 'A%'], ['internal-underscore', 'A_'],
  ['backslash', 'A\\'], ['apostrophe', "O'"], ['empty', ''], ['ten', 'X123456789'], ['eleven', 'X1234567890'],
  ['hundred', 'X'.repeat(100)], ['case', 'a'], ['accent', '\u00e1'], ['composed', '\u00e9'], ['decomposed', 'e\u0301'],
  ['astral-emoji', '\u{1f600}'], ['astral-case', '\u{10428}'],
]
const cityProfiles = [
  { id: 'cities-current', model: 'cidadeLegado', table: 'IBGE', municipioWidth: 35, estadoWidth: 25 },
  { id: 'cities-prior', model: 'cidadeLegadoAnterior', table: 'IBGE_OLD', municipioWidth: 30, estadoWidth: 20 },
]
const cityRows = width => [
  [1, '%CENTRO', 'PERNAMBUCO', 'PE'], [2, '_CENTRO', 'PARANA', 'PR'], [3, 'RECIFE', 'PERNAMBUCO', 'PE'],
  [4, 'A%VILA', 'ALAGOAS', 'AL'], [5, 'A_VILA', 'AMAZONAS', 'AM'], [6, 'M'.repeat(width), 'ESTADO', 'ES'],
  [7, null, null, null], [8, 'PE BAIRRO', 'PE', 'PE'],
  [9, '%VILA', '%', '%'], [10, 'ZVILA', '_', '_'],
]
const boundary = 'B'.repeat(8191)
const identitySql = "SELECT MON$DATABASE_NAME DATABASE_PATH,RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') ENGINE_VERSION,MON$SQL_DIALECT DIALECT,MON$ODS_MAJOR ODS_MAJOR FROM MON$DATABASE"
const emptyCatalogSql = 'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0'
const fieldSql = table => `SELECT TRIM(RF.RDB$FIELD_NAME) FIELD_NAME,F.RDB$FIELD_TYPE FIELD_TYPE,F.RDB$FIELD_LENGTH LENGTH_BYTES,F.RDB$CHARACTER_LENGTH LENGTH_CHARS,F.RDB$FIELD_PRECISION FIELD_PRECISION,F.RDB$FIELD_SCALE FIELD_SCALE,RF.RDB$NULL_FLAG NOT_NULL,TRIM(CS.RDB$CHARACTER_SET_NAME) CHARACTER_SET,TRIM(C.RDB$COLLATION_NAME) COLLATION_NAME FROM RDB$RELATION_FIELDS RF JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME=RF.RDB$FIELD_SOURCE LEFT JOIN RDB$CHARACTER_SETS CS ON CS.RDB$CHARACTER_SET_ID=F.RDB$CHARACTER_SET_ID LEFT JOIN RDB$COLLATIONS C ON C.RDB$CHARACTER_SET_ID=F.RDB$CHARACTER_SET_ID AND C.RDB$COLLATION_ID=COALESCE(RF.RDB$COLLATION_ID,F.RDB$COLLATION_ID,0) WHERE RF.RDB$RELATION_NAME='${table}' ORDER BY RF.RDB$FIELD_POSITION`
const keySql = table => `SELECT TRIM(S.RDB$FIELD_NAME) FIELD_NAME FROM RDB$RELATION_CONSTRAINTS RC JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME=RC.RDB$INDEX_NAME WHERE RC.RDB$CONSTRAINT_TYPE='PRIMARY KEY' AND RC.RDB$RELATION_NAME='${table}' ORDER BY S.RDB$FIELD_POSITION`
const setup = []
for (const profile of profiles) {
  setup.push({ sql: `CREATE TABLE ${profile.table}(COD_NCM VARCHAR(10) CHARACTER SET UTF8 NOT NULL PRIMARY KEY COLLATE ${profile.collation},ALIQNAC NUMERIC(15,2),ALIQIMP NUMERIC(15,2),ALIQEST NUMERIC(15,2),ALIQMUN NUMERIC(15,2))`, args: [] })
  for (const key of keys) setup.push({ sql: `INSERT INTO ${profile.table}(COD_NCM,ALIQNAC,ALIQIMP,ALIQEST,ALIQMUN) VALUES(?,1.23,2.34,3.45,4.56)`, args: [key] })
}
for (const profile of cityProfiles) {
  setup.push({ sql: `CREATE TABLE ${profile.table}(COD_MUN INTEGER NOT NULL PRIMARY KEY,NOME_MUNICIPIO VARCHAR(${profile.municipioWidth}) CHARACTER SET UTF8,ESTADO VARCHAR(${profile.estadoWidth}) CHARACTER SET UTF8,SIGLA VARCHAR(2) CHARACTER SET UTF8)`, args: [] })
  for (const row of cityRows(profile.municipioWidth)) setup.push({ sql: `INSERT INTO ${profile.table}(COD_MUN,NOME_MUNICIPIO,ESTADO,SIGLA) VALUES(?,?,?,?)`, args: row })
}
setup.push({ sql: 'CREATE TABLE M7_PREFIX_BOUNDARY(ID INTEGER NOT NULL PRIMARY KEY,PREFIX_TEXT VARCHAR(8191) CHARACTER SET UTF8 NOT NULL)', args: [] })
setup.push({ sql: 'INSERT INTO M7_PREFIX_BOUNDARY(ID,PREFIX_TEXT) VALUES(?,?)', args: [1, boundary] })
module.exports = { keys, profiles, prefixCases, cityProfiles, cityRows, boundary, identitySql, emptyCatalogSql, fieldSql, keySql, setup,
  expectedScenarioCount: 103,
  tables: [...profiles, ...cityProfiles, { table: 'M7_PREFIX_BOUNDARY' }].map(profile => profile.table) }
