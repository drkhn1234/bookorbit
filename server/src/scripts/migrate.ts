import { existsSync } from 'fs';
import { join } from 'path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { createPostgresClientConfig } from '../db/postgres-connection-config';
import { dropUnreleasedMigrationRows, reconcileMigrationLedgerTimestamps } from './migration-ledger-compatibility';
import { prepareLegacyLibraryOwnership } from './library-ownership-migration-compatibility';
import { installPostgresExtensions } from './postgres-extensions';
import { prepareLegacySeriesIndexColumns } from './series-index-migration-compatibility';

function resolveMigrationsFolder(): string {
  const candidates = [
    join(__dirname, '..', '..', 'migrations'),
    join(__dirname, '..', 'db', 'migrations'),
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'src', 'db', 'migrations'),
  ];

  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new Error(`Unable to locate migrations folder. Checked: ${candidates.join(', ')}`);
  }
  return match;
}

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool(
    createPostgresClientConfig(connectionString, {
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    }),
  );

  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('bookorbit'), hashtext('schema-migrations'))");
      await installPostgresExtensions(pool);
      const migrationsFolder = resolveMigrationsFolder();
      const migrationFiles = readMigrationFiles({ migrationsFolder });
      await dropUnreleasedMigrationRows(pool, migrationFiles);
      await reconcileMigrationLedgerTimestamps(pool, migrationFiles);
      await prepareLegacySeriesIndexColumns(pool);
      await prepareLegacyLibraryOwnership(client, migrationFiles);

      await migrate(drizzle(client), { migrationsFolder });

      console.log(`Migrations applied successfully from ${migrationsFolder}`);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext('bookorbit'), hashtext('schema-migrations'))");
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

void runMigrations();
