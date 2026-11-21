import { ScannerService } from '../src/modules/scanner/scanner.service';
import { LibraryRepository } from '../src/modules/library/library.repository';
import { randomUUID } from 'crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { Permission, type CreatedApiKey } from '@bookorbit/types';
import * as schema from '../src/db/schema';
import { PERSONAL_OWNER_MARKER } from '../src/modules/path/personal-directory';
import { seedLibrary } from './e2e/app-harness';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  uploadLibraryFile,
  locateBookByAbsolutePath,
  triggerAndWaitForLibraryScan,
  type AuthorizationMatrixE2EContext,
} from './e2e/authorization-matrix/authorization-matrix-harness';
import { createEpubFixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';

interface Actor {
  userId: number;
  username: string;
  accessToken: string;
  root: string;
}

describe('personal directory HTTP authorization (PostgreSQL e2e)', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let root: string;
  let books: string;
  const actors = {} as Record<'alice' | 'bob' | 'manager' | 'admin', Actor>;
  const previous = { parent: process.env.PERSONAL_LIBRARY_ROOT, browse: process.env.LIBRARY_BROWSE_ROOT };

  function get(actor: Actor, endpoint: string, query: Record<string, string> = {}) {
    return ctx.app.inject({ method: 'GET', url: `/api/v1/path${endpoint}?${new URLSearchParams(query)}`, headers: authHeader(actor.accessToken) });
  }
  function create(actor: Actor, parentPath: string, name: string, scope?: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/path${scope ? `?scope=${scope}` : ''}`,
      headers: authHeader(actor.accessToken),
      payload: { parentPath, name },
    });
  }
  async function key(actor: Actor, input: Record<string, unknown>): Promise<CreatedApiKey> {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: authHeader(actor.accessToken), payload: input });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }
  async function registered(path: string, ownerId: number) {
    const library = await seedLibrary(ctx.db, { rootPath: path, name: `Directory privacy ${randomUUID()}`, mode: 'book_per_file', watch: false });
    await grantLibraryAccess(ctx, ownerId, library.libraryId, 'owner');
    return library;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-directory-api-'));
    books = join(root, 'books');
    process.env.PERSONAL_LIBRARY_ROOT = books;
    process.env.LIBRARY_BROWSE_ROOT = root;
    ctx = await createAuthorizationMatrixE2EContext();
    for (const role of ['alice', 'bob', 'manager'] as const) {
      const session = await createUserAndLogin(ctx, {
        username: `${role}-${randomUUID().slice(0, 8)}`,
        permissions: [Permission.ApiKeys, ...(role === 'manager' ? [Permission.ManageLibraries] : [])],
      });
      actors[role] = { ...session, root: join(books, session.username) };
    }
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(ctx.adminToken) });
    actors.admin = { userId: me.json().id, username: me.json().username, accessToken: ctx.adminToken, root: join(books, me.json().username) };
    for (const actor of Object.values(actors)) {
      expect((await get(actor, '/config')).json()).toEqual({ root: actor.root });
      await expect(access(actor.root)).rejects.toMatchObject({ code: 'ENOENT' });
      const response = await create(actor, actor.root, 'Books');
      expect(response.statusCode, response.body).toBe(201);
      expect(JSON.parse(await readFile(join(actor.root, PERSONAL_OWNER_MARKER), 'utf8')).userId).toBe(actor.userId);
    }
    await mkdir(join(root, 'system-managed'));
    await writeFile(join(root, 'system-managed', 'operator-only.pdf'), 'synthetic private file');
  }, 60_000);

  afterAll(async () => {
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    if (root) await rm(root, { recursive: true, force: true });
    if (previous.parent === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
    else process.env.PERSONAL_LIBRARY_ROOT = previous.parent;
    if (previous.browse === undefined) delete process.env.LIBRARY_BROWSE_ROOT;
    else process.env.LIBRARY_BROWSE_ROOT = previous.browse;
  });

  for (const role of ['alice', 'bob', 'manager', 'admin'] as const) {
    it(`${role}: defaults to personal scope and rejects every direct foreign directory endpoint`, async () => {
      const actor = actors[role];
      const other = role === 'bob' ? actors.alice : actors.bob;
      expect((await get(actor, '/config')).json()).toEqual({ root: actor.root });
      for (const endpoint of ['', '/listing', '/inspect', '/search']) {
        const response = await get(actor, endpoint, { path: other.root, ...(endpoint === '/search' ? { q: 'Books' } : {}) });
        expect(response.statusCode, response.body).toBe(403);
      }
      const summary = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/path/summaries',
        headers: authHeader(actor.accessToken),
        payload: { paths: [other.root] },
      });
      expect(summary.statusCode, summary.body).toBe(200);
      expect(summary.json()).toMatchObject([{ state: 'blocked', files: 0 }]);
      expect((await create(actor, other.root, 'Unauthorized')).statusCode).toBe(403);
      await expect(access(join(other.root, 'Unauthorized'))).rejects.toMatchObject({ code: 'ENOENT' });
      const places = await get(actor, '/places');
      expect(places.json()).toMatchObject({ root: actor.root, mounts: [], appDataPath: null });
      expect(JSON.stringify(places.json())).not.toContain(other.root);
      expect((await get(actor, '/unclaimed')).json()).toEqual({ folders: [], truncated: false });
      expect((await get(actor, '/listing', { path: join(root, 'system-managed') })).statusCode).toBe(403);
    });
  }

  it('requires deliberate superuser scope for administrative filesystem operations', async () => {
    const target = join(root, 'system-managed');
    expect((await get(actors.manager, '/listing', { path: target, scope: 'admin' })).statusCode).toBe(403);
    expect((await get(actors.admin, '/listing', { path: target })).statusCode).toBe(403);
    expect((await get(actors.admin, '/listing', { path: target, scope: 'admin' })).statusCode).toBe(200);
    expect((await create(actors.admin, target, 'Operator-created', 'admin')).statusCode).toBe(201);
    expect((await get(actors.admin, '/listing', { path: '/etc', scope: 'admin' })).statusCode).toBe(403);
    expect((await get(actors.admin, '/config', { scope: 'invalid' })).statusCode).toBe(400);
  });

  it('keeps concurrent account requests in their own root and ignores caller-supplied identities', async () => {
    const responses = await Promise.all(
      [actors.alice, actors.bob].map(async (actor) => ({ actor, config: await get(actor, '/config'), listing: await get(actor, '/listing') })),
    );
    for (const { actor, config, listing } of responses) {
      expect(config.json().root).toBe(actor.root);
      expect(listing.json().path).toBe(actor.root);
      expect(listing.json().entries.every((entry: { path: string }) => entry.path.startsWith(actor.root + '/'))).toBe(true);
    }
    const injected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/path',
      headers: authHeader(actors.alice.accessToken),
      payload: { parentPath: actors.alice.root, name: 'No', userId: actors.bob.userId },
    });
    expect(injected.statusCode).toBe(400);
  });

  it('denies traversal, symlink escapes and owner-marker tampering, including after cached reads', async () => {
    const actor = actors.alice;
    for (const path of [
      '../' + actors.bob.username,
      actor.root + '/../' + actors.bob.username,
      actor.root + '\\..\\other',
      actor.root + '-sibling',
    ]) {
      expect((await get(actor, '/listing', { path })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await create(actor, path, 'Bad')).statusCode).toBeGreaterThanOrEqual(400);
    }
    const own = join(actor.root, 'Warm');
    await mkdir(own);
    await writeFile(join(own, 'test.epub'), 'synthetic');
    expect((await get(actor, '/inspect', { path: own })).json().files).toBe(1);
    await rm(own, { recursive: true });
    await symlink(actors.bob.root, own);
    expect((await get(actor, '/inspect', { path: own })).statusCode).toBe(403);
    await unlink(own);
    const marker = join(actor.root, PERSONAL_OWNER_MARKER);
    const original = await readFile(marker);
    await writeFile(marker, JSON.stringify({ version: 1, userId: actors.bob.userId }));
    expect((await get(actor, '/config')).statusCode).toBe(409);
    await writeFile(marker, original);
  });

  it('never adopts unmarked existing content through ordinary requests; explicit adoption retains its bytes', async () => {
    const actor = actors.bob;
    const marker = join(actor.root, PERSONAL_OWNER_MARKER);
    await unlink(marker);
    const file = join(actor.root, 'preexisting.epub');
    await writeFile(file, 'preexisting synthetic contents');
    expect((await get(actor, '/config')).statusCode).toBe(409);
    expect((await create(actor, actor.root, 'Blocked')).statusCode).toBe(409);
    const body = { userId: actor.userId };
    const url = '/api/v1/path/adopt-personal-root';
    expect((await ctx.app.inject({ method: 'POST', url, headers: authHeader(actors.manager.accessToken), payload: body })).statusCode).toBe(403);
    const adopted = await ctx.app.inject({ method: 'POST', url, headers: authHeader(actors.admin.accessToken), payload: body });
    expect(adopted.statusCode, adopted.body).toBe(201);
    expect((await get(actor, '/config')).statusCode).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('preexisting synthetic contents');
    await unlink(file);
  });

  it('rechecks library grants before cached counts and hides registered private subtrees', async () => {
    const actor = actors.alice;
    const path = join(actor.root, 'Transferred');
    await mkdir(path);
    await writeFile(join(path, 'hidden.epub'), 'synthetic');
    const library = await registered(path, actor.userId);
    expect((await get(actor, '/inspect', { path: actor.root })).json().files).toBe(1);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/path/summaries', headers: authHeader(actor.accessToken), payload: { paths: [actor.root] } });
    await get(actor, '/unclaimed');
    await grantLibraryAccess(ctx, actors.bob.userId, library.libraryId, 'owner');
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/libraries/${library.libraryId}/access/${actor.userId}?scope=admin`,
      headers: authHeader(actors.admin.accessToken),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await get(actor, '/listing')).json().entries.map((entry: { name: string }) => entry.name)).not.toContain('Transferred');
    expect((await get(actor, '/inspect', { path: actor.root })).json()).toMatchObject({ files: 0, samples: [] });
    expect((await get(actor, '/inspect', { path })).statusCode).toBe(403);
    expect((await get(actor, '/places')).json().libraries).toEqual([]);
    expect((await get(actor, '/unclaimed')).json().folders).toEqual([]);
    expect((await get(actors.admin, '/inspect', { path, scope: 'admin' })).statusCode).toBe(403);
    expect((await get(actors.admin, '/listing', { path: actor.root, scope: 'admin' })).json().entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Transferred' })]),
    );
    await grantLibraryAccess(ctx, actors.admin.userId, library.libraryId, 'viewer');
    expect((await get(actors.admin, '/inspect', { path, scope: 'admin' })).json().files).toBe(1);
    expect((await get(actors.admin, '/places', { scope: 'admin' })).json().libraries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: library.libraryId })]),
    );
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/libraries/${library.libraryId}/access/${actors.admin.userId}?scope=admin`,
      headers: authHeader(actors.admin.accessToken),
    });
    expect((await get(actors.admin, '/inspect', { path, scope: 'admin' })).statusCode).toBe(403);
    expect((await get(actors.admin, '/places', { scope: 'admin' })).json().libraries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: library.libraryId })]),
    );
  });

  it('keeps shared content outside a personal namespace out of raw filesystem landmarks', async () => {
    const path = join(actors.bob.root, 'Books');
    const library = await registered(path, actors.bob.userId);
    await grantLibraryAccess(ctx, actors.alice.userId, library.libraryId, 'viewer');
    const libraries = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: authHeader(actors.alice.accessToken) });
    expect(libraries.json().map((item: { id: number }) => item.id)).toContain(library.libraryId);
    expect((await get(actors.alice, '/places')).json().libraries).toEqual([]);
    expect((await get(actors.alice, '/listing', { path })).statusCode).toBe(403);
  });

  it('supports read/write wide keys but rejects raw filesystem browsing with a bounded library key', async () => {
    const actor = actors.alice;
    const readable = await key(actor, { name: 'Directory reader' });
    const headers = { 'x-api-key': readable.token };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/path/config', headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/path/summaries', headers, payload: { paths: [actor.root] } })).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/v1/path', headers, payload: { parentPath: actor.root, name: 'Read-key-denied' } }))
        .statusCode,
    ).toBe(403);
    const writer = await key(actor, { name: 'Directory writer', access: 'write' });
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/path',
          headers: { 'x-api-key': writer.token },
          payload: { parentPath: actor.root, name: 'Write-key-allowed' },
        })
      ).statusCode,
    ).toBe(201);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: authHeader(actor.accessToken) });
    const libraryId = list.json()[0].id as number;
    const bounded = await key(actor, { name: 'Bounded storage denied', libraryIds: [libraryId], access: 'write' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/path/config', headers: { 'x-api-key': bounded.token } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}`, headers: { 'x-api-key': bounded.token } })).statusCode).toBe(
      200,
    );
    const plainAdmin = await key(actors.admin, { name: 'No administrator flag' });
    const powerful = await key(actors.admin, { name: 'Explicit administrator', admin: true });
    const url = `/api/v1/path/listing?scope=admin&path=${encodeURIComponent(root)}`;
    expect((await ctx.app.inject({ method: 'GET', url, headers: { 'x-api-key': plainAdmin.token } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url, headers: { 'x-api-key': powerful.token } })).statusCode).toBe(200);
  });

  it('redacts private overlaps in prescan and creation, and rejects registering the user namespace itself', async () => {
    const actor = actors.manager;
    const parent = join(actor.root, 'Candidate');
    const hidden = join(parent, 'private-child');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, 'private.pdf'), 'synthetic');
    const library = await registered(hidden, actors.bob.userId);
    const [secret] = await ctx.db.select({ name: schema.libraries.name }).from(schema.libraries).where(eq(schema.libraries.id, library.libraryId));
    const preview = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/prescan',
      headers: authHeader(actor.accessToken),
      payload: { paths: [parent] },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json().totalFiles).toBe(0);
    expect(preview.body).not.toContain(secret.name);
    const createLibrary = (path: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/libraries',
        headers: authHeader(actor.accessToken),
        payload: { name: `Overlap ${randomUUID()}`, icon: 'BookOpen', folders: [path] },
      });
    const conflict = await createLibrary(parent);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.body).not.toContain(hidden);
    expect(conflict.body).not.toContain(secret.name);
    expect((await createLibrary(actor.root)).statusCode).toBe(403);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/prescan',
      headers: authHeader(actor.accessToken),
      payload: { paths: [actors.bob.root] },
    });
    expect(denied.json()).toMatchObject({ paths: [{ accessible: false, fileCount: 0 }] });
  });

  it('creates personal libraries without administrative permission, with atomic ownership and native reading/upload', async () => {
    const actor = actors.alice;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/personal',
      headers: authHeader(actor.accessToken),
      payload: { name: `Personal ${randomUUID()}`, icon: 'BookOpen', organizationMode: 'book_per_file' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const library = response.json();
    expect(library.accessLevel).toBe('owner');
    const inventory = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries/administration', headers: authHeader(actors.admin.accessToken) });
    expect(inventory.statusCode, inventory.body).toBe(200);
    expect(inventory.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: library.id, ownerCount: 1 })]));
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries/administration', headers: authHeader(actor.accessToken) })).statusCode,
    ).toBe(403);

    expect(library.folders[0].path.startsWith(actor.root + '/library-')).toBe(true);
    expect(await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, library.id))).toEqual([
      expect.objectContaining({ userId: actor.userId, accessLevel: 'owner' }),
    ]);
    const file = await createEpubFixture(library.folders[0].path, 'personal.epub', { title: 'Personal created library' });
    await grantLibraryAccess(ctx, actors.admin.userId, library.id, 'editor');
    await vi.waitFor(() => expect(ctx.app.get(ScannerService).isScanRunning(library.id)).toBe(false), { timeout: 10000 });
    expect((await triggerAndWaitForLibraryScan(ctx, library.id)).status).toBe('completed');
    const located = await locateBookByAbsolutePath(ctx, file);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/v1/epub/${located.bookId}/info`, headers: authHeader(actor.accessToken) })).statusCode,
    ).toBe(200);
    const allowed = await uploadLibraryFile(ctx, {
      token: actor.accessToken,
      libraryId: library.id,
      fileName: 'uploaded.epub',
      content: await readFile(file),
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${library.id}`,
      headers: authHeader(actor.accessToken),
      payload: { icon: 'BookOpen', watch: false },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const other = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${library.id}`,
      headers: authHeader(actors.bob.accessToken),
      payload: { icon: 'BookOpen' },
    });
    expect(other.statusCode).toBe(403);
    for (const method of ['DELETE', 'PATCH', 'POST'] as const) {
      const url = `/api/v1/libraries/${library.id}/access` + (method === 'POST' ? '' : `/${actor.userId}`);
      const denied = await ctx.app.inject({
        method,
        url,
        headers: authHeader(actor.accessToken),
        ...(method === 'DELETE' ? {} : { payload: { ...(method === 'POST' ? { userId: actor.userId } : {}), accessLevel: 'viewer' } }),
      });
      expect(denied.statusCode, denied.body).toBe(409);
    }
  }, 30000);

  it('registers and scans multiple personal directories in place and reuses the owner grant API', async () => {
    const actor = actors.alice;
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/libraries/assignable-users',
      headers: authHeader(actor.accessToken),
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.headers['cache-control']).toBe('private, no-store');
    expect(before.json()).toContainEqual({ id: actors.bob.userId, username: actors.bob.username, name: expect.any(String) });
    expect(before.json().some((candidate: { id: number }) => candidate.id === actor.userId)).toBe(false);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries/assignable-users' })).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/libraries/assignable-users?scope=admin',
          headers: authHeader(actors.manager.accessToken),
        })
      ).statusCode,
    ).toBe(403);

    const folders = ['Comics', 'Novels'].map((name) => join(actor.root, name));
    await Promise.all(folders.map((folder) => mkdir(folder)));
    const files = await Promise.all(
      folders.map((folder, index) => createEpubFixture(folder, `volume-${index}.epub`, { title: `Personal multi-folder volume ${index}` })),
    );
    const post = (paths: string[]) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/libraries/personal',
        headers: authHeader(actor.accessToken),
        payload: { name: randomUUID(), icon: 'BookOpen', organizationMode: 'book_per_file', folders: paths },
      });
    const created = await post(folders);
    expect(created.statusCode, created.body).toBe(201);
    const library = created.json();
    expect(library.accessLevel).toBe('owner');
    expect(library.folders.map((folder: { path: string }) => folder.path)).toEqual(folders);
    const share = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${library.id}/access`,
      headers: authHeader(actor.accessToken),
      payload: { userId: actors.bob.userId, accessLevel: 'editor' },
    });
    expect(share.statusCode, share.body).toBe(201);
    const unavailable = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${library.id}/access`,
      headers: authHeader(actor.accessToken),
      payload: { userId: 2147483647, accessLevel: 'viewer' },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(404);
    expect(await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, library.id))).toEqual(
      expect.arrayContaining([
        { userId: actor.userId, libraryId: library.id, accessLevel: 'owner' },
        { userId: actors.bob.userId, libraryId: library.id, accessLevel: 'editor' },
      ]),
    );
    await vi.waitFor(
      async () => {
        const registered = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.libraryFolderId, library.folders[0].id));
        const second = await ctx.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.libraryFolderId, library.folders[1].id));
        expect([...registered, ...second].map((file) => file.absolutePath)).toEqual(files);
      },
      { timeout: 15_000 },
    );
    expect((await post([folders[0]!])).statusCode).toBe(409);

    const link = join(actor.root, 'other-tenant');
    await symlink(join(actors.bob.root, 'Books'), link);
    for (const [path, status] of [
      [actor.root, 403],
      [join(actors.bob.root, 'Books'), 403],
      [`${actor.root}/../${actors.bob.username}/Books`, 400],
      [link, 403],
      [join(actor.root, 'never-created'), 400],
    ] as const) {
      const denied = await post([path]);
      expect(denied.statusCode, denied.body).toBe(status);
    }
  }, 30_000);

  it('rejects client-selected identity and foreign paths, and compensates duplicate/concurrent creation safely', async () => {
    const actor = actors.alice;
    const post = (payload: Record<string, unknown>) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/libraries/personal', headers: authHeader(actor.accessToken), payload });
    expect((await post({ name: randomUUID(), icon: 'BookOpen', folders: [actors.bob.root] })).statusCode).toBe(403);
    for (const extra of [{ userId: actors.bob.userId }, { accessLevel: 'viewer' }, { folders: null }])
      expect((await post({ name: `Rejected ${randomUUID()}`, icon: 'BookOpen', ...extra })).statusCode).toBe(400);
    const name = `Concurrent ${randomUUID()}`;
    const attempts = await Promise.all([post({ name, icon: 'BookOpen' }), post({ name, icon: 'BookOpen' })]);
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(1);
    const distinct = await Promise.all([post({ name: randomUUID(), icon: 'BookOpen' }), post({ name: randomUUID(), icon: 'BookOpen' })]);
    expect(distinct.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(distinct[0].json().folders[0].path).not.toBe(distinct[1].json().folders[0].path);
  });

  it.each(['folders', 'owner grant'] as const)('rolls back creation on a PostgreSQL failure inserting %s', async (stage) => {
    const repo = ctx.app.get(LibraryRepository);
    const original = repo.createOwned.bind(repo);
    const name = `Rollback ${randomUUID()}`;
    const actor = actors.alice;
    const keptFile = join(actor.root, 'Books', `before-creation-${randomUUID()}.epub`);
    await writeFile(keptFile, 'existing book bytes');
    const marker = await readFile(join(actor.root, PERSONAL_OWNER_MARKER));
    let allocated = '';
    const spy = vi.spyOn(repo, 'createOwned').mockImplementationOnce((data, paths, creatorId) => {
      allocated = paths[0]!;
      return stage === 'folders' ? original(data, [allocated, allocated], creatorId) : original(data, paths, 2147483647);
    });
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/libraries/personal',
        headers: authHeader(actor.accessToken),
        payload: { name, icon: 'BookOpen' },
      });
      expect(response.statusCode).toBe(500);
      expect(await repo.findByName(name)).toEqual([]);
      expect((await repo.findAllFolders()).some((f) => f.path === allocated)).toBe(false);
      await expect(access(allocated)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(actor.root, PERSONAL_OWNER_MARKER))).toEqual(marker);
      expect(await readFile(keptFile, 'utf8')).toBe('existing book bytes');
    } finally {
      spy.mockRestore();
    }
  });

  it('serializes last-owner removal and protects user-admin grant replacement', async () => {
    const a = actors.alice,
      b = actors.bob;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/personal',
      headers: authHeader(a.accessToken),
      payload: { name: randomUUID(), icon: 'BookOpen' },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().id;
    const share = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${id}/access`,
      headers: authHeader(a.accessToken),
      payload: { userId: b.userId, accessLevel: 'owner' },
    });
    expect(share.statusCode, share.body).toBe(201);
    const attempts = await Promise.all([
      ctx.app.inject({ method: 'DELETE', url: `/api/v1/libraries/${id}/access/${a.userId}`, headers: authHeader(a.accessToken) }),
      ctx.app.inject({ method: 'DELETE', url: `/api/v1/libraries/${id}/access/${b.userId}`, headers: authHeader(b.accessToken) }),
    ]);
    expect(attempts.map((r) => r.statusCode).sort()).toEqual([204, 409]);
    const remaining = await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, id));
    expect(remaining.filter((g) => g.accessLevel === 'owner')).toHaveLength(1);
    const bulk = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/users/${remaining[0]!.userId}/libraries`,
      headers: authHeader(ctx.adminToken),
      payload: { libraryIds: [] },
    });
    expect(bulk.statusCode, bulk.body).toBe(409);
    expect(bulk.json().message).toContain('last library owner');
    const assignable = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/libraries/${id}/assignable-users`,
      headers: authHeader(remaining[0]!.userId === a.userId ? a.accessToken : b.accessToken),
    });
    expect(assignable.statusCode, assignable.body).toBe(200);
  });

  it('rechecks the initiating owner under the grant transaction lock', async () => {
    const a = actors.alice;
    const b = actors.bob;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/personal',
      headers: authHeader(a.accessToken),
      payload: { name: randomUUID(), icon: 'BookOpen' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: number }>().id;
    await grantLibraryAccess(ctx, b.userId, id, 'owner');

    const repo = ctx.app.get(LibraryRepository);
    const original = repo.grantAccess.bind(repo);
    let transactionReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      transactionReached = resolve;
    });
    let resumeTransaction!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeTransaction = resolve;
    });
    const pause = vi.spyOn(repo, 'grantAccess').mockImplementationOnce(async (...args) => {
      transactionReached();
      await resume;
      return original(...args);
    });
    const pending = ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${id}/access`,
      headers: authHeader(a.accessToken),
      payload: { userId: actors.manager.userId, accessLevel: 'viewer' },
    });
    try {
      await reached;
      const revoke = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/libraries/${id}/access/${a.userId}`,
        headers: authHeader(b.accessToken),
      });
      expect(revoke.statusCode, revoke.body).toBe(204);
    } finally {
      resumeTransaction();
      pause.mockRestore();
    }
    expect((await pending).statusCode).toBe(403);
    const grants = await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, id));
    expect(grants).toEqual([{ userId: b.userId, libraryId: id, accessLevel: 'owner' }]);
  });

  it('allows wide write keys to create but rejects read-only and fixed-library keys', async () => {
    const actor = actors.alice;
    const wideRead = await key(actor, { name: 'Read personal', access: 'read' });
    const wideWrite = await key(actor, { name: 'Write personal', access: 'write' });
    const call = (token: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/libraries/personal',
        headers: { 'x-api-key': token },
        payload: { name: randomUUID(), icon: 'BookOpen' },
      });
    expect((await call(wideRead.token)).statusCode).toBe(403);
    const created = await call(wideWrite.token);
    expect(created.statusCode, created.body).toBe(201);
    const bounded = await key(actor, { name: 'Bounded personal', access: 'write', libraryIds: [created.json().id] });
    expect((await call(bounded.token)).statusCode).toBe(403);
  });

  it('retains native registration in explicit admin scope and denies personal folder rebinding', async () => {
    const actor = actors.admin;
    const original = join(root, 'operator-library');
    const next = join(root, 'operator-library-next');
    await mkdir(original);
    await mkdir(next);
    const payload = { name: `Admin register ${randomUUID()}`, icon: 'BookOpen', folders: [original], watch: false };
    const namespace = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries?scope=admin',
      headers: authHeader(actor.accessToken),
      payload: { ...payload, folders: [actors.bob.root] },
    });
    expect(namespace.statusCode).toBe(403);
    const ancestor = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries?scope=admin',
      headers: authHeader(actor.accessToken),
      payload: { ...payload, folders: [root] },
    });
    expect(ancestor.statusCode).toBe(403);
    const denied = await ctx.app.inject({ method: 'POST', url: '/api/v1/libraries', headers: authHeader(actor.accessToken), payload });
    expect(denied.statusCode).toBe(403);
    const added = await ctx.app.inject({ method: 'POST', url: '/api/v1/libraries?scope=admin', headers: authHeader(actor.accessToken), payload });
    expect(added.statusCode, added.body).toBe(201);
    const libraryId = added.json().id as number;
    // Creation now commits the creator owner grant atomically.
    expect(await ctx.db.select().from(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.libraryId, libraryId))).toEqual([
      expect.objectContaining({ userId: actor.userId, accessLevel: 'owner' }),
    ]);
    await grantLibraryAccess(ctx, actor.userId, libraryId, 'owner');
    const url = `/api/v1/libraries/${libraryId}`;
    expect((await ctx.app.inject({ method: 'PATCH', url, headers: authHeader(actor.accessToken), payload: { folders: [next] } })).statusCode).toBe(
      403,
    );
    const changed = await ctx.app.inject({
      method: 'PATCH',
      url: url + '?scope=admin',
      headers: authHeader(actor.accessToken),
      payload: { folders: [next] },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().folders.map((folder: { path: string }) => folder.path)).toEqual([next]);
    await expect(access(original)).resolves.toBeUndefined();
  });

  it('preserves scanning, reading and unchanged legacy folder registration outside personal/browse roots', async () => {
    const legacy = join(ctx.fixture.booksPath, 'legacy-outside-browse');
    await mkdir(legacy);
    const file = await createEpubFixture(legacy, 'legacy.epub', { title: 'Legacy reading regression' });
    const bytes = await readFile(file);
    const library = await registered(legacy, actors.admin.userId);
    const scan = await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    expect(scan.status).toBe('completed');
    const located = await locateBookByAbsolutePath(ctx, file);
    const saved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/libraries/${library.libraryId}`,
      headers: authHeader(actors.admin.accessToken),
      payload: { folders: [legacy], watch: false, icon: 'BookOpen' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await get(actors.admin, '/listing', { path: legacy })).statusCode).toBe(403);
    const readable = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/epub/${located.bookId}/info`,
      headers: authHeader(actors.admin.accessToken),
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect(await readFile(file)).toEqual(bytes);
  }, 20_000);
});
