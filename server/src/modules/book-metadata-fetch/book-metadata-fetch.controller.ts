import { UseGuards } from '@nestjs/common';
import { LibraryAdministratorModeGuard, librarySettingsAccount } from '../../common/library-scope/library-settings-scope';
import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { type BookMetadataFetchConfig, type BookMetadataFetchConfigOverride, Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import type { RequestUser } from '../../common/types/request-user';
import { InteractiveOnly, KeyReadSafe } from '../../common/decorators/api-key-policy.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BookMetadataFetchConfigService } from './book-metadata-fetch-config.service';
import { BookMetadataFetchOrchestratorService } from './book-metadata-fetch-orchestrator.service';
import { BookMetadataFetchPreviewService } from './book-metadata-fetch-preview.service';
import { BookMetadataFetchQueueRepository } from './book-metadata-fetch-queue.repository';
import { BookMetadataFetchSessionService } from './book-metadata-fetch-session.service';
import { TriggerBookMetadataFetchRunDto } from './dto/trigger-run.dto';
import {
  PreviewBooksDto,
  PreviewCountDto,
  PreviewScopeDto,
  UpdateBookMetadataFetchConfigDto,
  UpdateLibraryBookMetadataFetchConfigDto,
} from './dto/update-config.dto';

@Controller('book-metadata-fetch')
export class BookMetadataFetchController {
  constructor(
    private readonly configService: BookMetadataFetchConfigService,
    private readonly orchestrator: BookMetadataFetchOrchestratorService,
    private readonly queueRepo: BookMetadataFetchQueueRepository,
    private readonly session: BookMetadataFetchSessionService,
    private readonly preview: BookMetadataFetchPreviewService,
    private readonly libraries: LibraryScopeService,
  ) {}

  @Get('config')
  @Header('Cache-Control', 'private, no-store')
  @InteractiveOnly()
  getConfig(@CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    librarySettingsAccount(user, scope);
    return this.configService.getGlobalConfig();
  }

  @Put('config')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async updateConfig(@Body() dto: UpdateBookMetadataFetchConfigDto) {
    await this.configService.setGlobalConfig(dto);
    return this.configService.getGlobalConfig();
  }

  @Get('config/libraries')
  @Header('Cache-Control', 'private, no-store')
  @InteractiveOnly()
  async listLibraryConfigs(@CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    const account = librarySettingsAccount(user, scope);
    return this.configService.listLibraryConfigs(account === null ? undefined : await this.libraries.ownedIds(user));
  }

  @Get('config/libraries/:id')
  @Header('Cache-Control', 'private, no-store')
  @InteractiveOnly()
  async getLibraryConfig(@Param('id', ParseIntPipe) libraryId: number, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    if (librarySettingsAccount(user, scope) !== null) await this.libraries.assertLevel(user, libraryId, 'owner');
    return this.configService.getLibraryConfigWithLastRun(libraryId);
  }

  @Put('config/libraries/:id')
  @InteractiveOnly()
  async updateLibraryConfig(
    @Param('id', ParseIntPipe) libraryId: number,
    @Body() dto: UpdateLibraryBookMetadataFetchConfigDto,
    @CurrentUser() user: RequestUser,
    @Query('scope') scope?: string,
  ) {
    if (librarySettingsAccount(user, scope) !== null) await this.libraries.assertLevel(user, libraryId, 'owner');
    const override: BookMetadataFetchConfigOverride = Object.keys(dto).length === 0 ? null : dto;
    await this.configService.setLibraryOverride(libraryId, override);
    return this.configService.getLibraryConfigWithLastRun(libraryId);
  }

  @Get('status')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async getStatus() {
    const [summary, paused] = await Promise.all([this.queueRepo.getStatusSummary(), this.configService.isPaused()]);
    return { ...summary, paused, ...this.session.getSnapshot() };
  }

  @Post('run')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async triggerGlobal(@Body() dto: TriggerBookMetadataFetchRunDto) {
    const queued = await this.orchestrator.triggerGlobal(dto?.ignoreCache === true);
    return { queued };
  }

  @Post('run/:libraryId')
  @InteractiveOnly()
  async triggerForLibrary(
    @Param('libraryId', ParseIntPipe) libraryId: number,
    @Body() dto: TriggerBookMetadataFetchRunDto,
    @CurrentUser() user: RequestUser,
    @Query('scope') scope?: string,
  ) {
    if (librarySettingsAccount(user, scope) !== null) await this.libraries.assertLevel(user, libraryId, 'owner');
    const queued = await this.orchestrator.triggerForLibrary(libraryId, dto?.ignoreCache === true);
    return { queued };
  }

  @Post('pause')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async pause() {
    await this.orchestrator.pause();
    return { paused: true };
  }

  @Post('resume')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async resume() {
    await this.orchestrator.resume();
    return { paused: false };
  }

  @Post('cancel')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async cancel() {
    await this.orchestrator.cancelPending();
    return { cancelled: true };
  }

  @Post('retry-failed')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async retryFailed() {
    const requeued = await this.orchestrator.requeueFailed();
    return { requeued };
  }

  @Post('preview-count')
  @KeyReadSafe()
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async previewCount(@Body() dto: PreviewCountDto) {
    const config: BookMetadataFetchConfig = {
      enabled: true,
      triggerOnImport: false,
      conditions: dto.conditions,
    };
    const count = await this.queueRepo.countEligibleBooks(config, dto.libraryId);
    return { count };
  }

  @Post('preview-breakdown')
  @KeyReadSafe()
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  previewBreakdown(@Body() dto: PreviewScopeDto) {
    return this.preview.breakdown(dto);
  }

  @Post('preview-books')
  @KeyReadSafe()
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  previewBooks(@Body() dto: PreviewBooksDto) {
    return this.preview.previewBooks({ conditions: dto.conditions, libraryIds: dto.libraryIds }, dto.limit);
  }

  @Get('failed')
  @RequirePermission(Permission.ManageMetadataConfig)
  @UseGuards(LibraryAdministratorModeGuard)
  async getFailedItems(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const { items, total } = await this.queueRepo.getFailedItems(safePage, safeLimit);
    return { items, total, page: safePage, limit: safeLimit };
  }
}
