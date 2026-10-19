/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */

import type { Commands } from '@prisma/internals'

import { Bootstrap } from './bootstrap/Bootstrap'
import { Completions } from './completions'
import { Mcp } from './mcp/MCP'
import { Platform } from './platform/_Platform'
import { Link as PostgresLink } from './postgres/link/Link'
import { PostgresCommand } from './postgres/PostgresCommand'
import { Status } from './Status'
import { Studio } from './Studio'
import { SubCommand } from './SubCommand'
import type { CliDistributionIdentity } from './utils/cli-distribution-identity'

/** Optional upstream commands are excluded at build time by the local profile. */
export function createDefaultCommands(identity: CliDistributionIdentity): Commands {
  return {
    bootstrap: Bootstrap.new(identity),
    complete: Completions.new(identity),
    mcp: Mcp.new(identity),
    postgres: PostgresCommand.new({ link: PostgresLink.new(identity) }, identity),
    dev: new SubCommand('@prisma/cli-dev', identity),
    studio: Studio.new(identity),
    platform: Platform.$.new({ status: Status.new(identity) }, identity),
  }
}
