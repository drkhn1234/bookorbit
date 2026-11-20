import { lstat, rmdir } from 'fs/promises';
import { CreatePersonalLibraryDto } from './dto/create-personal-library.dto';
import { isDeepStrictEqual } from 'node:util';
import { RegexMetadataService } from '../metadata/regex/regex-metadata.service';
import { RegexMetadataPreviewDto, RegexMetadataValidationDto } from './dto/regex-metadata.dto';
import { ReadingAttemptEventsService } from '../user-book-status/reading-attempt-events.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rm, stat } from 'fs/promises';
import { join } from 'path';

import { Permission, DEFAULT_FORMAT_PRIORITY, resolveRegexMetadataConfig } from '@bookorbit/types';
import type {
  LibraryCapabilities,
  AccessLevel,
  LibraryFileSyncProgressEvent,
  LibraryOverviewEntry,
  OrganizationMode,
  RegexMetadataConfig,
  WriteResult,
} from '@bookorbit/types';
import { LibraryOperationGate } from '../../common/services/library-operation-gate.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { normalizeIconValue } from '../../common/utils/icon-value.utils';
import { LibraryScopeService, type LibraryScopeSubject } from '../../common/library-scope/library-scope.service';
import { apiKeyCredentialOf, type RequestUser } from '../../common/types/request-user';
import type { LibraryFolder } from '../../db/schema/libraries';
import { AchievementEventsService, ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED } from '../achievement/achievement-events.service';
import { FileWriteService } from '../file-write/file-write.service';
import { PathPolicyService, type PathRequest } from '../path/path-policy.service';
import { mapLimit, walkFolder } from '../path/folder-walk';
import { FileWatcherService } from '../scanner/file-watcher.service';
import { ScannerService } from '../scanner/scanner.service';
import { CreateLibraryDto } from './dto/create-library.dto';
import { GrantLibraryAccessDto } from './dto/grant-library-access.dto';
import { PrescanLibraryDto } from './dto/prescan-library.dto';
import { ReorderLibrariesDto } from './dto/reorder-libraries.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import {
  DEFAULT_LIBRARY_ADDED_AT_SOURCE,
  DEFAULT_LIBRARY_COVER_ASPECT_RATIO,
  DEFAULT_LIBRARY_ORGANIZATION_MODE,
  LIBRARY_METADATA_PRECEDENCE_DEFAULT,
} from './library.constants';
import { LibraryRepository } from './library.repository';
import { LibraryScanSchedulerService } from './library-scan-scheduler.service';

interface LibraryMetadataWriteStreamOptions {
  onProgress?: (event: LibraryFileSyncProgressEvent) => void;
  isCancelled?: () => boolean;
}

interface LibraryMetadataWriteSummary {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
}

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);
  private readonly appDataPath: string;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly config: ConfigService,
    private readonly scannerService: ScannerService,
    private readonly fileWatcherService: FileWatcherService,
    private readonly fileWriteService: FileWriteService,
    private readonly achievementEvents: AchievementEventsService,
    private readonly pathPolicy: PathPolicyService,
    private readonly scanScheduler: LibraryScanSchedulerService,
    private readonly regexMetadata: RegexMetadataService,
    private readonly readingAttemptEvents: ReadingAttemptEventsService,
    private readonly libraryGate: LibraryOperationGate,
    private readonly libraryScope: LibraryScopeService,
  ) {
    this.appDataPath = this.config.get<string>('storage.appDataPath')!;
  }

  async verifyAccess(user: LibraryScopeSubject, libraryId: number): Promise<void> {
    await this.libraryScope.assertVisible(user, libraryId);
  }

  async verifyAccessLevel(user: LibraryScopeSubject, libraryId: number, required: AccessLevel): Promise<void> {
    await this.libraryScope.assertLevel(user, libraryId, required);
  }

  verifyPermission(user: RequestUser, libraryId: number, permission: Permission, scope?: unknown): Promise<void> {
    return this.libraryScope.assertPermission(user, libraryId, permission, scope);
  }

  hasLibraryPermission(user: RequestUser, libraryId: number, permission: Permission): Promise<boolean> {
    return this.libraryScope.hasPermission(user, libraryId, permission);
  }

  async findAll(user: RequestUser) {
    const librariesForUser = await this.findLibrariesForUser(user);
    const folders = await this.libraryRepo.findFoldersByLibraryIds(librariesForUser.map((library) => library.id));

    const foldersByLibraryId = new Map<number, LibraryFolder[]>();
    for (const folder of folders) {
      const currentFolders = foldersByLibraryId.get(folder.libraryId);
      if (currentFolders) {
        currentFolders.push(folder);
      } else {
        foldersByLibraryId.set(folder.libraryId, [folder]);
      }
    }

    return librariesForUser.map((library) => ({
      ...normalizeLibraryOrganizationMode(library),
      folders: (foldersByLibraryId.get(library.id) ?? []).map(({ id, path, createdAt }) => ({ id, path, createdAt })),
    }));
  }

  /**
   * Which of these users can open this library. Callers that hold user ids rather than whole
   * users - a notifier resolving one link per recipient, for instance - cannot ask
   * `verifyAccess`, which needs the requesting user.
   */
  async findUserIdsWithAccess(libraryId: number, userIds: number[]): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.libraryRepo.findUserIdsWithAccess(libraryId, userIds);
    return new Set(rows.map(({ id }) => id));
  }

  async findAccessibleLibraryIds(user: RequestUser): Promise<number[]> {
    return this.libraryScope.visibleIds(user);
  }

  async findEditableLibraryIds(user: RequestUser): Promise<number[]> {
    return this.libraryScope.editableIds(user);
  }

  /**
   * All accounts list explicit grants. Keys further narrow libraries and cap read-only access.
   */
  private async findLibrariesForUser(user: RequestUser) {
    const credential = apiKeyCredentialOf(user);
    const rows = await this.libraryRepo.findAllForUser(user.id, user.isSuperuser ? undefined : user.contentFilters);
    if (!credential) return rows;
    const levels = new Map((await this.libraryScope.visibleLevels(user)).map(({ id, accessLevel }) => [id, accessLevel]));
    return rows.filter((library) => levels.has(library.id)).map((library) => ({ ...library, accessLevel: levels.get(library.id)! }));
  }

  async findOne(id: number) {
    const [library] = await this.libraryRepo.findById(id);
    if (!library) throw new NotFoundException('Library not found');
    const folders = await this.libraryRepo.findFoldersByLibrary(id);
    return { ...normalizeLibraryOrganizationMode(library), folders };
  }

  private async assertRegexMetadataLibrary(libraryId: number | undefined) {
    if (libraryId === undefined) return;
    await this.findOne(libraryId);
  }

  async validateRegexMetadata(dto: RegexMetadataValidationDto) {
    await this.assertRegexMetadataLibrary(dto.libraryId);
    return this.regexMetadata.check(dto.config);
  }

  async previewRegexMetadata(dto: RegexMetadataPreviewDto) {
    await this.assertRegexMetadataLibrary(dto.libraryId);
    return this.regexMetadata.preview(dto.config, dto.relativePath);
  }

  async capabilities(user: RequestUser): Promise<LibraryCapabilities> {
    const denial = async (request: PathRequest): Promise<string | null> => {
      try {
        await this.pathPolicy.assertCreationAccess(request);
        return null;
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 403, 409].includes(error.getStatus())) throw error;
        return error.message;
      }
    };
    const [personalLibraryDenialReason, administrativeStorageDenialReason] = await Promise.all([denial({ user }), denial({ user, scope: 'admin' })]);
    return {
      canCreatePersonalLibrary: personalLibraryDenialReason === null,
      personalLibraryDenialReason,
      canUseAdministrativeStorage: administrativeStorageDenialReason === null,
      administrativeStorageDenialReason,
    };
  }

  async createPersonal(dto: CreatePersonalLibraryDto, user: RequestUser) {
    if (dto.folders?.length) return this.create({ ...dto, folders: dto.folders }, { user }, true);

    const path = await this.pathPolicy.allocateLibraryDirectory(user);
    const identity = await lstat(path);
    try {
      return await this.create({ ...dto, folders: [path] }, { user }, true);
    } catch (error) {
      // A failed commit acknowledgement is ambiguous. Preserve storage unless the DB confirms it is unregistered.
      try {
        const folders = await this.libraryRepo.findAllFolders();
        const current = await lstat(path);
        if (
          !folders.some((folder) => folder.path === path) &&
          current.ino === identity.ino &&
          current.dev === identity.dev &&
          !current.isSymbolicLink()
        )
          await rmdir(path);
      } catch {
        this.logger.warn(`[library.create] [fail] userId=${user.id} - uncommitted directory retained for safe recovery`);
      }
      throw error;
    }
  }

  async create(dto: CreateLibraryDto, request: PathRequest, personal = false) {
    if (!personal && !request.user.isSuperuser && !request.user.permissions.includes(Permission.ManageLibraries))
      throw new ForbiddenException('Library administration permission required');
    const folderPaths = await this.assertFolderPathsWithinBrowseRoot(dto.folders, request, personal);
    const regexMetadata = resolveRegexMetadataConfig(dto.regexMetadata);
    await this.regexMetadata.validate(regexMetadata);
    await this.assertNameAvailable(dto.name);
    await this.assertFoldersDoNotOverlap(folderPaths, request, await this.libraryRepo.findAllFolderPaths(), undefined, true);
    const icon = normalizeIconValue(dto.icon);
    if (!icon) {
      throw new BadRequestException('Icon is required');
    }

    const { library, folders } = await this.libraryRepo.createOwned(
      {
        name: dto.name,
        icon,
        displayOrder: dto.displayOrder ?? 0,
        watch: dto.watch ?? false,
        autoScanCronExpression: dto.autoScanCronExpression ?? null,
        regexMetadata,
        metadataPrecedence: dto.metadataPrecedence ?? [...LIBRARY_METADATA_PRECEDENCE_DEFAULT],
        formatPriority: dto.formatPriority ?? [...DEFAULT_FORMAT_PRIORITY],
        allowedFormats: dto.allowedFormats ?? [],
        organizationMode: dto.organizationMode ?? DEFAULT_LIBRARY_ORGANIZATION_MODE,
        addedAtSource: dto.addedAtSource ?? DEFAULT_LIBRARY_ADDED_AT_SOURCE,
        excludePatterns: dto.excludePatterns ?? [],
        coverAspectRatio: dto.coverAspectRatio ?? DEFAULT_LIBRARY_COVER_ASPECT_RATIO,
        readingThreshold: dto.readingThreshold ?? 0.25,
        markAsFinishedPercentComplete: dto.markAsFinishedPercentComplete ?? 98,
        fileNamingPattern: dto.fileNamingPattern ?? null,
        fileWriteEnabled: dto.fileWriteEnabled ?? false,
        fileWriteWriteCover: dto.fileWriteWriteCover ?? true,
        fileWriteEpubEnabled: dto.fileWriteEpubEnabled ?? true,
        fileWriteEpubMaxFileSizeMb: dto.fileWriteEpubMaxFileSizeMb ?? 100,
        fileWriteFb2Enabled: dto.fileWriteFb2Enabled ?? false,
        fileWriteFb2MaxFileSizeMb: dto.fileWriteFb2MaxFileSizeMb ?? 100,
        fileWritePdfEnabled: dto.fileWritePdfEnabled ?? true,
        fileWritePdfMaxFileSizeMb: dto.fileWritePdfMaxFileSizeMb ?? 100,
        fileWriteCbxEnabled: dto.fileWriteCbxEnabled ?? false,
        fileWriteCbxMaxFileSizeMb: dto.fileWriteCbxMaxFileSizeMb ?? 500,
        fileWriteKindleEnabled: dto.fileWriteKindleEnabled ?? false,
        fileWriteKindleMaxFileSizeMb: dto.fileWriteKindleMaxFileSizeMb ?? 100,
        fileWriteAudioEnabled: dto.fileWriteAudioEnabled ?? true,
        fileWriteAudioMaxFileSizeMb: dto.fileWriteAudioMaxFileSizeMb ?? 500,
        fileWriteAllFiles: dto.fileWriteAllFiles ?? false,
        fileWriteReadAlongEnabled: dto.fileWriteReadAlongEnabled ?? false,
        fileWriteReadAlongMaxFileSizeMb: dto.fileWriteReadAlongMaxFileSizeMb ?? 1000,
        fileRenameEnabled: dto.fileRenameEnabled ?? false,
      },
      folderPaths,
      request.user.id,
      async (registered) => {
        if (personal) await this.assertFolderPathsWithinBrowseRoot(folderPaths, request, true);
        await this.assertFoldersDoNotOverlap(folderPaths, request, registered);
      },
    );

    let setupFailures = 0;
    const setup: Array<() => void | Promise<void>> = [
      () => this.scannerService.forgetLibraryRoots(),
      () =>
        library.watch
          ? this.fileWatcherService.startWatcher(
              library.id,
              folders.map((folder) => folder.path),
            )
          : undefined,
      () => this.scanScheduler.syncSchedule(library.id, dto.autoScanCronExpression ?? null),
      () => this.scannerService.startScanAsync(library.id),
    ];
    for (const operation of setup) {
      try {
        await operation();
      } catch (error) {
        setupFailures++;
        this.logger.warn(
          `[library.create] [fail] libraryId=${library.id} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(getErrorMessage(error))}" - library committed; background setup needs retry`,
        );
      }
    }
    this.logger.log(
      `[library.create] [end] libraryId=${library.id} userId=${request.user.id} setupFailures=${setupFailures} - library committed with creator ownership`,
    );
    return { ...normalizeLibraryOrganizationMode(library), folders, accessLevel: 'owner' as const };
  }

  async update(id: number, dto: UpdateLibraryDto, request: PathRequest) {
    await this.assertManagement(id, request);
    const administrativeFolders = dto.folders !== undefined && request.scope === 'admin';
    if (dto.folders !== undefined) {
      if (administrativeFolders) await this.pathPolicy.access(request);
      else await this.libraryScope.assertLevel(request.user, id, 'owner');
    }
    if (!administrativeFolders) {
      if (dto.watch !== undefined || dto.autoScanCronExpression !== undefined) {
        return this.libraryGate.withStableRegistry(() => this.saveUpdate(id, dto, request, false));
      }
      return this.saveUpdate(id, dto, request, false);
    }

    const releaseGate = this.libraryGate.tryAcquire(id, 'library_rebind');
    if (!releaseGate) {
      throw new ConflictException({
        message: 'A scan or another library operation is running. Try again when it finishes.',
        errorCode: 'LIBRARY_BUSY',
      });
    }
    try {
      return await this.saveUpdate(id, dto, request, true);
    } finally {
      releaseGate();
    }
  }

  private async saveUpdate(id: number, dto: UpdateLibraryDto, request: PathRequest, administrativeFolders: boolean) {
    const [existing] = await this.libraryRepo.findById(id);
    if (!existing) throw new NotFoundException('Library not found');

    // Compared as the rules that would run: a preset runs its current rules whatever copy is stored,
    // so re-sending a preset is no change even after the preset itself was updated.
    const regexRules = (config: RegexMetadataConfig | null | undefined) =>
      config ? [config.preset ?? null, config.rules.map(({ pattern, flags }) => [pattern, flags])] : null;
    const incomingRegexMetadata = dto.regexMetadata === undefined ? undefined : resolveRegexMetadataConfig(dto.regexMetadata);
    const regexMetadataChanged =
      incomingRegexMetadata !== undefined &&
      !isDeepStrictEqual(regexRules(incomingRegexMetadata), regexRules(resolveRegexMetadataConfig(existing.regexMetadata)));
    if (regexMetadataChanged) await this.regexMetadata.validate(incomingRegexMetadata);

    const existingOrganizationMode = normalizeOrganizationMode(existing.organizationMode);
    if (dto.organizationMode !== undefined && dto.organizationMode !== existingOrganizationMode) {
      throw new BadRequestException(
        'Library organization mode cannot be changed after creation. Create a new library to use a different organization mode.',
      );
    }

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameAvailable(dto.name, id);
    }

    const { folders: rawFolderPaths, ...fields } = dto;
    if (!regexMetadataChanged) delete fields.regexMetadata;
    else fields.regexMetadata = incomingRegexMetadata;
    const icon = fields.icon !== undefined ? normalizeIconValue(fields.icon) : normalizeIconValue(existing.icon);
    if (!icon) {
      throw new BadRequestException('Icon is required');
    }
    if (fields.icon !== undefined) {
      fields.icon = icon;
    }

    const incoming = rawFolderPaths && [...new Set(rawFolderPaths)];
    let validatedPaths: string[] | undefined;
    if (incoming && administrativeFolders) {
      const current = (await this.libraryRepo.findFoldersByLibrary(id)).map((folder) => folder.path);
      if (!samePaths(incoming, current)) validatedPaths = await this.assertFolderPathsWithinBrowseRoot(incoming, request);
    }
    const { library, folders, pathsChanged } =
      incoming === undefined
        ? { library: (await this.libraryRepo.update(id, fields))[0], folders: await this.libraryRepo.findFoldersByLibrary(id), pathsChanged: false }
        : await this.libraryRepo.updateWithFolders(id, fields, async (current, registered) => {
            if (samePaths(incoming, current)) return current;
            if (!administrativeFolders) {
              throw new ForbiddenException('Changing registered library folders requires explicit administrator storage scope');
            }
            if (!validatedPaths) throw new ConflictException('Library folders changed. Refresh the library and try again.');
            await this.assertFoldersDoNotOverlap(validatedPaths, request, registered, id);
            return validatedPaths;
          });
    if (!library) throw new NotFoundException('Library not found');

    if (pathsChanged) this.scannerService.forgetLibraryRoots();
    if (administrativeFolders || dto.autoScanCronExpression !== undefined) {
      if (!this.scanScheduler.syncSchedule(id, library.autoScanCronExpression)) {
        this.logger.warn(`[library.update] [fail] libraryId=${id} - settings committed; retry the scan schedule or restart to reconcile`);
      }
    }
    if (administrativeFolders || (dto.watch !== undefined && dto.watch !== existing.watch)) {
      try {
        if (library.watch)
          await this.fileWatcherService.startWatcher(
            id,
            folders.map((folder) => folder.path),
          );
        else await this.fileWatcherService.stopWatcher(id);
      } catch (error) {
        this.logger.warn(
          `[library.update] [fail] libraryId=${id} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(getErrorMessage(error))}" - settings committed; retry the watcher or restart to reconcile`,
        );
      }
    }
    const shouldRescan =
      dto.formatPriority !== undefined || dto.allowedFormats !== undefined || dto.excludePatterns !== undefined || rawFolderPaths !== undefined;
    if (shouldRescan) this.scannerService.startScanAsync(id);

    return { ...normalizeLibraryOrganizationMode(library), folders };
  }

  async remove(id: number) {
    const [existing] = await this.libraryRepo.findById(id);
    if (!existing) throw new NotFoundException('Library not found');
    // Held for the whole delete, so a scan, move, rename or merge cannot start on rows and files
    // that are going away, and one already running is not cut off halfway through its writes.
    const releaseGate = this.libraryGate.tryAcquire(id, 'library_delete');
    if (!releaseGate) {
      throw new ConflictException({
        message: 'Another operation is running in this library. Try again when it finishes.',
        errorCode: 'LIBRARY_BUSY',
      });
    }
    const event = 'library.delete';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] libraryId=${id} - library deletion started`);
    try {
      await this.fileWatcherService.stopWatcher(id);
      const bookRows = await this.libraryRepo.findBookIdsByLibrary(id);
      await this.libraryRepo.delete(id);
      this.scannerService.forgetLibraryRoots();
      this.readingAttemptEvents.notifyChanged(null);
      this.scanScheduler.removeSchedule(id);
      await this.cleanupCoverDirectories(bookRows.map(({ id: bookId }) => bookId));
      this.logger.log(`[${event}] [end] libraryId=${id} durationMs=${Date.now() - startedAt} books=${bookRows.length} - library deletion completed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[${event}] [fail] libraryId=${id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(message)}" - library deletion failed`,
      );
      throw error;
    } finally {
      releaseGate();
    }
  }

  async prescan(dto: PrescanLibraryDto, request: PathRequest) {
    const access = await this.pathPolicy.access(request);
    if (dto.libraryId !== undefined && request.scope !== 'admin') await this.libraryScope.assertVisible(request.user, dto.libraryId);
    const visible = new Set(await this.libraryScope.visibleIds(request.user));
    const allFolderPaths = await this.libraryRepo.findAllFolderPaths();

    const results = await mapLimit(dto.paths, 4, async (inputPath) => {
      let accessible: boolean;
      let fileCount = 0;
      let error: string | undefined;
      let overlapLibrary: string | undefined;
      let truncated = false;

      const resolvedInputPath = await this.pathPolicy.resolveScopedPath(inputPath, access).catch(() => null);
      if (resolvedInputPath === null) {
        return {
          path: inputPath,
          accessible: false,
          fileCount: 0,
          error: 'Path is outside your authorized storage scope',
        };
      }

      let inputStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        inputStat = await stat(resolvedInputPath);
      } catch (err) {
        error = formatPrescanError(err);
      }

      if (inputStat === null) {
        accessible = false;
      } else if (!inputStat.isDirectory()) {
        return { path: resolvedInputPath, accessible: false, fileCount: 0, error: 'Not a directory' };
      } else {
        accessible = true;
        try {
          const outcome = await walkFolder(resolvedInputPath, {
            maxEntries: 20_000,
            deadline: Date.now() + 3_000,
            canVisit: (path) => this.pathPolicy.canVisit(access, path),
            visible: (path) => this.pathPolicy.isVisiblePath(access, path),
          });
          fileCount = outcome.files;
          truncated = outcome.truncated;
          if (outcome.state !== 'ok') {
            accessible = false;
            error = 'Could not read this directory';
          }
        } catch (err) {
          accessible = false;
          fileCount = 0;
          error = formatPrescanError(err);
        }
      }

      for (const existing of allFolderPaths) {
        if (dto.libraryId !== undefined && existing.libraryId === dto.libraryId) continue;
        if (pathsOverlap(resolvedInputPath, existing.path)) {
          overlapLibrary = request.scope === 'admin' || visible.has(existing.libraryId) ? existing.libraryName : 'Another registered library';
          break;
        }
      }

      return { path: resolvedInputPath, accessible, fileCount, overlapLibrary, error, ...(truncated ? { truncated } : {}) };
    });

    const totalFiles = results.reduce((sum, r) => sum + r.fileCount, 0);
    return { paths: results, totalFiles };
  }

  /**
   * Everything the libraries settings page needs about every library the caller can reach, in one
   * request: the stats that used to cost a fan-out of one call per library, plus each library's
   * most recent scan.
   */
  async getOverview(user: RequestUser): Promise<LibraryOverviewEntry[]> {
    const libraryIds = await this.findAccessibleLibraryIds(user);
    if (libraryIds.length === 0) return [];

    let stats: Awaited<ReturnType<LibraryRepository['getStatsForLibraries']>>;
    try {
      stats = await this.libraryRepo.getStatsForLibraries(libraryIds);
    } catch (err) {
      if (err instanceof RangeError) {
        throw new InternalServerErrorException('Library stats exceed supported size range');
      }
      throw err;
    }
    const lastScans = await this.scannerService.getLatestScans(libraryIds);

    return libraryIds.map((libraryId) => ({
      libraryId,
      totalBooks: stats.get(libraryId)?.totalBooks ?? 0,
      totalSizeBytes: stats.get(libraryId)?.totalSizeBytes ?? 0,
      formatCounts: stats.get(libraryId)?.formatCounts ?? {},
      lastScan: lastScans.get(libraryId) ?? null,
    }));
  }

  async getStats(libraryId: number) {
    const [existing] = await this.libraryRepo.findById(libraryId);
    if (!existing) throw new NotFoundException('Library not found');
    try {
      return await this.libraryRepo.getStats(libraryId);
    } catch (err) {
      if (err instanceof RangeError) {
        throw new InternalServerErrorException('Library stats exceed supported size range');
      }
      throw err;
    }
  }

  async reorder(dto: ReorderLibrariesDto, user: RequestUser) {
    const requestedIds = [...new Set(dto.order.map(({ id }) => id))];
    const allowedIds = apiKeyCredentialOf(user)?.libraryIds;
    if (allowedIds && requestedIds.some((id) => !allowedIds.includes(id))) throw new ForbiddenException('Library outside credential scope');
    const visible = await this.libraryRepo.findByIds(requestedIds);
    if (visible.length !== requestedIds.length) throw new NotFoundException('Library not found');
    await this.libraryRepo.updateDisplayOrders(dto.order);
  }

  administration(user: RequestUser) {
    return this.libraryRepo.administration(apiKeyCredentialOf(user)?.libraryIds ?? undefined);
  }

  async assertManagement(libraryId: number, request: PathRequest): Promise<number | null> {
    const key = apiKeyCredentialOf(request.user);
    if (key?.libraryIds && !key.libraryIds.includes(libraryId)) throw new ForbiddenException('Library outside credential scope');
    if (request.scope === 'admin' && (request.user.isSuperuser || request.user.permissions.includes(Permission.ManageLibraries))) return null;
    await this.libraryScope.assertLevel(request.user, libraryId, 'owner');
    return request.user.id;
  }

  async assignableUsers(libraryId: number, request: PathRequest) {
    await this.assertManagement(libraryId, request);
    return this.libraryRepo.getUsersNotInLibrary(libraryId);
  }

  async creationAssignableUsers(request: PathRequest) {
    await this.pathPolicy.assertCreationAccess(request);
    return this.libraryRepo.getAssignableUsersForCreator(request.user.id);
  }

  async getAccess(libraryId: number) {
    await this.assertLibraryAvailable(libraryId);
    return this.libraryRepo.getAccessWithUsers(libraryId);
  }

  async grantAccess(libraryId: number, dto: GrantLibraryAccessDto, requiredOwnerId: number | null, actor: RequestUser) {
    await this.assertLibraryAvailable(libraryId);
    const result = await this.libraryRepo.grantAccess(libraryId, dto.userId, dto.accessLevel, requiredOwnerId, actor);
    this.achievementEvents.emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId: dto.userId, libraryId });
    return result;
  }

  async updateAccess(libraryId: number, userId: number, accessLevel: AccessLevel, requiredOwnerId: number | null, actor: RequestUser) {
    await this.assertLibraryAvailable(libraryId);
    return this.libraryRepo.updateAccess(libraryId, userId, accessLevel, requiredOwnerId, actor);
  }

  async revokeAccess(libraryId: number, userId: number, requiredOwnerId: number | null, actor: RequestUser) {
    await this.assertLibraryAvailable(libraryId);
    const result = await this.libraryRepo.revokeAccess(libraryId, userId, requiredOwnerId, actor);
    this.achievementEvents.emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId, libraryId });
    return result;
  }

  async writeMetadataToFiles(
    libraryId: number,
    userId: number,
    dryRun: boolean,
    options: LibraryMetadataWriteStreamOptions = {},
  ): Promise<LibraryMetadataWriteSummary> {
    const [library] = await this.libraryRepo.findById(libraryId);
    if (!library) throw new NotFoundException('Library not found');

    if (!dryRun && !library.fileWriteEnabled) {
      throw new BadRequestException('Metadata file write is not enabled for this library.');
    }

    const rows = await this.fileWriteService.findNonMissingPrimaryFilesByLibrary(libraryId);
    const onProgress = options.onProgress ?? (() => undefined);
    const isCancelled = options.isCancelled ?? (() => false);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      if (isCancelled()) break;

      let result: WriteResult;
      try {
        result = await this.fileWriteService.writeToFile(row.bookId, 'sync', userId, dryRun);
      } catch (err) {
        result = { status: 'failed', fieldsWritten: [], durationMs: 0, reason: getErrorMessage(err) };
      }

      if (result.status === 'success') succeeded++;
      else if (result.status === 'failed') failed++;
      else skipped++;

      onProgress({ bookId: row.bookId, status: result.status, reason: result.reason });
    }

    return {
      processed: succeeded + failed + skipped,
      succeeded,
      failed,
      skipped,
      cancelled: isCancelled(),
    };
  }

  private async assertNameAvailable(name: string, excludeId?: number) {
    const existing = await this.libraryRepo.findByName(name, excludeId);
    if (existing.length > 0) throw new ConflictException('A library with this name already exists');
  }

  private async assertLibraryAvailable(libraryId: number): Promise<void> {
    const [library] = await this.libraryRepo.findById(libraryId);
    if (!library) throw new NotFoundException('Library not found');
  }

  private async assertFolderPathsWithinBrowseRoot(paths: string[], request: PathRequest, requireExisting = false): Promise<string[]> {
    const access = await this.pathPolicy.access(request);
    const resolvedPaths = await mapLimit(paths, 16, (path) => this.pathPolicy.resolveScopedPath(path, access));
    for (const path of resolvedPaths) {
      this.pathPolicy.assertLibraryDirectory(path);
      if (request.scope !== 'admin' && path === access.root)
        throw new ForbiddenException('The personal storage root cannot be registered as a library');
      if (requireExisting && !(await lstat(path).catch(() => null))?.isDirectory())
        throw new BadRequestException('Select an existing directory in your personal storage');
      await this.pathPolicy.assertWritable(access, path);
    }
    return [...new Set(resolvedPaths)];
  }

  /**
   * A file can belong to one book in one library, so a folder this request adds may not sit inside
   * another library folder, contain one, or repeat one, in this library or any other. Folders the
   * library already has are not re-checked: a library saved before this rule keeps saving until an
   * admin moves its folders apart, and the scanner settles who owns what in the meantime.
   */
  private async assertFoldersDoNotOverlap(
    paths: string[],
    request: PathRequest,
    registered: { libraryId: number; path: string; libraryName: string }[],
    libraryId?: number,
    includeVisibleOverlap = false,
  ): Promise<void> {
    const existing = await mapLimit(registered, 16, async (row) => ({
      ...row,
      path: await this.pathPolicy.canonicalPath(row.path),
    }));
    const current = new Set(existing.filter((folder) => folder.libraryId === libraryId).map((folder) => folder.path));
    const otherLibraries = existing.filter((folder) => folder.libraryId !== libraryId);

    for (const path of paths) {
      if (current.has(path)) continue;
      const inAnotherLibrary = otherLibraries.find((folder) => pathsOverlap(path, folder.path));
      const inThisLibrary = paths.find((other) => other !== path && pathsOverlap(path, other));
      if (!inAnotherLibrary && inThisLibrary === undefined) continue;
      throw new ConflictException({
        message: 'Library folders cannot sit inside one another or be shared between libraries.',
        errorCode: 'LIBRARY_FOLDER_OVERLAP',
        errorMeta: {
          path,
          ...(!inAnotherLibrary ||
          request.scope === 'admin' ||
          (includeVisibleOverlap && (await this.libraryScope.visibleIds(request.user)).includes(inAnotherLibrary.libraryId))
            ? { overlapPath: inAnotherLibrary?.path ?? inThisLibrary, ...(inAnotherLibrary ? { overlapLibrary: inAnotherLibrary.libraryName } : {}) }
            : {}),
        },
      });
    }
  }

  private async cleanupCoverDirectories(bookIds: number[]): Promise<void> {
    const event = 'library.remove_cover_dirs';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] bookCount=${bookIds.length} - cover directory cleanup started`);

    let deletedCount = 0;
    let failedCount = 0;
    const concurrency = 10;

    for (let index = 0; index < bookIds.length; index += concurrency) {
      const chunk = bookIds.slice(index, index + concurrency);
      await Promise.all(
        chunk.map(async (bookId) => {
          const coverDir = join(this.appDataPath, 'covers', String(bookId));
          try {
            await rm(coverDir, { recursive: true, force: true });
            deletedCount++;
          } catch (err) {
            failedCount++;
            const errorClass = err instanceof Error ? err.name : 'Error';
            const errorMessage = sanitizeLogValue(getErrorMessage(err));
            this.logger.warn(
              `[${event}] [fail] bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - cover directory cleanup failed`,
            );
          }
        }),
      );
    }

    this.logger.log(
      `[${event}] [end] bookCount=${bookIds.length} durationMs=${Date.now() - startedAt} deletedCount=${deletedCount} failedCount=${failedCount} - cover directory cleanup completed`,
    );
  }
}

function formatPrescanError(error: unknown): string {
  const errorCode = getErrorCode(error);
  if (errorCode === 'ENOENT') return 'Path does not exist';
  if (errorCode === 'EACCES' || errorCode === 'EPERM') return 'Permission denied';
  return 'Directory is not readable';
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeOrganizationMode(mode: string | null | undefined): OrganizationMode {
  if (mode === 'book_per_file') return 'book_per_file';
  return DEFAULT_LIBRARY_ORGANIZATION_MODE;
}

function normalizeLibraryOrganizationMode<T extends Record<string, unknown>>(library: T): T {
  if (!Object.prototype.hasOwnProperty.call(library, 'organizationMode')) return library;
  return {
    ...library,
    organizationMode: normalizeOrganizationMode((library as { organizationMode?: string | null }).organizationMode),
  };
}

function samePaths(incoming: string[], current: string[]): boolean {
  return incoming.length === current.length && incoming.every((path) => current.includes(path));
}

function pathsOverlap(a: string, b: string): boolean {
  const normalize = (path: string) => (path.endsWith('/') ? path : `${path}/`);
  const left = normalize(a);
  const right = normalize(b);
  return left.startsWith(right) || right.startsWith(left);
}
