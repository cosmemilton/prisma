// Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md.
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  migrations: { path: './migrations', seed: 'node ../../fixtures/client-runner.mjs db-seed' },
  datasource: { url: env('DATABASE_URL'), shadowDatabaseUrl: env('SHADOW_DATABASE_URL') },
})
