import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Permission, type AccessLevel } from '@bookorbit/types';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import type { ApiKeyCredential, RequestUser } from '../../common/types/request-user';
import { TEST_ADMIN_REQUEST } from '../../../test/unit/path-access';
import { FolderInsightService } from './folder-insight.service';
import { PathPolicyService, type PathRequest } from './path-policy.service';
import type { LibraryFolderRow } from './path.repository';
import { PathService } from './path.service';
import { PERSONAL_OWNER_MARKER } from './personal-directory';

describe('personal filesystem authorization with real directories', () => {
  let root: string;
  let books: string;
  let aliceRoot: string;
  let bobRoot: string;
  let policy: PathPolicyService;
  let paths: PathService;
  let insight: FolderInsightService;
  let folders: LibraryFolderRow[];
  let grants: Map<number, Map<number, AccessLevel>>;
  const alice = { ...TEST_ADMIN_REQUEST.user, id: 11, username: 'alice', isSuperuser: false } as RequestUser;
  const bob = { ...alice, id: 22, username: 'bob' };
  const admin = { ...alice, id: 33, username: 'operator', isSuperuser: true };
  const request: PathRequest = { user: alice };

  function services(options: { parent?: string; browse?: string; appData?: string } = {}) {
    const repo = {
      findLibraryFolders: () => Promise.resolve([...folders]),
      findUserIdentity: (id: number) => Promise.resolve([alice, bob, admin].find((user) => user.id === id)),
    };
    const scope = new LibraryScopeService({
      findGrantedLevels: (id: number) => Promise.resolve([...(grants.get(id) ?? [])].map(([id, accessLevel]) => ({ id, accessLevel }))),
      findGrantedLevel: (id: number, libraryId: number) => Promise.resolve(grants.get(id)?.get(libraryId) ?? null),
    } as never);
    policy = new PathPolicyService(
      {
        libraryBrowseRoot: options.browse ?? root,
        personalLibraryRoot: options.parent ?? books,
        appDataPath: options.appData ?? join(root, 'managed'),
        bookDockPath: join(root, 'book-dock'),
      } as never,
      repo as never,
      scope,
    );
    paths = new PathService(policy);
    insight = new FolderInsightService(policy, paths);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-personal-paths-'));
    books = join(root, 'books');
    aliceRoot = join(books, 'alice');
    bobRoot = join(books, 'bob');
    folders = [];
    grants = new Map();
    services();
  });

  afterEach(async () => {
    await chmod(aliceRoot, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('checks creation eligibility read-only without weakening read-only or inactive principals', async () => {
    await expect(policy.assertCreationAccess(request)).resolves.toBeUndefined();
    await expect(access(aliceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(policy.assertCreationAccess({ user: { ...alice, active: false } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(policy.assertCreationAccess({ user: { ...alice, permissions: [Permission.DemoRestricted] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(access(books)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derives immutable usernames without provisioning on a GET', async () => {
    await expect(paths.getConfig(request)).resolves.toEqual({ root: aliceRoot });
    await expect(paths.listFolder(request)).resolves.toMatchObject({ state: 'missing', entries: [] });
    await expect(access(aliceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lazily provisions a user-ID marker, reuses it and preserves Unicode usernames', async () => {
    await paths.createDirectory(request, aliceRoot, 'Electromagnetism');
    expect(JSON.parse(await readFile(join(aliceRoot, PERSONAL_OWNER_MARKER), 'utf8'))).toEqual({ version: 1, userId: alice.id });
    await paths.createDirectory(request, aliceRoot, 'Mathematics');
    expect((await paths.listDirectories(request)).map((entry) => entry.name)).toEqual(['Electromagnetism', 'Mathematics']);
    const unicode = { ...alice, id: 44, username: 'ışık' };
    await paths.createDirectory({ user: unicode }, join(books, unicode.username), 'Kitaplar');
    expect((await paths.getConfig({ user: unicode })).root).toBe(join(books, 'ışık'));
  });

  it('handles concurrent provisioning and directory collisions without overwriting', async () => {
    await Promise.all(['A', 'B', 'C'].map((name) => paths.createDirectory(request, aliceRoot, name)));
    const outcomes = await Promise.allSettled([paths.createDirectory(request, aliceRoot, 'Same'), paths.createDirectory(request, aliceRoot, 'Same')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((result) => result.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(ConflictException);
    expect(JSON.parse(await readFile(join(aliceRoot, PERSONAL_OWNER_MARKER), 'utf8')).userId).toBe(alice.id);
  });

  it.each(['', '.', '..', '../bob', '/bob', 'alice/bob', 'alice\\bob', ' alice', 'alice ', 'ali\0ce', 'ali\u0085ce'])(
    'rejects unsafe stored username %j',
    async (username) => {
      await expect(paths.getConfig({ user: { ...alice, username } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(access(books)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([false, true])('does not adopt an existing unmarked directory (contains files: %s)', async (nonempty) => {
    await mkdir(aliceRoot, { recursive: true });
    if (nonempty) await writeFile(join(aliceRoot, 'unknown.epub'), 'untouched');
    await expect(paths.getConfig(request)).rejects.toBeInstanceOf(ConflictException);
    await expect(paths.createDirectory(request, aliceRoot, 'New')).rejects.toBeInstanceOf(ConflictException);
    await expect(access(join(aliceRoot, PERSONAL_OWNER_MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
    if (nonempty) expect(await readFile(join(aliceRoot, 'unknown.epub'), 'utf8')).toBe('untouched');
  });

  it('allows deliberate superuser adoption of an unmarked root, but never overwrites a previous owner', async () => {
    await mkdir(aliceRoot, { recursive: true });
    await writeFile(join(aliceRoot, 'existing.epub'), 'kept');
    await expect(paths.adoptPersonalRoot({ ...bob, permissions: [Permission.ManageLibraries] }, alice.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(paths.adoptPersonalRoot(admin, alice.id)).resolves.toBe(aliceRoot);
    expect(await readFile(join(aliceRoot, 'existing.epub'), 'utf8')).toBe('kept');
    await expect(paths.getConfig({ user: { ...alice, id: 999 } })).rejects.toBeInstanceOf(ConflictException);
    await writeFile(join(aliceRoot, PERSONAL_OWNER_MARKER), JSON.stringify({ version: 1, userId: 999 }));
    await expect(paths.adoptPersonalRoot(admin, alice.id)).rejects.toBeInstanceOf(ConflictException);
    expect(JSON.parse(await readFile(join(aliceRoot, PERSONAL_OWNER_MARKER), 'utf8')).userId).toBe(999);
  });

  it('isolates users, ManageLibraries and ordinary superuser requests, while allowing explicit administration', async () => {
    await paths.createDirectory(request, aliceRoot, 'Physics');
    await paths.createDirectory({ user: bob }, bobRoot, 'Quantum');
    for (const user of [alice, { ...alice, permissions: [Permission.ManageLibraries] }, { ...alice, isSuperuser: true }]) {
      await expect(paths.listFolder({ user }, bobRoot)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(paths.createDirectory({ user }, bobRoot, 'Forbidden')).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(paths.listFolder({ user: alice, scope: 'admin' }, bobRoot)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await paths.listFolder({ user: admin, scope: 'admin' }, bobRoot)).entries.map((entry) => entry.name)).toEqual(['Quantum']);
  });

  it.each(['../bob', 'Physics/../../bob', '/etc', '/proc', 'Physics\\..\\bob'])('rejects injected path %j before provisioning', async (path) => {
    await expect(paths.createDirectory(request, path, 'Bad')).rejects.toThrow();
    await expect(access(aliceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a same-prefix sibling and symlinks at the root, parent, descendants and marker', async () => {
    await paths.createDirectory({ user: bob }, bobRoot, 'Private');
    await symlink(bobRoot, aliceRoot);
    await expect(paths.getConfig(request)).rejects.toBeInstanceOf(ForbiddenException);
    await unlink(aliceRoot);
    await paths.createDirectory(request, aliceRoot, 'Own');
    await expect(paths.listFolder(request, aliceRoot + '-other')).rejects.toBeInstanceOf(ForbiddenException);
    await symlink(bobRoot, join(aliceRoot, 'Alias'));
    await expect(insight.inspect(request, join(aliceRoot, 'Alias'))).rejects.toBeInstanceOf(ForbiddenException);
    await unlink(join(aliceRoot, PERSONAL_OWNER_MARKER));
    await symlink(join(bobRoot, PERSONAL_OWNER_MARKER), join(aliceRoot, PERSONAL_OWNER_MARKER));
    await expect(paths.getConfig(request)).rejects.toBeInstanceOf(ConflictException);
    const parentAlias = join(root, 'alias-parent');
    await symlink(books, parentAlias);
    services({ parent: parentAlias });
    await expect(paths.getConfig({ user: bob })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revalidates symlinks and markers before returning a warm inspection cache', async () => {
    const dir = (await paths.createDirectory(request, aliceRoot, 'Own')).path;
    await writeFile(join(dir, 'visible.epub'), 'visible');
    expect((await insight.inspect(request, dir)).files).toBe(1);
    await paths.createDirectory({ user: bob }, bobRoot, 'Private');
    await rm(dir, { recursive: true });
    await symlink(bobRoot, dir);
    await expect(insight.inspect(request, dir)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(insight.inspect({ user: admin, scope: 'admin' }, dir)).rejects.toBeInstanceOf(ForbiddenException);
    await writeFile(join(aliceRoot, PERSONAL_OWNER_MARKER), '{}');
    await expect(insight.inspect(request, aliceRoot)).rejects.toBeInstanceOf(ConflictException);
  });

  it('prunes revoked registered subtrees from listings, search, places, counts, samples and unclaimed caches', async () => {
    const dir = (await paths.createDirectory(request, aliceRoot, 'Registered')).path;
    await writeFile(join(dir, 'private.epub'), 'private');
    folders.push({ libraryId: 7, path: dir, name: 'Private title', icon: null });
    grants.set(alice.id, new Map([[7, 'owner']]));
    expect((await insight.inspect(request, aliceRoot)).files).toBe(1);
    await insight.summarize(request, [aliceRoot]);
    await insight.unclaimed(request);
    expect((await paths.getPlaces(request)).libraries).toHaveLength(1);
    grants.set(alice.id, new Map());
    expect((await paths.listFolder(request)).entries).toEqual([]);
    expect(await paths.listDirectories(request)).toEqual([]);
    expect((await paths.searchFolders(request, 'Registered')).results).toEqual([]);
    expect(await paths.getPlaces(request)).toMatchObject({ libraries: [], mounts: [], appDataPath: null });
    expect(await insight.inspect(request, aliceRoot)).toMatchObject({ files: 0, folders: 0, samples: [] });
    expect(await insight.summarize(request, [aliceRoot, dir])).toMatchObject([{ files: 0 }, { state: 'blocked', files: 0 }]);
    expect((await insight.unclaimed(request)).folders).toEqual([]);
    await expect(insight.inspect(request, dir)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(insight.inspect({ user: admin, scope: 'admin' }, dir)).rejects.toBeInstanceOf(ForbiddenException);
    grants.set(admin.id, new Map([[7, 'viewer']]));
    expect((await insight.inspect({ user: admin, scope: 'admin' }, dir)).files).toBe(1);
    await expect(paths.createDirectory({ user: admin, scope: 'admin' }, dir, 'Denied')).rejects.toBeInstanceOf(ForbiddenException);
    grants.get(admin.id)!.set(7, 'owner');
    await expect(paths.createDirectory({ user: admin, scope: 'admin' }, dir, 'Allowed')).resolves.toMatchObject({ name: 'Allowed' });
  });

  it('hides application storage and rejects provisioning beneath a registered ancestor', async () => {
    services({ appData: join(aliceRoot, 'system-data') });
    await paths.createDirectory(request, aliceRoot, 'Own');
    await mkdir(join(aliceRoot, 'system-data'));
    await writeFile(join(aliceRoot, 'system-data', 'hidden.pdf'), 'secret');
    expect((await insight.inspect(request, aliceRoot)).files).toBe(0);
    expect((await paths.listFolder(request)).entries.map((entry) => entry.name)).toEqual(['Own']);
    await expect(paths.listFolder(request, join(aliceRoot, 'system-data'))).rejects.toBeInstanceOf(ForbiddenException);
    folders.push({ libraryId: 9, path: books, name: 'Legacy parent', icon: null });
    grants.set(bob.id, new Map([[9, 'owner']]));
    await expect(policy.allocateLibraryDirectory(bob)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(access(bobRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates unclaimed discovery when previously loose content becomes a private library', async () => {
    const dir = (await paths.createDirectory(request, aliceRoot, 'Incoming')).path;
    await writeFile(join(dir, 'book.epub'), 'synthetic');
    expect((await insight.unclaimed(request)).folders).toEqual([{ path: dir, files: 1, formats: { epub: 1 } }]);
    folders.push({ libraryId: 99, name: 'Another reader', icon: null, path: dir });
    expect((await insight.unclaimed(request)).folders).toEqual([]);
  });

  it('enforces the operator browse boundary and directory creation permissions', async () => {
    services({ browse: join(root, 'restricted') });
    await expect(paths.createDirectory(request, aliceRoot, 'Own')).rejects.toBeInstanceOf(ForbiddenException);
    services();
    const dir = (await paths.createDirectory(request, aliceRoot, 'Library')).path;
    folders.push({ libraryId: 7, path: dir, name: 'Shared', icon: null });
    grants.set(alice.id, new Map([[7, 'viewer']]));
    await expect(paths.createDirectory(request, dir, 'No')).rejects.toBeInstanceOf(ForbiddenException);
    grants.get(alice.id)!.set(7, 'editor');
    await expect(paths.createDirectory(request, dir, 'Yes')).resolves.toMatchObject({ name: 'Yes' });
  });

  it('read-only and library-limited keys cannot provision or widen their authority', async () => {
    const credential: ApiKeyCredential = {
      kind: 'api_key',
      keyId: 1,
      keyName: 'Reader',
      audience: 'api',
      access: 'read',
      libraryIds: null,
      ownerIsSuperuser: false,
    };
    const reader = { ...alice, credential };
    await expect(paths.getConfig({ user: reader })).resolves.toEqual({ root: aliceRoot });
    await expect(paths.createDirectory({ user: reader }, aliceRoot, 'No')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(access(aliceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const limited = { ...reader, credential: { ...credential, access: 'write' as const, libraryIds: [7] } };
    await expect(paths.getConfig({ user: limited })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects inactive and demo-restricted accounts before provisioning', async () => {
    for (const user of [
      { ...alice, active: false },
      { ...alice, permissions: [Permission.DemoRestricted] },
    ]) {
      await expect(paths.createDirectory({ user }, aliceRoot, 'No')).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(access(aliceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses malformed or non-file ownership markers without adopting their directory', async () => {
    await paths.createDirectory(request, aliceRoot, 'Keep');
    const marker = join(aliceRoot, PERSONAL_OWNER_MARKER);
    await writeFile(marker, 'invalid');
    await expect(paths.getConfig(request)).rejects.toBeInstanceOf(ConflictException);
    await unlink(marker);
    await mkdir(marker);
    await expect(paths.getConfig(request)).rejects.toBeInstanceOf(ConflictException);
    await expect(access(join(aliceRoot, 'Keep'))).resolves.toBeUndefined();
  });

  it('allocates distinct child roots for .2 without registering a library or changing ownership grants', async () => {
    const first = await policy.allocateLibraryDirectory(alice);
    const second = await policy.allocateLibraryDirectory(alice);
    expect(first).not.toBe(second);
    expect(first.startsWith(aliceRoot + '/library-')).toBe(true);
    expect(folders).toEqual([]);
    expect(grants.size).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)('fails safely on filesystem write errors without deleting existing data', async () => {
    await paths.createDirectory(request, aliceRoot, 'Keep');
    await chmod(aliceRoot, 0o500);
    await expect(paths.createDirectory(request, aliceRoot, 'No')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(access(join(aliceRoot, 'Keep'))).resolves.toBeUndefined();
  });
});
