import { Injectable, Logger } from '@nestjs/common';
import { NOTIFICATION_TYPE_META, NotificationType, Permission, isNotificationAllowed, resolveNotificationLevel } from '@bookorbit/types';
import type { NotificationItem, NotificationPreferences } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

import { NotificationGateway } from './notification.gateway';
import { NotificationRepository } from './notification.repository';
import type { NewNotification } from '../../db/schema';
import { apiKeyCredentialOf, type RequestUser } from '../../common/types/request-user';

export type NotificationScope =
  | { kind: 'library'; libraryId: number }
  | { kind: 'user'; userId: number }
  | { kind: 'users'; userIds: number[] }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'all' };

/** Notifications are a transient feed, not an audit trail; the audit log is the durable record. */
const NOTIFICATION_RETENTION_DAYS = 30;

const COALESCED_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.ScanCompleted,
  NotificationType.ScanFailed,
  NotificationType.BooksUnavailable,
  NotificationType.BooksRestored,
  NotificationType.EmailSent,
  NotificationType.EmailFailed,
  NotificationType.FileWriteBackCompleted,
  NotificationType.FileWriteBackFailed,
  NotificationType.FileRenameCompleted,
  NotificationType.FileRenameFailed,
]);

export interface NotifyPayload {
  type: NotificationType;
  title: string;
  message?: string;
  actionUrl?: string;
  meta?: Record<string, unknown>;
  scope: NotificationScope;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repo: NotificationRepository,
    private readonly gateway: NotificationGateway,
  ) {}

  async notify(payload: NotifyPayload): Promise<void> {
    const event = 'notification.notify';
    const scopeLabel = this.formatScope(payload.scope);
    this.logger.log(`[${event}] [start] type=${payload.type} ${scopeLabel} - notification dispatch started`);
    const startedAt = Date.now();

    try {
      const targetUserIds = await this.resolveUserIds(payload.scope);
      if (targetUserIds.length === 0) {
        this.logger.log(
          `[${event}] [end] type=${payload.type} targetUsers=0 eligible=0 durationMs=${Date.now() - startedAt} - notification dispatch completed`,
        );
        return;
      }

      const settingsMap = await this.repo.findUserSettings(targetUserIds);
      const eligibleUserIds = targetUserIds.filter((uid) => this.isEnabled(settingsMap.get(uid), payload.type));

      if (eligibleUserIds.length === 0) {
        this.logger.log(
          `[${event}] [end] type=${payload.type} targetUsers=${targetUserIds.length} eligible=0 durationMs=${Date.now() - startedAt} - notification dispatch completed`,
        );
        return;
      }

      const groupKey = this.buildGroupKey(payload);
      const rows: NewNotification[] = eligibleUserIds.map((userId) => ({
        userId,
        type: payload.type,
        title: payload.title,
        message: payload.message ?? null,
        actionUrl: payload.actionUrl ?? null,
        meta: payload.scope.kind === 'library' ? { ...payload.meta, libraryId: payload.scope.libraryId } : (payload.meta ?? null),
        groupKey,
      }));
      const persisted = await this.repo.insertOrCollapse(rows);
      let insertedCount = 0;
      let collapsedCount = 0;

      for (const notification of persisted) {
        if (notification.count === 1) {
          insertedCount++;
          void this.gateway.emitNew(notification.userId, this.toItem(notification));
        } else {
          collapsedCount++;
          void this.gateway.emitUpdated(notification.userId, this.toItem(notification));
        }
      }

      this.logger.log(
        `[${event}] [end] type=${payload.type} targetUsers=${targetUserIds.length} eligible=${eligibleUserIds.length} inserted=${insertedCount} collapsed=${collapsedCount} durationMs=${Date.now() - startedAt} - notification dispatch completed`,
      );
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.error(
        `[${event}] [fail] type=${payload.type} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - notification dispatch failed`,
      );
      throw error;
    }
  }

  async list(user: RequestUser, limit: number, offset: number) {
    const { items, total } = await this.repo.findByUser(user.id, limit, offset, apiKeyCredentialOf(user)?.libraryIds);
    return { items: items.map((n) => this.toItem(n)), total };
  }

  async markAsRead(user: RequestUser, id: number): Promise<boolean> {
    const updated = await this.repo.setRead(id, user.id, apiKeyCredentialOf(user)?.libraryIds);
    if (updated) {
      void this.gateway.emitRead(user.id, updated);
      void this.gateway.emitCountUpdate(user.id, updated);
    }
    return updated !== undefined;
  }

  async markAllAsRead(user: RequestUser): Promise<void> {
    const scopes = await this.repo.setAllRead(user.id, apiKeyCredentialOf(user)?.libraryIds);
    void this.gateway.emitRefresh(user.id, scopes);
  }

  async dismiss(user: RequestUser, id: number): Promise<boolean> {
    const deleted = await this.repo.deleteOne(id, user.id, apiKeyCredentialOf(user)?.libraryIds);
    if (deleted) {
      void this.gateway.emitDismissed(user.id, deleted);
      void this.gateway.emitCountUpdate(user.id, deleted);
    }
    return deleted !== undefined;
  }

  async clearAll(user: RequestUser): Promise<void> {
    const scopes = await this.repo.deleteAllForUser(user.id, apiKeyCredentialOf(user)?.libraryIds);
    void this.gateway.emitRefresh(user.id, scopes);
  }

  async getUnreadCount(user: RequestUser): Promise<number> {
    return this.repo.countUnread(user.id, apiKeyCredentialOf(user)?.libraryIds);
  }

  async runRetentionCleanup(days: number = NOTIFICATION_RETENTION_DAYS): Promise<number> {
    const event = 'notification.retention_cleanup';
    const startedAt = Date.now();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    this.logger.log(`[${event}] [start] retentionDays=${days} - notification retention cleanup started`);

    try {
      const deleted = await this.repo.deleteOlderThan(cutoff, (rows) => {
        const scopesByUser = new Map<number, unknown[]>();
        for (const { userId, scope } of rows) {
          const scopes = scopesByUser.get(userId);
          if (scopes) scopes.push(scope);
          else scopesByUser.set(userId, [scope]);
        }
        for (const [userId, scopes] of scopesByUser) void this.gateway.emitRefresh(userId, scopes);
      });
      this.logger.log(
        `[${event}] [end] retentionDays=${days} deleted=${deleted} durationMs=${Date.now() - startedAt} - notification retention cleanup completed`,
      );
      return deleted;
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[${event}] [fail] retentionDays=${days} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - notification retention cleanup failed`,
      );
      throw err;
    }
  }

  private async resolveUserIds(scope: NotificationScope): Promise<number[]> {
    switch (scope.kind) {
      case 'user':
        return [scope.userId];
      case 'users':
        return [...new Set(scope.userIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0))];
      case 'library':
        return this.repo.findUserIdsWithLibraryAccess(scope.libraryId);
      case 'permission':
        return this.repo.findUserIdsWithPermission(scope.permission);
      case 'all':
        return this.repo.findAllActiveUserIds();
    }
  }

  private buildGroupKey(payload: NotifyPayload): string | null {
    if (!COALESCED_NOTIFICATION_TYPES.has(payload.type)) return null;

    switch (payload.scope.kind) {
      case 'library':
        return `${payload.type}:library:${payload.scope.libraryId}`;
      case 'users':
        return null;
      case 'user':
        return `${payload.type}:user`;
      case 'permission':
        return `${payload.type}:permission:${payload.scope.permission}`;
      case 'all':
        return `${payload.type}:all`;
    }
  }

  private isEnabled(settings: Record<string, unknown> | undefined, type: NotificationType): boolean {
    const meta = NOTIFICATION_TYPE_META[type];
    if (!meta) return true;
    if (meta.category === 'bookRequests' && settings?.showBookRequests === false) return false;
    const prefs = settings?.notificationPreferences as NotificationPreferences | undefined;
    const level = resolveNotificationLevel(prefs?.[meta.category]);
    return isNotificationAllowed(level, meta.severity);
  }

  private toItem(n: {
    id: number;
    type: string;
    title: string;
    message: string | null;
    actionUrl: string | null;
    meta: unknown;
    read: boolean;
    count: number;
    createdAt: Date;
    updatedAt: Date;
  }): NotificationItem {
    return {
      id: n.id,
      type: n.type as NotificationType,
      title: n.title,
      message: n.message,
      actionUrl: n.actionUrl,
      meta: (n.meta as Record<string, unknown>) ?? null,
      read: n.read,
      count: n.count,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    };
  }

  private formatScope(scope: NotificationScope): string {
    switch (scope.kind) {
      case 'library':
        return `scope=library libraryId=${scope.libraryId}`;
      case 'user':
        return `scope=user userId=${scope.userId}`;
      case 'users':
        return `scope=users userCount=${scope.userIds.length}`;
      case 'permission':
        return `scope=permission permission=${scope.permission}`;
      case 'all':
        return 'scope=all';
    }
  }
}
