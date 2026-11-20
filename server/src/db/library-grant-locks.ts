import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Permission, RESTRICTIVE_PERMISSIONS } from '@bookorbit/types';
import { and, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { apiKeyCredentialOf, type RequestUser } from '../common/types/request-user';
import * as schema from './schema';

type Db = NodePgDatabase<typeof schema>;
type GrantTransaction = Pick<Parameters<Parameters<Db['transaction']>[0]>[0], 'execute' | 'select'>;

// Grant writers take the target account first, then the folder registry (creation only),
// then library parents in ascending order. The two-key advisory lock also covers empty grant sets.
const GRANT_ACCOUNT_LOCK = 72104914;

export async function lockGrantAccount(tx: GrantTransaction, userId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${GRANT_ACCOUNT_LOCK}::int, ${userId}::int)`);
}

export async function lockGrantLibraries(tx: GrantTransaction, libraryIds: readonly number[]): Promise<Set<number>> {
  if (!libraryIds.length) return new Set();
  const rows = await tx
    .select({ id: schema.libraries.id })
    .from(schema.libraries)
    .where(inArray(schema.libraries.id, libraryIds))
    .orderBy(schema.libraries.id)
    .for('no key update');
  return new Set(rows.map(({ id }) => id));
}

/** Recheck persisted authority after lock waits, without expanding the admitted credential's permissions. */
export async function currentGrantActor(tx: GrantTransaction, actor: RequestUser): Promise<Pick<RequestUser, 'isSuperuser' | 'permissions'>> {
  const key = apiKeyCredentialOf(actor);
  const now = new Date();
  const { apiKeys, authSessions, userPermissions, users } = schema;
  const liveCredential = key
    ? exists(
        tx
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, key.keyId),
              eq(apiKeys.userId, actor.id),
              eq(apiKeys.audience, 'api'),
              eq(apiKeys.access, 'write'),
              isNull(apiKeys.revokedAt),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
            ),
          ),
      )
    : actor.credential?.kind === 'session'
      ? exists(
          tx
            .select({ id: authSessions.id })
            .from(authSessions)
            .where(
              and(
                eq(authSessions.id, actor.credential.sessionId),
                eq(authSessions.userId, actor.id),
                eq(authSessions.tokenVersion, actor.tokenVersion),
                isNull(authSessions.revokedAt),
                gt(authSessions.expiresAt, now),
              ),
            ),
        )
      : undefined;
  const rows = await tx
    .select({ isSuperuser: users.isSuperuser, permission: userPermissions.permissionName })
    .from(users)
    .leftJoin(userPermissions, eq(userPermissions.userId, users.id))
    .where(and(eq(users.id, actor.id), eq(users.active, true), key ? undefined : eq(users.tokenVersion, actor.tokenVersion), liveCredential));
  if (!rows.length) throw new UnauthorizedException();

  const permissions = rows.flatMap(({ permission }) => (permission ? [permission as Permission] : []));
  if (key && !rows[0].isSuperuser && !permissions.includes(Permission.ApiKeys)) throw new ForbiddenException('API key owner no longer has access');

  // A non-admin key held by a superuser still gets its explicitly delegated permissions.
  const liveGrants = rows[0].isSuperuser ? actor.permissions : permissions;
  const granted = actor.permissions.filter((permission) => liveGrants.includes(permission) && !RESTRICTIVE_PERMISSIONS.includes(permission));
  const restrictions = permissions.filter((permission) => RESTRICTIVE_PERMISSIONS.includes(permission));
  return { isSuperuser: actor.isSuperuser && rows[0].isSuperuser, permissions: [...granted, ...restrictions] };
}
