import postgres from '@prisma/orm-postgres/runtime';
import { Pool } from 'pg';
import contractJson from './contract.json' with { type: 'json' };
import ENV from '../../utils/env.js';

const isVercel = process.env.VERCEL === '1';

export const databasePool = new Pool({
  connectionString: ENV.DATABASE_PUBLIC_URL,
  max: isVercel ? 1 : 10,
  connectionTimeoutMillis: isVercel ? 10_000 : 20_000,
  idleTimeoutMillis: isVercel ? 10_000 : 30_000,
});

export const db = postgres({
  contractJson,
  pg: databasePool,
});

export async function closeDatabase() {
  try {
    await db.close();
  } finally {
    await databasePool.end();
  }
}

export default db;