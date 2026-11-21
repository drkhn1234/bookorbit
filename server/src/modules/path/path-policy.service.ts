import type { ConfigType } from '@nestjs/config';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { apiKeyCredentialOf, principalCacheKey } from '../../common/types/request-user';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { isBlockedPath, isBlockedTarget, isInsideOrAt } from './folder-walk';
import { PathRepository, type LibraryFolderRow } from './path.repository';
import {
  assertDirectoryAncestors,
  personalDirectoryIdentity,
  personalDirectoryName,
  provisionPersonalDirectory,
  waitForPersonalDirectory,
} from './personal-directory';

import { storageConfig } from '../../config/config';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

const MAX_BROWSE_PATH_LENGTH = 4096;

export type PathScope = 'personal' | 'admin';
export interface PathRequest {
  user: RequestUser;
  scope?: PathScope;
}
export interface PathAccess {
  request: PathRequest;
  root: string;
  deniedRoots: string[];
  libraries: LibraryFolderRow[];
  cacheKey: string;
}

@Injectable()
export class PathPolicyService {
  private readonly logger = new Logger(PathPolicyService.name);
  private readonly browseRoot: string;
  private readonly appDataPath: string | null;
  private canonicalBrowseRootPromise: Promise<string> | null = null;
  private canonicalAppDataPathPromise: Promise<string | null> | null = null;
  private readonly personalRoot: string;
  private readonly bookDockPath: string | null;

  constructor(
    @Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>,
    private readonly paths: PathRepository,
    private readonly libraries: LibraryScopeService,
  ) {
    this.browseRoot = resolve(storage.libraryBrowseRoot);
    this.appDataPath = storage.appDataPath ? resolve(storage.appDataPath) : null;
    this.personalRoot = resolve(storage.personalLibraryRoot || '/books');
    this.bookDockPath = storage.bookDockPath ? resolve(storage.bookDockPath) : null;
  }

  async access(request: PathRequest, provision = false): Promise<PathAccess> {
    this.assertEligible(request, provision);
    const admin = request.scope === 'admin';
    const root = admin ? this.browseRoot : join(this.personalRoot, personalDirectoryName(request.user.username));
    if (isBlockedPath(root)) throw new ForbiddenException('This storage location is blocked');
    await this.assertWithinBrowseRoot(root);
    await assertDirectoryAncestors(root);
    if (await isBlockedTarget(root)) throw new ForbiddenException('This storage location is blocked');
    const rows = await this.paths.findLibraryFolders();
    const visible = new Set(await this.libraries.visibleIds(request.user));
    const deniedRoots: string[] = [];
    if (!admin) {
      for (const path of [this.appDataPath, this.bookDockPath]) if (path) deniedRoots.push(await canonicalizeWithExistingAncestor(path));
    }
    for (const row of rows) if (!visible.has(row.libraryId)) deniedRoots.push(await canonicalizeWithExistingAncestor(resolve(row.path)));
    if (!admin) {
      if (deniedRoots.some((path) => isInsideOrAt(root, path)))
        throw new ForbiddenException('Personal storage overlaps an inaccessible or system-managed directory');
    }
    let identity = 'admin';
    if (!admin) {
      if (provision) {
        await this.assertNoRegisteredParent(root, rows);
        const startedAt = Date.now();
        this.logger.log(`[path.provision_personal_root] [start] userId=${request.user.id} - personal storage provisioning started`);
        try {
          identity = await provisionPersonalDirectory(this.personalRoot, root, request.user.id);
          this.logger.log(
            `[path.provision_personal_root] [end] userId=${request.user.id} durationMs=${Date.now() - startedAt} - personal storage ready`,
          );
        } catch (error) {
          this.logger.warn(
            `[path.provision_personal_root] [fail] userId=${request.user.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - personal storage provisioning failed`,
          );
          throw error;
        }
      } else {
        await waitForPersonalDirectory(root);
        identity = await personalDirectoryIdentity(root, request.user.id);
      }
    }
    const allowedRows = rows.filter((row) => visible.has(row.libraryId) && isInsideOrAt(resolve(row.path), root));
    const cacheKey = principalCacheKey(
      request.user,
      JSON.stringify({
        userId: request.user.id,
        root,
        scope: request.scope ?? 'personal',
        identity,
        deniedRoots: [...deniedRoots].sort(),
        folders: rows.map((row) => [row.libraryId, row.path]).sort(),
      }),
    );
    return { request, root, deniedRoots, libraries: allowedRows, cacheKey };
  }

  async resolveScopedPath(rawPath: string | undefined, access: PathAccess): Promise<string> {
    const input = rawPath ?? '';
    if (input.length > MAX_BROWSE_PATH_LENGTH || input.includes('\0') || input.includes('\\') || input.split('/').includes('..'))
      throw new BadRequestException('Invalid storage path');
    const path = isAbsolute(input) ? resolve(input) : resolve(access.root, input || '.');
    if (!isInsideOrAt(path, access.root)) throw new ForbiddenException('Path is outside your authorized storage root');
    if (isBlockedPath(path)) throw new ForbiddenException('This storage location is blocked');
    if (access.deniedRoots.some((root) => isInsideOrAt(path, root))) throw new ForbiddenException('No access to this storage directory');
    await this.assertWithinBrowseRoot(path);
    await assertDirectoryAncestors(path);
    if (await isBlockedTarget(path)) throw new ForbiddenException('This storage location is blocked');
    return path;
  }

  isVisiblePath(access: PathAccess, path: string): boolean {
    return isInsideOrAt(path, access.root) && !isBlockedPath(path) && !access.deniedRoots.some((root) => isInsideOrAt(path, root));
  }

  async canVisit(access: PathAccess, path: string): Promise<boolean> {
    try {
      await this.resolveScopedPath(path, access);
      return true;
    } catch {
      return false;
    }
  }

  async assertWritable(access: PathAccess, path: string): Promise<void> {
    this.assertEligible(access.request, true);
    for (const folder of access.libraries) {
      if (isInsideOrAt(path, resolve(folder.path))) await this.libraries.assertLevel(access.request.user, folder.libraryId, 'editor');
    }
  }

  assertLibraryDirectory(path: string): void {
    if (isInsideOrAt(this.personalRoot, path) || dirname(path) === this.personalRoot) {
      throw new ForbiddenException('Personal storage namespace parents cannot be registered as library folders');
    }
  }

  async adoptPersonalRoot(actor: RequestUser, userId: number): Promise<string> {
    this.assertEligible({ user: actor, scope: 'admin' }, true);
    const target = await this.paths.findUserIdentity(userId);
    if (!target) throw new BadRequestException('User not found');
    const root = join(this.personalRoot, personalDirectoryName(target.username));
    if (isBlockedPath(root)) throw new ForbiddenException('This storage location is blocked');
    await this.assertWithinBrowseRoot(root);
    await assertDirectoryAncestors(root);
    if (await isBlockedTarget(root)) throw new ForbiddenException('This storage location is blocked');
    await this.assertNoRegisteredParent(root, await this.paths.findLibraryFolders());
    for (const path of [this.appDataPath, this.bookDockPath])
      if (path && isInsideOrAt(root, await canonicalizeWithExistingAncestor(path)))
        throw new ForbiddenException('Cannot adopt system-managed storage');
    const identity = await provisionPersonalDirectory(this.personalRoot, root, userId, true);
    if (identity === 'missing') throw new BadRequestException('The directory to adopt does not exist');
    return root;
  }

  /** Validate creation policy without invoking lazy filesystem provisioning. */
  async assertCreationAccess(request: PathRequest): Promise<void> {
    this.assertEligible(request, true);
    const access = await this.access(request);
    if (request.scope !== 'admin') await this.assertNoRegisteredParent(access.root, await this.paths.findLibraryFolders());
  }

  async allocateLibraryDirectory(user: RequestUser): Promise<string> {
    const access = await this.access({ user }, true);
    const path = await this.resolveScopedPath(join(access.root, `library-${randomUUID()}`), access);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw new ForbiddenException('Could not allocate a library directory');
    }
    return path;
  }

  private assertEligible(request: PathRequest, write: boolean): void {
    const user = request?.user;
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.active === false || user.permissions.includes(Permission.DemoRestricted))
      throw new ForbiddenException('Personal storage is unavailable for this account');
    const key = apiKeyCredentialOf(user);
    if (key?.libraryIds !== null && key?.libraryIds !== undefined)
      throw new ForbiddenException('Library-scoped API keys cannot browse or manage storage directories');
    if (write && key?.access === 'read') throw new ForbiddenException('Read-only API keys cannot change storage');
    if (request.scope === 'admin' && !user.isSuperuser) throw new ForbiddenException('Administrator filesystem scope requires a superuser');
  }

  private async assertNoRegisteredParent(root: string, rows: LibraryFolderRow[]): Promise<void> {
    for (const row of rows) {
      if (isInsideOrAt(root, await canonicalizeWithExistingAncestor(resolve(row.path))))
        throw new ForbiddenException('Personal storage overlaps an existing library. An administrator must resolve the storage layout.');
    }
  }

  getBrowseRoot(): string {
    return this.browseRoot;
  }

  canonicalPath(path: string): Promise<string> {
    return canonicalizeWithExistingAncestor(resolve(path));
  }

  getAppDataPath(): string | null {
    return this.appDataPath;
  }

  /** The data folder with symlinks resolved, so it matches paths read from the disk. */
  getCanonicalAppDataPath(): Promise<string | null> {
    if (!this.appDataPath) return Promise.resolve(null);
    this.canonicalAppDataPathPromise ??= realpath(this.appDataPath).catch(() => this.appDataPath);
    return this.canonicalAppDataPathPromise;
  }

  async resolveBrowsePath(rawPath?: string | null): Promise<string> {
    const inputPath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (inputPath.length > MAX_BROWSE_PATH_LENGTH) throw new BadRequestException('Path is too long');

    const path = resolve(inputPath || this.browseRoot);
    await this.assertWithinBrowseRoot(path);
    return path;
  }

  async assertWithinBrowseRoot(rawPath: string): Promise<string> {
    const path = resolve(rawPath);
    if (!(await this.isWithinBrowseRoot(path))) {
      throw new ForbiddenException('Path is outside the configured library browse root');
    }
    return path;
  }

  async isWithinBrowseRoot(rawPath: string): Promise<boolean> {
    if (typeof rawPath !== 'string' || rawPath.length > MAX_BROWSE_PATH_LENGTH) return false;

    return this.isWithinRoot(rawPath, this.browseRoot, await this.getCanonicalBrowseRoot());
  }

  async assertWithinRoot(rawPath: string, rawRoot: string): Promise<string> {
    const root = resolve(rawRoot);
    const canonicalRoot = await canonicalizeWithExistingAncestor(root);
    if (!(await this.isWithinRoot(rawPath, root, canonicalRoot))) {
      throw new ForbiddenException('Resolved path is outside the authorized root');
    }
    return resolve(rawPath);
  }

  private async isWithinRoot(rawPath: string, rootPath: string, canonicalRoot: string): Promise<boolean> {
    if (typeof rawPath !== 'string' || rawPath.length > MAX_BROWSE_PATH_LENGTH) return false;

    const resolvedPath = resolve(rawPath);
    const lexicalRelativePath = relative(rootPath, resolvedPath);
    if (lexicalRelativePath === '..' || lexicalRelativePath.startsWith(`..${sep}`) || isAbsolute(lexicalRelativePath)) return false;

    const suffixSegments: string[] = [];
    let current = resolvedPath;
    let canonicalPath: string;

    while (true) {
      try {
        const canonicalAncestor = await realpath(current);
        canonicalPath = suffixSegments.reduceRight((built, segment) => join(built, segment), canonicalAncestor);
        break;
      } catch (error) {
        const code = getErrorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      }

      const parent = dirname(current);
      if (parent === current) return false;

      suffixSegments.push(basename(current));
      current = parent;
    }

    const canonicalRelativePath = relative(canonicalRoot, canonicalPath);
    return (
      canonicalRelativePath === '' ||
      (!canonicalRelativePath.startsWith(`..${sep}`) && canonicalRelativePath !== '..' && !isAbsolute(canonicalRelativePath))
    );
  }

  private getCanonicalBrowseRoot(): Promise<string> {
    this.canonicalBrowseRootPromise ??= canonicalizeWithExistingAncestor(this.browseRoot);
    return this.canonicalBrowseRootPromise;
  }
}

async function canonicalizeWithExistingAncestor(resolvedPath: string): Promise<string> {
  const suffixSegments: string[] = [];
  let current = resolvedPath;

  while (true) {
    try {
      const canonical = await realpath(current);
      return suffixSegments.reduceRight((built, segment) => join(built, segment), canonical);
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return resolvedPath;
      }
    }

    const parent = dirname(current);
    if (parent === current) return resolvedPath;

    suffixSegments.push(basename(current));
    current = parent;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
