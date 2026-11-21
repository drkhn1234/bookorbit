import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { JOB_LIST_DEFAULT_LIMIT, JOBS_VIEW_PERMISSIONS, Permission, type JobActionResponse, type JobList, type JobsSummary } from '@bookorbit/types';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { PermissionService } from '../../common/services/permission.service';
import type { RequestUser } from '../../common/types/request-user';
import { JobActionDto, JobListQueryDto } from './dto/jobs.dto';
import { JobsService } from './jobs.service';

/**
 * The Jobs area's list and actions, for signed-in sessions only in this release. Holding any of the
 * view permissions or a scoped bulk capability opens the routes. Each job source scopes its own rows.
 */
@Controller('jobs')
@InteractiveOnly()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly permissions: PermissionService,
    private readonly libraries: LibraryScopeService,
  ) {}

  /** One page of a view. `403` for `scope=everyone` without that grant on any type; `400` for a cursor from another list. */
  @Get()
  async list(@Query() query: JobListQueryDto, @CurrentUser() user: RequestUser): Promise<JobList> {
    await this.requireJobsAccess(user);
    return this.jobs.list(user, {
      view: query.view ?? 'queue',
      type: query.type ?? null,
      scope: query.scope ?? 'mine',
      cursor: query.cursor ?? null,
      limit: query.limit ?? JOB_LIST_DEFAULT_LIMIT,
      counts: query.counts === true,
    });
  }

  /** The viewer's own running, waiting, needs-you and failed counts, and which ownerless work is running. */
  @Get('summary')
  async summary(@CurrentUser() user: RequestUser): Promise<JobsSummary> {
    await this.requireJobsAccess(user);
    return this.jobs.summary(user);
  }

  /** One action on up to 100 jobs of any types, with what happened to each. */
  @Post('actions')
  @HttpCode(HttpStatus.OK)
  async act(@Body() dto: JobActionDto, @CurrentUser() user: RequestUser): Promise<JobActionResponse> {
    await this.requireJobsAccess(user);
    return this.jobs.act(user, dto.action, dto.ids);
  }
  private async requireJobsAccess(user: RequestUser): Promise<void> {
    if (JOBS_VIEW_PERMISSIONS.some((permission) => this.permissions.userHas(user, permission))) return;
    if ((await this.libraries.permittedIds(user, Permission.LibraryEditMetadata)).length > 0) return;
    throw new ForbiddenException(`Missing permission: ${JOBS_VIEW_PERMISSIONS.join(' or ')}`);
  }
}
