import { ForbiddenException, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Permission, READ_ALOUD_JOB_UPDATED_EVENT, READ_ALOUD_SOCKET_NAMESPACE, type ReadAloudJob } from '@bookorbit/types';

import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { rejectSocketConnection } from '../../common/utils/ws-auth.utils';
import { wsCorsOrigin } from '../../common/utils/ws-cors.utils';
import { AuthenticatorService } from '../auth/authenticator.service';

function userRoom(userId: number): string {
  return `read-aloud:user:${userId}`;
}

/**
 * Live job updates go only to the job's requester: the payload is the requester's view of the job,
 * and other viewers of the book read the same job over HTTP, scoped by the same rules.
 */
@WebSocketGateway({ namespace: READ_ALOUD_SOCKET_NAMESPACE, cors: { origin: wsCorsOrigin() } })
export class ReadAloudGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ReadAloudGateway.name);

  constructor(
    private readonly authenticator: AuthenticatorService,
    private readonly libraryScope: LibraryScopeService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const user = await this.authenticator.authenticateSocket(client);
      if (user.permissions.includes(Permission.DemoRestricted)) throw new ForbiddenException('Demo-restricted account');
      if (!(await this.libraryScope.permittedIds(user, Permission.LibraryGenerateReadAloud)).length) {
        throw new ForbiddenException('Missing read-aloud permission');
      }
      await client.join(userRoom(user.id));
    } catch (err) {
      this.logger.warn(
        `[read_aloud.ws_connect] [fail] socket=${client.id} errorClass=${(err as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue((err as Error).message)}" - handshake refused`,
      );
      rejectSocketConnection(client, err);
    }
  }

  handleDisconnect(): void {}

  emitJobUpdated(userId: number, job: ReadAloudJob): void {
    this.server?.to(userRoom(userId)).emit(READ_ALOUD_JOB_UPDATED_EVENT, job);
  }
}
