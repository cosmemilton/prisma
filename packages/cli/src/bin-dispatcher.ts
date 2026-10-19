#!/usr/bin/env node
/*! Modified for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

if (process.env.PRISMA_CLI_BUILD_PROFILE !== 'firebird' && process.argv[2] === 'complete') {
  require('./completion.js')
} else {
  require('./cli.js')
}
