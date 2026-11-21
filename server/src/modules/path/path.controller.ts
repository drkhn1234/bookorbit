import type {
  FolderInspection,
  FolderListing,
  FolderPlaces,
  FolderSearchResult,
  FolderSummary,
  PathConfig,
  UnclaimedFolders,
} from '@bookorbit/types';
import { Permission } from '@bookorbit/types';
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ForbidPermission } from '../../common/decorators/forbid-permission.decorator';
import { KeyReadSafe } from '../../common/decorators/api-key-policy.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { PathScopeDto } from './dto/path-scope.dto';
import { AdoptPersonalRootDto } from './dto/adopt-personal-root.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { FolderPathQueryDto } from './dto/folder-path-query.dto';
import { FolderSummariesDto } from './dto/folder-summaries.dto';
import { SearchFoldersQueryDto } from './dto/search-folders-query.dto';
import { FolderInsightService } from './folder-insight.service';
import { PathService } from './path.service';

@Controller('path')
@ForbidPermission(Permission.DemoRestricted, 'Demo-restricted accounts cannot manage storage')
export class PathController {
  constructor(
    private readonly pathService: PathService,
    private readonly folderInsight: FolderInsightService,
  ) {}

  @Get('config')
  getConfig(@CurrentUser() user: RequestUser, @Query() query: PathScopeDto): Promise<PathConfig> {
    return this.pathService.getConfig({ user, scope: query.scope });
  }

  @Get()
  listDirectories(@CurrentUser() user: RequestUser, @Query() query: FolderPathQueryDto) {
    return this.pathService.listDirectories({ user, scope: query.scope }, query.path);
  }

  @Get('listing')
  listFolder(@CurrentUser() user: RequestUser, @Query() query: FolderPathQueryDto): Promise<FolderListing> {
    return this.pathService.listFolder({ user, scope: query.scope }, query.path);
  }

  @Post('summaries')
  @HttpCode(200)
  @KeyReadSafe()
  summarize(@CurrentUser() user: RequestUser, @Body() dto: FolderSummariesDto, @Query() query: PathScopeDto): Promise<FolderSummary[]> {
    return this.folderInsight.summarize({ user, scope: query.scope }, dto.paths);
  }

  @Get('inspect')
  inspect(@CurrentUser() user: RequestUser, @Query() query: FolderPathQueryDto): Promise<FolderInspection> {
    return this.folderInsight.inspect({ user, scope: query.scope }, query.path ?? '');
  }

  @Get('search')
  search(@CurrentUser() user: RequestUser, @Query() query: SearchFoldersQueryDto): Promise<FolderSearchResult> {
    return this.pathService.searchFolders({ user, scope: query.scope }, query.q, query.path, query.system === 'true');
  }

  @Get('places')
  places(@CurrentUser() user: RequestUser, @Query() query: PathScopeDto): Promise<FolderPlaces> {
    return this.pathService.getPlaces({ user, scope: query.scope });
  }

  @Get('unclaimed')
  unclaimed(@CurrentUser() user: RequestUser, @Query() query: PathScopeDto): Promise<UnclaimedFolders> {
    return this.folderInsight.unclaimed({ user, scope: query.scope });
  }

  @Post()
  async createFolder(@CurrentUser() user: RequestUser, @Body() dto: CreateFolderDto, @Query() query: PathScopeDto) {
    const created = await this.pathService.createDirectory({ user, scope: query.scope }, dto.parentPath, dto.name);
    this.folderInsight.forget();
    return created;
  }

  @Post('adopt-personal-root')
  @RequirePermission(Permission.ManageLibraries)
  async adoptPersonalRoot(@CurrentUser() user: RequestUser, @Body() dto: AdoptPersonalRootDto): Promise<PathConfig> {
    const root = await this.pathService.adoptPersonalRoot(user, dto.userId);
    this.folderInsight.forget();
    return { root };
  }
}
