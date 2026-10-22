import 'dotenv/config';
import  ENV  from './utils/env.js'
import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    db: {
      connection: ENV.DATABASE_PUBLIC_URL,
    },
  }),
});
