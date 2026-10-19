// Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
import { defineConfig } from 'prisma/config'

export default defineConfig({ schema: './schema.prisma', migrations: { path: './migrations' } })
