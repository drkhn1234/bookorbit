import { vi } from 'vitest';
import type { PathRequest } from '../../src/modules/path/path-policy.service';
import type { LibraryFolderRow } from '../../src/modules/path/path.repository';

export const TEST_ADMIN_REQUEST = {
  user: { id: 1, username: 'operator', isSuperuser: true, active: true, permissions: [] },
  scope: 'admin',
} as PathRequest;

/** Retain the existing walk/error fixtures as explicit admin requests; real policy tests use real files. */
export function attachPathContext(policy: object, root: () => string, rows: () => Promise<LibraryFolderRow[]> = () => Promise.resolve([])): void {
  const resolver = policy as { resolveBrowsePath: (path?: string) => Promise<string>; assertWithinBrowseRoot?: (path: string) => Promise<string> };
  Object.assign(policy, {
    access: vi.fn(async () => ({
      request: TEST_ADMIN_REQUEST,
      root: root(),
      deniedRoots: [],
      libraries: await rows(),
      cacheKey: 'legacy-admin-fixture',
    })),
    resolveScopedPath: vi.fn(async (path?: string) => {
      const resolved = await resolver.resolveBrowsePath(path);
      return resolver.assertWithinBrowseRoot ? resolver.assertWithinBrowseRoot(resolved) : resolved;
    }),
    canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
    canVisit: vi.fn(() => Promise.resolve(true)),
    isVisiblePath: vi.fn(() => true),
    assertWritable: vi.fn(() => Promise.resolve()),
    assertLibraryDirectory: vi.fn(),
  });
}
