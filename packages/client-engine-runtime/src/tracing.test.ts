/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import { expect, test } from 'vitest'

import { providerToOtelSystem } from './tracing'

test('Firebird query spans keep their own database system', () => {
  expect(providerToOtelSystem('firebird')).toBe('firebird')
})
