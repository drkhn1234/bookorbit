import { and, eq } from 'drizzle-orm';
import { Permission } from '@bookorbit/types';
import { books, userLibraryAccess, userPermissions } from '../src/db/schema';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  grantLibraryAccess,
  uploadLibraryFile,
  type AuthorizationMatrixE2EContext,
} from './e2e/authorization-matrix/authorization-matrix-harness';
import { buildFb2Fixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';

describe('Library capabilities and explicit administrator intent', () => {
  let ctx: AuthorizationMatrixE2EContext;
  const fixtureContent = (title: string) => buildFb2Fixture({ title, authors: ['Fixture Author'] });

  beforeAll(async () => {
    ctx = await createAuthorizationMatrixE2EContext();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
  });

  it('derives owner capabilities from the library only and checks every library in a batch', async () => {
    const owner = await createUserAndLogin(ctx, { permissions: [Permission.ApiKeys] });
    const primary = await createLibraryWithFolder(ctx);
    const other = await createLibraryWithFolder(ctx);
    await grantLibraryAccess(ctx, owner.userId, primary.libraryId, 'owner');
    await grantLibraryAccess(ctx, owner.userId, other.libraryId, 'viewer');
    const upload = await uploadLibraryFile(ctx, {
      token: owner.accessToken,
      libraryId: primary.libraryId,
      fileName: 'owned.fb2',
      content: fixtureContent('Owner fixture'),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const { bookId } = upload.json();
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookId}`, headers: authHeader(owner.accessToken) });
    expect(detail.statusCode, detail.body).toBe(200);
    const fileId = detail.json().files[0].id;
    const download = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/files/${fileId}/download`, headers: authHeader(owner.accessToken) });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toContain('Owner fixture');
    const metadata = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${bookId}/metadata`,
      headers: authHeader(owner.accessToken),
      payload: { title: 'Owner metadata update' },
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    const readAloud = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookId}/read-aloud`, headers: authHeader(owner.accessToken) });
    expect(readAloud.statusCode, readAloud.body).toBe(200);

    const [foreign] = await ctx.db
      .insert(books)
      .values({
        libraryId: other.libraryId,
        libraryFolderId: other.libraryFolderId,
        folderPath: other.folderPath,
        status: 'present',
      })
      .returning({ id: books.id });
    const keyResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: authHeader(owner.accessToken),
      payload: { name: 'owner without global content permissions', access: 'write', libraryIds: [primary.libraryId] },
    });
    expect(keyResponse.statusCode, keyResponse.body).toBe(201);
    const keyHeaders = { 'x-api-key': keyResponse.json().token };
    const keyDownload = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/files/${fileId}/download`, headers: keyHeaders });
    expect(keyDownload.statusCode).toBe(403);
    const keyUpload = await ctx.app.inject({ method: 'POST', url: `/api/v1/libraries/${primary.libraryId}/upload?scope=admin`, headers: keyHeaders });
    expect(keyUpload.statusCode).toBe(403);

    const second = await uploadLibraryFile(ctx, {
      token: owner.accessToken,
      libraryId: primary.libraryId,
      fileName: 'second.fb2',
      content: fixtureContent('Second fixture'),
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().bookId;
    const linkOwned = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/books/links',
      headers: authHeader(owner.accessToken),
      payload: { bookIds: [bookId, secondId] },
    });
    expect(linkOwned.statusCode, linkOwned.body).toBe(201);
    const unlink = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${bookId}/link`,
      headers: authHeader(owner.accessToken),
    });
    expect(unlink.statusCode, unlink.body).toBe(204);

    const batch = { bookIds: [bookId, foreign.id] };
    const links = await ctx.app.inject({ method: 'POST', url: '/api/v1/books/links', headers: authHeader(owner.accessToken), payload: batch });
    expect(links.statusCode, links.body).toBe(403);
    const deleteBatch = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/books', headers: authHeader(owner.accessToken), payload: batch });
    expect(deleteBatch.statusCode, deleteBatch.body).toBe(403);
    expect((await ctx.db.select().from(books).where(eq(books.id, bookId))).length).toBe(1);
    const deleteOwned = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/books',
      headers: authHeader(owner.accessToken),
      payload: { bookIds: [bookId] },
    });
    expect(deleteOwned.statusCode, deleteOwned.body).toBe(204);
    expect(await ctx.db.select().from(books).where(eq(books.id, bookId))).toEqual([]);
    expect(await ctx.db.select().from(userPermissions).where(eq(userPermissions.userId, owner.userId))).toEqual([
      expect.objectContaining({ permissionName: Permission.ApiKeys }),
    ]);
  }, 45_000);

  it.each(['viewer', 'editor', 'owner'] as const)(
    'keeps the %s role identical by default and scopes admin to explicit requests',
    async (role) => {
      const library = await createLibraryWithFolder(ctx);
      const permissions = role === 'owner' ? [] : [Permission.LibraryUpload, Permission.LibraryEditMetadata];
      const ordinary = await createUserAndLogin(ctx, { permissions });
      const superuser = await createUserAndLogin(ctx, { permissions, isSuperuser: true });
      const actorHeaders = authHeader(superuser.accessToken);
      const entry = `/api/v1/libraries/${library.libraryId}`;
      expect((await ctx.app.inject({ method: 'GET', url: entry, headers: actorHeaders })).statusCode).toBe(403);

      for (const actor of [ordinary, superuser]) await grantLibraryAccess(ctx, actor.userId, library.libraryId, role);
      const patch = (token: string, administrative = false) =>
        ctx.app.inject({
          method: 'PATCH',
          url: entry + (administrative ? '?scope=admin' : ''),
          headers: authHeader(token),
          payload: { icon: 'BookOpen', watch: false },
        });
      const upload = (actor: typeof ordinary, administrative = false) =>
        uploadLibraryFile(ctx, {
          token: actor.accessToken,
          libraryId: library.libraryId,
          fileName: `${actor.userId}-${administrative}.fb2`,
          content: fixtureContent(`Fixture ${actor.userId} ${administrative}`),
          administrative,
        });
      for (const actor of [ordinary, superuser]) {
        const ordinaryUpload = await upload(actor);
        expect(ordinaryUpload.statusCode, ordinaryUpload.body).toBe(role === 'viewer' ? 403 : 201);
        expect((await patch(actor.accessToken)).statusCode).toBe(role === 'owner' ? 200 : 403);
      }
      const explicitScopeUpload = await upload(superuser, true);
      expect(explicitScopeUpload.statusCode, explicitScopeUpload.body).toBe(201);
      expect((await patch(superuser.accessToken, true)).statusCode).toBe(200);
      expect((await patch(superuser.accessToken)).statusCode).toBe(role === 'owner' ? 200 : 403);
      if (role === 'viewer') {
        expect((await upload(ordinary, true)).statusCode).toBe(403);
        expect((await upload(superuser)).statusCode).toBe(403);
        const scan = await ctx.app.inject({ method: 'POST', url: `/api/v1/scanner/libraries/${library.libraryId}/scan`, headers: actorHeaders });
        expect(scan.statusCode, scan.body).toBe(403);
        const adminScan = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/scanner/libraries/${library.libraryId}/scan?scope=admin`,
          headers: actorHeaders,
        });
        expect(adminScan.statusCode, adminScan.body).toBe(202);
        const deniedAgain = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/scanner/libraries/${library.libraryId}/scan`,
          headers: actorHeaders,
        });
        expect(deniedAgain.statusCode, deniedAgain.body).toBe(403);
      }
      const [grant] = await ctx.db
        .select()
        .from(userLibraryAccess)
        .where(and(eq(userLibraryAccess.userId, superuser.userId), eq(userLibraryAccess.libraryId, library.libraryId)));
      expect(grant.accessLevel).toBe(role);
    },
    45_000,
  );
});
