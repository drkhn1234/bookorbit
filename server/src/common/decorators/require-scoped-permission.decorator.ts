import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@bookorbit/types';

export const SCOPED_PERMISSION_KEY = 'scoped-library-permission';
export interface ScopedPermission {
  permission: Permission;
  resource: 'library' | 'book' | 'file';
  param: string;
}

export const RequireScopedPermission = (permission: Permission, resource: ScopedPermission['resource'], param = 'id') =>
  SetMetadata(SCOPED_PERMISSION_KEY, { permission, resource, param } satisfies ScopedPermission);
