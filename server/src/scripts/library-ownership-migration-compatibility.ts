import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { PoolClient } from 'pg';

const LEGACY_HASH = '8fa2aadb06015baffe9406307ad7744c2c6f24a025172d0ee6ce6c451f874ee2';
const LEGACY_TIMESTAMP = 1795251122462;
const SHARED_BASE_INDEX = 144;

/**
 * The fork briefly used 0145 for the configuration-owner column. Its recorded timestamp is
 * newer than the upstream migrations that precede 0162. Remove just that exact recorded identity
 * after validating the database. Migration 0162 will recognize and preserve the existing column.
 */
export async function prepareLegacyLibraryOwnership(client: PoolClient, migrations: MigrationMeta[]): Promise<void> {
  await client.query('BEGIN');
  try {
    const table = await client.query<{ exists: boolean }>("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists");
    if (table.rows[0]?.exists) {
      const { rows } = await client.query<{ hash: string; timestamp: string }>(
        'SELECT hash, created_at::text AS timestamp FROM drizzle.__drizzle_migrations ORDER BY created_at FOR UPDATE',
      );
      const legacy = rows.filter(({ hash }) => hash === LEGACY_HASH);
      if (legacy.length > 0) {
        if (legacy.length !== 1 || Number(legacy[0].timestamp) !== LEGACY_TIMESTAMP) {
          throw new Error('Unexpected original library configuration-owner migration identity');
        }
        const base = migrations[SHARED_BASE_INDEX];
        if (!base || !rows.some(({ hash }) => hash === base.hash)) {
          throw new Error('Cannot verify the shared migration base for original library configuration ownership');
        }
        const appliedSinceBase = rows.filter(({ hash, timestamp }) => hash !== LEGACY_HASH && Number(timestamp) > base.folderMillis);
        const expected = migrations.slice(SHARED_BASE_INDEX + 1, SHARED_BASE_INDEX + 1 + appliedSinceBase.length);
        if (
          appliedSinceBase.length !== expected.length ||
          appliedSinceBase.some(({ hash, timestamp }, index) => hash !== expected[index].hash || Number(timestamp) !== expected[index].folderMillis)
        ) {
          throw new Error('Unexpected migrations after the shared library configuration-owner base');
        }
        const shape = await client.query<{ valid: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_attribute owner_column
            JOIN pg_constraint fk ON fk.conrelid = owner_column.attrelid AND fk.conkey = ARRAY[owner_column.attnum]
            JOIN pg_attribute user_id ON user_id.attrelid = fk.confrelid AND fk.confkey = ARRAY[user_id.attnum]
            WHERE owner_column.attrelid = 'public.libraries'::regclass
              AND owner_column.attname = 'configuration_owner_id' AND NOT owner_column.attisdropped
              AND owner_column.atttypid = 'integer'::regtype AND NOT owner_column.attnotnull AND NOT owner_column.atthasdef
              AND fk.conname = 'libraries_configuration_owner_id_users_id_fk' AND fk.contype = 'f'
              AND fk.convalidated AND fk.confdeltype = 'n' AND fk.confupdtype = 'a'
              AND fk.confrelid = 'public.users'::regclass AND user_id.attname = 'id'
          ) AS valid
        `);
        if (!shape.rows[0]?.valid) throw new Error('Original library configuration-owner ledger entry does not match the schema');
        await client.query('DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1 AND created_at = $2', [LEGACY_HASH, LEGACY_TIMESTAMP]);
        console.log('[db.library_configuration_owner] Original fork migration will be represented by the unified migration');
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
