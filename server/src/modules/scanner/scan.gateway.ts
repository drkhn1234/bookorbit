import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { Inject, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

import type {
  BookMergedEvent,
  BookLinksChangedEvent,
  BookDuplicateResolutionEvent,
  BookMergeJobEvent,
  BookMissingEvent,
  BookMovedEvent,
  BookProgressChangedEvent,
  BookRestoredEvent,
  BookTransferredEvent,
  CoverRefreshedEvent,
  CoverRefreshProgressEvent,
  ScanBooksAddedEvent,
  ScanProgressEvent,
} from '@bookorbit/types';
import {
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  AchievementEventsService,
  type BookProgressChangedPayload,
} from '../achievement/achievement-events.service';
import { ScanJobStore } from './scan-job-store.service';
import { ScannerRepository } from './scanner.repository';
import type { RequestUser } from '../../common/types/request-user';
import { rejectSocketConnection, resolveSocketUser, trackSocketHandshake } from '../../common/utils/ws-auth.utils';
import { appConfig } from '../../config/config';
import { BOOK_COVER_CHANGED, BookCoverEventsService } from '../book-cover-store/book-cover-events.service';
import { AuthenticatorService } from '../auth/authenticator.service';

@WebSocketGateway({ namespace: '/scan', cors: { credentials: true } })
export class ScanGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ScanGateway.name);
  private readonly clientOrigin: string;
  private readonly handleBookProgressChanged = (payload: BookProgressChangedPayload): void => {
    void this.emitBookProgressChanged(payload);
  };
  private readonly handleCoverChanged = (event: CoverRefreshedEvent): void => {
    void this.emitCoverRefreshed(event);
  };

  constructor(
    private readonly authenticator: AuthenticatorService,
    private readonly scanJobStore: ScanJobStore,
    private readonly scannerRepository: ScannerRepository,
    private readonly achievementEvents: AchievementEventsService,
    private readonly libraryScope: LibraryScopeService,
    @Inject(appConfig.KEY) app: ConfigType<typeof appConfig>,
    @Optional() private readonly coverEvents?: BookCoverEventsService,
  ) {
    this.clientOrigin = app.appUrl;
  }

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.handleBookProgressChanged);
    this.coverEvents?.on(BOOK_COVER_CHANGED, this.handleCoverChanged);
  }

  onModuleDestroy(): void {
    this.achievementEvents.removeListener(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.handleBookProgressChanged);
    this.coverEvents?.removeListener(BOOK_COVER_CHANGED, this.handleCoverChanged);
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
    await trackSocketHandshake(client, this.authenticate(client));
  }

  private async authenticate(client: Socket): Promise<RequestUser | null> {
    try {
      const user = await this.authenticator.authenticateSocket(client);
      (client.data as Record<string, unknown>).user = user;
      await client.join(`user:${user.id}`);
      this.logger.debug(`[scanner.ws_connection] [start] userId=${user.id} socketId=${client.id} - websocket connected`);
      return user;
    } catch (err) {
      this.logger.warn(
        `[scanner.ws_connection] [fail] socketId=${client.id} errorClass=${err instanceof Error ? err.name : 'Error'} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - websocket rejected`,
      );
      rejectSocketConnection(client, err);
      return null;
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[scanner.ws_connection] [end] socketId=${client.id} - websocket disconnected`);
  }

  /**
   * A library room carries the library's book cards and scan counts, so joining one needs the same
   * access as reading the library over HTTP.
   */
  @SubscribeMessage('subscribe:library')
  async handleSubscribeLibrary(client: Socket, libraryId: number): Promise<void> {
    if (!Number.isSafeInteger(libraryId) || libraryId <= 0 || !(await resolveSocketUser(client))) return;
    const user = await this.currentUser(client);
    if (!user) return;
    if (!(await this.libraryScope.canSee(user, libraryId))) {
      this.logger.debug(`[scanner.ws_subscribe] [fail] userId=${user.id} libraryId=${libraryId} socketId=${client.id} - no library access`);
      return;
    }
    await client.join(`library:${libraryId}`);
    // Send current snapshot immediately so reconnecting clients catch up.
    const entry = this.scanJobStore.get(libraryId);
    if (entry) {
      const event: ScanProgressEvent = {
        jobId: entry.jobId,
        libraryId,
        status: 'running',
        processed: entry.processed,
        total: entry.total,
        added: entry.added,
        updated: entry.updated,
        missing: entry.missing,
      };
      client.emit('scan:progress', event);
    }
  }

  private async currentUser(client: Socket): Promise<RequestUser | null> {
    try {
      const user = await this.authenticator.authenticateSocket(client);
      client.data.user = user;
      return user;
    } catch (error) {
      rejectSocketConnection(client, error);
      return null;
    }
  }

  private async emitLibraryEvent(libraryIds: number[], name: string, event: unknown): Promise<void> {
    if (!this.server) return;
    const ids = [...new Set(libraryIds)];
    try {
      const clients = await this.server.in(ids.map((id) => `library:${id}`)).fetchSockets();
      await mapWithConcurrency(clients, 8, async (client) => {
        const user = await this.currentUser(client as unknown as Socket);
        if (!user) return;
        const visible = await this.libraryScope.filterVisible(user, ids);
        for (const id of ids) {
          if (!visible.includes(id)) client.leave(`library:${id}`);
        }
        if (visible.length === 0) return;
        // A transfer/merge can cross a private boundary. Refresh the visible side without naming it.
        if (visible.length !== ids.length) client.emit('library:changed', { libraryIds: visible });
        else client.emit(name, event);
      });
    } catch (error) {
      this.logger.warn(
        `[scanner.ws_emit] [fail] event="${sanitizeLogValue(name)}" error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - library event delivery failed`,
      );
    }
  }

  emitProgress(event: ScanProgressEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'scan:progress', event);
  }

  emitCoverRefreshProgress(event: CoverRefreshProgressEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'cover:refresh:progress', event);
  }

  emitCoverRefreshed(event: CoverRefreshedEvent): Promise<void> {
    if (event.libraryId === undefined) return Promise.resolve();
    return this.emitLibraryEvent([event.libraryId], 'cover:refreshed', event);
  }

  emitBookMissing(event: BookMissingEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'book:missing', event);
  }

  emitBookRestored(event: BookRestoredEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'book:restored', event);
  }

  emitBookMoved(event: BookMovedEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'book:moved', event);
  }

  emitBookTransferred(event: BookTransferredEvent): Promise<void> {
    return this.emitLibraryEvent([event.fromLibraryId, event.toLibraryId], 'book:transferred', event);
  }

  emitBookMerged(event: BookMergedEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId, ...(event.sourceLibraryIds ?? [])], 'book:merged', event);
  }

  emitBookMergeJob(userId: number, phase: 'progress' | 'finished', event: BookMergeJobEvent, libraryIds: number[]): Promise<void> {
    return this.emitUserLibraryEvent(userId, `book-merge:${phase}`, event, libraryIds);
  }

  emitDuplicateResolution(userId: number, phase: 'progress' | 'finished', event: BookDuplicateResolutionEvent, libraryIds: number[]): Promise<void> {
    return this.emitUserLibraryEvent(userId, `book-duplicates:resolution-${phase}`, event, libraryIds);
  }

  emitBookLinksChanged(event: BookLinksChangedEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'book:links-changed', event);
  }

  async emitBookProgressChanged(payload: BookProgressChangedPayload): Promise<void> {
    if (!this.server) return;
    const event: BookProgressChangedEvent = {
      bookId: payload.bookId,
      progress: payload.progress,
      source: payload.source,
    };
    try {
      const [book] = await this.scannerRepository.findBooksByIds([payload.bookId]);
      if (book) await this.emitUserLibraryEvent(payload.userId, 'book:progress-changed', event, [book.libraryId]);
    } catch (error) {
      this.logger.warn(
        `[scanner.ws_emit] [fail] bookId=${payload.bookId} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - book progress delivery failed`,
      );
    }
  }

  private async emitUserLibraryEvent(userId: number, name: string, event: unknown, libraryIds: number[]): Promise<void> {
    if (!this.server) return;
    try {
      const clients = await this.server.in(`user:${userId}`).fetchSockets();
      await mapWithConcurrency(clients, 8, async (client) => {
        const user = await this.currentUser(client as unknown as Socket);
        if (user?.id !== userId) return;
        const visible = await this.libraryScope.filterVisible(user, libraryIds);
        if (visible.length === libraryIds.length) client.emit(name, event);
      });
    } catch (error) {
      this.logger.warn(
        `[scanner.ws_emit] [fail] event="${sanitizeLogValue(name)}" error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - user library event delivery failed`,
      );
    }
  }

  emitBooksAdded(event: ScanBooksAddedEvent): Promise<void> {
    return this.emitLibraryEvent([event.libraryId], 'scan:books:added', event);
  }
}
