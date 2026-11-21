import { Injectable } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { apiKeyCredentialOf } from '../../common/types/request-user';
import type { BulkRunRow } from '../../db/schema';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { ApiKeyAuthenticator } from '../api-key/api-key.authenticator';
import { runAsApiKey } from '../audit/api-key-audit-context';
import { AuthService } from '../auth/auth.service';

/** Why a run stopped before its end: the account or key it acts as may no longer do this. */
export class BulkRunStopped extends Error {
  constructor(readonly code: 'credential-revoked' | 'access-revoked' | 'requester-gone') {
    super(code);
    this.name = 'BulkRunStopped';
  }
}

/**
 * The account a run acts as, checked again as the run goes so that revoking a key, a permission
 * or the account stops it. A key run acts as the owner cut down to the key, and its audit events
 * name the key.
 */
@Injectable()
export class BulkRunActorService {
  constructor(
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeyAuthenticator,
    private readonly libraries: LibraryScopeService,
  ) {}

  async resolve(run: Pick<BulkRunRow, 'requestedBy' | 'credentialKind' | 'apiKeyId'>): Promise<RequestUser> {
    if (run.requestedBy === null) throw new BulkRunStopped('requester-gone');
    if (run.credentialKind === 'api_key') {
      if (run.apiKeyId === null) throw new BulkRunStopped('credential-revoked');
      const actor = await this.apiKeys.actorForStoredKey(run.apiKeyId, run.requestedBy);
      if (!actor || !(await this.mayRunBulk(actor))) throw new BulkRunStopped('credential-revoked');
      return actor;
    }
    const user = await this.auth.findActingUser(run.requestedBy);
    if (!user || !(await this.mayRunBulk(user))) throw new BulkRunStopped('access-revoked');
    return user;
  }

  private async mayRunBulk(user: RequestUser): Promise<boolean> {
    if (user.permissions.includes(Permission.DemoRestricted)) return false;
    if (user.isSuperuser || user.permissions.includes(Permission.LibraryEditMetadata)) return true;
    return (await this.libraries.permittedIds(user, Permission.LibraryEditMetadata)).length > 0;
  }

  /** Runs `work` so that audit events it causes name the key the run acts with, if any. */
  as<T>(actor: RequestUser, work: () => Promise<T>): Promise<T> {
    const credential = apiKeyCredentialOf(actor);
    return credential ? runAsApiKey({ keyId: credential.keyId, keyName: credential.keyName }, work) : work();
  }
}
