import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';

export const PERSONAL_LIBRARY_SETTING_PREFIX = 'library_personal_';
export const BUILTIN_PROVIDER_CONFIG_KEY = 'metadata_provider_config';

type Database = NodePgDatabase<typeof schema>;
type ScopeSetting = 'field_rules' | 'upload_pattern' | 'folder_pattern' | 'download_pattern' | 'provider_config' | `external_provider_${number}`;

/** Uses the application settings store with a server-selected account namespace. */
@Injectable()
export class LibraryDefaultsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  static key(userId: number, setting: ScopeSetting): string {
    return `${PERSONAL_LIBRARY_SETTING_PREFIX}${userId}_${setting}`;
  }

  async ownerFor(libraryId: number): Promise<number | null> {
    const { libraries, userLibraryAccess } = schema;
    const [row] = await this.db
      .select({ userId: userLibraryAccess.userId })
      .from(libraries)
      .innerJoin(
        userLibraryAccess,
        and(
          eq(userLibraryAccess.libraryId, libraries.id),
          eq(userLibraryAccess.userId, libraries.configurationOwnerId),
          eq(userLibraryAccess.accessLevel, 'owner'),
        ),
      )
      .where(eq(libraries.id, libraryId));
    return row?.userId ?? null;
  }

  async read(userId: number, setting: ScopeSetting): Promise<string | undefined> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(schema.appSettings.key, LibraryDefaultsService.key(userId, setting)) });
    return row?.value;
  }

  async readMany(userId: number, settings: readonly ScopeSetting[]): Promise<Map<string, string>> {
    if (settings.length === 0) return new Map();
    const keys = settings.map((setting) => LibraryDefaultsService.key(userId, setting));
    const rows = await this.db.select().from(schema.appSettings).where(inArray(schema.appSettings.key, keys));
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  async write(userId: number, setting: ScopeSetting, value: string): Promise<void> {
    await this.db
      .insert(schema.appSettings)
      .values({ key: LibraryDefaultsService.key(userId, setting), value })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
  }

  async remove(userId: number, setting: ScopeSetting): Promise<void> {
    await this.db.delete(schema.appSettings).where(eq(schema.appSettings.key, LibraryDefaultsService.key(userId, setting)));
  }
}
