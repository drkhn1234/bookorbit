import { createHash, randomUUID } from 'crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, getTableName } from 'drizzle-orm';
import { AuditAction, Permission, type CreatedApiKey, type LibraryCapabilities } from '@bookorbit/types';
import * as schema from '../src/db/schema';
import { PERSONAL_OWNER_MARKER } from '../src/modules/path/personal-directory';
import { seedLibrary } from './e2e/app-harness';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  type AuthorizationMatrixE2EContext,
  type TestUserSession,
} from './e2e/authorization-matrix/authorization-matrix-harness';

describe('read-only library capabilities (PostgreSQL HTTP)', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let root: string;
  let books: string;
  const actors = {} as Record<'alice' | 'bob' | 'manager' | 'admin' | 'demo', TestUserSession>;
  const old = { personal: process.env.PERSONAL_LIBRARY_ROOT, browse: process.env.LIBRARY_BROWSE_ROOT };
  const url = '/api/v1/libraries/capabilities';
  const headers = (actor: TestUserSession) => authHeader(actor.accessToken);
  const home = (actor: TestUserSession) => join(books, actor.username);
  const get = (actor: TestUserSession) => ctx.app.inject({ method: 'GET', url, headers: headers(actor) });

  async function key(actor: TestUserSession, options: Record<string, unknown>): Promise<CreatedApiKey> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: headers(actor),
      payload: { name: randomUUID(), ...options },
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<CreatedApiKey>();
    // Fixture mutations emit asynchronous audits; finish those writes before the read-only baseline.
    await vi.waitFor(async () =>
      expect(
        await ctx.db
          .select({ id: schema.auditLog.id })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.action, AuditAction.ApiKeyCreate), eq(schema.auditLog.resourceId, created.key.id))),
      ).toHaveLength(1),
    );
    return created;
  }

  async function tree(path: string): Promise<unknown> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { link: await readlink(path), mode: info.mode };
      if (info.isDirectory())
        return {
          mode: info.mode,
          children: await Promise.all((await readdir(path)).sort().map(async (name) => [name, await tree(join(path, name))])),
        };
      return { mode: info.mode, modified: info.mtimeMs, data: (await readFile(path)).toString('base64') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function dbState() {
    const tables = [
      schema.users,
      schema.userPermissions,
      schema.libraries,
      schema.libraryFolders,
      schema.userLibraryAccess,
      schema.apiKeys,
      schema.apiKeyLibraries,
      schema.authSessions,
      schema.refreshTokens,
      schema.auditLog,
      schema.appSettings,
    ];
    const rows = await Promise.all(tables.map(async (table) => (await ctx.db.select().from(table)).map((row) => JSON.stringify(row)).sort()));
    return Object.fromEntries(
      tables.map((table, index) => [getTableName(table), createHash('sha256').update(JSON.stringify(rows[index])).digest('hex')]),
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-capabilities-'));
    books = join(root, 'books');
    process.env.PERSONAL_LIBRARY_ROOT = books;
    process.env.LIBRARY_BROWSE_ROOT = root;
    ctx = await createAuthorizationMatrixE2EContext();
    for (const role of ['alice', 'bob', 'manager', 'admin', 'demo'] as const) {
      actors[role] = await createUserAndLogin(ctx, {
        username: `${role}-${randomUUID()}`,
        isSuperuser: role === 'admin',
        permissions: [
          Permission.ApiKeys,
          ...(role === 'manager' ? [Permission.ManageLibraries] : []),
          ...(role === 'demo' ? [Permission.DemoRestricted] : []),
        ],
      });
    }
  }, 60000);

  afterAll(async () => {
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    if (root) await rm(root, { recursive: true, force: true });
    if (old.personal === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
    else process.env.PERSONAL_LIBRARY_ROOT = old.personal;
    if (old.browse === undefined) delete process.env.LIBRARY_BROWSE_ROOT;
    else process.env.LIBRARY_BROWSE_ROOT = old.browse;
  });

  it('requires authentication and derives identity from the current principal', async () => {
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?userId=${actors.admin.userId}&scope=admin`, headers: headers(actors.alice) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ canCreatePersonalLibrary: true, canUseAdministrativeStorage: false });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).not.toContain(root);
  });

  it.each(['alice', 'manager', 'admin', 'demo'] as const)('%s: reports established policies without provisioning a missing root', async (role) => {
    const actor = actors[role];
    const before = await tree(root),
      database = await dbState();
    for (let i = 0; i < 3; i++) {
      const response = await get(actor);
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json<LibraryCapabilities>();
      expect(result.canCreatePersonalLibrary).toBe(role !== 'demo');
      expect(result.personalLibraryDenialReason === null).toBe(role !== 'demo');
      expect(result.canUseAdministrativeStorage).toBe(role === 'admin');
      expect(result.administrativeStorageDenialReason === null).toBe(role === 'admin');
    }
    expect(await tree(root)).toEqual(before);
    expect(await dbState()).toEqual(database);
    await expect(access(home(actor))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a bound root, preserving its marker and all database rows across repeated GETs', async () => {
    const actor = actors.alice;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/path',
      headers: headers(actor),
      payload: { parentPath: home(actor), name: 'Existing' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const before = await tree(root),
      database = await dbState();
    for (let i = 0; i < 3; i++) expect((await get(actor)).json().canCreatePersonalLibrary).toBe(true);
    expect(await tree(root)).toEqual(before);
    expect(await dbState()).toEqual(database);
  });

  it('refuses an unmarked root and never adopts its contents', async () => {
    const actor = actors.bob;
    await mkdir(home(actor));
    await writeFile(join(home(actor), 'keep.txt'), 'synthetic retained content');
    const before = await tree(root),
      database = await dbState();
    const response = await get(actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canCreatePersonalLibrary: false });
    expect(response.json().personalLibraryDenialReason).toContain('administrator');
    expect((await get(actors.alice)).json().canCreatePersonalLibrary).toBe(true);
    expect(await tree(root)).toEqual(before);
    expect(await dbState()).toEqual(database);
  });

  it.each(['{}', 'not-json', JSON.stringify({ version: 1, userId: 2147483647 })])(
    'refuses malformed/mismatched marker %s without repairing it',
    async (marker) => {
      await writeFile(join(home(actors.bob), PERSONAL_OWNER_MARKER), marker);
      const before = await tree(root),
        database = await dbState();
      expect((await get(actors.bob)).json().canCreatePersonalLibrary).toBe(false);
      expect(await tree(root)).toEqual(before);
      expect(await dbState()).toEqual(database);
    },
  );

  it('rejects symlinked roots and unsafe stored identity components without exposing paths', async () => {
    const alias = await createUserAndLogin(ctx, { username: `alias-${randomUUID()}` });
    await symlink(home(actors.alice), home(alias));
    const result = await get(alias);
    expect(result.json().canCreatePersonalLibrary).toBe(false);
    expect(result.body).not.toContain(home(actors.alice));
    const unsafe = await createUserAndLogin(ctx, { username: `../unsafe-${randomUUID()}` });
    expect((await get(unsafe)).json().canCreatePersonalLibrary).toBe(false);
  });

  it('rejects inactive accounts through existing authentication', async () => {
    const actor = await createUserAndLogin(ctx, { username: `inactive-${randomUUID()}`, permissions: [Permission.ApiKeys] });
    const delegated = await key(actor, { access: 'write' });
    await ctx.db.update(schema.users).set({ active: false }).where(eq(schema.users.id, actor.userId));
    const before = await dbState(),
      filesystem = await tree(root);
    expect((await get(actor)).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url, headers: { 'x-api-key': delegated.token } })).statusCode).toBe(401);
    expect(await dbState()).toEqual(before);
    expect(await tree(root)).toEqual(filesystem);
  });

  it('keeps explicit administrator storage separate from an unusable personal root', async () => {
    const actor = await createUserAndLogin(ctx, { username: `admin-unmarked-${randomUUID()}`, isSuperuser: true });
    await vi.waitFor(async () =>
      expect(
        await ctx.db
          .select({ id: schema.auditLog.id })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.action, AuditAction.AuthLogin), eq(schema.auditLog.userId, actor.userId))),
      ).toHaveLength(1),
    );
    await mkdir(home(actor));
    const before = await tree(root),
      database = await dbState();
    const response = await get(actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canCreatePersonalLibrary: false, canUseAdministrativeStorage: true });
    expect(await tree(root)).toEqual(before);
    expect(await dbState()).toEqual(database);
  });

  it('detects legacy parent-library overlap even for an owner and never creates the namespace', async () => {
    const actor = actors.manager;
    const library = await seedLibrary(ctx.db, { rootPath: books, name: randomUUID(), mode: 'book_per_file', watch: false });
    await grantLibraryAccess(ctx, actor.userId, library.libraryId, 'owner');
    try {
      const response = await get(actor);
      expect(response.json().canCreatePersonalLibrary).toBe(false);
      expect(response.body).not.toContain(library.libraryId.toString());
      await expect(access(home(actor))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await ctx.db.delete(schema.libraries).where(eq(schema.libraries.id, library.libraryId));
    }
  });

  it('honors current key restrictions and suppresses only capability-discovery usage writes', async () => {
    const actor = actors.alice;
    const library = await seedLibrary(ctx.db, { rootPath: join(home(actor), 'Existing'), name: randomUUID(), mode: 'book_per_file', watch: false });
    await grantLibraryAccess(ctx, actor.userId, library.libraryId, 'owner');
    const read = await key(actor, { access: 'read' }),
      wide = await key(actor, { access: 'write' }),
      bounded = await key(actor, { access: 'write', libraryIds: [library.libraryId] });
    const plainAdmin = await key(actors.admin, { access: 'write' }),
      admin = await key(actors.admin, { access: 'write', admin: true });
    const before = await dbState(),
      filesystem = await tree(root);
    for (const [credential, personal, administrative] of [
      [read, false, false],
      [wide, true, false],
      [bounded, false, false],
      [plainAdmin, true, false],
      [admin, true, true],
    ] as const) {
      for (let i = 0; i < 3; i++) {
        const response = await ctx.app.inject({ method: 'GET', url, headers: { 'x-api-key': credential.token } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ canCreatePersonalLibrary: personal, canUseAdministrativeStorage: administrative });
      }
    }
    expect(await dbState()).toEqual(before);
    expect(await tree(root)).toEqual(filesystem);
    const keyBefore = await ctx.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, wide.key.id));
    expect(keyBefore[0]!.lastUsedAt).toBeNull();
    await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: { 'x-api-key': wide.token } });
    await vi.waitFor(async () =>
      expect((await ctx.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, wide.key.id)))[0]!.lastUsedAt).not.toBeNull(),
    );
    expect((await get(actors.admin)).json().canUseAdministrativeStorage).toBe(true);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: headers(actors.admin) });
    expect(list.json().map((entry: { id: number }) => entry.id)).not.toContain(library.libraryId);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${library.libraryId}`, headers: headers(actors.admin) })).statusCode).toBe(
      403,
    );
    await grantLibraryAccess(ctx, actors.admin.userId, library.libraryId, 'viewer');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${library.libraryId}`, headers: headers(actors.admin) })).statusCode).toBe(
      200,
    );
    await ctx.db.delete(schema.userLibraryAccess).where(eq(schema.userLibraryAccess.userId, actors.admin.userId));
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/libraries/${library.libraryId}`, headers: headers(actors.admin) })).statusCode).toBe(
      403,
    );
  });
});
