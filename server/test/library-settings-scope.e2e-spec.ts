import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { appSettings, books } from '../src/db/schema';
import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  type AuthorizationMatrixE2EContext,
} from './e2e/authorization-matrix/authorization-matrix-harness';

describe('Library settings scope', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let provider: Server;
  let root: string;
  const previous = { personal: process.env.PERSONAL_LIBRARY_ROOT, browse: process.env.LIBRARY_BROWSE_ROOT };
  const credentials: string[] = [];
  const instanceKey = 'synthetic-google-administrator';
  const personalKey = 'synthetic-google-personal';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'library-settings-'));
    process.env.PERSONAL_LIBRARY_ROOT = root;
    process.env.LIBRARY_BROWSE_ROOT = root;
    ctx = await createAuthorizationMatrixE2EContext();
    provider = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      credentials.push(url.searchParams.get('key') ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture-volume', volumeInfo: { title: 'Fixture volume' } }));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    const actualFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname.endsWith('googleapis.com')) {
        return actualFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
      }
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
        return Promise.reject(new Error('External requests disabled in this fixture'));
      return actualFetch(input, init);
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (provider) await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
    if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    if (root) await rm(root, { recursive: true, force: true });
    if (previous.personal === undefined) delete process.env.PERSONAL_LIBRARY_ROOT;
    else process.env.PERSONAL_LIBRARY_ROOT = previous.personal;
    if (previous.browse === undefined) delete process.env.LIBRARY_BROWSE_ROOT;
    else process.env.LIBRARY_BROWSE_ROOT = previous.browse;
  });

  it('keeps instance settings deliberate and selects credentials by the stable library owner', async () => {
    const owner = await createUserAndLogin(ctx);
    const collaborator = await createUserAndLogin(ctx);
    const other = await createUserAndLogin(ctx);
    async function request(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, status: number, payload?: object) {
      const response = await ctx.app.inject({ method, url: '/api/v1' + url, headers: authHeader(token), ...(payload ? { payload } : {}) });
      expect(response.statusCode, method + ' ' + url).toBe(status);
      expect(response.body).not.toContain(instanceKey);
      expect(response.body).not.toContain(personalKey);
      return response;
    }
    const admin = ctx.adminToken;
    const settings = '/metadata-preferences/providers';
    const defaults = '/metadata-preferences/global';
    const naming = '/app-settings/library-naming/upload-pattern';
    const adminScope = '?scope=admin';
    await request(owner.accessToken, 'PUT', settings + adminScope, 403, { google: { apiKey: personalKey } });
    await request(admin, 'PUT', settings + adminScope, 204, { google: { apiKey: instanceKey, enabled: true } });
    const inherited = (await request(owner.accessToken, 'GET', settings, 200)).json();
    expect(inherited.config.google.apiKey).toBe('');
    expect(inherited.statuses.find((status: { key: string }) => status.key === 'google').credentialSource).toBe('administrator');
    expect(
      (await request(admin, 'GET', settings, 200)).json().statuses.find((status: { key: string }) => status.key === 'google').credentialSource,
    ).toBe('administrator');
    const initialAdminRules = (await request(admin, 'GET', defaults + adminScope, 200)).json();
    const ownerRules = structuredClone(initialAdminRules);
    ownerRules.fields.title.enabled = !initialAdminRules.fields.title.enabled;
    await request(owner.accessToken, 'PUT', defaults, 200, ownerRules);
    expect((await request(other.accessToken, 'GET', defaults, 200)).json().fields.title.enabled).toBe(initialAdminRules.fields.title.enabled);
    await request(owner.accessToken, 'PUT', naming, 200, { pattern: '{title}' });
    expect((await request(owner.accessToken, 'GET', naming, 200)).json().pattern).toBe('{title}');
    expect((await request(other.accessToken, 'GET', naming, 200)).json().pattern).not.toBe('{title}');
    await request(owner.accessToken, 'PUT', naming + adminScope, 403, { pattern: '{authors}' });

    const created = (
      await request(owner.accessToken, 'POST', '/libraries/personal', 201, {
        name: 'Fixture Settings Library',
        icon: 'BookOpen',
        organizationMode: 'book_per_file',
      })
    ).json();
    await grantLibraryAccess(ctx, collaborator.userId, created.id, 'owner');
    await request(other.accessToken, 'GET', '/libraries/settings-inventory' + adminScope, 403);
    await request(admin, 'GET', '/libraries/settings-inventory', 403);
    const inventory = (await request(admin, 'GET', '/libraries/settings-inventory' + adminScope, 200)).json();
    expect(inventory.find((entry: { id: number }) => entry.id === created.id).owners).toEqual([collaborator.username, owner.username].sort());
    await request(admin, 'GET', `/libraries/${created.id}`, 403);
    await request(admin, 'GET', `/libraries/${created.id}/settings` + adminScope, 200);
    const inheritedNaming = `/app-settings/library-naming/libraries/${created.id}/upload-pattern`;
    expect((await request(collaborator.accessToken, 'GET', inheritedNaming, 200)).json()).toEqual({
      pattern: '{title}',
      followsSelectedDefaults: false,
    });
    await request(other.accessToken, 'GET', inheritedNaming, 403);
    const libraryRules = '/metadata-preferences/libraries/' + created.id;
    expect((await request(collaborator.accessToken, 'GET', libraryRules, 200)).json().effective.fields.title.enabled).toBe(
      ownerRules.fields.title.enabled,
    );
    await request(other.accessToken, 'GET', libraryRules, 403);
    await request(collaborator.accessToken, 'PUT', libraryRules, 200, { overrides: { title: initialAdminRules.fields.title } });
    expect((await request(owner.accessToken, 'GET', libraryRules, 200)).json().effective.fields.title.enabled).toBe(
      initialAdminRules.fields.title.enabled,
    );

    await request(owner.accessToken, 'PUT', settings, 204, { google: { apiKey: personalKey } });
    const saved = (await request(owner.accessToken, 'GET', settings, 200)).json();
    expect(saved.statuses.find((status: { key: string }) => status.key === 'google').credentialSource).toBe('personal');
    const [row] = await ctx.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, `library_personal_${owner.userId}_provider_config`));
    expect(row.value).toContain('encrypted:');
    expect(row.value).not.toContain(personalKey);
    const publicSettings = (await request(admin, 'GET', '/app-settings', 200)).json();
    expect(publicSettings.some((item: { key: string }) => item.key.startsWith('library_personal_') || item.key === 'metadata_provider_config')).toBe(
      false,
    );
    const folder = created.folders[0];
    const [book] = await ctx.db
      .insert(books)
      .values({ libraryId: created.id, libraryFolderId: folder.id, folderPath: folder.path, status: 'present' })
      .returning({ id: books.id });

    const autoFetch = '/book-metadata-fetch/config/libraries';
    const autos = (await request(owner.accessToken, 'GET', autoFetch, 200)).json();
    expect(autos.map((entry: { libraryId: number }) => entry.libraryId)).toEqual([created.id]);
    expect((await request(other.accessToken, 'GET', autoFetch, 200)).json()).toEqual([]);
    await request(other.accessToken, 'PUT', autoFetch + '/' + created.id, 403, { triggerOnImport: true });
    const savedAutoFetch = (await request(owner.accessToken, 'PUT', autoFetch + '/' + created.id, 200, { triggerOnImport: true })).json();
    expect(savedAutoFetch.override.triggerOnImport).toBe(true);
    await request(admin, 'PATCH', '/app-settings/metadata_fetch_preferences', 400, { value: '{}' });
    await request(other.accessToken, 'POST', `/scanner/libraries/${created.id}/scan`, 403);
    await request(owner.accessToken, 'POST', `/scanner/libraries/${created.id}/scan`, 202);

    const lookup = '/metadata-fetch/lookup?provider=google&id=fixture-volume&cache=refresh';
    expect((await request(other.accessToken, 'GET', lookup, 200)).json().title).toBe('Fixture volume');
    expect(credentials.at(-1)).toBe(instanceKey);
    const scopedLookup = lookup + '&bookId=' + book.id;
    expect((await request(collaborator.accessToken, 'GET', scopedLookup, 200)).json().title).toBe('Fixture volume');
    expect(credentials.at(-1)).toBe(personalKey);
    await request(other.accessToken, 'GET', scopedLookup, 403);
    await request(owner.accessToken, 'PUT', settings, 204, { google: { apiKey: '' } });
    const authoritativeLookup = scopedLookup.replace('&cache=refresh', '');
    expect((await request(collaborator.accessToken, 'GET', authoritativeLookup, 200)).json().title).toBe('Fixture volume');
    expect(credentials.at(-1)).toBe(instanceKey);
  }, 45_000);
});
