import { ForbiddenException, Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Permission } from '@bookorbit/types';
import type { NotificationItem } from '@bookorbit/types';
import { Server, Socket } from 'socket.io';

import { apiKeyCredentialOf, type RequestUser } from '../../common/types/request-user';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { AuthenticatorService } from '../auth/authenticator.service';
import { NotificationRepository } from './notification.repository';
import { rejectSocketConnection } from '../../common/utils/ws-auth.utils';
import { appConfig } from '../../config/config';
import type { Notification } from '../../db/schema';

@WebSocketGateway({ namespace: '/notifications', cors: { credentials: true } })
export class NotificationGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(NotificationGateway.name);
  private readonly clientOrigin: string;

  constructor(
    private readonly authenticator: AuthenticatorService,
    private readonly notificationRepo: NotificationRepository,
    @Inject(appConfig.KEY) app: ConfigType<typeof appConfig>,
    private readonly libraryScope: LibraryScopeService,
  ) {
    this.clientOrigin = app.appUrl;
  }

  afterInit(server: Server): void {
    if (!server.engine?.opts) return;
    server.engine.opts.cors = {
      ...(server.engine.opts.cors ?? {}),
      origin: this.clientOrigin,
      credentials: true,
    };
  }

  async handleConnection(client: Socket): Promise<void> {
    const event = 'notification.socket';
    try {
      const user = await this.authenticator.authenticateSocket(client);

      this.assertHasAccess(user);

      await client.join(`user:${user.id}`);
      this.logger.debug(`[${event}] [start] userId=${user.id} socketId=${client.id} - websocket connected`);

      const unreadCount = await this.notificationRepo.countUnread(user.id, apiKeyCredentialOf(user)?.libraryIds);
      client.emit('notification:unread-count', { count: unreadCount });
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      const message = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[${event}] [fail] socketId=${client.id} errorClass=${errorClass} error="${message}" - websocket rejected`);
      rejectSocketConnection(client, err);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[notification.socket] [end] socketId=${client.id} - websocket disconnected`);
  }

  emitNew(userId: number, notification: NotificationItem): Promise<void> {
    return this.emitNotification(userId, 'notification:new', [notification.meta], notification);
  }

  /**
   * A collapsed occurrence. Separate from emitNew because the row was already unread and already
   * counted; reusing emitNew would double-count the unread badge and the page total.
   */
  emitUpdated(userId: number, notification: NotificationItem): Promise<void> {
    return this.emitNotification(userId, 'notification:updated', [notification.meta], notification);
  }

  emitRefresh(userId: number, scopes: readonly unknown[]): Promise<void> {
    return this.emitNotification(userId, 'notification:refresh', scopes);
  }

  emitCountUpdate(userId: number, notification: Pick<Notification, 'meta'>): Promise<void> {
    return this.emitNotification(userId, 'notification:unread-count', [notification.meta]);
  }

  emitRead(userId: number, notification: Pick<Notification, 'id' | 'meta'>): Promise<void> {
    return this.emitNotification(userId, 'notification:read', [notification.meta], { id: notification.id });
  }

  emitDismissed(userId: number, notification: Pick<Notification, 'id' | 'meta'>): Promise<void> {
    return this.emitNotification(userId, 'notification:dismissed', [notification.meta], { id: notification.id });
  }

  private async emitNotification(
    userId: number,
    name: string,
    scopes: readonly unknown[],
    payload?: NotificationItem | { id: number },
  ): Promise<void> {
    if (!scopes.length) return;
    const requiredLibraries = scopes.map(notificationLibraryIds).filter((ids) => ids !== null);
    if (!requiredLibraries.length) return;
    const unscoped = requiredLibraries.some((ids) => ids.length === 0);
    if (!this.server) return;
    try {
      const clients = await this.server.in(`user:${userId}`).fetchSockets();
      await mapWithConcurrency(clients, 8, async (client) => {
        let user: RequestUser;
        try {
          user = await this.authenticator.authenticateSocket(client as unknown as Socket);
          this.assertHasAccess(user);
          if (user.id !== userId) return;
        } catch (error) {
          rejectSocketConnection(client as unknown as Socket, error);
          return;
        }
        if (!unscoped) {
          const visible = new Set(await this.libraryScope.visibleIds(user));
          if (!requiredLibraries.some((ids) => ids.every((id) => visible.has(id)))) return;
        }
        const data =
          name === 'notification:unread-count'
            ? { count: await this.notificationRepo.countUnread(user.id, apiKeyCredentialOf(user)?.libraryIds) }
            : payload;
        client.emit(name, data);
      });
    } catch (error) {
      this.logger.warn(
        `[notification.socket] [fail] userId=${userId} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - notification delivery failed`,
      );
    }
  }

  private assertHasAccess(user: RequestUser): void {
    if (user.permissions.includes(Permission.DemoRestricted)) {
      throw new ForbiddenException('Demo-restricted account cannot access notifications');
    }
    if (user.isSuperuser) return;
    if (user.permissions.includes(Permission.NotificationAccess)) return;
    throw new ForbiddenException('Missing permission: notification_access');
  }
}

function isLibraryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// A legacy move notice supplies only the destination and cannot be safely scoped.
function notificationLibraryIds(meta: unknown): number[] | null {
  if (!meta || typeof meta !== 'object') return [];
  const fields = meta as Record<string, unknown>;
  if ('targetLibraryId' in fields || 'sourceLibraryIds' in fields) {
    const { targetLibraryId, sourceLibraryIds } = fields;
    if (!isLibraryId(targetLibraryId) || !Array.isArray(sourceLibraryIds) || !sourceLibraryIds.length || !sourceLibraryIds.every(isLibraryId)) {
      return null;
    }
    return [targetLibraryId, ...sourceLibraryIds];
  }
  const { libraryId } = fields;
  if (libraryId == null) return [];
  if (isLibraryId(libraryId)) return [libraryId];
  if (typeof libraryId !== 'string') return null;
  const id = Number(libraryId);
  return isLibraryId(id) && String(id) === libraryId ? [id] : null;
}
