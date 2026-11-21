/**
 * Cross-library book move end-to-end suite.
 *
 * Unit tests for this feature mock the database, so they cannot catch ordering
 * bugs against real constraints: `book_files_book_folder_consistency_fk`
 * references `books(id, library_folder_id)`, so rewriting a file's folder id
 * before the book row has moved violates it. This suite drives the real
 * endpoints against a real Postgres instance and a real filesystem.
 *
 * Covers:
 *
 *   - Preview classification: ready / already-in-target / collision / ineligible
 *   - Collision kinds: hash duplicate (suggests merge), name clash (suggests keep_both)
 *   - Ineligibility: multi-file book into a book_per_file target
 *   - Warnings: format mismatch, layout change, users losing access
 *   - Execute: row re-parenting, file relocation, preserved user state
 *   - Job bookkeeping in book_move_jobs
 *   - Collision policies: skip / keep_both / merge, and per-book overrides
 *   - Layout transition into a book_per_folder target
 *   - SSE progress framing
 *   - Editor access enforcement on both source and target
 */

import { randomUUID } from 'crypto';
import { access, copyFile } from 'fs/promises';
import { join } from 'path';

import { and, eq, inArray } from 'drizzle-orm';
import { io } from 'socket.io-client';

import type { BookMovePreviewResult, BookMoveProgressEvent, BookMoveSummary, CreatedApiKey, NotificationItem } from '@bookorbit/types';
import { NotificationType, Permission } from '@bookorbit/types';

import {
  annotations,
  bookFiles,
  bookMerges,
  bookMoveJobs,
  books,
  collectionBooks,
  collections,
  libraries,
  notifications,
  userBookStatus,
} from '../src/db/schema';
import { BookMoveExecutorService } from '../src/modules/book-move/book-move-executor.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { NotificationGateway } from '../src/modules/notification/notification.gateway';
import { createEpubFixture, createM4bFixture, createPdfFixture } from './e2e/metadata-write/metadata-write-fixture-builder';
import {
  authHeader,
  closeMetadataWriteE2EContext,
  createLibraryWithFolder,
  createMetadataWriteE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  locateBookFileByRelPath,
  triggerAndWaitForLibraryScan,
  type CreatedLibrary,
  type LocatedBookFile,
  type MetadataWriteE2EContext,
} from './e2e/metadata-write/metadata-write-harness';

const SCENARIO_TIMEOUT_MS = 120_000;

describe('Cross-library book move (e2e)', () => {
  let ctx: MetadataWriteE2EContext;
  let adminId: number;

  beforeAll(async () => {
    ctx = await createMetadataWriteE2EContext();
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(ctx.adminToken) });
    expect(me.statusCode, me.body).toBe(200);
    adminId = me.json().id;
    await ctx.app.listen(0, '127.0.0.1');
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await closeMetadataWriteE2EContext(ctx);
  });

  async function pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pin the destination naming pattern so expected paths are exact rather than
   * dependent on whatever the instance-wide upload pattern happens to be.
   */
  async function setNamingPattern(libraryId: number, pattern: string): Promise<void> {
    await ctx.db.update(libraries).set({ fileNamingPattern: pattern }).where(eq(libraries.id, libraryId));
  }

  async function createSource(options: { mode?: 'book_per_file' | 'book_per_folder' } = {}): Promise<CreatedLibrary> {
    const library = await createLibraryWithFolder(ctx, { name: `move-src-${randomUUID()}`, mode: options.mode ?? 'book_per_file' });
    await grantLibraryAccess(ctx, adminId, library.libraryId, 'owner');
    return library;
  }

  async function createTarget(
    options: { mode?: 'book_per_file' | 'book_per_folder'; pattern?: string; allowedFormats?: string[] } = {},
  ): Promise<CreatedLibrary> {
    const mode = options.mode ?? 'book_per_file';
    const library = await createLibraryWithFolder(ctx, {
      name: `move-dst-${randomUUID()}`,
      mode,
      allowedFormats: options.allowedFormats ?? [],
    });
    await grantLibraryAccess(ctx, adminId, library.libraryId, 'owner');
    await setNamingPattern(library.libraryId, options.pattern ?? (mode === 'book_per_folder' ? '{title}/{title}' : '{title}'));
    return library;
  }

  async function seedEpub(library: CreatedLibrary, relPath: string, title: string, uid?: string): Promise<LocatedBookFile> {
    await createEpubFixture(library.folderPath, relPath, { title, uid: uid ?? title });
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    return locateBookFileByRelPath(ctx, library.libraryId, relPath);
  }

  /**
   * Seeds a book already sitting on the exact path an incoming book of the same
   * title would resolve to, which is what makes the destination collide. A distinct
   * uid keeps the content hash different so this reads as a name clash rather than
   * a duplicate copy.
   */
  async function seedIncumbent(target: CreatedLibrary, title: string): Promise<LocatedBookFile> {
    return seedEpub(target, `${title}.epub`, title, `${title}-incumbent`);
  }

  /**
   * Places byte-identical copies of one book in both libraries so they share a
   * content hash. The bytes are copied rather than generated twice because the epub
   * archive embeds timestamps, which makes a second generation only usually equal.
   */
  async function seedIdenticalPair(
    source: CreatedLibrary,
    target: CreatedLibrary,
    title: string,
  ): Promise<{ existing: LocatedBookFile; incoming: LocatedBookFile }> {
    const existingPath = await createEpubFixture(target.folderPath, 'existing.epub', { title, uid: title });
    await copyFile(existingPath, join(source.folderPath, 'incoming.epub'));

    await triggerAndWaitForLibraryScan(ctx, target.libraryId);
    await triggerAndWaitForLibraryScan(ctx, source.libraryId);

    return {
      existing: await locateBookFileByRelPath(ctx, target.libraryId, 'existing.epub'),
      incoming: await locateBookFileByRelPath(ctx, source.libraryId, 'incoming.epub'),
    };
  }

  function previewMove(payload: Record<string, unknown>, token = ctx.adminToken) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/books/move/preview',
      headers: authHeader(token),
      payload,
    });
  }

  function executeMove(payload: Record<string, unknown>, token = ctx.adminToken) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/books/move',
      headers: authHeader(token),
      payload,
    });
  }

  /** The execute endpoint streams one frame per book plus a final done summary. */
  function parseMoveStream(body: string): { events: BookMoveProgressEvent[]; summary: BookMoveSummary | null } {
    const events: BookMoveProgressEvent[] = [];
    let summary: BookMoveSummary | null = null;

    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as BookMoveProgressEvent;
      events.push(event);
      if ('done' in event && event.done === true) {
        const { processed, succeeded, merged, failed, skipped, cancelled } = event;
        summary = { processed, succeeded, merged, failed, skipped, cancelled };
      }
    }

    return { events, summary };
  }

  async function moveAndSummarize(payload: Record<string, unknown>, token = ctx.adminToken): Promise<BookMoveSummary> {
    const response = await executeMove(payload, token);
    expect(response.statusCode).toBe(200);
    const { summary } = parseMoveStream(response.body);
    if (!summary) throw new Error(`Move stream carried no done summary: ${response.body}`);
    return summary;
  }

  async function readBookRow(bookId: number) {
    const [row] = await ctx.db
      .select({ id: books.id, libraryId: books.libraryId, libraryFolderId: books.libraryFolderId, status: books.status })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    return row ?? null;
  }

  async function readFileRows(bookId: number) {
    return ctx.db
      .select({
        id: bookFiles.id,
        libraryFolderId: bookFiles.libraryFolderId,
        absolutePath: bookFiles.absolutePath,
        relPath: bookFiles.relPath,
      })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId));
  }

  describe('move completion notifications', () => {
    function readNotifications(headers: Record<string, string>, suffix = '', method: 'GET' | 'PATCH' | 'DELETE' = 'GET') {
      return ctx.app.inject({ method, url: `/api/v1/notifications${suffix}`, headers });
    }

    async function openNotificationSocket(token: string) {
      const client = io(`${await ctx.app.getUrl()}/notifications`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      const events: { name: string; data: unknown }[] = [];
      client.onAny((name, data: unknown) => events.push({ name, data }));
      try {
        await vi.waitFor(() => expect(events[0]?.name).toBe('notification:unread-count'));
      } catch (error) {
        client.close();
        throw error;
      }
      return { client, events };
    }

    function followNotificationDeliveries(gateway: NotificationGateway) {
      const calls = [
        vi.spyOn(gateway, 'emitNew'),
        vi.spyOn(gateway, 'emitRead'),
        vi.spyOn(gateway, 'emitDismissed'),
        vi.spyOn(gateway, 'emitCountUpdate'),
        vi.spyOn(gateway, 'emitRefresh'),
      ];
      return {
        async drain() {
          await Promise.all(calls.flatMap((spy) => spy.mock.results.map(({ value }) => value)));
        },
        restore() {
          for (const spy of calls) spy.mockRestore();
        },
      };
    }

    it(
      'delivers a completed move only to the initiator with both library grants, including counts and changes',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'move-notice.epub', 'Move notice fixture');
        const actor = await createUserAndLogin(ctx, {
          permissions: [Permission.LibraryEditMetadata, Permission.NotificationAccess, Permission.ApiKeys],
        });
        const other = await createUserAndLogin(ctx, { permissions: [Permission.NotificationAccess] });
        for (const id of [src.libraryId, dst.libraryId]) {
          await grantLibraryAccess(ctx, actor.userId, id, 'editor');
          await grantLibraryAccess(ctx, other.userId, id, 'viewer');
        }

        const full = authHeader(actor.accessToken);
        const otherHeaders = authHeader(other.accessToken);
        const keys = await Promise.all(
          [[src.libraryId], [dst.libraryId], [src.libraryId, dst.libraryId]].map(async (libraryIds) => {
            const res = await ctx.app.inject({
              method: 'POST',
              url: '/api/v1/api-keys',
              headers: full,
              payload: { name: `Move notice ${libraryIds.join('-')}`, access: 'write', libraryIds, permissions: [Permission.NotificationAccess] },
            });
            expect(res.statusCode, res.body).toBe(201);
            return (res.json() as CreatedApiKey).token;
          }),
        );
        const [legacy] = await ctx.db
          .insert(notifications)
          .values({
            userId: actor.userId,
            type: NotificationType.BulkRenameCompleted,
            title: 'Book move completed',
            message: 'Legacy move details',
            meta: { targetLibraryId: dst.libraryId, moved: 2, failed: 0 },
          })
          .returning();
        const gateway = ctx.app.get(NotificationGateway);
        const delivery = followNotificationDeliveries(gateway);
        const sockets: Awaited<ReturnType<typeof openNotificationSocket>>[] = [];
        try {
          for (const token of [actor.accessToken, other.accessToken, ...keys]) sockets.push(await openNotificationSocket(token));
          for (const { events } of sockets) expect(events.shift()?.data).toEqual({ count: 0 });
          const [initiator, outsider, sourceKey, destinationKey, fullKey] = sockets;
          const summary = await moveAndSummarize(
            {
              selection: { bookIds: [book.bookId] },
              targetLibraryId: dst.libraryId,
              targetFolderId: dst.libraryFolderId,
              collisionPolicy: 'suggested',
            },
            actor.accessToken,
          );
          expect(summary).toMatchObject({ succeeded: 1, failed: 0 });
          await delivery.drain();

          const expectedNotice = (await readNotifications(full)).json().items[0] as NotificationItem;
          expect(expectedNotice).toMatchObject({
            type: NotificationType.BulkRenameCompleted,
            title: 'Book move completed',
            message: expect.stringMatching(/^1 moved to move-dst-.*?, 0 failed$/),
            actionUrl: null,
            meta: { sourceLibraryIds: [src.libraryId], targetLibraryId: dst.libraryId, moved: 1, failed: 0 },
            count: 1,
            read: false,
          });
          expect(JSON.stringify(expectedNotice)).not.toContain('Move notice fixture');
          await vi.waitFor(() => {
            for (const { events } of [initiator, fullKey]) expect(events).toEqual([{ name: 'notification:new', data: expectedNotice }]);
          });

          for (const headers of [full, { 'x-api-key': keys[2] }]) {
            expect((await readNotifications(headers)).json()).toEqual({ items: [expectedNotice], total: 1 });
            expect((await readNotifications(headers, '/unread-count')).json()).toEqual({ count: 1 });
          }
          for (const headers of [otherHeaders, ...keys.slice(0, 2).map((token) => ({ 'x-api-key': token }))]) {
            expect((await readNotifications(headers)).json()).toEqual({ items: [], total: 0 });
            expect((await readNotifications(headers, '/unread-count')).json()).toEqual({ count: 0 });
          }
          expect((await readNotifications(full, '/read-all', 'PATCH')).statusCode).toBe(204);
          expect((await readNotifications(full, `/${expectedNotice.id}/read`, 'PATCH')).statusCode).toBe(204);
          expect((await readNotifications(full, `/${expectedNotice.id}`, 'DELETE')).statusCode).toBe(204);
          for (const headers of [full, { 'x-api-key': keys[0] }]) {
            expect((await readNotifications(headers, '/read-all', 'PATCH')).statusCode).toBe(204);
            expect((await readNotifications(headers, '', 'DELETE')).statusCode).toBe(204);
          }
          const [persisted] = await ctx.db.select().from(notifications).where(eq(notifications.id, legacy.id));
          expect(persisted).toEqual(legacy);

          const service = ctx.app.get(NotificationService);
          for (const user of [actor, other]) {
            await service.notify({
              type: NotificationType.BulkRenameCompleted,
              title: 'Ordinary rename notice',
              scope: { kind: 'user', userId: user.userId },
            });
          }
          await delivery.drain();
          await vi.waitFor(() => {
            for (const { events } of sockets) {
              expect(events.at(-1)).toMatchObject({ name: 'notification:new', data: { title: 'Ordinary rename notice' } });
            }
          });
          for (const { events } of [sourceKey, destinationKey, outsider]) expect(events).toHaveLength(1);
          for (const { events } of [initiator, fullKey]) {
            expect(events).toEqual(
              expect.arrayContaining([
                { name: 'notification:refresh', data: null },
                { name: 'notification:read', data: { id: expectedNotice.id } },
                { name: 'notification:dismissed', data: { id: expectedNotice.id } },
                { name: 'notification:unread-count', data: { count: 0 } },
              ]),
            );
          }

          const expiredAt = new Date('2000-01-01');
          await ctx.db.update(notifications).set({ updatedAt: expiredAt }).where(eq(notifications.id, legacy.id));
          for (const { events } of sockets) events.length = 0;
          expect(await service.runRetentionCleanup()).toBe(1);
          await delivery.drain();
          expect(await ctx.db.select().from(notifications).where(eq(notifications.id, legacy.id))).toHaveLength(0);
          await service.notify({
            type: NotificationType.BulkRenameCompleted,
            title: 'Retention control',
            scope: { kind: 'user', userId: actor.userId },
          });
          await delivery.drain();
          await vi.waitFor(() => {
            for (const { events } of [initiator, sourceKey, destinationKey, fullKey]) {
              expect(events).toEqual([{ name: 'notification:new', data: expect.objectContaining({ title: 'Retention control' }) }]);
            }
          });
        } finally {
          delivery.restore();
          for (const { client } of sockets) client.close();
        }
      },
      SCENARIO_TIMEOUT_MS,
    );

    it.each(['source', 'destination'] as const)(
      'withholds a running move completion after %s access is revoked on a live socket',
      async (side) => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'revoked-notice.epub', 'Revoked move notice fixture');
        const actor = await createUserAndLogin(ctx, { permissions: [Permission.LibraryEditMetadata, Permission.NotificationAccess] });
        for (const id of [src.libraryId, dst.libraryId]) await grantLibraryAccess(ctx, actor.userId, id, 'editor');

        const connection = await openNotificationSocket(actor.accessToken);
        const executor = ctx.app.get(BookMoveExecutorService);
        const execute = executor.execute.bind(executor);
        const delivery = followNotificationDeliveries(ctx.app.get(NotificationGateway));
        let signalExecuted!: () => void;
        const executed = new Promise<void>((resolve) => {
          signalExecuted = resolve;
        });
        let releaseExecutor!: () => void;
        const finish = new Promise<void>((resolve) => {
          releaseExecutor = resolve;
        });
        const pause = vi.spyOn(executor, 'execute').mockImplementationOnce(async (input) => {
          const result = await execute(input);
          signalExecuted();
          await finish;
          return result;
        });
        const move = moveAndSummarize(
          {
            selection: { bookIds: [book.bookId] },
            targetLibraryId: dst.libraryId,
            targetFolderId: dst.libraryFolderId,
            collisionPolicy: 'suggested',
          },
          actor.accessToken,
        );
        try {
          await Promise.race([
            executed,
            move.then(() => {
              throw new Error('Move finished before the executor barrier');
            }),
          ]);
          const revokedId = side === 'source' ? src.libraryId : dst.libraryId;
          const revoke = await ctx.app.inject({
            method: 'DELETE',
            url: `/api/v1/libraries/${revokedId}/access/${actor.userId}?scope=admin`,
            headers: authHeader(ctx.adminToken),
          });
          expect(revoke.statusCode, revoke.body).toBe(204);
          releaseExecutor();
          expect(await move).toMatchObject({ succeeded: 1, failed: 0 });
          await delivery.drain();

          const headers = authHeader(actor.accessToken);
          expect((await readNotifications(headers)).json()).toEqual({ items: [], total: 0 });
          expect((await readNotifications(headers, '/unread-count')).json()).toEqual({ count: 0 });
          const [hidden] = await ctx.db.select().from(notifications).where(eq(notifications.userId, actor.userId));
          expect(hidden?.meta).toEqual({ sourceLibraryIds: [src.libraryId], targetLibraryId: dst.libraryId, moved: 1, failed: 0 });
          expect((await readNotifications(headers, `/${hidden.id}/read`, 'PATCH')).statusCode).toBe(404);
          expect((await readNotifications(headers, `/${hidden.id}`, 'DELETE')).statusCode).toBe(404);
          expect((await readNotifications(headers, '/read-all', 'PATCH')).statusCode).toBe(204);
          expect((await readNotifications(headers, '', 'DELETE')).statusCode).toBe(204);
          const [after] = await ctx.db.select().from(notifications).where(eq(notifications.id, hidden.id));
          expect(after).toEqual(hidden);

          await ctx.app.get(NotificationService).notify({
            type: NotificationType.BulkRenameCompleted,
            title: 'Still connected',
            scope: { kind: 'user', userId: actor.userId },
          });
          await delivery.drain();
          await vi.waitFor(() => {
            expect(connection.events).toEqual([
              { name: 'notification:unread-count', data: { count: 0 } },
              { name: 'notification:new', data: expect.objectContaining({ title: 'Still connected' }) },
            ]);
          });
          expect(connection.client.connected).toBe(true);
        } finally {
          releaseExecutor();
          await Promise.allSettled([move]);
          pause.mockRestore();
          delivery.restore();
          connection.client.close();
        }
      },
      SCENARIO_TIMEOUT_MS,
    );
  });

  describe('preview', () => {
    it(
      'classifies a movable book as ready and resolves its destination path',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Ready ${randomUUID().slice(0, 8)}`;
        const book = await seedEpub(src, 'inbox/ready.epub', title);

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.totalSelected).toBe(1);
        expect(preview.readyCount).toBe(1);
        expect(preview.collisionCount).toBe(0);
        expect(preview.ineligibleCount).toBe(0);
        expect(preview.alreadyInTargetCount).toBe(0);
        expect(preview.targetOrganizationMode).toBe('book_per_file');
        expect(preview.ready[0]).toMatchObject({
          bookId: book.bookId,
          currentPath: book.absolutePath,
          targetPath: join(dst.folderPath, `${title}.epub`),
          layoutChange: null,
        });
        expect(preview.requiresReview).toBe(false);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'reports books that already live in the target folder',
      async () => {
        const dst = await createTarget();
        const book = await seedEpub(dst, 'resident.epub', `Resident ${randomUUID().slice(0, 8)}`);

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;
        expect(preview.alreadyInTargetCount).toBe(1);
        expect(preview.readyCount).toBe(0);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'flags an identical copy in the target as a hash duplicate and suggests merge',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Duplicate ${randomUUID().slice(0, 8)}`;
        const { existing, incoming } = await seedIdenticalPair(src, dst, title);

        const response = await previewMove({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.collisionCount).toBe(1);
        expect(preview.collisions[0]).toMatchObject({
          bookId: incoming.bookId,
          kind: 'hash_duplicate',
          existingBookId: existing.bookId,
          suggestedPolicy: 'merge',
        });
        expect(preview.requiresReview).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'flags a name-only clash as a path collision and offers a keep-both destination',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Clash ${randomUUID().slice(0, 8)}`;

        // Same title (so the resolved destination name matches) but different uid,
        // so the content hashes differ and this is a name clash, not a duplicate.
        const incumbent = await seedIncumbent(dst, title);
        const incoming = await seedEpub(src, 'incoming.epub', title, `${title}-incoming`);

        const response = await previewMove({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.collisionCount).toBe(1);
        const collision = preview.collisions[0];
        expect(collision.bookId).toBe(incoming.bookId);
        // For a book_per_file target the plan's folder key is the destination file
        // path itself, so the folder-owner check reports the clash before the
        // per-file pass gets to it. Both describe the same occupied path.
        expect(collision.kind).toBe('folder_path');
        expect(collision.existingBookId).toBe(incumbent.bookId);
        expect(collision.suggestedPolicy).toBe('keep_both');
        expect(collision.targetPath).toBe(join(dst.folderPath, `${title}.epub`));
        expect(collision.keepBothPath).not.toBe(collision.targetPath);
        expect(collision.keepBothPath.startsWith(dst.folderPath)).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'marks a multi-file book ineligible for a book_per_file target',
      async () => {
        const src = await createSource({ mode: 'book_per_folder' });
        const dst = await createTarget({ mode: 'book_per_file' });
        const title = `Multi ${randomUUID().slice(0, 8)}`;

        await createEpubFixture(src.folderPath, `${title}/book.epub`, { title, uid: title });
        await createPdfFixture(src.folderPath, `${title}/book.pdf`, title);
        await triggerAndWaitForLibraryScan(ctx, src.libraryId);
        const seeded = await locateBookFileByRelPath(ctx, src.libraryId, `${title}/book.epub`);

        const files = await readFileRows(seeded.bookId);
        expect(files.length).toBeGreaterThan(1);

        const response = await previewMove({
          selection: { bookIds: [seeded.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.ineligibleCount).toBe(1);
        expect(preview.ineligible[0]).toMatchObject({
          bookId: seeded.bookId,
          reason: 'multi_file_target_per_file',
        });
        expect(preview.readyCount).toBe(0);
        expect(preview.requiresReview).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'warns when a moved format is outside the target library allow-list',
      async () => {
        const src = await createSource();
        const dst = await createTarget({ allowedFormats: ['pdf'] });
        const book = await seedEpub(src, 'mismatch.epub', `Mismatch ${randomUUID().slice(0, 8)}`);

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.warnings.formatMismatches).toHaveLength(1);
        expect(preview.warnings.formatMismatches[0]).toMatchObject({ bookId: book.bookId, format: 'epub' });
        expect(preview.requiresReview).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'warns about the layout change when the target organizes book-per-folder',
      async () => {
        const src = await createSource({ mode: 'book_per_file' });
        const dst = await createTarget({ mode: 'book_per_folder' });
        const book = await seedEpub(src, 'flat.epub', `Layout ${randomUUID().slice(0, 8)}`);

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.readyCount).toBe(1);
        expect(preview.ready[0].layoutChange).toBe('wrap_into_folder');
        expect(preview.warnings.layout).toMatchObject({ change: 'wrap_into_folder', bookCount: 1 });
        expect(preview.requiresReview).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'warns about users who lose sight of the books after the move',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'watched.epub', `Access ${randomUUID().slice(0, 8)}`);

        const viewer = await createUserAndLogin(ctx);
        await grantLibraryAccess(ctx, viewer.userId, src.libraryId, 'viewer');

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(201);
        const preview = response.json() as BookMovePreviewResult;

        expect(preview.warnings.accessLosers).toContainEqual({
          userId: viewer.userId,
          username: viewer.username,
          bookCount: 1,
        });
        expect(preview.requiresReview).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'rejects a target folder that does not exist',
      async () => {
        const src = await createSource();
        const book = await seedEpub(src, 'orphan.epub', `Orphan ${randomUUID().slice(0, 8)}`);

        const response = await previewMove({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: 999_999,
          targetFolderId: 999_999,
        });

        expect(response.statusCode).toBe(404);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'rejects a query selection that matches no books',
      async () => {
        const empty = await createSource();
        const dst = await createTarget();

        const response = await previewMove({
          selection: { query: { libraryId: empty.libraryId } },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(400);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'rejects a selection naming a book that does not exist',
      async () => {
        const dst = await createTarget();

        const response = await previewMove({
          selection: { bookIds: [9_999_999] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });

        expect(response.statusCode).toBe(404);
      },
      SCENARIO_TIMEOUT_MS,
    );
  });

  describe('execute', () => {
    it(
      'moves the KOReader hash revision of both libraries on, so devices re-read both hash lists',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'revision.epub', `Revision ${randomUUID().slice(0, 8)}`);

        const readRevisions = async () => {
          const rows = await ctx.db
            .select({ id: libraries.id, revision: libraries.koreaderHashRevision })
            .from(libraries)
            .where(inArray(libraries.id, [src.libraryId, dst.libraryId]));
          return new Map(rows.map((row) => [row.id, row.revision]));
        };
        const before = await readRevisions();

        const summary = await moveAndSummarize({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });
        expect(summary).toMatchObject({ succeeded: 1, failed: 0 });

        const after = await readRevisions();
        expect(after.get(src.libraryId)).toBeGreaterThan(before.get(src.libraryId)!);
        expect(after.get(dst.libraryId)).toBeGreaterThan(before.get(dst.libraryId)!);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      're-parents the book, relocates the file, and preserves user state',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Moved ${randomUUID().slice(0, 8)}`;
        const book = await seedEpub(src, 'nested/moved.epub', title);
        const originalPath = book.absolutePath;

        const reader = await createUserAndLogin(ctx);
        await ctx.db.insert(userBookStatus).values({ userId: reader.userId, bookId: book.bookId, status: 'reading', source: 'manual' });
        const [annotation] = await ctx.db
          .insert(annotations)
          .values({ userId: reader.userId, bookId: book.bookId, text: 'preserved highlight' })
          .returning({ id: annotations.id });
        const [collection] = await ctx.db
          .insert(collections)
          .values({ userId: reader.userId, name: `collection-${randomUUID()}` })
          .returning({ id: collections.id });
        await ctx.db.insert(collectionBooks).values({ collectionId: collection.id, bookId: book.bookId });

        const summary = await moveAndSummarize({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });

        expect(summary).toMatchObject({ processed: 1, succeeded: 1, merged: 0, failed: 0, skipped: 0, cancelled: false });

        // The book row and its file rows must both land in the target folder. If the
        // file row were rewritten first, the composite FK back to books would reject it.
        const row = await readBookRow(book.bookId);
        expect(row).toMatchObject({ libraryId: dst.libraryId, libraryFolderId: dst.libraryFolderId, status: 'present' });

        const expectedPath = join(dst.folderPath, `${title}.epub`);
        const files = await readFileRows(book.bookId);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ libraryFolderId: dst.libraryFolderId, absolutePath: expectedPath, relPath: `${title}.epub` });

        expect(await pathExists(expectedPath)).toBe(true);
        expect(await pathExists(originalPath)).toBe(false);

        const [status] = await ctx.db
          .select({ status: userBookStatus.status })
          .from(userBookStatus)
          .where(and(eq(userBookStatus.userId, reader.userId), eq(userBookStatus.bookId, book.bookId)));
        expect(status?.status).toBe('reading');

        const keptAnnotations = await ctx.db.select({ id: annotations.id }).from(annotations).where(eq(annotations.bookId, book.bookId));
        expect(keptAnnotations).toContainEqual({ id: annotation.id });

        const keptCollection = await ctx.db
          .select({ bookId: collectionBooks.bookId })
          .from(collectionBooks)
          .where(and(eq(collectionBooks.collectionId, collection.id), eq(collectionBooks.bookId, book.bookId)));
        expect(keptCollection).toHaveLength(1);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'records a completed job row carrying the per-status counts',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'job.epub', `Job ${randomUUID().slice(0, 8)}`);

        await moveAndSummarize({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });

        const [job] = await ctx.db
          .select()
          .from(bookMoveJobs)
          .where(and(eq(bookMoveJobs.targetLibraryId, dst.libraryId), eq(bookMoveJobs.targetFolderId, dst.libraryFolderId)));

        expect(job).toBeDefined();
        expect(job.status).toBe('completed');
        expect(job.totalBooks).toBe(1);
        expect(job.succeeded).toBe(1);
        expect(job.failed).toBe(0);
        expect(job.sourceLibraryIds).toEqual([src.libraryId]);
        expect(job.finishedAt).not.toBeNull();
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'leaves a colliding book untouched under the skip policy',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Skipped ${randomUUID().slice(0, 8)}`;

        await seedIncumbent(dst, title);
        const incoming = await seedEpub(src, 'incoming.epub', title, `${title}-incoming`);
        const originalPath = incoming.absolutePath;

        const summary = await moveAndSummarize({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'skip',
        });

        // "skip" drops the book from the work list entirely, so nothing is processed.
        expect(summary.succeeded).toBe(0);
        expect(summary.merged).toBe(0);

        const row = await readBookRow(incoming.bookId);
        expect(row?.libraryId).toBe(src.libraryId);
        expect(await pathExists(originalPath)).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'lands a colliding book beside the incumbent under the keep_both policy',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `KeepBoth ${randomUUID().slice(0, 8)}`;

        const existing = await seedIncumbent(dst, title);
        const incoming = await seedEpub(src, 'incoming.epub', title, `${title}-incoming`);

        const previewResponse = await previewMove({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
        });
        const keepBothPath = (previewResponse.json() as BookMovePreviewResult).collisions[0].keepBothPath;

        const summary = await moveAndSummarize({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'keep_both',
        });

        expect(summary.succeeded).toBe(1);

        const files = await readFileRows(incoming.bookId);
        expect(files[0].absolutePath).toBe(keepBothPath);
        expect(await pathExists(keepBothPath)).toBe(true);

        // The incumbent is untouched.
        expect(await pathExists(existing.absolutePath)).toBe(true);
        const incumbent = await readBookRow(existing.bookId);
        expect(incumbent?.libraryId).toBe(dst.libraryId);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'replaces the incumbent copy under the merge policy',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Merge ${randomUUID().slice(0, 8)}`;
        const { existing, incoming } = await seedIdenticalPair(src, dst, title);

        const summary = await moveAndSummarize({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'merge',
        });

        expect(summary.merged).toBe(1);
        expect(summary.failed).toBe(0);

        const moved = await readBookRow(incoming.bookId);
        expect(moved?.libraryId).toBe(dst.libraryId);

        // The duplicate row it replaced is gone.
        expect(await readBookRow(existing.bookId)).toBeNull();
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'keeps the replaced copy’s readers on the moved book under the merge policy',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Absorb ${randomUUID().slice(0, 8)}`;
        const { existing, incoming } = await seedIdenticalPair(src, dst, title);

        const reader = await createUserAndLogin(ctx);
        await ctx.db.insert(userBookStatus).values({ userId: reader.userId, bookId: existing.bookId, status: 'read', source: 'manual' });
        await ctx.db.insert(annotations).values({ userId: reader.userId, bookId: existing.bookId, text: 'kept through the move' });
        const [collection] = await ctx.db
          .insert(collections)
          .values({ userId: reader.userId, name: `collection-${randomUUID()}` })
          .returning({ id: collections.id });
        await ctx.db.insert(collectionBooks).values({ collectionId: collection.id, bookId: existing.bookId });

        const summary = await moveAndSummarize({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'merge',
        });

        expect(summary).toMatchObject({ merged: 1, failed: 0 });
        expect(await readBookRow(existing.bookId)).toBeNull();
        expect((await readBookRow(incoming.bookId))?.libraryId).toBe(dst.libraryId);

        const [status] = await ctx.db.select().from(userBookStatus).where(eq(userBookStatus.bookId, incoming.bookId));
        expect(status).toMatchObject({ userId: reader.userId, status: 'read' });
        const notes = await ctx.db.select().from(annotations).where(eq(annotations.bookId, incoming.bookId));
        expect(notes.map((note) => note.text)).toEqual(['kept through the move']);
        const shelved = await ctx.db.select().from(collectionBooks).where(eq(collectionBooks.collectionId, collection.id));
        expect(shelved.map((row) => row.bookId)).toEqual([incoming.bookId]);
        const [alias] = await ctx.db.select().from(bookMerges).where(eq(bookMerges.sourceBookId, existing.bookId));
        expect(alias?.targetBookId).toBe(incoming.bookId);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'lets a per-book override win over the job-level policy',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const title = `Override ${randomUUID().slice(0, 8)}`;

        await seedIncumbent(dst, title);
        const incoming = await seedEpub(src, 'incoming.epub', title, `${title}-incoming`);

        // Job policy says skip; the override says keep_both, so the book still moves.
        const summary = await moveAndSummarize({
          selection: { bookIds: [incoming.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'skip',
          overrides: [{ bookId: incoming.bookId, policy: 'keep_both' }],
        });

        expect(summary.succeeded).toBe(1);
        const row = await readBookRow(incoming.bookId);
        expect(row?.libraryId).toBe(dst.libraryId);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'wraps a flat book into its own folder for a book_per_folder target',
      async () => {
        const src = await createSource({ mode: 'book_per_file' });
        const dst = await createTarget({ mode: 'book_per_folder' });
        const title = `Wrapped ${randomUUID().slice(0, 8)}`;
        const book = await seedEpub(src, 'flat.epub', title);

        const summary = await moveAndSummarize({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });

        expect(summary.succeeded).toBe(1);

        const expectedPath = join(dst.folderPath, title, `${title}.epub`);
        const files = await readFileRows(book.bookId);
        expect(files[0].absolutePath).toBe(expectedPath);
        expect(await pathExists(expectedPath)).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'picks the primary file by the format priority of the library the book moved into',
      async () => {
        const src = await createSource({ mode: 'book_per_folder' });
        const dst = await createTarget({ mode: 'book_per_folder' });
        await ctx.db
          .update(libraries)
          .set({ formatPriority: ['m4b', 'epub'] })
          .where(eq(libraries.id, dst.libraryId));
        const title = `Both formats ${randomUUID().slice(0, 8)}`;
        await createM4bFixture(src.folderPath, `${title}/${title}.m4b`, { title });
        const book = await seedEpub(src, `${title}/${title}.epub`, title);

        const formatOf = async (fileId: number | null) => (await readFileRows(book.bookId)).find((file) => file.id === fileId)?.relPath ?? null;
        const primaryOf = async () =>
          (await ctx.db.select({ primaryFileId: books.primaryFileId }).from(books).where(eq(books.id, book.bookId)))[0]?.primaryFileId ?? null;
        expect(await formatOf(await primaryOf())).toMatch(/\.epub$/);

        const summary = await moveAndSummarize({
          selection: { bookIds: [book.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });

        expect(summary.succeeded).toBe(1);
        expect(await formatOf(await primaryOf())).toMatch(/\.m4b$/);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'streams one progress frame per book before the done summary',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const first = await seedEpub(src, 'first.epub', `Stream A ${randomUUID().slice(0, 8)}`);
        const second = await seedEpub(src, 'second.epub', `Stream B ${randomUUID().slice(0, 8)}`);

        const response = await executeMove({
          selection: { bookIds: [first.bookId, second.bookId] },
          targetLibraryId: dst.libraryId,
          targetFolderId: dst.libraryFolderId,
          collisionPolicy: 'suggested',
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/event-stream');

        const { events, summary } = parseMoveStream(response.body);
        const perBook = events.filter((event) => !('done' in event)) as { bookId: number; status: string }[];

        expect(perBook).toHaveLength(2);
        expect(perBook.map((event) => event.bookId).sort()).toEqual([first.bookId, second.bookId].sort());
        expect(perBook.every((event) => event.status === 'success')).toBe(true);
        expect(summary).toMatchObject({ processed: 2, succeeded: 2 });

        // The done frame is last.
        expect('done' in events[events.length - 1]).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );
  });

  describe('access control', () => {
    it(
      'refuses a mover without editor access to the source library',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'guarded.epub', `Guarded ${randomUUID().slice(0, 8)}`);

        const mover = await createUserAndLogin(ctx, { permissions: [Permission.LibraryEditMetadata] });
        await grantLibraryAccess(ctx, mover.userId, src.libraryId, 'viewer');
        await grantLibraryAccess(ctx, mover.userId, dst.libraryId, 'editor');

        const response = await executeMove(
          {
            selection: { bookIds: [book.bookId] },
            targetLibraryId: dst.libraryId,
            targetFolderId: dst.libraryFolderId,
            collisionPolicy: 'suggested',
          },
          mover.accessToken,
        );

        expect(response.statusCode).toBe(403);
        const row = await readBookRow(book.bookId);
        expect(row?.libraryId).toBe(src.libraryId);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it(
      'refuses a mover without editor access to the target library',
      async () => {
        const src = await createSource();
        const dst = await createTarget();
        const book = await seedEpub(src, 'guarded-target.epub', `GuardedTarget ${randomUUID().slice(0, 8)}`);

        const mover = await createUserAndLogin(ctx, { permissions: [Permission.LibraryEditMetadata] });
        await grantLibraryAccess(ctx, mover.userId, src.libraryId, 'editor');
        await grantLibraryAccess(ctx, mover.userId, dst.libraryId, 'viewer');

        const response = await executeMove(
          {
            selection: { bookIds: [book.bookId] },
            targetLibraryId: dst.libraryId,
            targetFolderId: dst.libraryFolderId,
            collisionPolicy: 'suggested',
          },
          mover.accessToken,
        );

        expect(response.statusCode).toBe(403);
        const row = await readBookRow(book.bookId);
        expect(row?.libraryId).toBe(src.libraryId);
      },
      SCENARIO_TIMEOUT_MS,
    );
  });
});
