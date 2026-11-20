import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  BookDetail,
  MetadataHttpProviderView,
  MetadataProviderDirectory,
  MetadataProviderInfo,
  MetadataSearchCandidateEvent,
} from '@bookorbit/types';
import { and, eq } from 'drizzle-orm';

import * as schema from '../src/db/schema';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  grantLibraryAccess,
  triggerAndWaitForLibraryScan,
  type AuthorizationMatrixE2EContext,
  type TestUserSession,
} from './e2e/authorization-matrix/authorization-matrix-harness';
import { createEpubFixture } from './e2e/metadata-write/metadata-write-fixture-builder';

const SCENARIO_TIMEOUT_MS = 90_000;
const KEY = 'fake-provider';
const COLOR = '#336699';
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const TITLE = 'Zero Coupling Novel';
const EDITION_ID = 'fp/edition 2';
const EDITION_PATH = '/book/fp%2Fedition%202';
const EDITION_TITLE = 'Zero Coupling Novel, revised edition';
const EDITION_URL = 'https://fake.example/books/revised?from=selection';
const FIXTURE_ISBN = '9780306406157';

/**
 * A provider BookOrbit has never heard of, served by the test itself. Nothing in BookOrbit names
 * it: if any step below needs a code change to pass, external providers are coupled again.
 */
class FakeProvider {
  private server!: Server;
  readonly calls: { method: string | undefined; url: URL }[] = [];
  timeoutConnectionsClosed = 0;
  unavailable = false;
  editionPublisher = 'Selected Editions';
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    this.calls.push({ method: req.method, url });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ICON);
      return;
    }
    if (url.pathname === '/provider/info') {
      return send(200, {
        name: 'Fake Provider',
        key: KEY,
        avatarUrl: `${this.baseUrl}icon.png`,
        color: COLOR,
        version: '1.0.0',
        lookup: true,
        mediaTypes: ['book'],
        searchParams: ['isbn', 'limit'],
        supportedFields: ['title', 'authors', 'description', 'publisher', 'publishedDate', 'pageCount', 'isbn', 'communityRating'],
        bookUrlTemplate: 'https://fake.example/books/{id}',
      });
    }
    if (this.unavailable) return send(503, { error: 'Fixture provider unavailable' });
    if (url.pathname === '/search') {
      switch (url.searchParams.get('query')) {
        case 'Fixture timeout':
          res.once('close', () => this.timeoutConnectionsClosed++);
          return;
        case 'Fixture HTTP error':
          return send(503, { error: 'Fixture search unavailable' });
        case 'Fixture malformed body':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{invalid');
          return;
        case 'Fixture incomplete records':
          return send(200, { matches: [{ title: 'Missing id' }, { providerId: 'missing-title' }] });
        case 'Fixture empty search':
          return send(200, { matches: [] });
        case EDITION_TITLE:
          return send(200, { matches: [this.edition()] });
        default:
          return send(200, { matches: [this.record('fp-1')] });
      }
    }
    const lookup = /^\/book\/(.+)$/.exec(url.pathname);
    if (lookup) {
      if (url.pathname === EDITION_PATH) return send(200, this.edition());
      if (lookup[1] === 'fp-1') return send(200, this.record('fp-1'));
      return send(404, { error: 'Not found' });
    }
    send(404, { error: 'Not found' });
  }

  private record(id: string) {
    return {
      providerId: id,
      title: TITLE,
      authors: ['Test Author'],
      description: 'A description only the fake provider knows.',
      publisher: 'Fake House',
      rating: 4.2,
      ratingCount: 321,
      url: `https://fake.example/books/${id}?from=search`,
    };
  }

  private edition() {
    return {
      ...this.record(EDITION_ID),
      title: EDITION_TITLE,
      publisher: this.editionPublisher,
      publishedDate: '2024-03-14',
      publishedYear: 2024,
      pages: 287,
      isbn: FIXTURE_ISBN,
      url: EDITION_URL,
    };
  }
}

describe('External metadata providers (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  let ctx!: AuthorizationMatrixE2EContext;
  let admin!: TestUserSession;
  let reader!: TestUserSession;
  const fake = new FakeProvider();
  let providerId = 0;
  let bookId = 0;
  let apiBase = '';

  const call = (session: TestUserSession, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    ctx.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: authHeader(session.accessToken),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const detail = async (): Promise<BookDetail> => (await call(admin, 'GET', `/books/${bookId}`)).json() as BookDetail;

  async function search(title: string, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ title, providers: KEY, cache: 'refresh', ...extra });
    const stream = await fetch(`${apiBase}/api/v1/metadata-fetch/stream?${query}`, {
      headers: authHeader(reader.accessToken),
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    return (await stream.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
      const lines = frame.split(/\r?\n/);
      const data = lines.find((line) => line.startsWith('data:'));
      const name = lines.find((line) => line.startsWith('event:'));
      return data ? [{ event: name?.slice(6).trim() ?? 'message', data: JSON.parse(data.slice(5)) as unknown }] : [];
    });
  }

  async function persistedMetadata() {
    const { bookMetadata, bookProviderIds, bookCommunityRatings, bookAuthors, authors } = schema;
    const [metadata] = await ctx.db
      .select({
        title: bookMetadata.title,
        description: bookMetadata.description,
        publisher: bookMetadata.publisher,
        publishedDate: bookMetadata.publishedDate,
        publishedYear: bookMetadata.publishedYear,
        isbn13: bookMetadata.isbn13,
        pageCount: bookMetadata.pageCount,
        lockedFields: bookMetadata.lockedFields,
      })
      .from(bookMetadata)
      .where(eq(bookMetadata.bookId, bookId));
    const [identifier] = await ctx.db
      .select({ provider: bookProviderIds.provider, externalId: bookProviderIds.externalId, sourceUrl: bookProviderIds.sourceUrl })
      .from(bookProviderIds)
      .where(eq(bookProviderIds.bookId, bookId));
    const [rating] = await ctx.db
      .select({
        provider: bookCommunityRatings.provider,
        rating: bookCommunityRatings.rating,
        ratingCount: bookCommunityRatings.ratingCount,
      })
      .from(bookCommunityRatings)
      .where(eq(bookCommunityRatings.bookId, bookId));
    const authorRows = await ctx.db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(bookAuthors.displayOrder);
    return { metadata, identifier, rating, authors: authorRows.map(({ name }) => name) };
  }

  const previousDirectoryUrl = process.env.METADATA_PROVIDER_DIRECTORY_URL;

  beforeAll(async () => {
    await fake.start();
    // A test run must never reach GitHub; the bundled directory is what is checked here.
    process.env.METADATA_PROVIDER_DIRECTORY_URL = 'off';
    ctx = await createAuthorizationMatrixE2EContext({ keepMetadataPersistence: true });
    admin = await createUserAndLogin(ctx, { isSuperuser: true });
    reader = await createUserAndLogin(ctx, { permissions: [] });

    const library = await createLibraryWithFolder(ctx);
    await grantLibraryAccess(ctx, admin.userId, library.libraryId, 'owner');
    await createEpubFixture(library.folderPath, 'zero/coupling.epub', { title: TITLE });
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    const [row] = await ctx.db.select({ id: schema.books.id }).from(schema.books).where(eq(schema.books.libraryId, library.libraryId)).limit(1);
    bookId = row.id;
    // The harness stubs file extraction, so the scanned book starts with no title to search by.
    const titled = await call(admin, 'PATCH', `/books/${bookId}/metadata`, { title: TITLE });
    if (titled.statusCode !== 200) throw new Error(`Could not title the fixture book: ${titled.statusCode} ${titled.body}`);
    // Server-sent events need a real socket; fastify's injected one cannot keep a stream open.
    await ctx.app.listen(0, '127.0.0.1');
    apiBase = await ctx.app.getUrl();
  });

  afterAll(async () => {
    await closeAuthorizationMatrixE2EContext(ctx);
    await fake.stop();
    if (previousDirectoryUrl === undefined) delete process.env.METADATA_PROVIDER_DIRECTORY_URL;
    else process.env.METADATA_PROVIDER_DIRECTORY_URL = previousDirectoryUrl;
  });

  it('keeps provider registration behind ManageMetadataConfig', async () => {
    expect((await call(reader, 'GET', '/metadata-http-providers')).statusCode).toBe(403);
    expect((await call(reader, 'POST', '/metadata-http-providers', { baseUrl: fake.baseUrl })).statusCode).toBe(403);
    expect((await call(reader, 'GET', '/metadata-http-providers/directory')).statusCode).toBe(403);
  });

  it('lists the ready-made providers from the bundled directory when the online one is off', async () => {
    const response = await call(admin, 'GET', '/metadata-http-providers/directory');

    expect(response.statusCode).toBe(200);
    const directory = response.json() as MetadataProviderDirectory;
    expect(directory).toMatchObject({ source: 'bundled', fetchedAt: null });
    expect(directory.providers.map((entry) => entry.key)).toContain('mangabaka');
    expect(directory.providers.every((entry) => entry.image.startsWith('ghcr.io/bookorbit/'))).toBe(true);
  });

  it('refuses a private address until the admin allows one', async () => {
    const refused = await call(admin, 'POST', '/metadata-http-providers', { baseUrl: fake.baseUrl });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'METADATA_PROVIDER_PRIVATE_ADDRESS' });
  });

  it('registers the provider disabled, under the key it reports, and refuses a duplicate', async () => {
    const created = await call(admin, 'POST', '/metadata-http-providers', { baseUrl: fake.baseUrl, allowPrivateAddress: true, timeoutMs: 2_000 });
    expect(created.statusCode).toBe(201);
    const view = created.json() as MetadataHttpProviderView;
    expect(view).toMatchObject({ key: KEY, enabled: false, status: 'ok', hasAuthorization: false, info: { name: 'Fake Provider', lookup: true } });
    providerId = view.id;

    const duplicate = await call(admin, 'POST', '/metadata-http-providers', { baseUrl: fake.baseUrl, allowPrivateAddress: true });
    expect(duplicate.statusCode).toBe(409);

    const providers = (await call(reader, 'GET', '/metadata-fetch/providers')).json() as MetadataProviderInfo[];
    expect(providers.map((p) => p.key)).not.toContain(KEY);
  });

  it('lists an enabled provider to every user, once, as external', async () => {
    expect((await call(admin, 'PATCH', `/metadata-http-providers/${providerId}`, { enabled: true })).statusCode).toBe(200);

    const providers = (await call(reader, 'GET', '/metadata-fetch/providers')).json() as MetadataProviderInfo[];
    const listed = providers.filter((p) => p.key === KEY);
    expect(listed).toEqual([
      {
        key: KEY,
        label: 'Fake Provider',
        identifiable: true,
        source: 'external',
        iconUrl: expect.stringMatching(new RegExp(`^/api/v1/metadata-providers/${KEY}/icon\\?v=[0-9a-f]{16}$`)),
        color: COLOR,
      },
    ]);
    expect(new Set(providers.map((p) => p.key)).size).toBe(providers.length);
  });

  it("serves the provider's icon from BookOrbit to every signed-in user", async () => {
    const [listed] = ((await call(reader, 'GET', '/metadata-fetch/providers')).json() as MetadataProviderInfo[]).filter((p) => p.key === KEY);
    const icon = await ctx.app.inject({ method: 'GET', url: listed.iconUrl!, headers: authHeader(reader.accessToken) });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['x-content-type-options']).toBe('nosniff');
    expect(icon.headers['cache-control']).toContain('immutable');
    expect(icon.rawPayload.equals(ICON)).toBe(true);

    expect((await ctx.app.inject({ method: 'GET', url: listed.iconUrl! })).statusCode).toBe(401);
    expect((await call(reader, 'GET', '/metadata-providers/not-registered/icon')).statusCode).toBe(404);
  });

  it('answers manual search and lookup through the ordinary endpoints', async () => {
    const start = fake.calls.length;
    const events = await search(EDITION_TITLE, { author: 'Test Author', isbn: FIXTURE_ISBN, mediaKind: 'ebook', resultsPerProvider: '3' });
    expect(events).toEqual([
      {
        event: 'message',
        data: expect.objectContaining({ provider: KEY, providerId: EDITION_ID, title: EDITION_TITLE, isbn13: FIXTURE_ISBN }),
      },
    ]);
    const request = fake.calls[start];
    expect(request.method).toBe('GET');
    expect(request.url.pathname).toBe('/search');
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      query: EDITION_TITLE,
      author: 'Test Author',
      isbn: FIXTURE_ISBN,
      mediaType: 'book',
      limit: '3',
    });
    const lookup = await call(reader, 'GET', `/metadata-fetch/lookup?provider=${KEY}&id=${encodeURIComponent(EDITION_ID)}&cache=refresh`);
    expect(lookup.statusCode).toBe(200);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'GET', url: { pathname: EDITION_PATH, search: '' } });
    expect(lookup.json()).toMatchObject({
      provider: KEY,
      providerId: EDITION_ID,
      title: EDITION_TITLE,
      authors: ['Test Author'],
      isbn13: FIXTURE_ISBN,
      publishedDate: '2024-03-14',
      pageCount: 287,
      communityRating: 4.2,
      sourceUrl: EDITION_URL,
    });
  });

  it.each([
    ['Fixture timeout', 'timeout'],
    ['Fixture HTTP error', 'failed'],
    ['Fixture malformed body', 'failed'],
    ['Fixture incomplete records', null],
    ['Fixture empty search', null],
  ])('terminates search for %s with the expected SSE status and no metadata writes', async (query, outcome) => {
    const before = await persistedMetadata();
    const closed = fake.timeoutConnectionsClosed;
    const events = await search(query);
    expect(fake.calls.at(-1)?.url.searchParams.get('query')).toBe(query);
    expect(events).toEqual(outcome === null ? [] : [{ event: 'provider-status', data: { provider: KEY, outcome } }]);
    if (outcome === 'timeout') await expect.poll(() => fake.timeoutConnectionsClosed).toBe(closed + 1);
    expect(await persistedMetadata()).toEqual(before);
  });

  it('returns no candidate for an upstream 404 without changing metadata', async () => {
    const before = await persistedMetadata();
    const response = await call(reader, 'GET', `/metadata-fetch/lookup?provider=${KEY}&id=missing-edition&cache=refresh`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
    expect(fake.calls.at(-1)?.url.pathname).toBe('/book/missing-edition');
    expect(await persistedMetadata()).toEqual(before);
  });

  it('accepts the provider in field rules, and a refresh then stores its id, rating and link', async () => {
    const global = (await call(admin, 'GET', '/metadata-preferences/global')).json() as {
      fields: Record<string, { enabled: boolean; providers: string[]; mergeStrategy: string }>;
    };
    const configured = ['title', 'description', 'publisher', 'communityRating'];
    for (const field of configured) {
      global.fields[field] = { ...global.fields[field], enabled: true, providers: [KEY], mergeStrategy: 'overwriteIfProvided' };
    }
    for (const [field, rule] of Object.entries(global.fields)) {
      if (!configured.includes(field)) global.fields[field] = { ...rule, providers: [] };
    }
    const saved = await call(admin, 'PUT', '/metadata-preferences/global', global);
    expect(saved.statusCode).toBe(200);

    const refresh = await call(admin, 'POST', `/books/${bookId}/refresh-metadata`);
    expect(refresh.statusCode).toBe(201);

    const book = await detail();
    expect(book.providerIds[KEY]).toBe('fp-1');
    expect(book.providerLinks?.[KEY]).toBe('https://fake.example/books/fp-1');
    expect(book.description).toBe('A description only the fake provider knows.');
    expect(book.communityRatings).toEqual(expect.arrayContaining([expect.objectContaining({ provider: KEY, rating: 4.2, ratingCount: 321 })]));
  });

  it('refreshes by stored id with a lookup, not a search', async () => {
    fake.calls.length = 0;
    expect((await call(admin, 'POST', `/books/${bookId}/refresh-metadata`)).statusCode).toBe(201);
    expect(fake.calls.map(({ url }) => url.pathname)).toEqual(['/book/fp-1']);
  });

  it('applies a selected edition and preserves a locked title in the editor and on refresh', async () => {
    const lookup = await call(admin, 'GET', `/metadata-fetch/lookup?provider=${KEY}&id=${encodeURIComponent(EDITION_ID)}&cache=refresh`);
    expect(lookup.statusCode).toBe(200);
    const selected = lookup.json<MetadataSearchCandidateEvent>();
    const patch = {
      authors: selected.authors,
      publisher: selected.publisher,
      publishedDate: selected.publishedDate,
      publishedYear: selected.publishedYear,
      pageCount: selected.pageCount,
      isbn13: selected.isbn13,
      externalProviderIds: { [selected.provider]: selected.providerId },
      externalProviderLinks: { [selected.provider]: selected.sourceUrl },
      communityRatings: [{ provider: selected.provider, rating: selected.communityRating, ratingCount: selected.communityRatingCount }],
    };
    expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, { ...patch, title: selected.title })).statusCode).toBe(200);
    expect((await persistedMetadata()).metadata.title).toBe(EDITION_TITLE);
    expect(
      (
        await call(admin, 'PATCH', `/books/${bookId}/metadata-and-locks`, {
          metadata: { title: TITLE, publisher: 'Local publisher before selection' },
          lockedFields: ['title'],
        })
      ).statusCode,
    ).toBe(200);
    const before = await persistedMetadata();
    const blocked = await call(admin, 'PATCH', `/books/${bookId}/metadata`, { ...patch, title: selected.title });
    expect(blocked.statusCode).toBe(409);
    expect(await persistedMetadata()).toEqual(before);

    expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, patch)).statusCode).toBe(200);
    const stored = await persistedMetadata();
    expect(stored.metadata).toMatchObject({
      title: TITLE,
      publisher: 'Selected Editions',
      publishedDate: '2024-03-14',
      publishedYear: 2024,
      pageCount: 287,
      isbn13: FIXTURE_ISBN,
      lockedFields: ['title'],
    });
    expect(stored.authors).toEqual(['Test Author']);
    expect(stored.identifier).toEqual({ provider: KEY, externalId: EDITION_ID, sourceUrl: EDITION_URL });
    expect(stored.rating).toMatchObject({ provider: KEY, rating: expect.closeTo(4.2), ratingCount: 321 });
    expect(await detail()).toMatchObject({ providerIds: { [KEY]: EDITION_ID }, providerLinks: { [KEY]: EDITION_URL } });

    fake.editionPublisher = 'Refreshed Editions';
    fake.calls.length = 0;
    expect((await call(admin, 'POST', `/books/${bookId}/refresh-metadata`)).statusCode).toBe(201);
    expect(fake.calls.map(({ url }) => url.pathname)).toEqual([EDITION_PATH]);
    expect((await persistedMetadata()).metadata).toMatchObject({ title: TITLE, publisher: 'Refreshed Editions', lockedFields: ['title'] });
    expect(await detail()).toMatchObject({ title: TITLE, publisher: 'Refreshed Editions' });
  });

  it('reports a warm cache fallback during a provider outage and preserves stored data on a cold miss', async () => {
    const warm = await persistedMetadata();
    expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, { publisher: 'Local publisher before outage' })).statusCode).toBe(200);
    expect((await persistedMetadata()).metadata.publisher).toBe('Local publisher before outage');
    fake.calls.length = 0;
    fake.unavailable = true;
    try {
      const fallback = await call(admin, 'POST', `/books/${bookId}/refresh-metadata`);
      expect(fallback.statusCode).toBe(201);
      expect(fake.calls.map(({ url }) => url.pathname)).toContain(EDITION_PATH);
      expect(fallback.json()).toMatchObject({
        publisher: 'Refreshed Editions',
        metadataCache: { fallbackProviders: expect.arrayContaining([expect.objectContaining({ provider: KEY, source: 'fallback' })]) },
      });
      expect(await persistedMetadata()).toEqual(warm);

      // Remove only this fixture provider's cache rows to distinguish a cold outage from a cache hit.
      await ctx.db.delete(schema.providerMetadataCache).where(eq(schema.providerMetadataCache.provider, KEY));
      expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, { publisher: 'Local publisher on cold miss' })).statusCode).toBe(200);
      const before = await persistedMetadata();
      fake.calls.length = 0;
      const cold = await call(admin, 'POST', `/books/${bookId}/refresh-metadata`);
      expect(cold.statusCode).toBe(201);
      expect(fake.calls.map(({ url }) => url.pathname)).toContain(EDITION_PATH);
      expect(cold.json()).not.toHaveProperty('metadataCache');
      expect(await persistedMetadata()).toEqual(before);
    } finally {
      fake.unavailable = false;
    }
  });

  it('keeps the rating through other edits and through a client re-sending it, as released iOS builds do', async () => {
    expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, { publisher: 'Edited House' })).statusCode).toBe(200);
    const resent = await call(admin, 'PATCH', `/books/${bookId}/metadata`, {
      communityRatings: [{ provider: KEY, rating: 4.2, ratingCount: 321 }],
    });
    expect(resent.statusCode).toBe(200);
    expect((await detail()).communityRatings).toEqual(expect.arrayContaining([expect.objectContaining({ provider: KEY })]));
  });

  it('edits external ids through the metadata PATCH, for registered providers only', async () => {
    const edited = await call(admin, 'PATCH', `/books/${bookId}/metadata`, { externalProviderIds: { [KEY]: 'fp-2' } });
    expect(edited.statusCode).toBe(200);
    expect((await detail()).providerIds[KEY]).toBe('fp-2');

    const unknown = await call(admin, 'PATCH', `/books/${bookId}/metadata`, { externalProviderIds: { 'not-registered': 'x' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ errorCode: 'METADATA_PROVIDER_UNKNOWN' });

    const builtIn = await call(admin, 'PATCH', `/books/${bookId}/metadata`, { externalProviderIds: { goodreads: '1' } });
    expect(builtIn.statusCode).toBe(400);

    expect((await call(admin, 'PATCH', `/books/${bookId}/metadata`, { externalProviderIds: { 'not-registered': null } })).statusCode).toBe(200);
  });

  it('drops a disabled provider from searches but keeps what it stored', async () => {
    expect((await call(admin, 'PATCH', `/metadata-http-providers/${providerId}`, { enabled: false })).statusCode).toBe(200);
    const providers = (await call(reader, 'GET', '/metadata-fetch/providers')).json() as MetadataProviderInfo[];
    expect(providers.map((p) => p.key)).not.toContain(KEY);
    expect((await call(reader, 'GET', `/metadata-fetch/lookup?provider=${KEY}&id=fp-1`)).json()).toBeNull();
    expect((await detail()).providerIds[KEY]).toBe('fp-2');
  });

  it('purges its ids and ratings only when asked', async () => {
    expect((await call(admin, 'DELETE', `/metadata-http-providers/${providerId}?purge=true`)).statusCode).toBe(200);
    const ids = await ctx.db.select().from(schema.bookProviderIds).where(eq(schema.bookProviderIds.provider, KEY));
    const ratings = await ctx.db
      .select()
      .from(schema.bookCommunityRatings)
      .where(and(eq(schema.bookCommunityRatings.bookId, bookId), eq(schema.bookCommunityRatings.provider, KEY)));
    expect(ids).toEqual([]);
    expect(ratings).toEqual([]);
    expect((await call(admin, 'GET', '/metadata-http-providers')).json()).toEqual([]);
    expect((await call(reader, 'GET', `/metadata-providers/${KEY}/icon`)).statusCode).toBe(404);
  });
});
