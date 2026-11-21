import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { and, eq } from 'drizzle-orm';
import { NotificationType, Permission, type CreatedApiKey, type NotificationItem } from '@bookorbit/types';
import { io } from 'socket.io-client';

import * as schema from '../src/db/schema';
import { AchievementRepository } from '../src/modules/achievement/achievement.repository';
import { LibraryRepository } from '../src/modules/library/library.repository';
import { NotificationRepository } from '../src/modules/notification/notification.repository';
import { NotificationGateway } from '../src/modules/notification/notification.gateway';
import { ScannerRepository } from '../src/modules/scanner/scanner.repository';
import { ScanGateway } from '../src/modules/scanner/scan.gateway';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  grantLibraryAccess,
  triggerAndWaitForLibraryScan,
  uploadLibraryFile,
  type AuthorizationMatrixE2EContext,
} from './e2e/authorization-matrix/authorization-matrix-harness';
import { createEpubFixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';

describe('explicit library grants and collection ownership (e2e)', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let ownerId: number;
  let adminId: number;
  let ownerToken: string;
  let first: number;
  let second: number;
  let legacy: number;
  let firstBook: number;
  let secondBook: number;
  let privateCollection: number;
  let publicCollection: number;
  let privateTitle: string;
  const principals: { name: string; headers: Record<string, string>; userId: number }[] = [];

  async function key(token: string, input: Record<string, unknown>): Promise<CreatedApiKey> {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: authHeader(token), payload: input });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }

  async function revoke(userId: number, libraryId: number) {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/libraries/${libraryId}/access/${userId}?scope=admin`,
      headers: authHeader(ctx.adminToken),
    });
    expect(response.statusCode, response.body).toBe(204);
  }

  beforeAll(async () => {
    ctx = await createAuthorizationMatrixE2EContext();
    const owner = await createUserAndLogin(ctx, { permissions: [Permission.ApiKeys, Permission.LibraryUpload, Permission.LibraryDownload] });
    const other = await createUserAndLogin(ctx);
    ownerId = owner.userId;
    ownerToken = owner.accessToken;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(ctx.adminToken) });
    adminId = me.json().id;

    const suffix = randomUUID();
    privateTitle = `Private example ${suffix}`;
    const firstLibrary = await createLibraryWithFolder(ctx, { name: `Explicitly shared ${suffix}` });
    const secondLibrary = await createLibraryWithFolder(ctx, { name: `Another reader private ${suffix}` });
    ({ libraryId: legacy } = await createLibraryWithFolder(ctx, { name: `Legacy system library with no grants ${suffix}` }));
    first = firstLibrary.libraryId;
    second = secondLibrary.libraryId;
    await grantLibraryAccess(ctx, ownerId, first, 'owner');
    await grantLibraryAccess(ctx, other.userId, second, 'owner');
    const custodian = await createUserAndLogin(ctx, { username: `custodian-${suffix}`, permissions: [] });
    await grantLibraryAccess(ctx, custodian.userId, first, 'owner');

    for (const [library, title] of [
      [firstLibrary, 'Visible example'],
      [secondLibrary, privateTitle],
    ] as const) {
      const [book] = await ctx.db
        .insert(schema.books)
        .values({
          libraryId: library.libraryId,
          libraryFolderId: library.libraryFolderId,
          folderPath: `${library.folderPath}/synthetic`,
        })
        .returning();
      await ctx.db.insert(schema.bookMetadata).values({ bookId: book.id, title });
      if (library.libraryId === first) firstBook = book.id;
      else secondBook = book.id;
    }

    for (const isPublic of [false, true]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: authHeader(other.accessToken),
        payload: { name: isPublic ? 'Public selection' : 'Private selection', icon: 'FolderOpen', isPublic },
      });
      expect(response.statusCode, response.body).toBe(201);
      if (isPublic) publicCollection = response.json().id;
      else privateCollection = response.json().id;
    }
    await ctx.db.insert(schema.collectionBooks).values([
      { collectionId: publicCollection, bookId: firstBook },
      { collectionId: publicCollection, bookId: secondBook },
    ]);

    principals.push({ name: 'ordinary session', headers: authHeader(ownerToken), userId: ownerId });
    principals.push({ name: 'superuser session', headers: authHeader(ctx.adminToken), userId: adminId });
    for (const [name, token, input, userId] of [
      ['ordinary API key', ownerToken, {}, ownerId],
      ['superuser plain API key', ctx.adminToken, {}, adminId],
      ['superuser admin API key', ctx.adminToken, { admin: true }, adminId],
    ] as const) {
      const created = await key(token, { name, access: 'write', ...input });
      principals.push({ name, headers: { 'x-api-key': created.token }, userId });
    }
    await ctx.app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
  });

  // The same existing session/key is used before the grant, after it, and after revocation.
  for (const name of ['ordinary session', 'superuser session', 'ordinary API key', 'superuser plain API key', 'superuser admin API key']) {
    it(`${name}: denies guessed IDs, accepts an explicit grant and immediately respects revocation`, async () => {
      const principal = principals.find((item) => item.name === name)!;
      const { headers, userId } = principal;
      const read = (url: string) => ctx.app.inject({ method: 'GET', url: `/api/v1/${url}`, headers });
      const books = () => ctx.app.inject({ method: 'POST', url: `/api/v1/libraries/${second}/books`, headers, payload: {} });
      expect((await read(`libraries/${second}`)).statusCode).toBe(403);
      expect((await books()).statusCode).toBe(403);
      expect((await read(`books/${secondBook}`)).statusCode).toBe(404);
      const searchUrl = `books/search?q=${encodeURIComponent(privateTitle)}`;
      expect((await read(searchUrl)).json()).toEqual([]);
      expect((await read('libraries')).json().map((library: { id: number }) => library.id)).not.toContain(second);

      const grant = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/libraries/${second}/access?scope=admin`,
        headers: authHeader(ctx.adminToken),
        payload: { userId, accessLevel: 'viewer' },
      });
      expect(grant.statusCode, grant.body).toBe(201);
      expect((await read(`books/${secondBook}`)).statusCode).toBe(200);
      expect((await read(searchUrl)).json().map((book: { id: number }) => book.id)).toEqual([secondBook]);
      expect((await books()).statusCode).toBe(201);
      expect((await read('libraries')).json().map((library: { id: number }) => library.id)).toContain(second);
      // Prime the real statistics cache with this library's data.
      const summaryUrl = `statistics/summary?libraryIds=${second}`;
      expect((await read(summaryUrl)).json().totalBooks).toBe(1);
      await revoke(userId, second);
      expect((await read(`books/${secondBook}`)).statusCode).toBe(404);
      expect((await read(searchUrl)).json()).toEqual([]);
      expect((await read(summaryUrl)).json().totalBooks).toBe(0);
      expect((await read('libraries')).json().map((library: { id: number }) => library.id)).not.toContain(second);
    });

    it(`${name}: private collections deny direct access and public collections do not expand book visibility`, async () => {
      const { headers, userId } = principals.find((item) => item.name === name)!;
      if (userId === adminId) await grantLibraryAccess(ctx, adminId, first, 'viewer');
      const listing = await ctx.app.inject({ method: 'GET', url: '/api/v1/collections', headers });
      expect(listing.json().map((collection: { id: number }) => collection.id)).not.toContain(privateCollection);
      expect(listing.json().map((collection: { id: number }) => collection.id)).toContain(publicCollection);
      for (const suffix of ['', '/books']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/collections/${privateCollection}${suffix}`, headers })).statusCode).toBe(403);
      }
      const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/collections/${publicCollection}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().bookCount).toBe(1);
      const books = await ctx.app.inject({ method: 'GET', url: `/api/v1/collections/${publicCollection}/books`, headers });
      expect(books.statusCode, books.body).toBe(200);
      expect(books.json().items.map((book: { id: number }) => book.id)).toEqual([firstBook]);

      for (const id of [privateCollection, publicCollection]) {
        expect(
          (await ctx.app.inject({ method: 'PATCH', url: `/api/v1/collections/${id}`, headers, payload: { name: 'Unauthorized edit' } })).statusCode,
        ).toBe(403);
        expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/collections/${id}`, headers })).statusCode).toBe(403);
        expect(
          (await ctx.app.inject({ method: 'POST', url: `/api/v1/collections/${id}/books`, headers, payload: { bookIds: [firstBook] } })).statusCode,
        ).toBe(403);
        expect(
          (await ctx.app.inject({ method: 'DELETE', url: `/api/v1/collections/${id}/books`, headers, payload: { bookIds: [firstBook] } })).statusCode,
        ).toBe(403);
      }
    });
  }

  it('lets owners read, edit and delete their own private collections through a session or write key', async () => {
    for (const { headers } of principals.filter((principal) => principal.userId === ownerId)) {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers,
        payload: { name: `Owned ${Date.now()}`, icon: 'FolderOpen' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const url = `/api/v1/collections/${created.json().id}`;
      expect((await ctx.app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'PATCH', url, headers, payload: { name: `Renamed ${Date.now()}` } })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204);
      expect((await ctx.app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
    }
  });

  it('keeps an ownerless legacy library hidden but preserves the administrative grant recovery route', async () => {
    const headers = authHeader(ctx.adminToken);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers });
    expect(list.json().map((library: { id: number }) => library.id)).not.toContain(legacy);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${legacy}`, headers })).statusCode).toBe(403);
    const grant = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${legacy}/access?scope=admin`,
      headers,
      payload: { userId: adminId, accessLevel: 'owner' },
    });
    expect(grant.statusCode, grant.body).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${legacy}`, headers })).statusCode).toBe(200);
  });

  it('intersects a key whitelist with current grants, and a read-only key cannot edit its owners collection', async () => {
    await grantLibraryAccess(ctx, ownerId, second, 'viewer');
    const created = await key(ownerToken, { name: 'Narrow reader', libraryIds: [first] });
    const headers = { 'x-api-key': created.token };
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers });
    expect(list.json().map((library: { id: number }) => library.id)).toEqual([first]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${secondBook}`, headers })).statusCode).toBe(404);
    const collection = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authHeader(ownerToken),
      payload: { name: 'Read key owner', icon: 'FolderOpen' },
    });
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: `/api/v1/collections/${collection.json().id}`, headers, payload: { name: 'Denied' } }))
        .statusCode,
    ).toBe(403);
    await revoke(ownerId, first);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers })).json()).toEqual([]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${firstBook}`, headers })).statusCode).toBe(404);
    await grantLibraryAccess(ctx, ownerId, first, 'owner');
    await revoke(ownerId, second);
  });

  it('scopes notification, scan-recipient and achievement queries to grants, including API-key library limits', async () => {
    await ctx.db
      .delete(schema.userLibraryAccess)
      .where(and(eq(schema.userLibraryAccess.userId, adminId), eq(schema.userLibraryAccess.libraryId, second)));
    const notifications = ctx.app.get(NotificationRepository);
    const libraries = ctx.app.get(LibraryRepository);
    const scanner = ctx.app.get(ScannerRepository);
    for (const ids of [await notifications.findUserIdsWithLibraryAccess(second), await scanner.findLibraryAccessibleUserIds(second)]) {
      expect(ids).not.toContain(adminId);
    }
    expect(await libraries.findUserIdsWithAccess(second, [ownerId, adminId])).toEqual([]);
    const achievements = ctx.app.get(AchievementRepository);
    expect(await achievements.findAccessibleBookIds(adminId, true, [secondBook])).toEqual(new Set());
    await grantLibraryAccess(ctx, adminId, second, 'viewer');
    expect(await notifications.findUserIdsWithLibraryAccess(second)).toContain(adminId);
    expect(await scanner.findLibraryAccessibleUserIds(second)).toContain(adminId);
    expect(await achievements.findAccessibleBookIds(adminId, true, [secondBook])).toEqual(new Set([secondBook]));
    expect(await achievements.countAccessibleBooks(adminId, true, [first])).toBe(1);
    expect(await achievements.findAccessibleBookIds(adminId, true, [secondBook], [first])).toEqual(new Set());
  });

  it('revalidates live API keys before delivering to an established scan socket', async () => {
    const gateway = ctx.app.get(ScanGateway);
    for (const action of ['revoke', 'expire'] as const) {
      const created = await key(ownerToken, { name: `Socket ${action}` });
      const client = io(`${await ctx.app.getUrl()}/scan`, {
        auth: { token: created.token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      const events: unknown[] = [];
      client.on('scan:progress', (event: unknown) => events.push(event));
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('connect_error', reject);
        });
        client.emit('subscribe:library', first);
        await vi.waitFor(() => expect(gateway.server.adapter.rooms.get(`library:${first}`)?.has(client.id!)).toBe(true));
        if (action === 'revoke') {
          const response = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${created.key.id}`, headers: authHeader(ownerToken) });
          expect(response.statusCode).toBe(204);
        } else {
          await ctx.db
            .update(schema.apiKeys)
            .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(schema.apiKeys.id, created.key.id));
        }
        const disconnected = new Promise<string>((resolve) => client.once('disconnect', resolve));
        await gateway.emitProgress({ jobId: 1, libraryId: first, status: 'running', processed: 1, total: 2, added: 0, updated: 0, missing: 0 });
        await expect(disconnected).resolves.toBe('io server disconnect');
        expect(events).toEqual([]);
      } finally {
        client.close();
      }
    }
  }, 15_000);

  it('uses current library scope when exposing merge and duplicate resolution results', async () => {
    const [merge] = await ctx.db
      .insert(schema.bookMergeJobs)
      .values({
        libraryId: first,
        libraryIds: [first, second],
        targetBookId: firstBook,
        sourceBookIds: [secondBook],
        requestedByUserId: adminId,
        status: 'done',
        plan: {},
      })
      .returning();
    const [scan] = await ctx.db
      .insert(schema.bookDuplicateScans)
      .values({
        userId: adminId,
        libraryIds: [first, second],
        similarityPercent: 90,
        status: 'completed',
      })
      .returning();
    const [resolution] = await ctx.db
      .insert(schema.bookDuplicateResolutions)
      .values({
        userId: adminId,
        scanId: scan.id,
        status: 'completed',
        total: 1,
      })
      .returning();
    await grantLibraryAccess(ctx, adminId, first, 'viewer');
    await grantLibraryAccess(ctx, adminId, second, 'viewer');
    const bounded = await key(ctx.adminToken, {
      name: 'First-library job reader',
      libraryIds: [first],
      permissions: [Permission.LibraryMergeBooks, Permission.LibraryDeleteBooks],
    });
    const session = authHeader(ctx.adminToken);
    const read = (url: string, headers: Record<string, string>) => ctx.app.inject({ method: 'GET', url: `/api/v1/${url}`, headers });
    const mergeUrl = `books/merge/jobs/${merge.id}`;
    const resolutionUrl = `book-duplicates/resolutions/${resolution.id}`;
    expect((await read(mergeUrl, session)).json()).toMatchObject({ id: merge.id, sourceBookIds: [secondBook] });
    expect((await read(resolutionUrl, session)).json()).toMatchObject({ id: resolution.id });
    expect((await read(mergeUrl, { 'x-api-key': bounded.token })).statusCode).toBe(404);
    expect((await read(resolutionUrl, { 'x-api-key': bounded.token })).statusCode).toBe(403);
    await revoke(adminId, second);
    expect((await read(mergeUrl, session)).statusCode).toBe(404);
    expect((await read(resolutionUrl, session)).statusCode).toBe(403);
  });

  it('rejects a mixed administrative reorder outside a write key library bound', async () => {
    const bounded = await key(ctx.adminToken, {
      name: 'First-library settings writer',
      access: 'write',
      libraryIds: [first],
      permissions: [Permission.ManageLibraries],
    });
    const readOrder = (id: number) =>
      ctx.db.select({ order: schema.libraries.displayOrder }).from(schema.libraries).where(eq(schema.libraries.id, id));
    const original = await Promise.all([readOrder(first), readOrder(second)]);
    const reorder = (ids: number[]) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/libraries/reorder',
        headers: { 'x-api-key': bounded.token },
        payload: { order: ids.map((id, index) => ({ id, displayOrder: 30 + index })) },
      });
    expect((await reorder([first, second])).statusCode).toBe(403);
    expect(await Promise.all([readOrder(first), readOrder(second)])).toEqual(original);
    expect((await reorder([first])).statusCode).toBe(204);
    expect(await readOrder(first)).toEqual([{ order: 30 }]);
  });

  it('drops an established scan subscription after its library grant is revoked', async () => {
    await grantLibraryAccess(ctx, ownerId, second, 'viewer');
    const bounded = await key(ownerToken, { name: 'Second library scan reader', libraryIds: [second] });
    const gateway = ctx.app.get(ScanGateway);
    const url = `${await ctx.app.getUrl()}/scan`;
    const sockets = [ownerToken, bounded.token].map((token) =>
      io(url, { autoConnect: false, auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false }),
    );
    const readingProgress: number[][] = sockets.map(() => []);
    const progress = (jobId: number) =>
      gateway.emitProgress({
        jobId,
        libraryId: second,
        status: 'running',
        processed: 1,
        total: 2,
        added: 0,
        updated: 0,
        missing: 0,
      });
    try {
      const events = await Promise.all(
        sockets.map(async (socket, index) => {
          const received: number[] = [];
          socket.on('scan:progress', (event: { jobId: number }) => received.push(event.jobId));
          socket.on('book:progress-changed', (event: { progress: number }) => readingProgress[index].push(event.progress));
          await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            socket.connect();
          });
          socket.emit('subscribe:library', second);
          return received;
        }),
      );
      await vi.waitFor(() => expect(sockets.every((socket) => gateway.server.adapter.rooms.get(`library:${second}`)?.has(socket.id!))).toBe(true));
      await progress(72001);
      await vi.waitFor(() => expect(events).toEqual([[72001], [72001]]));
      await gateway.emitBookProgressChanged({ userId: ownerId, bookId: secondBook, progress: 20, source: 'web_reader' });
      await vi.waitFor(() => expect(readingProgress).toEqual([[20], [20]]));
      const summary = () =>
        ctx.app.inject({
          method: 'GET',
          url: `/api/v1/statistics/summary?libraryIds=${second}`,
          headers: authHeader(ownerToken),
        });
      expect((await summary()).json().totalBooks).toBe(1);
      await revoke(ownerId, second);
      expect((await summary()).json().totalBooks).toBe(0);
      await progress(72002);
      await gateway.emitBookProgressChanged({ userId: ownerId, bookId: secondBook, progress: 30, source: 'web_reader' });
      expect(sockets.every((socket) => !gateway.server.adapter.rooms.get(`library:${second}`)?.has(socket.id!))).toBe(true);
      expect(events).toEqual([[72001], [72001]]);
      expect(readingProgress).toEqual([[20], [20]]);
    } finally {
      for (const socket of sockets) socket.close();
    }
  }, 15_000);

  it('filters historical library notifications, unread counts and live events by current grants and key scope', async () => {
    await grantLibraryAccess(ctx, adminId, first, 'viewer');
    await grantLibraryAccess(ctx, adminId, second, 'viewer');
    const rows = await ctx.db
      .insert(schema.notifications)
      .values([
        { userId: adminId, type: NotificationType.ScanCompleted, title: 'Visible scan notification', meta: { libraryId: first } },
        { userId: adminId, type: NotificationType.ScanCompleted, title: 'Other library notification', meta: { libraryId: second } },
      ])
      .returning();
    const read = (headers: Record<string, string>, path = '') => ctx.app.inject({ method: 'GET', url: `/api/v1/notifications${path}`, headers });
    const full = await read(authHeader(ctx.adminToken));
    expect(full.statusCode, full.body).toBe(200);
    const items = full.json().items as NotificationItem[];
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(rows.map((row) => row.id)));
    const keyRecord = await key(ctx.adminToken, {
      name: 'Library notification reader',
      access: 'write',
      libraryIds: [first],
      permissions: [Permission.NotificationAccess],
    });
    const headers = { 'x-api-key': keyRecord.token };
    const scoped = await read(headers);
    expect(scoped.json().items.map((item: NotificationItem) => item.id)).toContain(rows[0].id);
    expect(scoped.json().items.map((item: NotificationItem) => item.id)).not.toContain(rows[1].id);
    const countBefore = (await read(authHeader(ctx.adminToken), '/unread-count')).json().count as number;
    const keyCount = (await read(headers, '/unread-count')).json().count as number;
    expect(countBefore).toBeGreaterThan(keyCount);

    const client = io(`${await ctx.app.getUrl()}/notifications`, {
      auth: { token: keyRecord.token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const received: NotificationItem[] = [];
    const dismissed: number[] = [];
    client.on('notification:new', (item: NotificationItem) => received.push(item));
    client.on('notification:dismissed', ({ id }: { id: number }) => dismissed.push(id));
    try {
      const initialCount = await new Promise<{ count: number }>((resolve) => client.once('notification:unread-count', resolve));
      expect(initialCount.count).toBe(keyCount);
      const gateway = ctx.app.get(NotificationGateway);
      await gateway.emitNew(
        adminId,
        items.find((item) => item.id === rows[1].id)!,
      );
      await gateway.emitNew(
        adminId,
        items.find((item) => item.id === rows[0].id)!,
      );
      await vi.waitFor(() => expect(received.map((item) => item.id)).toEqual([rows[0].id]));
      const mutate = (method: 'PATCH' | 'DELETE', suffix: string, actor: Record<string, string> = headers) =>
        ctx.app.inject({ method, url: `/api/v1/notifications${suffix}`, headers: actor });
      expect((await mutate('PATCH', `/${rows[1].id}/read`)).statusCode).toBe(404);
      expect((await mutate('DELETE', `/${rows[1].id}`)).statusCode).toBe(404);
      expect((await mutate('PATCH', '/read-all')).statusCode).toBe(204);
      const [outsideKey] = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.id, rows[1].id));
      expect(outsideKey.read).toBe(false);

      const [outsideEvent] = await ctx.db
        .insert(schema.notifications)
        .values({
          userId: adminId,
          type: NotificationType.ScanCompleted,
          title: 'Dismissal outside key scope',
          meta: { libraryId: second },
          read: true,
        })
        .returning();
      expect((await mutate('DELETE', `/${outsideEvent.id}`, authHeader(ctx.adminToken))).statusCode).toBe(204);
      expect((await mutate('DELETE', `/${rows[0].id}`)).statusCode).toBe(204);
      await vi.waitFor(() => expect(dismissed).toEqual([rows[0].id]));
      expect((await mutate('DELETE', '')).statusCode).toBe(204);
      expect(await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.id, rows[1].id))).toHaveLength(1);

      await revoke(adminId, second);
      expect((await read(authHeader(ctx.adminToken))).json().items.map((item: NotificationItem) => item.id)).not.toContain(rows[1].id);
      expect((await read(authHeader(ctx.adminToken), '/unread-count')).json().count).toBe(0);
      expect((await mutate('PATCH', `/${rows[1].id}/read`, authHeader(ctx.adminToken))).statusCode).toBe(404);

      await ctx.app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${keyRecord.key.id}`, headers: authHeader(ctx.adminToken) });
      const disconnected = new Promise<string>((resolve) => client.once('disconnect', resolve));
      await gateway.emitNew(
        adminId,
        items.find((item) => item.id === rows[0].id)!,
      );
      await expect(disconnected).resolves.toBe('io server disconnect');
      expect(received.map((item) => item.id)).toEqual([rows[0].id]);
    } finally {
      client.close();
    }
  }, 15_000);

  it('preserves native upload, filesystem placement, scanning and EPUB reading for an explicitly authorized owner', async () => {
    const library = await createLibraryWithFolder(ctx);
    await grantLibraryAccess(ctx, ownerId, library.libraryId, 'owner');
    const source = await createEpubFixture(ctx.fixture.rootPath, 'reading-regression.epub', { title: 'Reading regression' });
    const uploaded = await uploadLibraryFile(ctx, {
      token: ownerToken,
      libraryId: library.libraryId,
      folderId: library.libraryFolderId,
      fileName: 'reading-regression.epub',
      content: await readFile(source),
      contentType: 'application/epub+zip',
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const bookId = uploaded.json().bookId as number;
    await vi.waitFor(async () => {
      const row = await ctx.db.query.books.findFirst({ where: eq(schema.books.id, bookId) });
      expect(row?.status).toBe('present');
    });
    const file = await ctx.db.query.bookFiles.findFirst({ where: eq(schema.bookFiles.bookId, bookId) });
    expect(file?.absolutePath.startsWith(`${library.folderPath}/`)).toBe(true);
    await expect(readFile(file!.absolutePath)).resolves.toEqual(await readFile(source));
    expect(ctx.metadataMock.extractAndSave).toHaveBeenCalledWith(bookId, expect.any(String), 'epub');
    const scan = await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    expect(scan.status).toBe('completed');
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/epub/${bookId}/info`, headers: authHeader(ownerToken) });
    expect(response.statusCode, response.body).toBe(200);
    // Administrative scanning is retained; reading still needs a content grant.
    const denied = await ctx.app.inject({ method: 'GET', url: `/api/v1/epub/${bookId}/info`, headers: authHeader(ctx.adminToken) });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ message: `Book ${bookId} not found` });
  }, 20_000);
});
