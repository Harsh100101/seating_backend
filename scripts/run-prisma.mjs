import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(backendDirectory, '../..');
const repositoryEnvPath = resolve(repositoryDirectory, '.env');
const allowedCommands = new Set(['validate', 'generate', 'format', 'db push', 'studio']);
const [command, ...argumentsForPrisma] = process.argv.slice(2);
const commandKey = command === 'db' ? `${command} ${argumentsForPrisma[0] ?? ''}` : command;

if (!allowedCommands.has(commandKey)) {
  console.error('Usage: node scripts/run-prisma.mjs <validate|generate|format|db push|studio> [Prisma options]');
  process.exit(1);
}

// Prisma resolves dotenv files relative to the schema, unlike the application
// bootstrap. Load the documented repository environment explicitly so package
// scripts work from both the workspace root and apps/backend without copying
// credentials into package-local files. Host-provided values remain authoritative.
if (existsSync(repositoryEnvPath)) {
  dotenv.config({ path: repositoryEnvPath, override: false, quiet: true });
}

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    'DATABASE_URL is required for Prisma. Set it in the process environment or the repository .env file.',
  );
  process.exit(1);
}

const executable = process.execPath;
const prismaCli = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
const result = spawnSync(
  executable,
  [prismaCli, command, '--schema=prisma/schema.prisma', ...argumentsForPrisma],
  {
    cwd: backendDirectory,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`Unable to start Prisma: ${result.error.message}`);
}

process.exit(result.status ?? 1);
