import { NotificationType, Permission } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import type { NotifyPayload } from './notification.service';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let repo: {
    insertOrCollapse: ReturnType<typeof vi.fn>;
    findByUser: ReturnType<typeof vi.fn>;
    countUnread: ReturnType<typeof vi.fn>;
    setRead: ReturnType<typeof vi.fn>;
    setAllRead: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    deleteAllForUser: ReturnType<typeof vi.fn>;
    deleteOlderThan: ReturnType<typeof vi.fn>;
    findUserIdsWithLibraryAccess: ReturnType<typeof vi.fn>;
    findUserIdsWithPermission: ReturnType<typeof vi.fn>;
    findAllActiveUserIds: ReturnType<typeof vi.fn>;
    findUserSettings: ReturnType<typeof vi.fn>;
  };
  let gateway: {
    emitNew: ReturnType<typeof vi.fn>;
    emitUpdated: ReturnType<typeof vi.fn>;
    emitRefresh: ReturnType<typeof vi.fn>;
    emitCountUpdate: ReturnType<typeof vi.fn>;
    emitRead: ReturnType<typeof vi.fn>;
    emitDismissed: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repo = {
      insertOrCollapse: vi.fn(),
      findByUser: vi.fn(),
      countUnread: vi.fn(),
      setRead: vi.fn(),
      setAllRead: vi.fn(),
      deleteOne: vi.fn(),
      deleteAllForUser: vi.fn(),
      deleteOlderThan: vi.fn(),
      findUserIdsWithLibraryAccess: vi.fn(),
      findUserIdsWithPermission: vi.fn(),
      findAllActiveUserIds: vi.fn(),
      findUserSettings: vi.fn(),
    };
    gateway = {
      emitNew: vi.fn(),
      emitUpdated: vi.fn(),
      emitRefresh: vi.fn(),
      emitCountUpdate: vi.fn(),
      emitRead: vi.fn(),
      emitDismissed: vi.fn(),
    };
    service = new NotificationService(repo as never, gateway as never);
  });

  function makeInserted(userId: number, overrides?: Partial<{ id: number; type: string; title: string; count: number }>) {
    return {
      id: overrides?.id ?? 1,
      userId,
      type: overrides?.type ?? 'scan_completed',
      title: overrides?.title ?? 'Library scan completed',
      message: null,
      actionUrl: null,
      meta: null,
      read: false,
      count: overrides?.count ?? 1,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
  }

  function makePayload(scope: NotifyPayload['scope'], overrides?: Partial<NotifyPayload>): NotifyPayload {
    return {
      type: 'scan_completed',
      title: 'Library scan completed',
      scope,
      ...overrides,
    };
  }

  // ---------- notify() ----------

  describe('notify()', () => {
    it('does not dispatch request notifications to users who hide Requests', async () => {
      repo.findUserSettings.mockResolvedValue(
        new Map([
          [1, { showBookRequests: false }],
          [2, {}],
        ]),
      );
      repo.insertOrCollapse.mockResolvedValue([makeInserted(2, { type: NotificationType.BookRequestSubmitted })]);

      await service.notify(makePayload({ kind: 'users', userIds: [1, 2] }, { type: NotificationType.BookRequestSubmitted }));

      expect(repo.insertOrCollapse).toHaveBeenCalledWith([expect.objectContaining({ userId: 2 })]);
      expect(gateway.emitNew).toHaveBeenCalledTimes(1);
    });

    it('resolves user IDs for "user" scope', async () => {
      repo.findUserSettings.mockResolvedValue(new Map());
      repo.insertOrCollapse.mockResolvedValue([makeInserted(42)]);

      await service.notify(makePayload({ kind: 'user', userId: 42 }));

      expect(repo.findUserSettings).toHaveBeenCalledWith([42]);
      expect(repo.insertOrCollapse).toHaveBeenCalled();
      expect(repo.insertOrCollapse.mock.calls[0][0][0]).toMatchObject({ userId: 42 });
    });

    it('deduplicates and validates an explicit bounded user scope', async () => {
      repo.findUserSettings.mockResolvedValue(new Map());
      repo.insertOrCollapse.mockResolvedValue([makeInserted(42), makeInserted(43, { id: 2 })]);

      await service.notify(makePayload({ kind: 'users', userIds: [42, 42, -1, 43] }));

      expect(repo.findUserSettings).toHaveBeenCalledWith([42, 43]);
      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(2);
    });

    it('resolves user IDs for "library" scope', async () => {
      repo.findUserIdsWithLibraryAccess.mockResolvedValue([10, 20]);
      repo.findUserSettings.mockResolvedValue(new Map());
      repo.insertOrCollapse.mockResolvedValue([makeInserted(10), makeInserted(20, { id: 2 })]);

      await service.notify(makePayload({ kind: 'library', libraryId: 5 }));

      expect(repo.findUserIdsWithLibraryAccess).toHaveBeenCalledWith(5);
      expect(repo.insertOrCollapse).toHaveBeenCalled();
    });

    it('resolves user IDs for "permission" scope', async () => {
      repo.findUserIdsWithPermission.mockResolvedValue([30]);
      repo.findUserSettings.mockResolvedValue(new Map());
      repo.insertOrCollapse.mockResolvedValue([makeInserted(30)]);

      await service.notify(makePayload({ kind: 'permission', permission: Permission.NotificationAccess }));

      expect(repo.findUserIdsWithPermission).toHaveBeenCalledWith(Permission.NotificationAccess);
    });

    it('resolves user IDs for "all" scope', async () => {
      repo.findAllActiveUserIds.mockResolvedValue([1, 2, 3]);
      repo.findUserSettings.mockResolvedValue(new Map());
      repo.insertOrCollapse.mockResolvedValue([makeInserted(1), makeInserted(2, { id: 2 }), makeInserted(3, { id: 3 })]);

      await service.notify(makePayload({ kind: 'all' }));

      expect(repo.findAllActiveUserIds).toHaveBeenCalled();
      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(3);
    });

    it('skips when no target users resolved', async () => {
      repo.findAllActiveUserIds.mockResolvedValue([]);

      await service.notify(makePayload({ kind: 'all' }));

      expect(repo.findUserSettings).not.toHaveBeenCalled();
      expect(repo.insertOrCollapse).not.toHaveBeenCalled();
      expect(gateway.emitNew).not.toHaveBeenCalled();
    });

    it('filters by user preferences - skips users who disabled the category', async () => {
      repo.findUserIdsWithLibraryAccess.mockResolvedValue([10, 20]);
      repo.findUserSettings.mockResolvedValue(
        new Map<number, Record<string, unknown>>([
          [10, { notificationPreferences: { scanning: false } }],
          [20, {}],
        ]),
      );
      repo.insertOrCollapse.mockResolvedValue([makeInserted(20)]);

      await service.notify(makePayload({ kind: 'library', libraryId: 1 }));

      const insertedRows = repo.insertOrCollapse.mock.calls[0][0];
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].userId).toBe(20);
    });

    it('defaults to enabled when no preferences set', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[42, {}]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(42)]);

      await service.notify(makePayload({ kind: 'user', userId: 42 }));

      expect(repo.insertOrCollapse).toHaveBeenCalled();
      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(1);
    });

    it('inserts notifications and emits via gateway for each', async () => {
      repo.findAllActiveUserIds.mockResolvedValue([10, 20]);
      repo.findUserSettings.mockResolvedValue(new Map());
      const inserted = [makeInserted(10, { id: 1 }), makeInserted(20, { id: 2 })];
      repo.insertOrCollapse.mockResolvedValue(inserted);

      await service.notify(makePayload({ kind: 'all' }, { message: 'Added 5 books', actionUrl: '/library/1', meta: { count: 5 } }));

      expect(repo.insertOrCollapse).toHaveBeenCalledOnce();
      const rows = repo.insertOrCollapse.mock.calls[0][0];
      expect(rows[0]).toMatchObject({ userId: 10, type: 'scan_completed', title: 'Library scan completed' });

      expect(gateway.emitNew).toHaveBeenCalledTimes(2);
      expect(gateway.emitNew).toHaveBeenCalledWith(10, expect.objectContaining({ id: 1, type: 'scan_completed' }));
      expect(gateway.emitNew).toHaveBeenCalledWith(20, expect.objectContaining({ id: 2 }));
    });

    it('handles unknown notification type category - defaults to enabled', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[42, { notificationPreferences: { scanning: false } }]]));
      repo.insertOrCollapse.mockResolvedValue([{ ...makeInserted(42), type: 'unknown_type' }]);

      await service.notify(makePayload({ kind: 'user', userId: 42 }, { type: 'unknown_type' as never }));

      expect(repo.insertOrCollapse).toHaveBeenCalled();
      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(1);
    });

    it('catches and re-throws errors', async () => {
      const error = new Error('DB connection failed');
      repo.findAllActiveUserIds.mockRejectedValue(error);

      await expect(service.notify(makePayload({ kind: 'all' }))).rejects.toThrow('DB connection failed');
    });

    it('catches and re-throws errors with special chars in message', async () => {
      const error = new Error('DB "connection" lost\nnewline injected');
      repo.findAllActiveUserIds.mockRejectedValue(error);

      await expect(service.notify(makePayload({ kind: 'all' }))).rejects.toThrow('DB "connection" lost');
    });

    it('skips insert when all users filtered out by preferences', async () => {
      repo.findUserSettings.mockResolvedValue(new Map<number, Record<string, unknown>>([[42, { notificationPreferences: { scanning: false } }]]));

      await service.notify(makePayload({ kind: 'user', userId: 42 }));

      expect(repo.insertOrCollapse).not.toHaveBeenCalled();
      expect(gateway.emitNew).not.toHaveBeenCalled();
    });
  });

  // ---------- notification levels ----------

  describe('notification levels', () => {
    it('delivers a success at level "all"', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[1, { notificationPreferences: { scanning: 'all' } }]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(1)]);

      await service.notify(makePayload({ kind: 'user', userId: 1 }, { type: 'scan_completed' }));

      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(1);
    });

    it('suppresses a success at level "problems" but still delivers the failure', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[1, { notificationPreferences: { scanning: 'problems' } }]]));

      await service.notify(makePayload({ kind: 'user', userId: 1 }, { type: 'scan_completed' }));
      expect(repo.insertOrCollapse).not.toHaveBeenCalled();

      repo.insertOrCollapse.mockResolvedValue([makeInserted(1, { type: 'scan_failed' })]);
      await service.notify(makePayload({ kind: 'user', userId: 1 }, { type: 'scan_failed' }));

      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(1);
    });

    it('treats a partial success as a problem so it survives level "problems"', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[1, { notificationPreferences: { scanning: 'problems' } }]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(1, { type: 'books_unavailable' })]);

      await service.notify(makePayload({ kind: 'user', userId: 1 }, { type: 'books_unavailable' }));

      expect(repo.insertOrCollapse.mock.calls[0][0]).toHaveLength(1);
    });

    it('suppresses everything at level "off"', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[1, { notificationPreferences: { scanning: 'off' } }]]));

      await service.notify(makePayload({ kind: 'user', userId: 1 }, { type: 'scan_failed' }));

      expect(repo.insertOrCollapse).not.toHaveBeenCalled();
    });

    it('honours the legacy boolean shape without a migration', async () => {
      repo.findUserSettings.mockResolvedValue(
        new Map<number, Record<string, unknown>>([
          [1, { notificationPreferences: { scanning: false } }],
          [2, { notificationPreferences: { scanning: true } }],
        ]),
      );
      repo.findUserIdsWithLibraryAccess.mockResolvedValue([1, 2]);
      repo.insertOrCollapse.mockResolvedValue([makeInserted(2)]);

      await service.notify(makePayload({ kind: 'library', libraryId: 1 }, { type: 'scan_completed' }));

      const rows = repo.insertOrCollapse.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(2);
    });
  });

  // ---------- coalescing ----------

  describe('coalescing', () => {
    it('collapses a repeat into the existing row and emits an update, not a new notification', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[1, {}]]));
      repo.insertOrCollapse.mockResolvedValue([{ ...makeInserted(1, { count: 2 }) }]);

      await service.notify(makePayload({ kind: 'user', userId: 1 }));

      expect(repo.insertOrCollapse).toHaveBeenCalledOnce();
      expect(gateway.emitNew).not.toHaveBeenCalled();
      expect(gateway.emitUpdated).toHaveBeenCalledWith(1, expect.objectContaining({ count: 2 }));
    });

    it('groups by library so two libraries do not collapse into each other', async () => {
      repo.findUserIdsWithLibraryAccess.mockResolvedValue([1]);
      repo.findUserSettings.mockResolvedValue(new Map([[1, {}]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(1)]);

      await service.notify(makePayload({ kind: 'library', libraryId: 7 }));
      await service.notify(makePayload({ kind: 'library', libraryId: 8 }));

      expect(repo.insertOrCollapse.mock.calls[0][0][0].groupKey).toBe('scan_completed:library:7');
      expect(repo.insertOrCollapse.mock.calls[1][0][0].groupKey).toBe('scan_completed:library:8');
    });

    it('groups per-item types by user so a bulk run collapses to one row', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[3, {}]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(3)]);

      await service.notify(makePayload({ kind: 'user', userId: 3 }, { type: 'file_rename_completed' }));

      expect(repo.insertOrCollapse.mock.calls[0][0][0].groupKey).toBe('file_rename_completed:user');
    });

    it('does not collapse distinct achievement or batch-summary notifications', async () => {
      repo.findUserSettings.mockResolvedValue(new Map([[3, {}]]));
      repo.insertOrCollapse.mockResolvedValue([makeInserted(3)]);

      await service.notify(makePayload({ kind: 'user', userId: 3 }, { type: 'achievement_unlocked' }));
      await service.notify(makePayload({ kind: 'user', userId: 3 }, { type: 'bulk_rename_completed' }));

      expect(repo.insertOrCollapse.mock.calls[0][0][0].groupKey).toBeNull();
      expect(repo.insertOrCollapse.mock.calls[1][0][0].groupKey).toBeNull();
    });
  });

  // ---------- list() ----------

  describe('list()', () => {
    it('returns paginated items transformed via toItem', async () => {
      const dbRow = {
        id: 1,
        type: 'scan_completed',
        title: 'Done',
        message: 'All good',
        actionUrl: '/lib/1',
        meta: { count: 3 },
        read: false,
        count: 4,
        createdAt: new Date('2024-06-15T12:00:00Z'),
        updatedAt: new Date('2024-06-15T18:00:00Z'),
      };
      repo.findByUser.mockResolvedValue({ items: [dbRow], total: 1 });

      const result = await service.list({ id: 42 } as never, 20, 0);

      expect(repo.findByUser).toHaveBeenCalledWith(42, 20, 0, undefined);
      expect(result.total).toBe(1);
      expect(result.items[0]).toEqual({
        id: 1,
        type: 'scan_completed',
        title: 'Done',
        message: 'All good',
        actionUrl: '/lib/1',
        meta: { count: 3 },
        read: false,
        count: 4,
        createdAt: '2024-06-15T12:00:00.000Z',
        updatedAt: '2024-06-15T18:00:00.000Z',
      });
    });
  });

  const user = { id: 42 } as RequestUser;

  it('emits the read event with stored notification scope and requests a count refresh', async () => {
    const row = { id: 7, meta: { libraryId: 19 } };
    repo.setRead.mockResolvedValue(row);
    expect(await service.markAsRead(user, 7)).toBe(true);
    expect(gateway.emitRead).toHaveBeenCalledWith(42, row);
    expect(gateway.emitCountUpdate).toHaveBeenCalledWith(42, row);
  });

  it('does not emit a read event for an inaccessible or missing notification', async () => {
    expect(await service.markAsRead(user, 999)).toBe(false);
    expect(gateway.emitRead).not.toHaveBeenCalled();
    expect(gateway.emitCountUpdate).not.toHaveBeenCalled();
  });

  it('refreshes notification state after marking the current scope read', async () => {
    const scopes = [{ libraryId: 19 }];
    repo.setAllRead.mockResolvedValue(scopes);
    await service.markAllAsRead(user);
    expect(repo.setAllRead).toHaveBeenCalledWith(42, undefined);
    expect(gateway.emitRefresh).toHaveBeenCalledWith(42, scopes);
  });

  it('emits the dismissal with the deleted notification scope and requests a count refresh', async () => {
    const row = { id: 7, meta: { libraryId: 19 } };
    repo.deleteOne.mockResolvedValue(row);
    expect(await service.dismiss(user, 7)).toBe(true);
    expect(gateway.emitDismissed).toHaveBeenCalledWith(42, row);
    expect(gateway.emitCountUpdate).toHaveBeenCalledWith(42, row);
  });

  it('does not emit a dismissal for an inaccessible or missing notification', async () => {
    expect(await service.dismiss(user, 999)).toBe(false);
    expect(gateway.emitDismissed).not.toHaveBeenCalled();
    expect(gateway.emitCountUpdate).not.toHaveBeenCalled();
  });

  it('refreshes notification state after clearing the current scope', async () => {
    const scopes = [{ libraryId: 19 }];
    repo.deleteAllForUser.mockResolvedValue(scopes);
    await service.clearAll(user);
    expect(repo.deleteAllForUser).toHaveBeenCalledWith(42, undefined);
    expect(gateway.emitRefresh).toHaveBeenCalledWith(42, scopes);
  });

  // ---------- getUnreadCount() ----------

  describe('getUnreadCount()', () => {
    it('returns count from repo', async () => {
      repo.countUnread.mockResolvedValue(5);

      const result = await service.getUnreadCount({ id: 42 } as never);

      expect(result).toBe(5);
      expect(repo.countUnread).toHaveBeenCalledWith(42, undefined);
    });
  });

  // ---------- deleteOlderThan() ----------

  describe('deleteOlderThan()', () => {
    it('calls repo with calculated cutoff date', async () => {
      repo.deleteOlderThan.mockImplementation((_date, onBatchDeleted) => {
        onBatchDeleted([
          { userId: 3, scope: null },
          { userId: 7, scope: { libraryId: 19 } },
        ]);
        return 2;
      });
      const now = new Date('2024-06-15T00:00:00Z');
      vi.setSystemTime(now);

      const result = await service.runRetentionCleanup(30);

      expect(result).toBe(2);
      const cutoffArg = repo.deleteOlderThan.mock.calls[0][0] as Date;
      const expectedCutoff = new Date('2024-05-16T00:00:00Z');
      expect(cutoffArg.getTime()).toBe(expectedCutoff.getTime());
      expect(gateway.emitRefresh).toHaveBeenCalledWith(3, [null]);
      expect(gateway.emitRefresh).toHaveBeenCalledWith(7, [{ libraryId: 19 }]);

      vi.useRealTimers();
    });
  });
});
