import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { copyFile, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Library } from '@bookorbit/types';

import { bookFiles, bookMetadata, books, scanJobs } from '../src/db/schema';
import { FileEventProcessorService } from '../src/modules/scanner/file-event-processor.service';
import { computeFileHash } from '../src/modules/scanner/lib/hash';
import { ScannerService } from '../src/modules/scanner/scanner.service';
import { assertNoIntegrityViolations, waitForScanCompletion } from './e2e/app-harness';
import { createEpubFixture } from './e2e/authorization-matrix/authorization-matrix-fixture-builder';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createUserAndLogin,
  type AuthorizationMatrixE2EContext,
  type TestUserSession,
} from './e2e/authorization-matrix/authorization-matrix-harness';

describe('scanner identity with stale catalog rows (PostgreSQL e2e)', () => {
  let root: string;
  let ctx: AuthorizationMatrixE2EContext;
  let sourceOwner: TestUserSession;
  let destinationOwner: TestUserSession;
  const previousPersonalRoot = process.env.PERSONAL_LIBRARY_ROOT;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookorbit-file-identity-'));
    process.env.PERSONAL_LIBRARY_ROOT = join(root, 'books');
    ctx = await createAuthorizationMatrixE2EContext({ keepMetadataPersistence: true });
    sourceOwner = await createUserAndLogin(ctx, {});
    destinationOwner = await createUserAndLogin(ctx, {});
  }, 60_000);

  afterAll(async () => {
    try {
      if (ctx) {
        try {
          await assertNoIntegrityViolations(ctx.db);
        } finally {
          await closeAuthorizationMatrixE2EContext(ctx);
        }
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      if (previousPersonalRoot === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
      else process.env.PERSONAL_LIBRARY_ROOT = previousPersonalRoot;
    }
  });

  async function createLibrary(owner: TestUserSession, mode: Library['organizationMode'], extraFolders = false): Promise<Library> {
    const folders: string[] = [];
    if (extraFolders) {
      const parentPath = join(root, 'books', owner.username);
      for (let index = 0; index < 2; index++) {
        const name = randomUUID();
        const folder = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/path',
          headers: authHeader(owner.accessToken),
          payload: { parentPath, name },
        });
        expect(folder.statusCode, folder.body).toBe(201);
        folders.push(join(parentPath, name));
      }
    }
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/libraries/personal',
      headers: authHeader(owner.accessToken),
      payload: { name: randomUUID(), icon: 'BookOpen', organizationMode: mode, watch: false, ...(extraFolders && { folders }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    const library = response.json<Library>();
    expect(library.accessLevel).toBe('owner');
    if (extraFolders) expect(library.folders.map((folder) => folder.path)).toEqual(folders);
    // Creation schedules the first scan asynchronously, before isScanRunning can see it.
    await vi.waitFor(
      async () => {
        const jobs = await ctx.db.select().from(scanJobs).where(eq(scanJobs.libraryId, library.id));
        expect(jobs).toMatchObject([{ status: 'completed' }]);
        expect(ctx.app.get(ScannerService).isScanRunning(library.id)).toBe(false);
      },
      { timeout: 10_000 },
    );
    return library;
  }

  async function scan(owner: TestUserSession, library: Library, full = false) {
    if (full) {
      const { jobId } = await ctx.app.get(ScannerService).startScan(library.id, 'manual', true);
      return waitForScanCompletion(ctx.db, jobId);
    }
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/scanner/libraries/${library.id}/scan`,
      headers: authHeader(owner.accessToken),
    });
    expect(response.statusCode, response.body).toBe(202);
    return waitForScanCompletion(ctx.db, response.json<{ jobId: number }>().jobId);
  }

  async function state(path: string) {
    const [row] = await ctx.db.select().from(bookFiles).where(eq(bookFiles.absolutePath, path));
    expect(row).toBeDefined();
    return row!;
  }

  async function record(bookId: number) {
    const [row] = await ctx.db
      .select({ libraryId: books.libraryId, status: books.status, primaryFileId: books.primaryFileId, title: bookMetadata.title })
      .from(books)
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(eq(books.id, bookId));
    return row;
  }

  async function setTitle(owner: TestUserSession, bookId: number, title: string) {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/books/${bookId}/metadata`,
      headers: authHeader(owner.accessToken),
      payload: { title },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  function serve(owner: TestUserSession, fileId: number) {
    return ctx.app.inject({ method: 'GET', url: `/api/v1/books/files/${fileId}/serve`, headers: authHeader(owner.accessToken) });
  }

  it('imports a new file into an empty catalog and leaves it stable on full rescan', async () => {
    expect(await ctx.db.select({ id: books.id }).from(books)).toEqual([]);
    const library = await createLibrary(sourceOwner, 'book_per_file');
    const path = await createEpubFixture(library.folders[0].path, 'first.epub', { title: 'Fresh import' });
    const job = await scan(sourceOwner, library);
    const row = await state(path);
    const metadata = await record(row.bookId);
    console.info('identity fresh', { added: job.addedCount, updated: job.updatedCount, bookId: row.bookId, fileId: row.id, digest: row.fileHash });
    expect(job).toMatchObject({ addedCount: 1, missingCount: 0 });
    expect(metadata).toMatchObject({ libraryId: library.id, primaryFileId: row.id, status: 'present', title: 'Fresh import' });
    expect(row.fileHash).toBe(await computeFileHash(path));
    expect(await scan(sourceOwner, library, true)).toMatchObject({ addedCount: 0, updatedCount: 0, missingCount: 0 });
    expect(await state(path)).toMatchObject({ id: row.id, bookId: row.bookId });
  }, 60_000);

  it.each(['stale-row', 'filesystem'] as const)(
    'keeps a new file separate when a missing book in another personal library shares its inode (%s)',
    async (collision) => {
      const source = await createLibrary(sourceOwner, 'book_per_file');
      const destination = await createLibrary(destinationOwner, 'book_per_file', true);
      const originalPath = await createEpubFixture(source.folders[0].path, 'previous.epub', { title: 'Original bytes' });
      expect(await scan(sourceOwner, source)).toMatchObject({ addedCount: 1 });
      const original = await state(originalPath);
      const savedTitle = `Source title ${collision}`;
      await setTitle(sourceOwner, original.bookId, savedTitle);
      const originalStat = await stat(originalPath, { bigint: true });

      const staging = join(root, `staged-${collision}.epub`);
      if (collision === 'stale-row') {
        // A prior suite removed its files without running a final source scan.
        await unlink(originalPath);
      } else {
        await rename(originalPath, staging);
        expect(await scan(sourceOwner, source)).toMatchObject({ missingCount: 1 });
      }
      const sourceStatus = collision === 'stale-row' ? 'present' : 'missing';
      expect(await record(original.bookId)).toMatchObject({ libraryId: source.id, status: sourceStatus });

      const incoming = await createEpubFixture(root, `new-${collision}.epub`, { title: `Different publication ${collision}` });
      const newPath = join(destination.folders[1].path, 'arriving.epub');
      if (collision === 'stale-row') {
        await rename(incoming, newPath);
        const { ino } = await stat(newPath, { bigint: true });
        await ctx.db.update(bookFiles).set({ ino }).where(eq(bookFiles.id, original.id));
      } else {
        await writeFile(staging, await readFile(incoming));
        await rename(staging, newPath);
        expect(await stat(newPath, { bigint: true })).toMatchObject({ ino: originalStat.ino, dev: originalStat.dev });
      }
      const stale = await state(originalPath);
      const newStat = await stat(newPath, { bigint: true });
      const newHash = await computeFileHash(newPath);
      expect(newStat.ino).toBe(stale.ino);
      expect(newHash).not.toBe(stale.fileHash);
      const job = await scan(destinationOwner, destination);
      const arrived = await state(newPath);
      const oldBook = await record(original.bookId);
      const newBook = await record(arrived.bookId);
      const oldBookInDestination = (await serve(destinationOwner, original.id)).statusCode;
      const newFileInSource = (await serve(sourceOwner, arrived.id)).statusCode;
      const newFileInDestination = await serve(destinationOwner, arrived.id);
      console.info('identity collision', {
        collision,
        inode: String(newStat.ino),
        added: job.addedCount,
        updated: job.updatedCount,
        original: { bookId: original.bookId, fileId: original.id, digest: original.fileHash },
        arrived: { bookId: arrived.bookId, fileId: arrived.id, persistedDigest: arrived.fileHash, expectedDigest: newHash },
        oldBook,
        newBook,
        http: [oldBookInDestination, newFileInSource, newFileInDestination.statusCode],
      });
      expect.soft(job).toMatchObject({ addedCount: 1, missingCount: 0 });
      expect.soft(arrived.bookId).not.toBe(original.bookId);
      expect.soft(arrived.id).not.toBe(original.id);
      expect.soft(arrived).toMatchObject({ libraryFolderId: destination.folders[1].id, fileHash: newHash });
      expect.soft(oldBook).toMatchObject({ libraryId: source.id, status: sourceStatus, primaryFileId: original.id, title: savedTitle });
      expect.soft(newBook).toMatchObject({
        libraryId: destination.id,
        primaryFileId: arrived.id,
        status: 'present',
        title: `Different publication ${collision}`,
      });
      expect.soft(oldBookInDestination).toBe(403);
      expect.soft(newFileInSource).toBe(403);
      expect(newFileInDestination.statusCode).toBe(200);
      expect(newFileInDestination.rawPayload).toEqual(await readFile(newPath));
      if (collision === 'stale-row') expect(await scan(sourceOwner, source)).toMatchObject({ missingCount: 1 });
      expect.soft(await record(original.bookId)).toMatchObject({ libraryId: source.id, status: 'missing', title: savedTitle });
      expect(await scan(destinationOwner, destination, true)).toMatchObject({ addedCount: 0, updatedCount: 0, missingCount: 0 });
      expect(await state(newPath)).toMatchObject({ id: arrived.id, bookId: arrived.bookId });
    },
    60_000,
  );

  it('defers a same-library watcher event when a disappeared file has been rewritten in place', async () => {
    const library = await createLibrary(sourceOwner, 'book_per_folder');
    const path = await createEpubFixture(library.folders[0].path, 'Old/previous.epub', { title: 'Old folder title' });
    await scan(sourceOwner, library);
    const old = await state(path);
    const staging = join(root, 'watcher-stage.epub');
    await rename(path, staging);
    await scan(sourceOwner, library);
    // Keep the directory itself absent as it would be for a complete folder relocation.
    await rm(join(library.folders[0].path, 'Old'), { recursive: true });
    const replacement = await createEpubFixture(library.folders[0].path, 'Different/template.epub', { title: 'New folder title' });
    await writeFile(staging, await readFile(replacement));
    await unlink(replacement);
    const arrival = join(library.folders[0].path, 'Different/arrived.epub');
    await rename(staging, arrival);
    expect((await stat(arrival, { bigint: true })).ino).toBe(old.ino);
    const event = await ctx.app.get(FileEventProcessorService).handleCreate(arrival, library.id);
    console.info('identity watcher', event);
    expect.soft(event).toEqual({ type: 'scan-required', scope: 'file' });
    const job = await scan(sourceOwner, library);
    const row = await state(arrival);
    expect.soft(job).toMatchObject({ addedCount: 1 });
    expect.soft(row.id).not.toBe(old.id);
    expect.soft(row.bookId).not.toBe(old.bookId);
    expect(await record(old.bookId)).toMatchObject({ status: 'missing' });
  }, 60_000);

  it('recovers an interrupted job and follows unchanged bytes to a different inode', async () => {
    const library = await createLibrary(sourceOwner, 'book_per_file', true);
    const path = await createEpubFixture(library.folders[0].path, 'copy-source.epub', { title: 'Unchanged publication' });
    await scan(sourceOwner, library);
    const original = await state(path);

    const destination = join(library.folders[1].path, 'copy-destination.epub');
    await copyFile(path, destination);
    expect((await stat(destination, { bigint: true })).ino).not.toBe(original.ino);
    expect(await computeFileHash(destination)).toBe(original.fileHash);
    await unlink(path);
    // Persist the job row left by a stopped scanner, then run the actual startup recovery.
    const [interrupted] = await ctx.db.insert(scanJobs).values({ libraryId: library.id, triggeredBy: 'manual' }).returning();
    await closeAuthorizationMatrixE2EContext(ctx);
    ctx = await createAuthorizationMatrixE2EContext({ keepMetadataPersistence: true });

    const [recoveredJob] = await ctx.db.select().from(scanJobs).where(eq(scanJobs.id, interrupted.id));
    expect(recoveredJob).toMatchObject({ status: 'failed', errorMessage: 'Server restarted during scan' });
    const recovery = await scan(sourceOwner, library);
    expect(recovery).toMatchObject({ status: 'completed', addedCount: 0 });
    // Scanning the source folder first can count a missing book before the destination restores it.
    expect([0, 1]).toContain(recovery.missingCount);
    expect(await record(original.bookId)).toMatchObject({ libraryId: library.id, status: 'present', primaryFileId: original.id });
    expect(await state(destination)).toMatchObject({
      id: original.id,
      bookId: original.bookId,
      libraryFolderId: library.folders[1].id,
      fileHash: original.fileHash,
    });
    expect((await serve(sourceOwner, original.id)).statusCode).toBe(200);
  }, 60_000);
});
