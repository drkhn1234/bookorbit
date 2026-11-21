import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Permission } from '@bookorbit/types';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';

import { LibraryOperationGate } from '../src/common/services/library-operation-gate.service';
import * as schema from '../src/db/schema';
import { LibraryScanSchedulerService } from '../src/modules/library/library-scan-scheduler.service';
import { FileWatcherService } from '../src/modules/scanner/file-watcher.service';
import { ScannerRepository } from '../src/modules/scanner/scanner.repository';
import { ScannerService } from '../src/modules/scanner/scanner.service';
import { seedLibrary, waitForCondition, waitForScanCompletion } from './e2e/app-harness';
import { createEpubFixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  locateBookByAbsolutePath,
  type AuthorizationMatrixE2EContext,
  type TestUserSession,
} from './e2e/authorization-matrix/authorization-matrix-harness';

const pauseKey = 72104913;
const cron = '0 4 * * *';

describe('administrative folder replacement (PostgreSQL e2e)', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let observer: Client;
  let root: string;
  let manager: TestUserSession;
  let scanner: ScannerService;
  let gate: LibraryOperationGate;
  let administratorId: number;
  const databaseUrl = process.env.E2E_DATABASE_URL;
  const previous = { browse: process.env.LIBRARY_BROWSE_ROOT, personal: process.env.PERSONAL_LIBRARY_ROOT };

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_e2e')) throw new Error('A disposable E2E_DATABASE_URL is required');
    root = await mkdtemp(join(tmpdir(), 'bo-rebind-'));
    process.env.LIBRARY_BROWSE_ROOT = root;
    process.env.PERSONAL_LIBRARY_ROOT = join(root, 'personal');
    ctx = await createAuthorizationMatrixE2EContext();
    gate = ctx.app.get(LibraryOperationGate);
    scanner = ctx.app.get(ScannerService);
    manager = await createUserAndLogin(ctx, { permissions: [Permission.ManageLibraries] });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(ctx.adminToken) });
    administratorId = me.json().id;
    observer = new Client({ connectionString: databaseUrl });
    await observer.connect();
    await observer.query(`
      create function e2e_rebind_settings_barrier() returns trigger language plpgsql as $body$
      begin
        if new.name like 'Rebind pause %' and old.name <> new.name then
          perform pg_advisory_xact_lock(${pauseKey});
        end if;
        if new.name like 'Rebind fail %' then
          raise exception 'synthetic late settings failure' using errcode = '23514';
        end if;
        return new;
      end
      $body$;
      create trigger e2e_rebind_settings_barrier before update on libraries
      for each row execute function e2e_rebind_settings_barrier();
    `);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ctx) {
      await waitForCondition(async () => {
        const ids = await ctx.db.select({ id: schema.libraries.id }).from(schema.libraries);
        expect(ids.filter(({ id }) => gate.isHeld(id))).toEqual([]);
      });
    }
  });

  afterAll(async () => {
    try {
      if (observer) {
        await observer.query(
          'drop trigger if exists e2e_rebind_settings_barrier on libraries; drop function if exists e2e_rebind_settings_barrier()',
        );
        await observer.end();
      }
      if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      if (previous.browse === undefined) delete process.env.LIBRARY_BROWSE_ROOT;
      else process.env.LIBRARY_BROWSE_ROOT = previous.browse;
      if (previous.personal === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
      else process.env.PERSONAL_LIBRARY_ROOT = previous.personal;
    }
  });

  async function directory(name: string = randomUUID()) {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return path;
  }

  async function library() {
    const path = await directory();
    const ids = await seedLibrary(ctx.db, { rootPath: path, mode: 'book_per_file' });
    await ctx.db.update(schema.libraries).set({ icon: 'BookOpen' }).where(eq(schema.libraries.id, ids.libraryId));
    await grantLibraryAccess(ctx, administratorId, ids.libraryId, 'owner');
    return { ...ids, path };
  }

  function rebind(id: number, folders: string[], fields: Record<string, unknown> = {}) {
    return Promise.resolve(
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/libraries/${id}?scope=admin`,
        headers: authHeader(ctx.adminToken),
        payload: { folders, ...fields },
      }),
    );
  }

  async function registryState(id: number) {
    const { rows } = await observer.query(
      `select l.name, l.watch, l.auto_scan_cron_expression as schedule, l.koreader_hash_revision as revision,
        (select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path) order by f.id)
         from library_folders f where f.library_id = l.id) as folders
       from libraries l where l.id = $1`,
      [id],
    );
    return rows[0];
  }

  async function waitForAdvisoryWaiter(key: number, blocker: number) {
    let pid: number;
    await waitForCondition(async () => {
      const { rows } = await observer.query<{ pid: number; blockers: number[] }>(
        `select pid, pg_blocking_pids(pid) as blockers from pg_locks
         where locktype = 'advisory' and classid = 0 and objid = $1 and objsubid = 1 and not granted
           and database = (select oid from pg_database where datname = current_database())`,
        [key],
      );
      const waiter = rows.find(({ blockers }) => blockers.includes(blocker));
      expect(waiter).toBeDefined();
      pid = waiter!.pid;
    }, 8_000);
    return pid!;
  }

  async function concurrentWithRebind<A, B>(first: () => Promise<A>, second: () => Promise<B>, checkUncommitted: () => Promise<void>) {
    const {
      rows: [{ pid }],
    } = await observer.query<{ pid: number }>('select pg_backend_pid() as pid');
    await observer.query('select pg_advisory_lock($1::bigint)', [pauseKey]);
    const primary = first();
    let contender: Promise<B> | undefined;
    try {
      const primaryPid = await waitForAdvisoryWaiter(pauseKey, pid);
      contender = second();
      await waitForAdvisoryWaiter(72104912, primaryPid);
      await checkUncommitted();
    } finally {
      await observer.query('select pg_advisory_unlock($1::bigint)', [pauseKey]);
      await Promise.allSettled(contender ? [primary, contender] : [primary]);
    }
    return [await primary, await contender!] as const;
  }

  it('serializes rebind against an overlapping library creation and preserves the owner and persisted registrations', async () => {
    const existing = await library();
    const managerRoot = join(root, 'personal', manager.username);
    const provision = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/path',
      headers: authHeader(manager.accessToken),
      payload: { parentPath: managerRoot, name: 'Candidate' },
    });
    expect(provision.statusCode, provision.body).toBe(201);
    const parent = join(managerRoot, 'Candidate');
    const child = await directory(join('personal', manager.username, 'Candidate', 'child'));
    const name = `Rebind pause ${randomUUID()}`;
    const competingName = `Contending creation ${randomUUID()}`;
    const previousState = await registryState(existing.libraryId);

    const [first, second] = await concurrentWithRebind(
      () => rebind(existing.libraryId, [parent], { name }),
      () =>
        Promise.resolve(
          ctx.app.inject({
            method: 'POST',
            url: '/api/v1/libraries',
            headers: authHeader(manager.accessToken),
            payload: { name: competingName, icon: 'BookOpen', folders: [child] },
          }),
        ),
      async () => expect(await registryState(existing.libraryId)).toEqual(previousState),
    );

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ errorCode: 'LIBRARY_FOLDER_OVERLAP' });
    expect(second.body).not.toContain(name);
    expect(await registryState(existing.libraryId)).toMatchObject({ name, folders: [{ path: parent }] });
    expect(await ctx.db.select().from(schema.libraries).where(eq(schema.libraries.name, competingName))).toEqual([]);
    expect(await ctx.db.select().from(schema.libraryFolders).where(eq(schema.libraryFolders.path, child))).toEqual([]);
    expect(await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, existing.libraryId))).toEqual([
      expect.objectContaining({ userId: administratorId, accessLevel: 'owner' }),
    ]);
  }, 30_000);

  it.each(['identical', 'nested', 'disjoint'])(
    'serializes simultaneous rebinds with %s roots',
    async (overlap) => {
      const firstLibrary = await library();
      const secondLibrary = await library();
      const next = await directory();
      const candidate =
        overlap === 'identical' ? next : overlap === 'nested' ? await directory(join(next.slice(root.length + 1), 'child')) : await directory();
      const name = `Rebind pause ${randomUUID()}`;
      const losingName = `Concurrent rebind ${randomUUID()}`;
      const original = await registryState(secondLibrary.libraryId);

      const [first, second] = await concurrentWithRebind(
        () => rebind(firstLibrary.libraryId, [next], { name }),
        () => rebind(secondLibrary.libraryId, [candidate], { name: losingName, autoScanCronExpression: cron }),
        async () => expect(await registryState(secondLibrary.libraryId)).toEqual(original),
      );

      expect(first.statusCode, first.body).toBe(200);
      expect(await registryState(firstLibrary.libraryId)).toMatchObject({ name, folders: [{ path: next }] });
      if (overlap === 'disjoint') {
        expect(second.statusCode, second.body).toBe(200);
        expect(await registryState(secondLibrary.libraryId)).toMatchObject({ name: losingName, folders: [{ path: candidate }], schedule: cron });
      } else {
        expect(second.statusCode, second.body).toBe(409);
        expect(second.json()).toMatchObject({ errorCode: 'LIBRARY_FOLDER_OVERLAP' });
        expect(await registryState(secondLibrary.libraryId)).toEqual(original);
      }
    },
    30_000,
  );

  it('rolls back a late failure and reconciles committed watchers and schedules on replay', async () => {
    const existing = await library();
    const retained = await directory();
    const [retainedFolder] = await ctx.db.insert(schema.libraryFolders).values({ libraryId: existing.libraryId, path: retained }).returning();
    const removedPath = await createEpubFixture(existing.path, 'Removed.epub', { title: 'Removed synthetic book' });
    const retainedPath = await createEpubFixture(retained, 'Retained.epub', { title: 'Retained synthetic book' });
    const { jobId } = await scanner.startScan(existing.libraryId, 'manual', true);
    expect((await waitForScanCompletion(ctx.db, jobId)).status).toBe('completed');
    await gate.whenReleased(existing.libraryId);
    const removed = await locateBookByAbsolutePath(ctx, removedPath);
    const kept = await locateBookByAbsolutePath(ctx, retainedPath);
    const [reading] = await ctx.db
      .insert(schema.readingAttempts)
      .values({
        userId: administratorId,
        bookId: removed.bookId,
        origin: 'manual',
        outcome: 'completed',
      })
      .returning();
    const [entitlement] = await ctx.db
      .insert(schema.koboBookEntitlements)
      .values({
        userId: administratorId,
        bookId: removed.bookId,
      })
      .returning();
    const [device] = await ctx.db
      .insert(schema.koboDevices)
      .values({
        userId: administratorId,
        name: 'Synthetic rebind device',
        token: randomUUID(),
      })
      .returning();
    const [hash] = await ctx.db
      .insert(schema.bookFileHashHistory)
      .values({
        bookFileId: removed.bookFileId,
        fileHash: randomUUID().replaceAll('-', ''),
        reason: 'kobo_download',
      })
      .returning();
    const state = await registryState(existing.libraryId);
    const next = await directory();
    const watchers = ctx.app.get(FileWatcherService);
    const schedules = ctx.app.get(LibraryScanSchedulerService);
    const startWatcher = watchers.startWatcher.bind(watchers);
    const syncSchedule = schedules.syncSchedule.bind(schedules);
    const watched = vi.spyOn(watchers, 'startWatcher');
    const scheduled = vi.spyOn(schedules, 'syncSchedule');
    const rescan = vi.spyOn(scanner, 'startScanAsync');
    const scheduler = ctx.app.get(SchedulerRegistry);
    const scheduleName = `library-auto-scan:${existing.libraryId}`;

    const failed = await rebind(existing.libraryId, [retained, next], {
      name: `Rebind fail ${randomUUID()}`,
      watch: true,
      autoScanCronExpression: cron,
    });
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await registryState(existing.libraryId)).toEqual(state);
    expect(await locateBookByAbsolutePath(ctx, removedPath)).toEqual(removed);
    expect(await locateBookByAbsolutePath(ctx, retainedPath)).toEqual(kept);
    expect(await ctx.db.select().from(schema.readingAttempts).where(eq(schema.readingAttempts.id, reading.id))).toEqual([reading]);
    expect(await ctx.db.select().from(schema.koboBookEntitlements).where(eq(schema.koboBookEntitlements.id, entitlement.id))).toEqual([entitlement]);
    expect(await ctx.db.select().from(schema.bookFileHashHistory).where(eq(schema.bookFileHashHistory.id, hash.id))).toEqual([hash]);
    expect(
      await ctx.db
        .select()
        .from(schema.koboEntitlementTombstones)
        .where(eq(schema.koboEntitlementTombstones.entitlementId, entitlement.entitlementId)),
    ).toEqual([]);
    expect(watched).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(rescan).not.toHaveBeenCalled();

    const observed: ReturnType<typeof registryState>[] = [];
    function observe(id: number) {
      const snapshot = Promise.resolve(observed.at(-1)).then(() => registryState(id));
      observed.push(snapshot);
    }
    watched.mockImplementationOnce(() => {
      observe(existing.libraryId);
      return Promise.reject(new Error('synthetic watcher start failure'));
    });
    scheduled.mockImplementationOnce(() => {
      observe(existing.libraryId);
      return false;
    });
    const settings = { name: `Rebind pause committed ${randomUUID()}`, watch: true, autoScanCronExpression: cron };
    const {
      rows: [{ pid }],
    } = await observer.query<{ pid: number }>('select pg_backend_pid() as pid');
    await observer.query('select pg_advisory_lock($1::bigint)', [pauseKey]);
    const request = rebind(existing.libraryId, [retained, next], settings);
    try {
      await waitForAdvisoryWaiter(pauseKey, pid);
      expect(await registryState(existing.libraryId)).toEqual(state);
      expect(watched).not.toHaveBeenCalled();
      expect(scheduled).not.toHaveBeenCalled();
      expect(rescan).not.toHaveBeenCalled();
    } finally {
      await observer.query('select pg_advisory_unlock($1::bigint)', [pauseKey]);
      await request;
    }
    const saved = await request;
    expect(saved.statusCode, saved.body).toBe(200);
    const committed = await registryState(existing.libraryId);
    expect(committed).toMatchObject({
      name: settings.name,
      watch: true,
      schedule: cron,
      revision: String(BigInt(state.revision) + 1n),
      folders: [{ id: retainedFolder.id, path: retained }, { path: next }],
    });
    expect(await Promise.all(observed)).toEqual([committed, committed]);
    expect(scheduler.doesExist('cron', scheduleName)).toBe(false);
    expect(await locateBookByAbsolutePath(ctx, retainedPath)).toEqual(kept);
    expect(await ctx.db.select().from(schema.books).where(eq(schema.books.id, removed.bookId))).toEqual([]);
    expect(await ctx.db.select().from(schema.readingAttempts).where(eq(schema.readingAttempts.id, reading.id))).toEqual([
      expect.objectContaining({ bookId: null, bookLibraryIdSnapshot: existing.libraryId, bookRemovedAt: expect.any(Date) }),
    ]);
    expect(await ctx.db.select().from(schema.koboBookEntitlements).where(eq(schema.koboBookEntitlements.id, entitlement.id))).toEqual([]);
    expect(await ctx.db.select().from(schema.bookFileHashHistory).where(eq(schema.bookFileHashHistory.id, hash.id))).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(schema.koboEntitlementTombstones)
        .where(eq(schema.koboEntitlementTombstones.entitlementId, entitlement.entitlementId)),
    ).toEqual([expect.objectContaining({ userId: administratorId, legacyBookId: removed.bookId })]);
    expect(
      await ctx.db
        .select()
        .from(schema.koboDeviceEntitlementTombstones)
        .where(eq(schema.koboDeviceEntitlementTombstones.entitlementId, entitlement.entitlementId)),
    ).toEqual([expect.objectContaining({ deviceId: device.id, legacyNumericRemoval: true })]);
    await gate.whenReleased(existing.libraryId);
    await vi.waitFor(() => expect(gate.current(existing.libraryId)).toBeNull());
    let watcherReconciled = false;
    watched.mockImplementation(async (id, paths) => {
      observe(id);
      await startWatcher(id, paths);
      watcherReconciled = true;
    });
    scheduled.mockImplementation((id, expression) => {
      observe(id);
      return syncSchedule(id, expression);
    });

    const replay = await rebind(existing.libraryId, [retained, next]);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(watcherReconciled).toBe(true);
    expect(await observed.at(-1)).toEqual(committed);
    expect(watched).toHaveBeenLastCalledWith(existing.libraryId, [retained, next]);
    expect(scheduler.doesExist('cron', scheduleName)).toBe(true);
    expect(await registryState(existing.libraryId)).toEqual(committed);
  }, 45_000);

  it.each(['full', 'targeted'] as const)(
    'rejects a rebind while a %s scan holds the old snapshot, then reads the committed folders',
    async (kind) => {
      const existing = await library();
      const next = await directory();
      const foreign = await library();
      await grantLibraryAccess(ctx, manager.userId, foreign.libraryId, 'owner');
      const oldFile = await createEpubFixture(existing.path, 'Old.epub', { title: 'Old synthetic scan fixture' });
      const newFile = await createEpubFixture(next, 'New.epub', { title: 'New synthetic scan fixture' });
      const repo = ctx.app.get(ScannerRepository);
      const getRoots = repo.findAllLibraryRoots.bind(repo);
      let captured = false;
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const roots = vi.spyOn(repo, 'findAllLibraryRoots').mockImplementationOnce(async () => {
        const result = await getRoots();
        expect(result).toContainEqual(expect.objectContaining({ id: existing.libraryFolderId, path: existing.path }));
        captured = true;
        await paused;
        return result;
      });

      let fullJobId: number | undefined;
      if (kind === 'full') fullJobId = (await scanner.startScan(existing.libraryId, 'manual', true)).jobId;
      else scanner.scanBookFolderAsync(oldFile, existing.libraryId);
      const previousState = await registryState(existing.libraryId);
      try {
        await vi.waitFor(() => expect(captured).toBe(true), { timeout: 8_000 });
        const rejected = await rebind(existing.libraryId, [next]);
        expect(rejected.statusCode, rejected.body).toBe(409);
        expect(rejected.json()).toMatchObject({ errorCode: 'LIBRARY_BUSY' });
        expect(await registryState(existing.libraryId)).toEqual(previousState);
        expect(roots).toHaveBeenCalledOnce();
      } finally {
        resume();
      }

      if (fullJobId) expect((await waitForScanCompletion(ctx.db, fullJobId)).status).toBe('completed');
      await waitForCondition(async () => {
        expect(await locateBookByAbsolutePath(ctx, oldFile)).toMatchObject({ libraryId: existing.libraryId });
        const release = gate.tryAcquire(existing.libraryId, 'library_rebind');
        expect(release).not.toBeNull();
        release?.();
      });
      const {
        rows: [{ pid }],
      } = await observer.query<{ pid: number }>('select pg_backend_pid() as pid');
      await observer.query('select pg_advisory_lock($1::bigint)', [pauseKey]);
      const pending = rebind(existing.libraryId, [next], { name: `Rebind pause scanner ${randomUUID()}` });
      try {
        await waitForAdvisoryWaiter(pauseKey, pid);
        const snapshotsBeforeQueue = roots.mock.calls.length;
        scanner.scanBookFolderAsync(oldFile, existing.libraryId);
        expect(await registryState(existing.libraryId)).toEqual(previousState);
        expect(roots).toHaveBeenCalledTimes(snapshotsBeforeQueue);
      } finally {
        await observer.query('select pg_advisory_unlock($1::bigint)', [pauseKey]);
        await pending;
      }
      const saved = await pending;
      expect(saved.statusCode, saved.body).toBe(200);
      await waitForCondition(async () => expect(await locateBookByAbsolutePath(ctx, newFile)).toMatchObject({ libraryId: existing.libraryId }));
      await vi.waitFor(() => {
        const release = gate.tryAcquire(existing.libraryId, 'library_rebind');
        expect(release).not.toBeNull();
        release?.();
      });
      const files = await ctx.db
        .select()
        .from(schema.bookFiles)
        .where(sql`${schema.bookFiles.absolutePath} in (${oldFile}, ${newFile})`);
      expect(files.map((file) => file.absolutePath)).toEqual([newFile]);
      const reader = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/books/${files[0]!.bookId}`,
        headers: authHeader(manager.accessToken),
      });
      expect(reader.statusCode).toBe(404);
      const owner = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/books/${files[0]!.bookId}`,
        headers: authHeader(ctx.adminToken),
      });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(await registryState(foreign.libraryId)).toMatchObject({ folders: [{ path: foreign.path }] });
    },
    45_000,
  );
});
