import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, exists, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { NOTIFICATION_TYPE_META, NotificationType } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { notifications, users, userPermissions, userLibraryAccess } from '../../db/schema';
import type { NewNotification, Notification } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
type NotificationReference = Pick<Notification, 'id' | 'meta'>;

const moveScoped = sql`coalesce(${notifications.meta} ? 'targetLibraryId' or ${notifications.meta} ? 'sourceLibraryIds', false)`;
// Refresh events need only the visibility inputs, which also lets bulk mutations deduplicate their scopes.
const scopeMeta = sql`case
  when ${moveScoped} then jsonb_build_object('targetLibraryId', ${notifications.meta}->'targetLibraryId', 'sourceLibraryIds', ${notifications.meta}->'sourceLibraryIds')
  when ${notifications.meta}->>'libraryId' is not null then jsonb_build_object('libraryId', ${notifications.meta}->'libraryId')
  else null
end`.as('scope_meta');

const BOOK_REQUEST_NOTIFICATION_TYPES = Object.values(NotificationType).filter((type) => NOTIFICATION_TYPE_META[type]?.category === 'bookRequests');

@Injectable()
export class NotificationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insertOrCollapse(rows: NewNotification[]): Promise<Notification[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(notifications)
      .values(rows)
      .onConflictDoUpdate({
        target: [notifications.userId, notifications.groupKey],
        targetWhere: sql`${notifications.read} = false and ${notifications.groupKey} is not null`,
        set: {
          title: sql`excluded.title`,
          message: sql`excluded.message`,
          actionUrl: sql`excluded.action_url`,
          meta: sql`excluded.meta`,
          count: sql`${notifications.count} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
  }

  async findByUser(
    userId: number,
    limit: number,
    offset: number,
    libraryIds?: readonly number[] | null,
  ): Promise<{ items: Notification[]; total: number }> {
    const requestCondition = await this.requestVisibilityCondition(userId);
    const condition = and(eq(notifications.userId, userId), requestCondition, this.libraryVisibilityCondition(userId, libraryIds));
    const [items, [{ value: total }]] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(condition)
        .orderBy(desc(notifications.updatedAt), desc(notifications.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(notifications).where(condition),
    ]);
    return { items, total };
  }

  async countUnread(userId: number, libraryIds?: readonly number[] | null): Promise<number> {
    const requestCondition = await this.requestVisibilityCondition(userId);
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.read, false), requestCondition, this.libraryVisibilityCondition(userId, libraryIds)),
      );
    return value;
  }

  private async requestVisibilityCondition(userId: number) {
    const [user] = await this.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
    return (user?.settings as Record<string, unknown> | null)?.showBookRequests === false
      ? notInArray(notifications.type, BOOK_REQUEST_NOTIFICATION_TYPES)
      : undefined;
  }

  private libraryVisibilityCondition(userId: number, libraryIds?: readonly number[] | null) {
    const allowedGrant = and(
      eq(userLibraryAccess.userId, userId),
      libraryIds == null ? undefined : libraryIds.length ? inArray(userLibraryAccess.libraryId, libraryIds) : sql`false`,
    );
    const libraryId = sql`${notifications.meta}->>'libraryId'`;
    const target = sql`${notifications.meta}->'targetLibraryId'`;
    const sources = sql`case when jsonb_typeof(${notifications.meta}->'sourceLibraryIds') = 'array'
      then ${notifications.meta}->'sourceLibraryIds' else '[]'::jsonb end`;
    const missingMoveGrant = this.db
      .select({ one: sql`1` })
      .from(sql`jsonb_array_elements(${sources} || jsonb_build_array(${target})) as required(id)`)
      .where(
        sql`not exists (${this.db
          .select({ one: sql`1` })
          .from(userLibraryAccess)
          .where(and(allowedGrant, sql`to_jsonb(${userLibraryAccess.libraryId}) = required.id`))})`,
      );

    return sql`case when ${moveScoped} then jsonb_array_length(${sources}) > 0 and not exists (${missingMoveGrant})
      else ${or(
        isNull(libraryId),
        exists(
          this.db
            .select({ one: sql`1` })
            .from(userLibraryAccess)
            .where(and(allowedGrant, sql`${userLibraryAccess.libraryId}::text = ${libraryId}`)),
        ),
      )} end`;
  }

  async setRead(id: number, userId: number, libraryIds?: readonly number[] | null): Promise<NotificationReference | undefined> {
    const [row] = await this.db
      .update(notifications)
      .set({ read: true, updatedAt: sql`${notifications.updatedAt}` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), this.libraryVisibilityCondition(userId, libraryIds)))
      .returning({ id: notifications.id, meta: notifications.meta });
    return row;
  }

  async setAllRead(userId: number, libraryIds?: readonly number[] | null): Promise<unknown[]> {
    const requestCondition = await this.requestVisibilityCondition(userId);
    const affected = this.db.$with('affected').as(
      this.db
        .update(notifications)
        .set({ read: true, updatedAt: sql`${notifications.updatedAt}` })
        .where(
          and(eq(notifications.userId, userId), eq(notifications.read, false), requestCondition, this.libraryVisibilityCondition(userId, libraryIds)),
        )
        .returning({ scope: scopeMeta }),
    );
    const rows = await this.db.with(affected).selectDistinct({ scope: affected.scope }).from(affected);
    return rows.map(({ scope }) => scope);
  }

  async deleteOne(id: number, userId: number, libraryIds?: readonly number[] | null): Promise<NotificationReference | undefined> {
    const [row] = await this.db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), this.libraryVisibilityCondition(userId, libraryIds)))
      .returning({ id: notifications.id, meta: notifications.meta });
    return row;
  }

  async deleteAllForUser(userId: number, libraryIds?: readonly number[] | null): Promise<unknown[]> {
    const requestCondition = await this.requestVisibilityCondition(userId);
    const affected = this.db.$with('affected').as(
      this.db
        .delete(notifications)
        .where(and(eq(notifications.userId, userId), requestCondition, this.libraryVisibilityCondition(userId, libraryIds)))
        .returning({ scope: scopeMeta }),
    );
    const rows = await this.db.with(affected).selectDistinct({ scope: affected.scope }).from(affected);
    return rows.map(({ scope }) => scope);
  }

  async deleteOlderThan(date: Date, onBatchDeleted: (rows: { userId: number; scope: unknown }[]) => void, batchSize = 1_000): Promise<number> {
    let deleted = 0;

    while (true) {
      const candidates = await this.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(lt(notifications.updatedAt, date))
        .orderBy(notifications.updatedAt, notifications.id)
        .limit(batchSize);
      if (candidates.length === 0) break;

      const rows = await this.db
        .delete(notifications)
        .where(
          and(
            inArray(
              notifications.id,
              candidates.map((row) => row.id),
            ),
            lt(notifications.updatedAt, date),
          ),
        )
        .returning({ userId: notifications.userId, scope: scopeMeta });
      deleted += rows.length;
      onBatchDeleted(rows);
    }

    return deleted;
  }

  async findUserIdsWithLibraryAccess(libraryId: number): Promise<number[]> {
    const rows = await this.db
      .select({ userId: userLibraryAccess.userId })
      .from(userLibraryAccess)
      .innerJoin(users, eq(users.id, userLibraryAccess.userId))
      .where(and(eq(userLibraryAccess.libraryId, libraryId), eq(users.active, true)));
    return rows.map((row) => row.userId);
  }

  async findUserIdsWithPermission(permission: string): Promise<number[]> {
    const byPermission = this.db
      .select({ userId: userPermissions.userId })
      .from(userPermissions)
      .innerJoin(users, eq(users.id, userPermissions.userId))
      .where(and(eq(userPermissions.permissionName, permission), eq(users.active, true)));

    const superusers = this.db
      .select({ userId: users.id })
      .from(users)
      .where(and(eq(users.isSuperuser, true), eq(users.active, true)));

    const rows = await this.db.selectDistinct({ userId: sql<number>`user_id` }).from(sql`(${byPermission} UNION ${superusers}) as combined`);
    return rows.map((r) => r.userId);
  }

  async findAllActiveUserIds(): Promise<number[]> {
    const rows = await this.db.select({ id: users.id }).from(users).where(eq(users.active, true));
    return rows.map((r) => r.id);
  }

  async findUserSettings(userIds: number[]): Promise<Map<number, Record<string, unknown>>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, settings: users.settings }).from(users).where(inArray(users.id, userIds));
    return new Map(rows.map((r) => [r.id, (r.settings ?? {}) as Record<string, unknown>]));
  }
}
