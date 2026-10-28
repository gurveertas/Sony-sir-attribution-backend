import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import  ENV  from './utils/env.js'
import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';

const contractPath = fileURLToPath(new URL('./src/prisma/contract.prisma', import.meta.url));
const contractOutput = fileURLToPath(new URL('./src/prisma/', import.meta.url));

function getContractSource() {
  if (process.platform !== 'win32' || !contractPath.includes(' ')) {
    return contractPath;
  }

  const shortPath = execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', 'for %I in (%PRISMA_CONTRACT_SOURCE%) do @echo %~sI'],
    {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_CONTRACT_SOURCE: `"${contractPath}"` },
    },
  ).trim();

  if (!shortPath || shortPath.includes(' ')) {
    throw new Error(
      'Prisma contract emit cannot resolve schema paths with spaces on Windows. Move the project to a path without spaces or enable 8.3 short filenames.',
    );
  }

  return shortPath;
}

export default definePrismaConfig({
  orm: ormConfig({
    contract: getContractSource(),
    output: contractOutput,
    db: {
      connection: ENV.DATABASE_PUBLIC_URL,
    },
  }),
});
