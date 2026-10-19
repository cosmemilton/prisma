/*! Added for experimental Firebird support (2026-10-18); see MODIFICATIONS.md. */
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

export const firebirdDatamodel = `
generator client {
  provider = "prisma-client"
  output = "./generated"
}

datasource db {
  provider = "firebird"
}

model User {
  id        Int       @id
  email     String    @unique @db.VarChar(255)
  name      String?   @db.VarChar(255)
  balance   Decimal?  @db.Decimal(18, 4)
  bigValue  BigInt?
  createdAt DateTime? @db.Timestamp
  active    Boolean?
  bytes     Bytes?    @db.Blob
  dateValue DateTime? @db.Date
  timeValue DateTime? @db.Time
  posts     Post[]
}

model Post {
  id        Int      @id
  title     String   @db.VarChar(255)
  content   String?  @db.Text
  published Boolean?
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id])
}

model AutoUser {
  id      Int        @id @default(autoincrement())
  email   String     @unique @db.VarChar(255)
  name    String?    @db.VarChar(255)
  tag     String     @default(dbgenerated("'db-default'")) @db.VarChar(64)
  active  Boolean    @default(true)
  balance Decimal?   @db.Decimal(18, 4)
  posts   AutoPost[]
}

model AutoPost {
  id       Int      @id @default(autoincrement())
  title    String   @db.VarChar(255)
  authorId Int
  author   AutoUser @relation(fields: [authorId], references: [id])
}

model BigAuto {
  id   BigInt  @id @default(autoincrement())
  note String? @db.VarChar(255)
}

model IdentityOnly {
  id Int @id @default(autoincrement())
}

model LegacyAuto {
  id   Int    @id @default(dbgenerated())
  note String @db.VarChar(255)
}
`

export interface FirebirdGeneratedClientPaths {
  workspaceRoot: string
  ormRoot: string
  labRoot: string
  schemaPath: string
  outputDir: string
  clientModulePath: string
  metadataPath: string
}

export function generatedClientPaths(
  workspaceRoot = path.resolve(__dirname, '../../../../..'),
): FirebirdGeneratedClientPaths {
  const root = path.resolve(workspaceRoot)
  const labRoot = path.join(root, 'firebird-client-lab')
  const outputDir = path.join(labRoot, 'generated')

  return {
    workspaceRoot: root,
    ormRoot: path.join(root, 'prisma-firebird'),
    labRoot,
    schemaPath: path.join(labRoot, 'schema.prisma'),
    outputDir,
    clientModulePath: path.join(outputDir, 'client.ts'),
    metadataPath: path.join(labRoot, 'generated-client.json'),
  }
}

export async function setupGeneratedClient(
  options: { workspaceRoot?: string; compilerBuild?: 'fast' | 'small' } = {},
): Promise<FirebirdGeneratedClientPaths> {
  const locations = generatedClientPaths(options.workspaceRoot)
  const requireFromGenerator = createRequire(
    path.join(locations.ormRoot, 'packages', 'client-generator-ts', 'package.json'),
  )
  const { generateClient, getDMMF } = requireFromGenerator('@prisma/client-generator-ts')
  const compilerBuild = options.compilerBuild ?? 'fast'
  const engineVersion = requireFromGenerator('@prisma/engines-version').enginesVersion

  await fs.mkdir(locations.labRoot, { recursive: true })
  await fs.writeFile(locations.schemaPath, firebirdDatamodel)

  const dmmf = await getDMMF({ datamodel: firebirdDatamodel })

  await generateClient({
    datamodel: firebirdDatamodel,
    schemaPath: locations.schemaPath,
    runtimeBase: '@prisma/client/runtime',
    outputDir: locations.outputDir,
    generator: {
      name: 'client',
      provider: { value: 'prisma-client', fromEnvVar: null },
      output: { value: locations.outputDir, fromEnvVar: null },
      config: {},
      binaryTargets: [],
      previewFeatures: [],
      sourceFilePath: locations.schemaPath,
      isCustomOutput: true,
    },
    dmmf,
    datasources: [
      {
        name: 'db',
        provider: 'firebird',
        activeProvider: 'firebird',
        schemas: [],
        sourceFilePath: locations.schemaPath,
      },
    ],
    binaryPaths: {},
    engineVersion,
    clientVersion: '7.10.1-firebird-local',
    activeProvider: 'firebird',
    target: 'nodejs',
    generatedFileExtension: 'ts',
    importFileExtension: 'ts',
    moduleFormat: 'esm',
    tsNoCheckPreamble: true,
    compilerBuild,
  })

  await fs.writeFile(
    path.join(locations.outputDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n',
  )
  const prismaModules = path.join(locations.outputDir, 'node_modules', '@prisma')
  await fs.mkdir(prismaModules, { recursive: true })
  await ensureClientLink(path.join(locations.ormRoot, 'packages', 'client'), path.join(prismaModules, 'client'))
  await fs.writeFile(
    locations.metadataPath,
    JSON.stringify({ ...locations, provider: 'firebird', compilerBuild, engineVersion }, null, 2) + '\n',
  )

  return locations
}

async function ensureClientLink(target: string, link: string): Promise<void> {
  const existing = await fs.lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) {
    if (!existing.isSymbolicLink() || (await fs.realpath(link)) !== (await fs.realpath(target))) {
      throw new Error(`The generated client package link has an unexpected target: ${link}`)
    }
    return
  }
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

if (require.main === module) {
  setupGeneratedClient()
    .then((locations) => {
      process.stdout.write(JSON.stringify(locations, null, 2) + '\n')
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
