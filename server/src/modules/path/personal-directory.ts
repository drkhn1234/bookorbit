import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { constants } from 'fs';
import { lstat, mkdir, open, realpath } from 'fs/promises';
import { dirname, join, resolve } from 'path';

export const PERSONAL_OWNER_MARKER = '.bookorbit-owner.json';
const provisioning = new Map<string, Promise<string>>();

export function waitForPersonalDirectory(root: string): Promise<unknown> {
  return provisioning.get(root) ?? Promise.resolve();
}

export function personalDirectoryName(username: string): string {
  if (!username || username.trim() !== username || username.startsWith('.') || /[/\\\p{Cc}]/u.test(username) || Buffer.byteLength(username) > 255) {
    throw new BadRequestException('This username cannot be used as a personal storage directory. Contact an administrator.');
  }
  return username;
}

/** Missing descendants are safe to create; every existing ancestor must be a real directory. */
export async function assertDirectoryAncestors(path: string): Promise<void> {
  const ancestors: string[] = [];
  let current = resolve(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const ancestor of ancestors.reverse()) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new ForbiddenException('Storage paths must use real directories without symbolic links');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof ForbiddenException) throw error;
      throw new ForbiddenException('Cannot validate this storage directory');
    }
  }
}

export async function personalDirectoryIdentity(root: string, userId: number): Promise<string> {
  await assertDirectoryAncestors(root);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new ForbiddenException('Cannot validate personal storage');
  }
  try {
    const markerPath = join(root, PERSONAL_OWNER_MARKER);
    const existingMarker = await lstat(markerPath);
    if (!existingMarker.isFile() || existingMarker.size > 1024) throw new Error('Invalid marker');
    const marker = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await marker.stat();
      if (!info.isFile() || info.size > 1024) throw new Error('Invalid marker');
      const owner = JSON.parse(await marker.readFile('utf8')) as { version?: unknown; userId?: unknown };
      if (owner.version !== 1 || owner.userId !== userId) throw new Error('Mismatched owner');
    } finally {
      await marker.close();
    }
    const after = await lstat(root);
    if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev || (await realpath(root)) !== root) {
      throw new Error('Directory changed');
    }
    return `${after.dev}:${after.ino}`;
  } catch {
    throw new ConflictException('Personal storage is unmarked, invalid, or belongs to another account. An administrator must resolve it.');
  }
}

export async function provisionPersonalDirectory(base: string, root: string, userId: number, adopt = false): Promise<string> {
  const pending = provisioning.get(root);
  if (pending) {
    await pending;
    return personalDirectoryIdentity(root, userId);
  }
  const operation = bindDirectory(base, root, userId, adopt);
  provisioning.set(root, operation);
  try {
    return await operation;
  } finally {
    if (provisioning.get(root) === operation) provisioning.delete(root);
  }
}

async function bindDirectory(base: string, root: string, userId: number, adopt: boolean): Promise<string> {
  await assertDirectoryAncestors(root);
  let created = false;
  if (!adopt) {
    try {
      await mkdir(base, { recursive: true, mode: 0o750 });
      await assertDirectoryAncestors(base);
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ForbiddenException('Could not provision personal storage');
    }
  }
  await assertDirectoryAncestors(root);
  if (!created) {
    try {
      return await personalDirectoryIdentity(root, userId);
    } catch (error) {
      if (!adopt) throw error;
      // Adoption can bind an unmarked folder, but never replace a previous owner's marker.
      try {
        await lstat(join(root, PERSONAL_OWNER_MARKER));
      } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') {
          await writeMarker(root, userId);
          return personalDirectoryIdentity(root, userId);
        }
      }
      throw error;
    }
  }
  await writeMarker(root, userId);
  return personalDirectoryIdentity(root, userId);
}

async function writeMarker(root: string, userId: number): Promise<void> {
  await assertDirectoryAncestors(root);
  try {
    const marker = await open(
      join(root, PERSONAL_OWNER_MARKER),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await marker.writeFile(JSON.stringify({ version: 1, userId }) + '\n');
      await marker.sync();
    } finally {
      await marker.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConflictException('Could not bind personal storage safely');
  }
}
