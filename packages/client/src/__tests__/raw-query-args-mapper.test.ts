/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import { Sql } from '@prisma/client-runtime-utils'

import { rawQueryArgsMapper } from '../runtime/core/raw-query/rawQueryArgsMapper'

test.each(['$queryRaw', '$executeRaw'])('Firebird %s uses positional question-mark placeholders', (clientMethod) => {
  const mapArgs = rawQueryArgsMapper({ clientMethod, activeProvider: 'firebird', clientVersion: '0.0.0' })
  const query = new Sql(['SELECT ', ' FROM RDB$DATABASE WHERE ', ' = ', ''], ['value', 1, 1])

  expect(mapArgs(query)).toEqual({
    query: 'SELECT ? FROM RDB$DATABASE WHERE ? = ?',
    parameters: { values: '["value",1,1]', __prismaRawParameters__: true },
  })
})
