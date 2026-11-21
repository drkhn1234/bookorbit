import { Permission, type AccessLevel, type CreatedApiKey } from '@bookorbit/types';
import { Client } from 'pg';

import {
  authHeader,
  closeAuthorizationMatrixE2EContext,
  createAuthorizationMatrixE2EContext,
  createLibraryWithFolder,
  createUserAndLogin,
  grantLibraryAccess,
  type AuthorizationMatrixE2EContext,
} from './e2e/authorization-matrix/authorization-matrix-harness';

const barrierKey = 72104915;
type Grant = { libraryId: number; userId: number; accessLevel: AccessLevel };

describe('library grant transactions (PostgreSQL e2e)', () => {
  let ctx: AuthorizationMatrixE2EContext;
  let observer: Client;
  let observerPid: number;
  const pending: Promise<unknown>[] = [];

  beforeAll(async () => {
    const connectionString = process.env.E2E_DATABASE_URL;
    if (!connectionString || !new URL(connectionString).pathname.endsWith('_e2e')) throw new Error('A disposable E2E_DATABASE_URL is required');
    ctx = await createAuthorizationMatrixE2EContext();
    observer = new Client({ connectionString });
    await observer.connect();
    const { rows } = await observer.query<{ pid: number }>('select pg_backend_pid() as pid');
    observerPid = rows[0].pid;
    await observer.query(`
      create table fixture_grant_barrier (
        library_id integer not null, user_id integer not null, operation text not null, action text not null
      );
      create function fixture_grant_write_barrier() returns trigger language plpgsql as $fixture$
      declare fixture_action text;
      begin
        if tg_op = 'DELETE' then
          select action into fixture_action from fixture_grant_barrier
            where library_id = old.library_id and user_id = old.user_id and operation = tg_op;
        else
          select action into fixture_action from fixture_grant_barrier
            where library_id = new.library_id and user_id = new.user_id and operation = tg_op;
        end if;
        if fixture_action = 'pause' then
          perform pg_advisory_xact_lock(${barrierKey});
        elsif fixture_action = 'fail' then
          raise exception 'fixture grant write constraint failed' using errcode = '23514';
        end if;
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end
      $fixture$;
      create trigger fixture_grant_write_barrier before insert or update or delete on user_library_access
        for each row execute function fixture_grant_write_barrier();
    `);
  }, 60_000);

  afterEach(async () => {
    if (!observer) return;
    await observer.query('rollback');
    await observer.query('select pg_advisory_unlock_all()');
    await Promise.allSettled(pending.splice(0));
    await observer.query('delete from fixture_grant_barrier');
  });

  afterAll(async () => {
    try {
      if (observer) {
        await observer.query(`
          drop trigger if exists fixture_grant_write_barrier on user_library_access;
          drop function if exists fixture_grant_write_barrier();
          drop table if exists fixture_grant_barrier;
        `);
        await observer.end();
      }
    } finally {
      if (ctx) await closeAuthorizationMatrixE2EContext(ctx);
    }
  });

  async function fixtureLibrary() {
    return (await createLibraryWithFolder(ctx)).libraryId;
  }

  async function grants(...libraries: number[]): Promise<Grant[]> {
    const { rows } = await observer.query<Grant>(
      'select library_id as "libraryId", user_id as "userId", access_level as "accessLevel" from user_library_access where library_id = any($1::int[]) order by library_id, user_id',
      [libraries],
    );
    return rows;
  }

  async function owners(library: number): Promise<number[]> {
    return (await grants(library)).filter(({ accessLevel }) => accessLevel === 'owner').map(({ userId }) => userId);
  }

  function track<T>(thenable: PromiseLike<T>): Promise<T> {
    const promise = Promise.resolve(thenable);
    pending.push(promise);
    return promise;
  }

  function bulk(userId: number, libraryIds: number[], headers = authHeader(ctx.adminToken)) {
    return track(ctx.app.inject({ method: 'PUT', url: `/api/v1/users/${userId}/libraries`, headers, payload: { libraryIds } }));
  }

  function direct(libraryId: number, userId: number, token: string, accessLevel?: AccessLevel, admin = false) {
    return track(
      ctx.app.inject({
        method: accessLevel ? 'PATCH' : 'DELETE',
        url: `/api/v1/libraries/${libraryId}/access/${userId}${admin ? '?scope=admin' : ''}`,
        headers: authHeader(token),
        payload: accessLevel ? { accessLevel } : undefined,
      }),
    );
  }

  function deleteAccount(userId: number) {
    return track(ctx.app.inject({ method: 'DELETE', url: `/api/v1/users/${userId}`, headers: authHeader(ctx.adminToken) }));
  }

  async function existingAccounts(...userIds: number[]): Promise<number[]> {
    const { rows } = await observer.query<{ id: number }>('select id from users where id = any($1::int[]) order by id', [userIds]);
    return rows.map(({ id }) => id);
  }

  async function fixtureWrite(libraryId: number, userId: number, operation: 'UPDATE' | 'INSERT' | 'DELETE', action: 'pause' | 'fail') {
    await observer.query('insert into fixture_grant_barrier values ($1, $2, $3, $4)', [libraryId, userId, operation, action]);
    if (action === 'pause') await observer.query('select pg_advisory_lock($1::bigint)', [barrierKey]);
  }

  async function releaseWrite() {
    await observer.query('select pg_advisory_unlock($1::bigint)', [barrierKey]);
  }

  async function holdLibrary(libraryId: number) {
    await observer.query('begin');
    await observer.query('select id from libraries where id = $1 for no key update', [libraryId]);
  }

  async function waitingOn(blockerPid: number, advisoryKey?: number): Promise<number> {
    return vi.waitFor(
      async () => {
        await observer.query('select pg_stat_clear_snapshot()');
        const { rows } = await observer.query<{ pid: number }>(
          `
        select activity.pid from pg_stat_activity activity
        where activity.datname = current_database()
          and $1 = any(pg_blocking_pids(activity.pid))
          and ($2::int is null or exists (
            select 1 from pg_locks locks where locks.pid = activity.pid and locks.locktype = 'advisory'
              and not locks.granted and locks.objid = $2::int and locks.classid = 0 and locks.objsubid = 1
          ))
      `,
          [blockerPid, advisoryKey ?? null],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].pid).not.toBe(blockerPid);
        return rows[0].pid;
      },
      { timeout: 8000 },
    );
  }

  it('serializes two owners targeting one another and denies the waiting owner after demotion', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    for (const user of [a, b]) await grantLibraryAccess(ctx, user.userId, library, 'owner');

    await fixtureWrite(library, b.userId, 'UPDATE', 'pause');
    const demotion = direct(library, b.userId, a.accessToken, 'viewer');
    const firstPid = await waitingOn(observerPid, barrierKey);
    const competingRemoval = direct(library, a.userId, b.accessToken);
    await waitingOn(firstPid);
    expect(await owners(library)).toEqual([a.userId, b.userId]);

    await releaseWrite();
    const [won, refused] = await Promise.all([demotion, competingRemoval]);
    expect(won.statusCode, won.body).toBe(200);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().message).toContain('Owner access');
    expect(await grants(library)).toEqual([
      { libraryId: library, userId: a.userId, accessLevel: 'owner' },
      { libraryId: library, userId: b.userId, accessLevel: 'viewer' },
    ]);
  }, 30_000);

  it('serializes a direct removal against a bulk removal of the other owner', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    for (const user of [a, b]) await grantLibraryAccess(ctx, user.userId, library, 'owner');

    await fixtureWrite(library, b.userId, 'DELETE', 'pause');
    const remove = direct(library, b.userId, a.accessToken);
    const firstPid = await waitingOn(observerPid, barrierKey);
    const replace = bulk(a.userId, []);
    await waitingOn(firstPid);
    expect(await owners(library)).toEqual([a.userId, b.userId]);

    await releaseWrite();
    const [won, refused] = await Promise.all([remove, replace]);
    expect(won.statusCode, won.body).toBe(204);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toContain('last library owner');
    expect(await grants(library)).toEqual([{ libraryId: library, userId: a.userId, accessLevel: 'owner' }]);
  }, 30_000);

  it('rechecks an owner assignment to an initially empty target grant set before bulk removal', async () => {
    const subject = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();

    await fixtureWrite(library, subject.userId, 'INSERT', 'pause');
    const assign = track(
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/libraries/${library}/access?scope=admin`,
        headers: authHeader(ctx.adminToken),
        payload: { userId: subject.userId, accessLevel: 'owner' },
      }),
    );
    const firstPid = await waitingOn(observerPid, barrierKey);
    const remove = bulk(subject.userId, []);
    await waitingOn(firstPid);
    expect(await grants(library)).toEqual([]);

    await releaseWrite();
    const [won, refused] = await Promise.all([assign, remove]);
    expect(won.statusCode, won.body).toBe(201);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await grants(library)).toEqual([{ libraryId: library, userId: subject.userId, accessLevel: 'owner' }]);
  }, 30_000);

  it('serializes two bulk replacements of the same target even before it has grant rows', async () => {
    const subject = await createUserAndLogin(ctx);
    const owner = await createUserAndLogin(ctx);
    const first = await fixtureLibrary();
    const second = await fixtureLibrary();
    for (const library of [first, second]) await grantLibraryAccess(ctx, owner.userId, library, 'owner');

    await fixtureWrite(first, subject.userId, 'INSERT', 'pause');
    await holdLibrary(second);
    const a = bulk(subject.userId, [first]);
    const firstPid = await waitingOn(observerPid, barrierKey);
    const b = bulk(subject.userId, [second]);
    const secondPid = await waitingOn(firstPid);
    await releaseWrite();
    const intermediate = await a;
    expect(intermediate.statusCode, intermediate.body).toBe(204);
    expect(await waitingOn(observerPid)).toBe(secondPid);
    expect(await owners(first)).toEqual([owner.userId]);
    expect(await owners(second)).toEqual([owner.userId]);
    expect((await grants(first, second)).filter(({ userId }) => userId === subject.userId)).toEqual([
      { libraryId: first, userId: subject.userId, accessLevel: 'viewer' },
    ]);

    await observer.query('commit');
    const final = await b;
    expect(final.statusCode, final.body).toBe(204);
    expect((await grants(first, second)).filter(({ userId }) => userId === subject.userId)).toEqual([
      { libraryId: second, userId: subject.userId, accessLevel: 'viewer' },
    ]);
    expect(await owners(first)).toEqual([owner.userId]);
    expect(await owners(second)).toEqual([owner.userId]);
  }, 30_000);

  it('locks overlapping multi-library assignments in library order and lets a disjoint target commit', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const independent = await createUserAndLogin(ctx);
    const low = await fixtureLibrary();
    const high = await fixtureLibrary();
    const added = await fixtureLibrary();
    const separate = await fixtureLibrary();
    for (const user of [a, b]) {
      for (const library of [high, low]) await grantLibraryAccess(ctx, user.userId, library, 'owner');
    }
    await grantLibraryAccess(ctx, b.userId, added, 'owner');
    await grantLibraryAccess(ctx, b.userId, separate, 'owner');

    await holdLibrary(high);
    const replaceA = bulk(a.userId, [added]);
    const firstPid = await waitingOn(observerPid);
    const replaceB = bulk(b.userId, [added, separate]);
    // B needs low before high. It queues behind A even though the observer only holds high.
    await waitingOn(firstPid);

    const disjoint = await bulk(independent.userId, [separate]);
    expect(disjoint.statusCode, disjoint.body).toBe(204);
    expect(await owners(low)).toEqual([a.userId, b.userId]);
    expect(await owners(high)).toEqual([a.userId, b.userId]);
    expect(await owners(added)).toEqual([b.userId]);
    expect(await grants(separate)).toEqual([
      { libraryId: separate, userId: b.userId, accessLevel: 'owner' },
      { libraryId: separate, userId: independent.userId, accessLevel: 'viewer' },
    ]);

    await observer.query('commit');
    const [won, refused] = await Promise.all([replaceA, replaceB]);
    expect(won.statusCode, won.body).toBe(204);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await owners(low)).toEqual([b.userId]);
    expect(await owners(high)).toEqual([b.userId]);
    expect(await grants(added)).toEqual([
      { libraryId: added, userId: a.userId, accessLevel: 'viewer' },
      { libraryId: added, userId: b.userId, accessLevel: 'owner' },
    ]);
  }, 30_000);

  it.each(['ManageUsers', 'ManageLibraries'] as const)(
    'rechecks %s after an admitted request waits for a library lock',
    async (permission) => {
      const actor = await createUserAndLogin(ctx, { permissions: [Permission[permission]] });
      const subject = await createUserAndLogin(ctx);
      const library = await fixtureLibrary();
      await grantLibraryAccess(ctx, subject.userId, library, 'viewer');
      const original = await grants(library);

      await holdLibrary(library);
      const attempt =
        permission === 'ManageUsers'
          ? bulk(subject.userId, [], authHeader(actor.accessToken))
          : direct(library, subject.userId, actor.accessToken, 'editor', true);
      await waitingOn(observerPid);
      const revoke = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/users/${actor.userId}/permissions`,
        headers: authHeader(ctx.adminToken),
        payload: { permissionNames: [] },
      });
      expect(revoke.statusCode, revoke.body).toBe(204);

      await observer.query('commit');
      const result = await attempt;
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().message).toContain(Permission[permission]);
      expect(await grants(library)).toEqual(original);
    },
    30_000,
  );

  it('rejects a revoked write credential after the lock wait while preserving the live key and read-only contracts', async () => {
    const actor = await createUserAndLogin(ctx, { permissions: [Permission.ManageUsers, Permission.ApiKeys] });
    const subject = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    const actorHeaders = authHeader(actor.accessToken);
    async function makeKey(access: 'read' | 'write') {
      const result = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: actorHeaders,
        payload: { name: `Grant test ${access}`, access, permissions: [Permission.ManageUsers] },
      });
      expect(result.statusCode, result.body).toBe(201);
      return result.json() as CreatedApiKey;
    }
    const reader = await makeKey('read');
    const writer = await makeKey('write');
    const writeHeaders = { 'x-api-key': writer.token };
    expect((await bulk(subject.userId, [library], { 'x-api-key': reader.token })).statusCode).toBe(403);
    expect(await grants(library)).toEqual([]);
    expect((await bulk(subject.userId, [library], writeHeaders)).statusCode).toBe(204);
    const original = await grants(library);

    await holdLibrary(library);
    const attempt = bulk(subject.userId, [], writeHeaders);
    await waitingOn(observerPid);
    const revoke = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${writer.key.id}`, headers: actorHeaders });
    expect(revoke.statusCode, revoke.body).toBe(204);
    await observer.query('commit');

    const result = await attempt;
    expect(result.statusCode, result.body).toBe(401);
    expect(await grants(library)).toEqual(original);
  }, 30_000);

  it('preserves the global ManageUsers grant of a superuser key without administrator access', async () => {
    const actor = await createUserAndLogin(ctx, { isSuperuser: true });
    const subject = await createUserAndLogin(ctx);
    const otherAdmin = await createUserAndLogin(ctx, { isSuperuser: true });
    const library = await fixtureLibrary();
    await grantLibraryAccess(ctx, otherAdmin.userId, library, 'owner');
    const key = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: authHeader(actor.accessToken),
      payload: { name: 'Delegated grant manager', access: 'write', permissions: [Permission.ManageUsers] },
    });
    expect(key.statusCode, key.body).toBe(201);
    const headers = { 'x-api-key': (key.json() as CreatedApiKey).token };

    const unknown = await bulk(subject.userId, [2147483647], headers);
    expect(unknown.statusCode, unknown.body).toBe(400);
    expect(unknown.json().message).toBe('Unknown library IDs: 2147483647');

    const rejected = await bulk(otherAdmin.userId, [], headers);
    expect(rejected.statusCode, rejected.body).toBe(403);
    expect(await owners(library)).toEqual([otherAdmin.userId]);

    const allowed = await bulk(subject.userId, [library], headers);
    expect(allowed.statusCode, allowed.body).toBe(204);
    expect(await grants(library)).toContainEqual({ libraryId: library, userId: subject.userId, accessLevel: 'viewer' });
    expect(await owners(library)).toEqual([otherAdmin.userId]);
  }, 30_000);

  it('rolls back an earlier deletion on a failed insert and preserves exact roles on retry', async () => {
    const subject = await createUserAndLogin(ctx);
    const owner = await createUserAndLogin(ctx);
    const removal = await fixtureLibrary();
    const retained = await fixtureLibrary();
    const addition = await fixtureLibrary();
    for (const library of [removal, retained, addition]) await grantLibraryAccess(ctx, owner.userId, library, 'owner');
    await grantLibraryAccess(ctx, subject.userId, removal, 'viewer');
    await grantLibraryAccess(ctx, subject.userId, retained, 'editor');
    const original = await grants(removal, retained, addition);

    await fixtureWrite(addition, subject.userId, 'INSERT', 'fail');
    const failure = await bulk(subject.userId, [addition, retained]);
    expect(failure.statusCode, failure.body).toBe(500);
    expect(await grants(removal, retained, addition)).toEqual(original);

    await observer.query('delete from fixture_grant_barrier');
    const retry = await bulk(subject.userId, [addition, retained, addition]);
    expect(retry.statusCode, retry.body).toBe(204);
    expect((await grants(removal, retained, addition)).filter(({ userId }) => userId === subject.userId)).toEqual([
      { libraryId: retained, userId: subject.userId, accessLevel: 'editor' },
      { libraryId: addition, userId: subject.userId, accessLevel: 'viewer' },
    ]);
    for (const library of [removal, retained, addition]) expect(await owners(library)).toEqual([owner.userId]);
  }, 30_000);

  it('serializes account deletion for two co-owners and leaves one owner', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    for (const user of [a, b]) await grantLibraryAccess(ctx, user.userId, library, 'owner');

    await fixtureWrite(library, a.userId, 'DELETE', 'pause');
    const first = deleteAccount(a.userId);
    const firstPid = await waitingOn(observerPid, barrierKey);
    const second = deleteAccount(b.userId);
    await waitingOn(firstPid);
    expect(await owners(library)).toEqual([a.userId, b.userId]);
    await releaseWrite();

    expect((await first).statusCode).toBe(204);
    expect((await second).statusCode).toBe(409);
    expect(await existingAccounts(a.userId, b.userId)).toEqual([b.userId]);
    expect(await owners(library)).toEqual([b.userId]);
  }, 30_000);

  it('rechecks surviving owners after account deletion waits for bulk grant replacement', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    for (const user of [a, b]) await grantLibraryAccess(ctx, user.userId, library, 'owner');

    await fixtureWrite(library, b.userId, 'DELETE', 'pause');
    const replacement = bulk(b.userId, []);
    const writer = await waitingOn(observerPid, barrierKey);
    const deletion = deleteAccount(a.userId);
    await waitingOn(writer);
    await releaseWrite();

    expect((await replacement).statusCode).toBe(204);
    expect((await deletion).statusCode).toBe(409);
    expect(await existingAccounts(a.userId, b.userId)).toEqual([a.userId, b.userId]);
    expect(await owners(library)).toEqual([a.userId]);
  }, 30_000);

  it('makes direct grant removal wait for account deletion before checking the remaining owner', async () => {
    const a = await createUserAndLogin(ctx);
    const b = await createUserAndLogin(ctx);
    const library = await fixtureLibrary();
    for (const user of [a, b]) await grantLibraryAccess(ctx, user.userId, library, 'owner');

    await fixtureWrite(library, a.userId, 'DELETE', 'pause');
    const deletion = deleteAccount(a.userId);
    const writer = await waitingOn(observerPid, barrierKey);
    const removal = direct(library, b.userId, ctx.adminToken, undefined, true);
    await waitingOn(writer);
    await releaseWrite();

    expect((await deletion).statusCode).toBe(204);
    expect((await removal).statusCode).toBe(409);
    expect(await existingAccounts(a.userId, b.userId)).toEqual([b.userId]);
    expect(await owners(library)).toEqual([b.userId]);
  }, 30_000);

  it.each([false, true])(
    'coordinates account deletion with an owner grant in flight (target already owns a library: %s)',
    async (replacement) => {
      const subject = await createUserAndLogin(ctx);
      const other = await createUserAndLogin(ctx);
      const library = await fixtureLibrary();
      if (replacement) await grantLibraryAccess(ctx, subject.userId, library, 'owner');
      const recipient = replacement ? other : subject;

      await fixtureWrite(library, recipient.userId, 'INSERT', 'pause');
      const assignment = track(
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/libraries/${library}/access?scope=admin`,
          headers: authHeader(ctx.adminToken),
          payload: { userId: recipient.userId, accessLevel: 'owner' },
        }),
      );
      const writer = await waitingOn(observerPid, barrierKey);
      const deletion = deleteAccount(subject.userId);
      await waitingOn(writer);
      await releaseWrite();

      expect((await assignment).statusCode).toBe(201);
      expect((await deletion).statusCode).toBe(replacement ? 204 : 409);
      expect(await existingAccounts(subject.userId)).toEqual(replacement ? [] : [subject.userId]);
      expect(await owners(library)).toEqual([recipient.userId]);
    },
    30_000,
  );

  it('rolls back account deletion and all grants when a database cascade fails', async () => {
    const subject = await createUserAndLogin(ctx);
    const other = await createUserAndLogin(ctx);
    const owned = await fixtureLibrary();
    const shared = await fixtureLibrary();
    await grantLibraryAccess(ctx, subject.userId, owned, 'owner');
    await grantLibraryAccess(ctx, other.userId, owned, 'owner');
    await grantLibraryAccess(ctx, subject.userId, shared, 'viewer');
    const original = await grants(owned, shared);

    await fixtureWrite(owned, subject.userId, 'DELETE', 'fail');
    expect((await deleteAccount(subject.userId)).statusCode).toBe(500);
    expect(await existingAccounts(subject.userId)).toEqual([subject.userId]);
    expect(await grants(owned, shared)).toEqual(original);

    await observer.query('delete from fixture_grant_barrier');
    expect((await deleteAccount(subject.userId)).statusCode).toBe(204);
    expect(await existingAccounts(subject.userId)).toEqual([]);
    expect(await grants(owned, shared)).toEqual([{ libraryId: owned, userId: other.userId, accessLevel: 'owner' }]);
  }, 30_000);
});
