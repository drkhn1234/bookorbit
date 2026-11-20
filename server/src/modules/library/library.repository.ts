import { retainFinishedReads } from '../../db/reading-attempt-retention';
import { deleteLibraryFoldersWithHashInvalidation } from '../../db/book-file-hash-history';
import { writeKoboTombstones } from '../../db/kobo-entitlement-tombstones';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Permission, type AccessLevel, type ContentFilterRules, type LibraryStats } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { DB } from '../../db';
import { currentGrantActor, lockGrantAccount, lockGrantLibraries } from '../../db/library-grant-locks';
import type { RequestUser } from '../../common/types/request-user';
import { MIN_VALID_FILE_TIME_MS } from '../../common/utils/file-time.utils';
import * as schema from '../../db/schema';
import { bookFiles, books, libraries, libraryFolders } from '../../db/schema';
import { LIBRARY_BOOK_STATUS_PRESENT } from './library.constants';

type Db = NodePgDatabase<typeof schema>;
type RegisteredFolder = { libraryId: number; path: string; libraryName: string };

function lockFolderRegistry(tx: Pick<Db, 'execute'>) {
  return tx.execute(sql`select pg_advisory_xact_lock(72104912)`);
}

@Injectable()
export class LibraryRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  administration(libraryIds?: readonly number[]) {
    if (libraryIds?.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        id: libraries.id,
        name: libraries.name,
        icon: libraries.icon,
        ownerCount: sql<number>`(select count(*)::int from ${schema.userLibraryAccess} a where a.library_id = ${libraries.id} and a.access_level = 'owner')`,
      })
      .from(libraries)
      .where(libraryIds ? inArray(libraries.id, [...libraryIds]) : undefined)
      .orderBy(libraries.id);
  }

  findAll() {
    return this.db
      .select({
        ...getTableColumns(libraries),
        accessLevel: sql<AccessLevel | null>`null`,
        bookCount: sql<number>`count(${books.id})::int`,
      })
      .from(libraries)
      .leftJoin(books, and(eq(books.libraryId, libraries.id), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT)))
      .groupBy(libraries.id)
      .orderBy(libraries.displayOrder, libraries.name);
  }

  findAllForUser(userId: number, contentFilters?: ContentFilterRules) {
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const bookJoinOn = and(eq(books.libraryId, libraries.id), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT), ...filterClauses)!;

    return this.db
      .select({
        id: libraries.id,
        accessLevel: schema.userLibraryAccess.accessLevel,
        name: libraries.name,
        icon: libraries.icon,
        displayOrder: libraries.displayOrder,
        coverAspectRatio: libraries.coverAspectRatio,
        watch: libraries.watch,
        autoScanCronExpression: libraries.autoScanCronExpression,
        organizationMode: libraries.organizationMode,
        scanMode: libraries.scanMode,
        fileWriteEnabled: libraries.fileWriteEnabled,
        fileRenameEnabled: libraries.fileRenameEnabled,
        createdAt: libraries.createdAt,
        updatedAt: libraries.updatedAt,
        bookCount: sql<number>`count(${books.id})::int`,
      })
      .from(libraries)
      .innerJoin(schema.userLibraryAccess, and(eq(schema.userLibraryAccess.libraryId, libraries.id), eq(schema.userLibraryAccess.userId, userId)))
      .leftJoin(books, bookJoinOn)
      .groupBy(libraries.id, schema.userLibraryAccess.accessLevel)
      .orderBy(libraries.displayOrder, libraries.name);
  }

  findAutoScanSchedules() {
    return this.db
      .select({ id: libraries.id, autoScanCronExpression: libraries.autoScanCronExpression })
      .from(libraries)
      .where(isNotNull(libraries.autoScanCronExpression))
      .orderBy(libraries.id);
  }

  findById(id: number) {
    return this.db.select().from(libraries).where(eq(libraries.id, id)).limit(1);
  }

  findByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.select({ id: libraries.id }).from(libraries).where(inArray(libraries.id, ids));
  }

  findByName(name: string, excludeId?: number) {
    return this.db
      .select({ id: libraries.id })
      .from(libraries)
      .where(
        excludeId
          ? and(eq(sql`lower(${libraries.name})`, name.toLowerCase()), sql`${libraries.id} != ${excludeId}`)
          : eq(sql`lower(${libraries.name})`, name.toLowerCase()),
      )
      .limit(1);
  }

  findFoldersByLibrary(libraryId: number) {
    return this.db.select().from(libraryFolders).where(eq(libraryFolders.libraryId, libraryId)).orderBy(libraryFolders.createdAt, libraryFolders.id);
  }

  findAllFolders() {
    return this.db.select().from(libraryFolders).orderBy(libraryFolders.libraryId, libraryFolders.createdAt, libraryFolders.id);
  }

  findFoldersByLibraryIds(libraryIds: number[]) {
    if (libraryIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(libraryFolders)
      .where(inArray(libraryFolders.libraryId, libraryIds))
      .orderBy(libraryFolders.libraryId, libraryFolders.createdAt, libraryFolders.id);
  }

  findAllFolderPaths(db: Pick<Db, 'select'> = this.db) {
    return db
      .select({ libraryId: libraryFolders.libraryId, path: libraryFolders.path, libraryName: libraries.name })
      .from(libraryFolders)
      .innerJoin(libraries, eq(libraries.id, libraryFolders.libraryId))
      .orderBy(libraries.displayOrder, libraries.name, libraryFolders.createdAt, libraryFolders.id);
  }

  async createOwned(
    data: typeof libraries.$inferInsert,
    paths: string[],
    creatorId: number,
    validateFolders: (registered: RegisteredFolder[]) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      await lockGrantAccount(tx, creatorId);
      await lockFolderRegistry(tx);
      await validateFolders(await this.findAllFolderPaths(tx));
      const duplicate = await tx
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(sql`lower(${libraries.name})`, data.name.toLowerCase()))
        .limit(1);
      if (duplicate.length) throw new ConflictException('A library with this name already exists');
      const [library] = await tx.insert(libraries).values(data).returning();
      const folders = await tx
        .insert(libraryFolders)
        .values(paths.map((path) => ({ libraryId: library.id, path })))
        .returning();
      await tx.insert(schema.userLibraryAccess).values({ libraryId: library.id, userId: creatorId, accessLevel: 'owner' });
      return { library, folders };
    });
  }

  insert(data: typeof libraries.$inferInsert) {
    return this.db.insert(libraries).values(data).returning();
  }

  update(id: number, data: Partial<typeof libraries.$inferInsert>) {
    return this.db
      .update(libraries)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(libraries.id, id))
      .returning();
  }

  async updateWithFolders(
    id: number,
    data: Partial<typeof libraries.$inferInsert>,
    resolvePaths: (current: string[], registered: RegisteredFolder[]) => Promise<string[]>,
  ) {
    return this.db.transaction(async (tx) => {
      await lockFolderRegistry(tx);
      const [existing] = await tx.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, id)).for('update');
      if (!existing) throw new NotFoundException('Library not found');
      const folders = await tx
        .select()
        .from(libraryFolders)
        .where(eq(libraryFolders.libraryId, id))
        .orderBy(libraryFolders.createdAt, libraryFolders.id);
      const existingPaths = new Set(folders.map((folder) => folder.path));
      const nextPaths = new Set(await resolvePaths([...existingPaths], await this.findAllFolderPaths(tx)));
      const removedIds = folders.filter((folder) => !nextPaths.has(folder.path)).map((folder) => folder.id);
      const addedPaths = [...nextPaths].filter((path) => !existingPaths.has(path));

      if (removedIds.length) await deleteLibraryFoldersWithHashInvalidation(tx, inArray(libraryFolders.id, removedIds));
      const addedFolders = addedPaths.length
        ? await tx
            .insert(libraryFolders)
            .values(addedPaths.map((path) => ({ libraryId: id, path })))
            .returning()
        : [];
      const [library] = await tx
        .update(libraries)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(libraries.id, id))
        .returning();
      return {
        library,
        folders: [...folders.filter((folder) => nextPaths.has(folder.path)), ...addedFolders],
        pathsChanged: removedIds.length > 0 || addedPaths.length > 0,
      };
    });
  }

  findBookIdsByLibrary(libraryId: number) {
    return this.db.select({ id: books.id }).from(books).where(eq(books.libraryId, libraryId));
  }

  /**
   * The library's books go with it by cascade; their finished reads stay in each reader's history.
   * A link group left with fewer than two members means "not linked", so it goes too, as it does
   * when books or folders are deleted.
   */
  delete(id: number) {
    return this.db.transaction(async (tx) => {
      await retainFinishedReads(tx, eq(books.libraryId, id));
      await writeKoboTombstones(tx, eq(books.libraryId, id));
      await tx.execute(sql`
        delete from ${schema.bookLinkGroups} g
        where g.id in (
            select l.group_id from ${schema.bookLinks} l
            join ${books} b on b.id = l.book_id
            where b.library_id = ${id}
          )
          and (
            select count(*) from ${schema.bookLinks} l
            join ${books} b on b.id = l.book_id
            where l.group_id = g.id and b.library_id <> ${id}
          ) < 2
      `);
      await tx.delete(libraries).where(eq(libraries.id, id));
    });
  }

  deleteFolder(id: number) {
    return deleteLibraryFoldersWithHashInvalidation(this.db, eq(libraryFolders.id, id));
  }

  deleteFoldersByLibrary(libraryId: number) {
    return deleteLibraryFoldersWithHashInvalidation(this.db, eq(libraryFolders.libraryId, libraryId));
  }

  async updateDisplayOrders(order: { id: number; displayOrder: number }[]) {
    await this.db.transaction(async (tx) => {
      for (const item of order) {
        await tx.update(libraries).set({ displayOrder: item.displayOrder }).where(eq(libraries.id, item.id));
      }
    });
  }

  async getStats(libraryId: number) {
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(books)
      .where(and(eq(books.libraryId, libraryId), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT)));

    const formatRows = await this.db
      .select({
        format: bookFiles.format,
        count: sql<number>`count(*)::int`,
        totalSize: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)::bigint`,
      })
      .from(books)
      .innerJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
      .where(and(eq(books.libraryId, libraryId), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT)))
      .groupBy(bookFiles.format);

    const formatCounts: Record<string, number> = {};
    let totalSizeBytes = 0n;
    for (const row of formatRows) {
      if (row.format) formatCounts[row.format] = row.count;
      totalSizeBytes += toBigInt(row.totalSize);
    }

    return {
      totalBooks: countRow?.count ?? 0,
      totalSizeBytes: toSafeNumber(totalSizeBytes),
      formatCounts,
    };
  }

  /**
   * The same aggregates as getStats, for many libraries in two round trips instead of two per
   * library. Book counts come from books alone so titles with no primary file still count, while
   * sizes and formats need the bookFiles join.
   */
  async getStatsForLibraries(libraryIds: number[]) {
    if (libraryIds.length === 0) return new Map<number, LibraryStats>();

    const [countRows, formatRows] = await Promise.all([
      this.db
        .select({ libraryId: books.libraryId, count: sql<number>`count(*)::int` })
        .from(books)
        .where(and(inArray(books.libraryId, libraryIds), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT)))
        .groupBy(books.libraryId),
      this.db
        .select({
          libraryId: books.libraryId,
          format: bookFiles.format,
          count: sql<number>`count(*)::int`,
          totalSize: sql<number>`coalesce(sum(${bookFiles.sizeBytes}), 0)::bigint`,
        })
        .from(books)
        .innerJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
        .where(and(inArray(books.libraryId, libraryIds), eq(books.status, LIBRARY_BOOK_STATUS_PRESENT)))
        .groupBy(books.libraryId, bookFiles.format),
    ]);

    const sizeByLibrary = new Map<number, bigint>();
    const formatsByLibrary = new Map<number, Record<string, number>>();
    for (const row of formatRows) {
      sizeByLibrary.set(row.libraryId, (sizeByLibrary.get(row.libraryId) ?? 0n) + toBigInt(row.totalSize));
      if (!row.format) continue;
      const formats = formatsByLibrary.get(row.libraryId);
      if (formats) formats[row.format] = row.count;
      else formatsByLibrary.set(row.libraryId, { [row.format]: row.count });
    }

    const countByLibrary = new Map(countRows.map((row) => [row.libraryId, row.count]));
    const stats = new Map<number, LibraryStats>();
    for (const libraryId of libraryIds) {
      stats.set(libraryId, {
        totalBooks: countByLibrary.get(libraryId) ?? 0,
        totalSizeBytes: toSafeNumber(sizeByLibrary.get(libraryId) ?? 0n),
        formatCounts: formatsByLibrary.get(libraryId) ?? {},
      });
    }
    return stats;
  }

  /**
   * Which of these users can open this library, answered in one query rather than one per user.
   *
   * Administrative authority does not imply content access; include only explicit grants.
   */
  findUserIdsWithAccess(libraryId: number, userIds: number[]) {
    return this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(
        schema.userLibraryAccess,
        and(eq(schema.userLibraryAccess.userId, schema.users.id), eq(schema.userLibraryAccess.libraryId, libraryId)),
      )
      .where(inArray(schema.users.id, userIds));
  }

  async getAddedAtRecomputeBounds(libraryId: number) {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        maxId: sql<number>`coalesce(max(${books.id}), 0)::int`,
      })
      .from(books)
      .where(eq(books.libraryId, libraryId));
    return row ?? { total: 0, maxId: 0 };
  }

  findAddedAtBookBatch(libraryId: number, afterId: number, maxId: number, limit: number) {
    return this.db
      .select({ id: books.id, addedAt: books.addedAt, previousAddedAt: sql<string>`${books.addedAt}::text` })
      .from(books)
      .where(and(eq(books.libraryId, libraryId), gt(books.id, afterId), lte(books.id, maxId)))
      .orderBy(books.id)
      .limit(limit);
  }

  findAddedAtMtimes(libraryId: number, bookIds: number[]) {
    return this.db
      .select({ bookId: bookFiles.bookId, mtime: sql<Date>`min(${bookFiles.mtime})`.mapWith(bookFiles.mtime) })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .where(
        and(
          eq(books.libraryId, libraryId),
          inArray(books.id, bookIds),
          eq(bookFiles.role, 'content'),
          gt(bookFiles.mtime, new Date(MIN_VALID_FILE_TIME_MS)),
        ),
      )
      .groupBy(bookFiles.bookId);
  }

  findAddedAtFileBatch(libraryId: number, bookIds: number[], afterId: number, limit: number) {
    return this.db
      .select({
        id: bookFiles.id,
        bookId: bookFiles.bookId,
        absolutePath: bookFiles.absolutePath,
        mtime: bookFiles.mtime,
        rootPath: libraryFolders.path,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .innerJoin(libraryFolders, eq(libraryFolders.id, books.libraryFolderId))
      .where(and(eq(books.libraryId, libraryId), inArray(books.id, bookIds), eq(bookFiles.role, 'content'), gt(bookFiles.id, afterId)))
      .orderBy(bookFiles.id)
      .limit(limit);
  }

  async updateAddedAtBatch(libraryId: number, values: { id: number; addedAt: Date; previousAddedAt: string }[]): Promise<number[]> {
    if (values.length === 0) return [];
    const rows = sql.join(
      values.map(({ id, addedAt, previousAddedAt }) => sql`(${id}::int, ${addedAt.toISOString()}::timestamptz, ${previousAddedAt}::timestamptz)`),
      sql`, `,
    );
    const result = await this.db
      .update(books)
      .set({ addedAt: sql`dates.added_at`, updatedAt: new Date() })
      .from(sql`(values ${rows}) as dates(id, added_at, previous_added_at)`)
      .where(and(eq(books.libraryId, libraryId), sql`${books.id} = dates.id`, sql`${books.addedAt} = dates.previous_added_at`))
      .returning({ id: books.id });
    return result.map(({ id }) => id);
  }

  getAccess(libraryId: number) {
    return this.db.query.userLibraryAccess.findMany({
      where: eq(schema.userLibraryAccess.libraryId, libraryId),
    });
  }

  private async changeAccess(
    libraryId: number,
    userId: number,
    accessLevel: AccessLevel | null,
    requiredOwnerId: number | null,
    actor: RequestUser,
    upsert = false,
  ) {
    return this.db.transaction(async (tx) => {
      await lockGrantAccount(tx, userId);
      const locked = await lockGrantLibraries(tx, [libraryId]);
      if (!locked.has(libraryId)) throw new NotFoundException('Library not found');
      const principal = await currentGrantActor(tx, actor);
      if (principal.permissions.includes(Permission.DemoRestricted)) {
        throw new ForbiddenException(`Forbidden permission: ${Permission.DemoRestricted}`);
      }
      if (requiredOwnerId === null && !principal.isSuperuser && !principal.permissions.includes(Permission.ManageLibraries)) {
        throw new ForbiddenException(`Missing permission: ${Permission.ManageLibraries}`);
      }
      const grants = await tx.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, libraryId));
      if (requiredOwnerId !== null && !grants.some((grant) => grant.userId === requiredOwnerId && grant.accessLevel === 'owner')) {
        throw new ForbiddenException('Owner access is required to change library grants');
      }
      if (
        accessLevel !== 'owner' &&
        grants.some((grant) => grant.userId === userId && grant.accessLevel === 'owner') &&
        !grants.some((grant) => grant.userId !== userId && grant.accessLevel === 'owner')
      )
        throw new ConflictException('The last library owner cannot be removed or demoted');
      const target = and(eq(schema.userLibraryAccess.libraryId, libraryId), eq(schema.userLibraryAccess.userId, userId));
      if (accessLevel === null) await tx.delete(schema.userLibraryAccess).where(target);
      else if (upsert) {
        const [recipient] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
        if (!recipient) throw new NotFoundException('User not found');
        await tx
          .insert(schema.userLibraryAccess)
          .values({ libraryId, userId, accessLevel })
          .onConflictDoUpdate({ target: [schema.userLibraryAccess.libraryId, schema.userLibraryAccess.userId], set: { accessLevel } });
      } else await tx.update(schema.userLibraryAccess).set({ accessLevel }).where(target);
    });
  }

  grantAccess(libraryId: number, userId: number, accessLevel: AccessLevel, requiredOwnerId: number | null, actor: RequestUser) {
    return this.changeAccess(libraryId, userId, accessLevel, requiredOwnerId, actor, true);
  }
  updateAccess(libraryId: number, userId: number, accessLevel: AccessLevel, requiredOwnerId: number | null, actor: RequestUser) {
    return this.changeAccess(libraryId, userId, accessLevel, requiredOwnerId, actor);
  }
  revokeAccess(libraryId: number, userId: number, requiredOwnerId: number | null, actor: RequestUser) {
    return this.changeAccess(libraryId, userId, null, requiredOwnerId, actor);
  }

  getUsersNotInLibrary(libraryId: number) {
    const subquery = this.db
      .select({ userId: schema.userLibraryAccess.userId })
      .from(schema.userLibraryAccess)
      .where(eq(schema.userLibraryAccess.libraryId, libraryId));

    return this.getAssignableUsers(sql`${schema.users.id} not in (${subquery})`);
  }

  getAssignableUsersForCreator(creatorId: number) {
    return this.getAssignableUsers(ne(schema.users.id, creatorId));
  }

  private getAssignableUsers(filter: SQL) {
    return this.db
      .select({ id: schema.users.id, username: schema.users.username, name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.active, true), filter));
  }

  getAccessWithUsers(libraryId: number) {
    return this.db
      .select({
        userId: schema.userLibraryAccess.userId,
        accessLevel: schema.userLibraryAccess.accessLevel,
        username: schema.users.username,
        name: schema.users.name,
      })
      .from(schema.userLibraryAccess)
      .innerJoin(schema.users, eq(schema.users.id, schema.userLibraryAccess.userId))
      .where(eq(schema.userLibraryAccess.libraryId, libraryId));
  }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  throw new TypeError(`Unsupported bigint value: ${String(value)}`);
}

function toSafeNumber(value: bigint): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maxSafe) {
    throw new RangeError('Library stats totalSizeBytes exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(value);
}
