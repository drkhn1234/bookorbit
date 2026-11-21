import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permission, type AccessLevel } from '@bookorbit/types';

import {
  authHeader,
  closeUsersAdminLifecycleE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  createUsersAdminLifecycleE2EContext,
  type TestUserSession,
  type UsersAdminLifecycleE2EContext,
} from './e2e/users-admin-lifecycle/users-admin-lifecycle-harness';

describe('account deletion and library ownership (PostgreSQL e2e)', { timeout: 30_000 }, () => {
  let ctx: UsersAdminLifecycleE2EContext;
  let root: string;
  let userManager: TestUserSession;
  let libraryManager: TestUserSession;
  let reader: TestUserSession;
  const originalRoot = process.env.PERSONAL_LIBRARY_ROOT;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookorbit-deletion-'));
    process.env.PERSONAL_LIBRARY_ROOT = root;
    ctx = await createUsersAdminLifecycleE2EContext();
    userManager = await createUserAndLogin(ctx, { username: 'deletion-user-manager', permissions: [Permission.ManageUsers] });
    libraryManager = await createUserAndLogin(ctx, { username: 'deletion-library-manager', permissions: [Permission.ManageLibraries] });
    reader = await createUserAndLogin(ctx);
  }, 60_000);

  afterAll(async () => {
    try {
      if (ctx) await closeUsersAdminLifecycleE2EContext(ctx);
    } finally {
      if (originalRoot === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
      else process.env.PERSONAL_LIBRARY_ROOT = originalRoot;
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  function request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) {
    return ctx.app.inject({ method, url: '/api/v1' + path, headers: authHeader(token), payload });
  }

  function deleteAccount(userId: number, token = userManager.accessToken) {
    return request(token, 'DELETE', `/users/${userId}`);
  }

  function grant(libraryId: number, userId: number, accessLevel: AccessLevel, token = libraryManager.accessToken, scope = '?scope=admin') {
    return request(token, 'POST', `/libraries/${libraryId}/access${scope}`, { userId, accessLevel });
  }

  function account(userId: number) {
    return ctx.db.query.users.findFirst({ columns: { id: true, active: true }, where: (fields, { eq }) => eq(fields.id, userId) });
  }

  function grants(libraryId: number) {
    return ctx.db.query.userLibraryAccess.findMany({
      columns: { userId: true, accessLevel: true },
      where: (fields, { eq }) => eq(fields.libraryId, libraryId),
      orderBy: (fields, { asc }) => asc(fields.userId),
    });
  }

  async function inspectFile(path: string) {
    const { ino, mode, uid, gid } = await stat(path);
    return { ino, mode, uid, gid, bytes: await readFile(path) };
  }

  async function storageSnapshot(libraryId: number, file: string, marker: string) {
    return {
      library: await ctx.db.query.libraries.findFirst({ where: (fields, { eq }) => eq(fields.id, libraryId) }),
      folders: await ctx.db.query.libraryFolders.findMany({
        columns: { id: true, libraryId: true, path: true },
        where: (fields, { eq }) => eq(fields.libraryId, libraryId),
        orderBy: (fields, { asc }) => asc(fields.id),
      }),
      file: await inspectFile(file),
      marker: await inspectFile(marker),
    };
  }

  async function makeLibrary(owner: TestUserSession, name: string) {
    const response = await request(owner.accessToken, 'POST', '/libraries/personal', { name, icon: 'BookOpen' });
    expect(response.statusCode, response.body).toBe(201);
    const { id, folders } = response.json<{ id: number; folders: { id: number; path: string }[] }>();
    const file = join(folders[0].path, 'retained-fixture.txt');
    const marker = join(root, owner.username, '.bookorbit-owner.json');
    await writeFile(file, `synthetic data for ${name}\n`);
    expect(JSON.parse(await readFile(marker, 'utf8')).userId).toBe(owner.userId);
    const snapshot = () => storageSnapshot(id, file, marker);
    return { id, snapshot, initial: await snapshot() };
  }

  it('deletes an account with no owner grants and leaves existing ownerless libraries unchanged', async () => {
    const subject = await createUserAndLogin(ctx);
    const { libraryId, libraryFolderId, folderPath } = await createLibraryWithFolder(ctx);
    expect((await grant(libraryId, subject.userId, 'viewer')).statusCode).toBe(201);
    expect((await deleteAccount(subject.userId)).statusCode).toBe(204);
    expect(await account(subject.userId)).toBeUndefined();
    expect(await grants(libraryId)).toEqual([]);
    const folder = await ctx.db.query.libraryFolders.findFirst({ where: (fields, { eq }) => eq(fields.id, libraryFolderId) });
    expect(folder).toMatchObject({ id: libraryFolderId, libraryId, path: folderPath });
  });

  it('blocks deletion of an active sole owner even with surviving editors and viewers and discloses no library details', async () => {
    const subject = await createUserAndLogin(ctx);
    const editor = await createUserAndLogin(ctx);
    const lib = await makeLibrary(subject, 'Private sole owner fixture');
    expect((await grant(lib.id, editor.userId, 'editor')).statusCode).toBe(201);
    expect((await grant(lib.id, reader.userId, 'viewer')).statusCode).toBe(201);
    const original = await grants(lib.id);
    expect((await deleteAccount(subject.userId, reader.accessToken)).statusCode).toBe(403);
    const denied = await deleteAccount(subject.userId);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Assign another owner to each library where this account is the sole owner before deleting the account',
    });
    expect(await account(subject.userId)).toEqual({ id: subject.userId, active: true });
    expect(await grants(lib.id)).toEqual(original);
    expect(await lib.snapshot()).toEqual(lib.initial);
    for (const token of [userManager.accessToken, libraryManager.accessToken, ctx.adminToken]) {
      expect((await request(token, 'GET', `/libraries/${lib.id}`)).statusCode).toBe(403);
    }
  });

  it('deactivates a sole owner, preserves ownership, and counts the inactive owner when deleting a co-owner', async () => {
    const subject = await createUserAndLogin(ctx);
    const other = await createUserAndLogin(ctx);
    const lib = await makeLibrary(subject, 'Inactive sole owner fixture');
    const soleGrant = [{ userId: subject.userId, accessLevel: 'owner' }];

    expect((await request(userManager.accessToken, 'PATCH', `/users/${subject.userId}`, { active: false })).statusCode).toBe(200);
    expect((await request(subject.accessToken, 'GET', `/libraries/${lib.id}`)).statusCode).toBe(401);
    expect((await deleteAccount(subject.userId)).statusCode).toBe(409);
    expect(await account(subject.userId)).toEqual({ id: subject.userId, active: false });
    expect(await grants(lib.id)).toEqual(soleGrant);

    expect((await grant(lib.id, other.userId, 'owner')).statusCode).toBe(201);
    expect((await deleteAccount(other.userId)).statusCode).toBe(204);
    expect(await account(other.userId)).toBeUndefined();
    expect(await grants(lib.id)).toEqual(soleGrant);
    expect(await lib.snapshot()).toEqual(lib.initial);
  });

  it('rejects deletion atomically across several libraries and allows it after explicit reassignment', async () => {
    const subject = await createUserAndLogin(ctx);
    const other = await createUserAndLogin(ctx);
    const shared = await makeLibrary(subject, 'Earlier shared library fixture');
    const privateLib = await makeLibrary(subject, 'Later sole owner fixture');
    expect((await grant(shared.id, other.userId, 'owner')).statusCode).toBe(201);
    const originalShared = await grants(shared.id);
    const originalPrivate = await grants(privateLib.id);
    expect((await deleteAccount(subject.userId)).statusCode).toBe(409);
    expect(await account(subject.userId)).toEqual({ id: subject.userId, active: true });
    expect(await grants(shared.id)).toEqual(originalShared);
    expect(await grants(privateLib.id)).toEqual(originalPrivate);
    expect((await grant(privateLib.id, other.userId, 'owner', userManager.accessToken)).statusCode).toBe(403);
    expect((await grant(privateLib.id, other.userId, 'owner', libraryManager.accessToken, '')).statusCode).toBe(403);
    expect(await grants(privateLib.id)).toEqual(originalPrivate);

    expect((await grant(privateLib.id, other.userId, 'owner')).statusCode).toBe(201);
    expect((await deleteAccount(subject.userId)).statusCode).toBe(204);
    expect(await account(subject.userId)).toBeUndefined();
    for (const lib of [shared, privateLib]) {
      expect(await grants(lib.id)).toEqual([{ userId: other.userId, accessLevel: 'owner' }]);
      expect(await lib.snapshot()).toEqual(lib.initial);
      expect((await request(other.accessToken, 'GET', `/libraries/${lib.id}`)).statusCode).toBe(200);
      expect((await request(userManager.accessToken, 'GET', `/libraries/${lib.id}`)).statusCode).toBe(403);
    }
  });
});
