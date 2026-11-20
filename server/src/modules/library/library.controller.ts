import { ForbidPermission } from '../../common/decorators/forbid-permission.decorator';
import { CreatePersonalLibraryDto } from './dto/create-personal-library.dto';
import { RegexMetadataPreviewDto, RegexMetadataValidationDto } from './dto/regex-metadata.dto';
import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Permission, AuditAction, AuditResource } from '@bookorbit/types';
import type { BookQuery, BulkRenameProgressEvent, JumpBucketsQuery, LibraryBookFacets, LibraryFileSyncProgressEvent } from '@bookorbit/types';
import { KeyReadSafe, NoApiKeyUsageTracking } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequireScopedPermission } from '../../common/decorators/require-scoped-permission.decorator';
import { Auditable } from '../../common/decorators/auditable.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookQueryPipe, JumpBucketsQueryPipe } from '../book/pipes/book-query.pipe';
import { BookService } from '../book/book.service';
import { BulkRenameExecuteDto } from './dto/bulk-rename-execute.dto';
import { BulkRenamePreviewQueryDto } from './dto/bulk-rename-preview-query.dto';
import { CreateLibraryDto } from './dto/create-library.dto';
import { GrantLibraryAccessDto } from './dto/grant-library-access.dto';
import { PrescanLibraryDto } from './dto/prescan-library.dto';
import { ReorderLibrariesDto } from './dto/reorder-libraries.dto';
import { UpdateLibraryAccessDto } from './dto/update-library-access.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import { BulkRenameService } from './bulk-rename.service';
import { LibraryService } from './library.service';
import { LibraryAddedAtService } from './library-added-at.service';
import { PathScopeDto } from '../path/dto/path-scope.dto';

@Controller('libraries')
export class LibraryController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly bookService: BookService,
    private readonly bulkRenameService: BulkRenameService,
    private readonly addedAtService: LibraryAddedAtService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: RequestUser) {
    return this.libraryService.findAll(user);
  }

  @Get('capabilities')
  @Header('Cache-Control', 'private, no-store')
  @NoApiKeyUsageTracking()
  capabilities(@CurrentUser() user: RequestUser) {
    return this.libraryService.capabilities(user);
  }

  @Get('assignable-users')
  @Header('Cache-Control', 'private, no-store')
  creationAssignableUsers(@CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    return this.libraryService.creationAssignableUsers({ user, scope: query.scope });
  }

  /**
   * Declared before the ':id' route so 'overview' is never parsed as a library id.
   * Scan error text can name server paths, so this stays behind ManageLibraries even
   * though the per-library stats route is viewer-level.
   */
  @Get('overview')
  @RequirePermission(Permission.ManageLibraries)
  getOverview(@CurrentUser() user: RequestUser) {
    return this.libraryService.getOverview(user);
  }

  @Post('regex-metadata/validate')
  @KeyReadSafe()
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageLibraries)
  validateRegexMetadata(@Body() dto: RegexMetadataValidationDto) {
    return this.libraryService.validateRegexMetadata(dto);
  }

  @Post('regex-metadata/preview')
  @KeyReadSafe()
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.ManageLibraries)
  previewRegexMetadata(@Body() dto: RegexMetadataPreviewDto) {
    return this.libraryService.previewRegexMetadata(dto);
  }

  @Get('administration')
  @RequirePermission(Permission.ManageLibraries)
  administration(@CurrentUser() user: RequestUser) {
    return this.libraryService.administration(user);
  }

  @Get(':id')
  @RequireLibraryAccess('viewer')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.libraryService.findOne(id);
  }

  @Post(':id/books')
  @KeyReadSafe()
  @RequireLibraryAccess('viewer')
  queryBooks(@Param('id', ParseIntPipe) libraryId: number, @Body(BookQueryPipe) query: BookQuery, @CurrentUser() user: RequestUser) {
    return this.bookService.queryForLibrary(user, libraryId, query);
  }

  @Post(':id/books/facets')
  @KeyReadSafe()
  @RequireLibraryAccess('viewer')
  getBookFacets(
    @Param('id', ParseIntPipe) libraryId: number,
    @Body(BookQueryPipe) query: BookQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<LibraryBookFacets> {
    return this.bookService.facetsForLibrary(user, libraryId, query);
  }

  @Post(':id/books/jump-buckets')
  @KeyReadSafe()
  @RequireLibraryAccess('viewer')
  queryJumpBuckets(
    @Param('id', ParseIntPipe) libraryId: number,
    @Body(JumpBucketsQueryPipe) query: JumpBucketsQuery,
    @CurrentUser() user: RequestUser,
  ) {
    return this.bookService.queryJumpBucketsForLibrary(user, libraryId, query);
  }

  @Post('personal')
  @Auditable({
    action: AuditAction.LibraryCreate,
    resource: AuditResource.Library,
    getResourceId: (_, res: unknown) => (res as { id?: number })?.id,
    description: () => 'Created personal library',
  })
  createPersonal(@Body() dto: CreatePersonalLibraryDto, @CurrentUser() user: RequestUser) {
    return this.libraryService.createPersonal(dto, user);
  }

  @Post()
  @RequirePermission(Permission.ManageLibraries)
  @Auditable({
    action: AuditAction.LibraryCreate,
    resource: AuditResource.Library,
    getResourceId: (_, res: unknown) => (res as { id?: number })?.id,
    description: (_, res: unknown) => `Created library '${(res as { name?: string })?.name ?? 'unknown'}'`,
  })
  create(@Body() dto: CreateLibraryDto, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    return this.libraryService.create(dto, { user, scope: query.scope });
  }

  @Patch(':id')
  @ForbidPermission(Permission.DemoRestricted)
  @Auditable({
    action: AuditAction.LibraryUpdate,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'] as string, 10),
    description: (req) => `Updated library #${req.params['id']}`,
  })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLibraryDto, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    return this.libraryService.update(id, dto, { user, scope: query.scope });
  }

  @Delete(':id')
  @ForbidPermission(Permission.DemoRestricted)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({
    action: AuditAction.LibraryDelete,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'] as string, 10),
    description: (req) => `Deleted library #${req.params['id']}`,
  })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    await this.libraryService.assertManagement(id, { user, scope: query.scope });
    return this.libraryService.remove(id);
  }

  @Post('prescan')
  @KeyReadSafe()
  prescan(@Body() dto: PrescanLibraryDto, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    return this.libraryService.prescan(dto, { user, scope: query.scope });
  }

  @Post('reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.ManageLibraries)
  reorder(@Body() dto: ReorderLibrariesDto, @CurrentUser() user: RequestUser) {
    return this.libraryService.reorder(dto, user);
  }

  @Get(':id/stats')
  @RequireLibraryAccess('viewer')
  getStats(@Param('id', ParseIntPipe) id: number) {
    return this.libraryService.getStats(id);
  }

  @Get(':id/recompute-added-at')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  getAddedAtRecompute(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.addedAtService.get(id, user, scope);
  }

  @Post(':id/recompute-added-at')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  @Auditable({
    action: AuditAction.LibraryRecomputeAddedAt,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'], 10),
    description: (req) => `Started added_at recompute for library #${req.params['id']}`,
  })
  recomputeAddedAt(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.addedAtService.start(id, user);
  }

  @Post(':id/write-metadata-to-files')
  @RequireScopedPermission(Permission.LibraryEditMetadata, 'library')
  @Auditable({
    action: AuditAction.LibraryWriteMetadataToFiles,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'], 10),
    description: (req) => `Wrote metadata to files for library #${req.params['id']}`,
  })
  async writeMetadataToFiles(
    @Param('id', ParseIntPipe) libraryId: number,
    @Query('dryRun') dryRunParam: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ) {
    const dryRun = dryRunParam === 'true';

    let disconnected = false;
    let streamStarted = false;
    const handleDisconnect = () => {
      disconnected = true;
    };

    const ensureStreamStarted = () => {
      if (streamStarted) return;
      streamStarted = true;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.on('close', handleDisconnect);
      reply.raw.on('aborted', handleDisconnect);
    };

    const writeEvent = (event: LibraryFileSyncProgressEvent) => {
      if (disconnected || reply.raw.writableEnded || reply.raw.destroyed) return;
      ensureStreamStarted();
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const summary = await this.libraryService.writeMetadataToFiles(libraryId, user.id, dryRun, {
        onProgress: writeEvent,
        isCancelled: () => disconnected || reply.raw.writableEnded || reply.raw.destroyed,
      });

      const doneEvent: LibraryFileSyncProgressEvent = {
        done: true,
        processed: summary.processed,
        succeeded: summary.succeeded,
        failed: summary.failed,
        skipped: summary.skipped,
      };
      writeEvent(doneEvent);

      if (streamStarted && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    } catch (error) {
      if (streamStarted && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
        return;
      }
      throw error;
    } finally {
      if (streamStarted) {
        reply.raw.off('close', handleDisconnect);
        reply.raw.off('aborted', handleDisconnect);
      }
    }
  }

  @Get(':id/assignable-users')
  assignableUsers(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    return this.libraryService.assignableUsers(id, { user, scope: query.scope });
  }

  // ── Library access management ─────────────────────────────────────────────

  @Get(':libraryId/access')
  async getAccess(@Param('libraryId', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser, @Query() query: PathScopeDto) {
    await this.libraryService.assertManagement(libraryId, { user, scope: query.scope });
    return this.libraryService.getAccess(libraryId);
  }

  @Post(':libraryId/access')
  @ForbidPermission(Permission.DemoRestricted)
  @Auditable({
    action: AuditAction.LibraryAccessGrant,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['libraryId'] as string, 10),
    description: (req) => `Granted library #${req.params['libraryId']} access to user #${(req.body as { userId?: number })?.userId}`,
  })
  async grantAccess(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Body() dto: GrantLibraryAccessDto,
    @CurrentUser() user: RequestUser,
    @Query() query: PathScopeDto,
  ) {
    const requiredOwnerId = await this.libraryService.assertManagement(libraryId, { user, scope: query.scope });
    return this.libraryService.grantAccess(libraryId, dto, requiredOwnerId, user);
  }

  @Patch(':libraryId/access/:userId')
  @ForbidPermission(Permission.DemoRestricted)
  @Auditable({
    action: AuditAction.LibraryAccessUpdate,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['libraryId'] as string, 10),
    description: (req) => `Updated library #${req.params['libraryId']} access for user #${req.params['userId']}`,
  })
  async updateAccess(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateLibraryAccessDto,
    @CurrentUser() user: RequestUser,
    @Query() query: PathScopeDto,
  ) {
    const requiredOwnerId = await this.libraryService.assertManagement(libraryId, { user, scope: query.scope });
    return this.libraryService.updateAccess(libraryId, userId, dto.accessLevel, requiredOwnerId, user);
  }

  @Delete(':libraryId/access/:userId')
  @ForbidPermission(Permission.DemoRestricted)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({
    action: AuditAction.LibraryAccessRevoke,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['libraryId'] as string, 10),
    description: (req) => `Revoked library #${req.params['libraryId']} access from user #${req.params['userId']}`,
  })
  async revokeAccess(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: RequestUser,
    @Query() query: PathScopeDto,
  ) {
    const requiredOwnerId = await this.libraryService.assertManagement(libraryId, { user, scope: query.scope });
    return this.libraryService.revokeAccess(libraryId, userId, requiredOwnerId, user);
  }

  // ── Bulk rename ────────────────────────────────────────────────────────────

  @Get(':id/bulk-rename/preview')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  getBulkRenamePreview(@Param('id', ParseIntPipe) libraryId: number, @Query() query: BulkRenamePreviewQueryDto) {
    return this.bulkRenameService.getPreview(libraryId, query.page, query.pageSize, query.status, query.search);
  }

  @Get(':id/bulk-rename/status')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  getBulkRenameStatus(@Param('id', ParseIntPipe) libraryId: number) {
    return { running: this.bulkRenameService.isRunning(libraryId) };
  }

  @Post(':id/bulk-rename/execute')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  @Auditable({
    action: AuditAction.LibraryBulkRename,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'], 10),
    description: (req) => `Bulk renamed books in library #${req.params['id']}`,
  })
  async executeBulkRename(
    @Param('id', ParseIntPipe) libraryId: number,
    @Body() body: BulkRenameExecuteDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ) {
    let disconnected = false;
    let streamStarted = false;
    const handleDisconnect = () => {
      disconnected = true;
    };

    const ensureStreamStarted = () => {
      if (streamStarted) return;
      streamStarted = true;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.on('close', handleDisconnect);
      reply.raw.on('aborted', handleDisconnect);
    };

    const writeEvent = (event: BulkRenameProgressEvent) => {
      if (disconnected || reply.raw.writableEnded || reply.raw.destroyed) return;
      ensureStreamStarted();
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const summary = await this.bulkRenameService.execute(libraryId, user.id, {
        excludeBookIds: body.excludeBookIds,
        includeBookIds: body.includeBookIds,
        onProgress: writeEvent,
        isCancelled: () => disconnected || reply.raw.writableEnded || reply.raw.destroyed,
      });

      const doneEvent: BulkRenameProgressEvent = {
        done: true,
        processed: summary.processed,
        succeeded: summary.succeeded,
        failed: summary.failed,
        skipped: summary.skipped,
      };
      writeEvent(doneEvent);

      if (streamStarted && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    } catch (error) {
      if (streamStarted && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
        return;
      }
      throw error;
    } finally {
      if (streamStarted) {
        reply.raw.off('close', handleDisconnect);
        reply.raw.off('aborted', handleDisconnect);
      }
    }
  }
}
