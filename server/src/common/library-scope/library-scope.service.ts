import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LIBRARY_OWNER_PERMISSIONS, Permission, type AccessLevel } from '@bookorbit/types';
import type { ScopedPermission } from '../decorators/require-scoped-permission.decorator';

import { apiKeyCredentialOf, type RequestUser } from '../types/request-user';
import { LibraryScopeRepository } from './library-scope.repository';

/** The fields library visibility depends on. A full `RequestUser` always satisfies it. */
export type LibraryScopeSubject = Pick<RequestUser, 'id' | 'isSuperuser'> & Partial<Pick<RequestUser, 'credential'>>;

const ACCESS_RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };
const EDITOR_LEVELS: readonly AccessLevel[] = ['editor', 'owner'];
export function meetsAccessLevel(level: AccessLevel | null, required: AccessLevel): boolean {
  return level !== null && ACCESS_RANK[level] >= ACCESS_RANK[required];
}

export function hasLibraryAdministratorIntent(user: RequestUser, scope?: unknown): boolean {
  return scope === 'admin' && user.isSuperuser && !apiKeyCredentialOf(user) && !user.permissions.includes(Permission.DemoRestricted);
}

/**
 * Which libraries the requesting principal may see or change, and at what level.
 *
 * Administrator authority does not grant content access. Every account needs a current library
 * grant, and an API key can only narrow it. Query grants on each call so revocation is immediate.
 */
@Injectable()
export class LibraryScopeService {
  constructor(private readonly repo: LibraryScopeRepository) {}

  /** Visible library ids in display order. */
  async visibleIds(user: LibraryScopeSubject): Promise<number[]> {
    return this.limitedIds(user);
  }

  /** Keep the nullable query contract; ordinary principals always have an explicit scope. */
  async visibleIdsOrAll(user: LibraryScopeSubject): Promise<number[] | null> {
    return this.limitedIds(user);
  }

  /**
   * The same answer for a caller that only holds a user id: device protocols (Kobo, the KOReader
   * sync and plugin endpoints) authenticate with their own credentials and act as the whole account.
   */
  async visibleIdsOrAllForUserId(userId: number): Promise<number[] | null> {
    return this.visibleIdsOrAll({ id: userId, isSuperuser: false });
  }

  /** Library ids the principal may edit, in display order. */
  async editableIds(user: LibraryScopeSubject): Promise<number[]> {
    const credential = apiKeyCredentialOf(user);
    if (credential?.access === 'read') return [];
    return this.limitedIds(user, EDITOR_LEVELS);
  }

  /** The principal's level in one library, or null when it cannot see it. */
  async levelFor(user: LibraryScopeSubject, libraryId: number): Promise<AccessLevel | null> {
    const credential = apiKeyCredentialOf(user);
    if (credential?.libraryIds && !credential.libraryIds.includes(libraryId)) return null;
    const level = await this.repo.findGrantedLevel(user.id, libraryId);
    return this.capped(level, credential?.access);
  }

  async canSee(user: LibraryScopeSubject, libraryId: number): Promise<boolean> {
    return (await this.levelFor(user, libraryId)) !== null;
  }

  async assertVisible(user: LibraryScopeSubject, libraryId: number): Promise<void> {
    if (!(await this.canSee(user, libraryId))) throw new ForbiddenException('No access to this library');
  }

  async assertLevel(user: LibraryScopeSubject, libraryId: number, required: AccessLevel): Promise<void> {
    const level = await this.levelFor(user, libraryId);
    if (level === null) throw new ForbiddenException('No access to this library');
    if (!meetsAccessLevel(level, required)) throw new ForbiddenException('Insufficient library access level');
  }

  hasPermissionAtLevel(user: RequestUser, level: AccessLevel | null, permission: Permission): boolean {
    if (!meetsAccessLevel(level, 'editor')) return false;
    return (
      user.permissions.includes(permission) ||
      (level === 'owner' &&
        LIBRARY_OWNER_PERMISSIONS.has(permission) &&
        !apiKeyCredentialOf(user) &&
        !user.permissions.includes(Permission.DemoRestricted))
    );
  }

  async hasPermission(user: RequestUser, libraryId: number, permission: Permission): Promise<boolean> {
    const credential = apiKeyCredentialOf(user);
    if (credential?.access === 'read' && permission === Permission.LibraryDownload) {
      // A read key can still download with its explicit scope and its owner's actual grant.
      if (credential.libraryIds && !credential.libraryIds.includes(libraryId)) return false;
      return meetsAccessLevel(await this.repo.findGrantedLevel(user.id, libraryId), 'editor') && user.permissions.includes(permission);
    }
    return this.hasPermissionAtLevel(user, await this.levelFor(user, libraryId), permission);
  }

  async permittedIds(user: RequestUser, permission: Permission): Promise<number[]> {
    const rows = await this.visibleLevels(user);
    return rows.filter(({ accessLevel }) => this.hasPermissionAtLevel(user, accessLevel, permission)).map(({ id }) => id);
  }

  async assertPermission(user: RequestUser, libraryId: number, permission: Permission, scope?: unknown): Promise<void> {
    if (hasLibraryAdministratorIntent(user, scope)) return;
    if (!(await this.hasPermission(user, libraryId, permission))) throw new ForbiddenException(`Insufficient library access for ${permission}`);
  }

  async assertResourcePermission(user: RequestUser, resource: ScopedPermission['resource'], id: number, permission: Permission, scope?: unknown) {
    const libraryId = resource === 'library' ? id : await this.repo.findResourceLibrary(resource, id);
    if (libraryId === null || (resource !== 'library' && !(await this.canSee(user, libraryId)))) throw new NotFoundException('Resource not found');
    await this.assertPermission(user, libraryId, permission, resource === 'library' ? scope : undefined);
  }

  /** The given ids the principal can see, keeping their order. */
  async filterVisible(user: LibraryScopeSubject, libraryIds: readonly number[]): Promise<number[]> {
    if (libraryIds.length === 0) return [];
    const visible = await this.visibleIdsOrAll(user);
    if (visible === null) return [...libraryIds];
    const allowed = new Set(visible);
    return libraryIds.filter((id) => allowed.has(id));
  }

  /** Every visible library with the principal's level in it, in display order. */
  async visibleLevels(user: LibraryScopeSubject): Promise<{ id: number; accessLevel: AccessLevel }[]> {
    const credential = apiKeyCredentialOf(user);
    let rows = await this.repo.findGrantedLevels(user.id);
    if (credential?.libraryIds) {
      const allowed = new Set(credential.libraryIds);
      rows = rows.filter(({ id }) => allowed.has(id));
    }
    return rows.map(({ id, accessLevel }) => ({ id, accessLevel: this.capped(accessLevel, credential?.access)! }));
  }

  private async limitedIds(user: LibraryScopeSubject, levels?: readonly AccessLevel[]): Promise<number[]> {
    const credential = apiKeyCredentialOf(user);
    const rows = await this.repo.findGrantedLevels(user.id, levels);
    const ids = rows.map(({ id }) => id);
    if (!credential?.libraryIds) return ids;
    const allowed = new Set(credential.libraryIds);
    return ids.filter((id) => allowed.has(id));
  }

  /** A read-only key never acts above viewer, whatever its owner holds. */
  private capped(level: AccessLevel | null, access: 'read' | 'write' | undefined): AccessLevel | null {
    if (level === null || access !== 'read') return level;
    return 'viewer';
  }
}
