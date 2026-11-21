import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@bookorbit/types';

import { FORBIDDEN_PERMISSION_KEY, type ForbiddenPermissionRule } from '../decorators/forbid-permission.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ANY_PERMISSION_KEY } from '../decorators/require-any-permission.decorator';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { PermissionService } from '../services/permission.service';
import { RequestUser } from '../types/request-user';
import { SCOPED_PERMISSION_KEY, type ScopedPermission } from '../decorators/require-scoped-permission.decorator';
import { LibraryScopeService } from '../library-scope/library-scope.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
    private readonly libraryScope: LibraryScopeService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ user: RequestUser; params?: Record<string, string>; query?: { scope?: string } }>();
    const user = request.user;
    const forbidden = this.reflector.getAllAndOverride<ForbiddenPermissionRule | undefined>(FORBIDDEN_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (forbidden && this.permissionService.userHasExplicit(user, forbidden.permission)) {
      throw new ForbiddenException(forbidden.message ?? `Forbidden permission: ${forbidden.permission}`);
    }

    const scoped = this.reflector.getAllAndOverride<ScopedPermission>(SCOPED_PERMISSION_KEY, [context.getHandler()]);
    if (scoped) {
      const id = Number(request.params?.[scoped.param]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('Missing or invalid resource identifier');
      return this.libraryScope.assertResourcePermission(user, scoped.resource, id, scoped.permission, request.query?.scope).then(() => true);
    }

    const anyOf = this.reflector.getAllAndOverride<Permission[] | undefined>(ANY_PERMISSION_KEY, [context.getHandler()]);
    if (anyOf) {
      if (anyOf.some((permission) => this.permissionService.userHas(user, permission))) return true;
      throw new ForbiddenException(`Missing permission: ${anyOf.join(' or ')}`);
    }

    const required = this.reflector.getAllAndOverride<Permission | Permission[] | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const permissions = Array.isArray(required) ? required : [required];
    const missing = permissions.find((permission) => !this.permissionService.userHas(user, permission));
    if (missing) {
      throw new ForbiddenException(`Missing permission: ${missing}`);
    }
    return true;
  }
}
