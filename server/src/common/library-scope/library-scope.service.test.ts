import { ForbiddenException } from '@nestjs/common';
import type { AccessLevel } from '@bookorbit/types';

import type { ApiKeyCredential } from '../types/request-user';
import { LibraryScopeService, type LibraryScopeSubject } from './library-scope.service';

function makeService() {
  const grants = new Map<number, AccessLevel>([
    [1, 'viewer'],
    [2, 'editor'],
  ]);
  const repo = {
    findAllIds: vi.fn(),
    findGrantedLevels: vi.fn((_userId: number, levels?: readonly AccessLevel[]) =>
      Promise.resolve([...grants].filter(([, level]) => !levels || levels.includes(level)).map(([id, accessLevel]) => ({ id, accessLevel }))),
    ),
    findGrantedLevel: vi.fn((_userId: number, libraryId: number) => Promise.resolve(grants.get(libraryId) ?? null)),
  };
  return { service: new LibraryScopeService(repo as never), repo, grants };
}

function key(overrides: Partial<ApiKeyCredential> = {}): ApiKeyCredential {
  return { kind: 'api_key', keyId: 9, keyName: 'script', audience: 'api', access: 'write', libraryIds: null, ownerIsSuperuser: true, ...overrides };
}

const principals: LibraryScopeSubject[] = [
  { id: 5, isSuperuser: false },
  { id: 1, isSuperuser: true },
  { id: 5, isSuperuser: false, credential: key({ ownerIsSuperuser: false }) },
  { id: 1, isSuperuser: false, credential: key() },
  { id: 1, isSuperuser: true, credential: key() },
];

describe('LibraryScopeService', () => {
  it.each(principals)('requires explicit grants for principal %j', async (user) => {
    const { service, repo } = makeService();
    expect(await service.visibleIds(user)).toEqual([1, 2]);
    expect(await service.visibleIdsOrAll(user)).toEqual([1, 2]);
    expect(await service.editableIds(user)).toEqual([2]);
    expect(await service.levelFor(user, 3)).toBeNull();
    await expect(service.assertVisible(user, 3)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.assertLevel(user, 1, 'editor')).rejects.toThrow('Insufficient library access level');
    await expect(service.assertLevel(user, 2, 'editor')).resolves.toBeUndefined();
    expect(repo.findAllIds).not.toHaveBeenCalled();
  });

  it.each(principals)('respects new grants and revocation without refreshing the principal %j', async (user) => {
    const { service, grants } = makeService();
    grants.set(3, 'owner');
    expect(await service.levelFor(user, 3)).toBe('owner');
    expect(await service.visibleLevels(user)).toContainEqual({ id: 3, accessLevel: 'owner' });
    grants.delete(3);
    expect(await service.levelFor(user, 3)).toBeNull();
    expect(await service.visibleIds(user)).not.toContain(3);
    expect(await service.filterVisible(user, [3, 2, 1])).toEqual([2, 1]);
  });

  it('intersects a key whitelist with current owner grants instead of treating the whitelist as grants', async () => {
    const { service, grants } = makeService();
    const user = { id: 1, isSuperuser: true, credential: key({ libraryIds: [2, 3] }) };
    expect(await service.visibleIds(user)).toEqual([2]);
    expect(await service.levelFor(user, 1)).toBeNull();
    expect(await service.levelFor(user, 3)).toBeNull();
    grants.delete(2);
    expect(await service.visibleIds(user)).toEqual([]);
    expect(await service.visibleLevels(user)).toEqual([]);
  });

  it('sees nothing for an empty key scope', async () => {
    const { service } = makeService();
    const user = { id: 1, isSuperuser: true, credential: key({ libraryIds: [] }) };
    expect(await service.visibleIdsOrAll(user)).toEqual([]);
    expect(await service.canSee(user, 1)).toBe(false);
  });

  it('caps read-only keys at viewer even for an explicitly granted superuser owner', async () => {
    const { service, grants } = makeService();
    grants.set(3, 'owner');
    const user = { id: 1, isSuperuser: true, credential: key({ access: 'read' }) };
    expect(await service.levelFor(user, 3)).toBe('viewer');
    expect(await service.editableIds(user)).toEqual([]);
    await expect(service.assertLevel(user, 3, 'editor')).rejects.toThrow('Insufficient library access level');
    expect(await service.visibleLevels(user)).toEqual([1, 2, 3].map((id) => ({ id, accessLevel: 'viewer' })));
  });

  it('uses explicit grants in user-id-only device protocol calls, including system libraries', async () => {
    const { service, repo, grants } = makeService();
    expect(await service.visibleIdsOrAllForUserId(1)).toEqual([1, 2]);
    grants.clear();
    expect(await service.visibleIdsOrAllForUserId(1)).toEqual([]);
    grants.set(9, 'viewer');
    expect(await service.visibleIdsOrAllForUserId(1)).toEqual([9]);
    expect(repo.findAllIds).not.toHaveBeenCalled();
  });
});
