// Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
import { defineConfig, env } from 'prisma/config'
export default defineConfig({ schema: './schema.prisma', datasource: { url: env('DATABASE_URL') } })
