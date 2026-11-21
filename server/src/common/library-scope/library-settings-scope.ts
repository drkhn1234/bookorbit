import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { apiKeyCredentialOf, type RequestUser } from '../types/request-user';
import { hasLibraryAdministratorIntent } from './library-scope.service';

export function requireLibraryAdministrator(user: RequestUser, scope: unknown): void {
  if (!hasLibraryAdministratorIntent(user, scope)) throw new ForbiddenException('Enable Administrator Mode to manage instance settings');
}

/** Null represents instance defaults. Positive account IDs are selected by the authenticated session. */
export function librarySettingsAccount(user: RequestUser, scope?: string): number | null {
  if (scope === 'admin') {
    requireLibraryAdministrator(user, scope);
    return null;
  }
  if (apiKeyCredentialOf(user) || user.permissions.includes(Permission.DemoRestricted))
    throw new ForbiddenException('Library settings require an eligible session');
  return user.id;
}

@Injectable()
export class LibraryAdministratorModeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user: RequestUser; query?: { scope?: string } }>();
    requireLibraryAdministrator(request.user, request.query?.scope);
    return true;
  }
}
