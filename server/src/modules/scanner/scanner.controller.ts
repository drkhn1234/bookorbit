import { AuditAction, AuditResource, Permission } from '@bookorbit/types';
import { Controller, DefaultValuePipe, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';

import { Auditable } from '../../common/decorators/auditable.decorator';
import { RequireScopedPermission } from '../../common/decorators/require-scoped-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { RegexMetadataReapplyService } from './regex-metadata-reapply.service';
import { ScannerService } from './scanner.service';

@Controller('scanner')
export class ScannerController {
  constructor(
    private readonly scannerService: ScannerService,
    private readonly regexReapply: RegexMetadataReapplyService,
  ) {}

  @Post('libraries/:id/scan')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  @HttpCode(HttpStatus.ACCEPTED)
  scan(@Param('id', ParseIntPipe) libraryId: number) {
    return this.scannerService.startScan(libraryId, 'manual');
  }

  /**
   * Scan errors can name server paths, so this needs access to the library itself and not just the
   * global permission to manage libraries.
   */
  @Get('libraries/:id/scan-history')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  scanHistory(@Param('id', ParseIntPipe) libraryId: number, @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.scannerService.getScanHistory(libraryId, limit);
  }

  @Get('libraries/:id/reapply-regex-metadata')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  getRegexReapply(@Param('id', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.regexReapply.get(libraryId, user, scope);
  }

  /** Writes only the fields the saved rules decide, so it is safe to run on a library with fetched metadata. */
  @Post('libraries/:id/reapply-regex-metadata')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({
    action: AuditAction.LibraryReapplyRegexMetadata,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'], 10),
    description: (req) => `Started applying path rules to existing books in library #${req.params['id']}`,
  })
  reapplyRegexMetadata(@Param('id', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser) {
    return this.regexReapply.start(libraryId, user);
  }

  @Post('libraries/:id/refresh-covers')
  @RequireScopedPermission(Permission.ManageLibraries, 'library')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshCovers(@Param('id', ParseIntPipe) libraryId: number) {
    return this.scannerService.refreshCovers(libraryId);
  }
}
