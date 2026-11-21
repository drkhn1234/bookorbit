import { computeFileHash } from './hash';

/** An inode can be reused after deletion or shared by unrelated files on different devices. */
export async function matchesStoredFileFingerprint(
  path: string,
  sizeBytes: number,
  stored: { sizeBytes: number | null; fileHash: string | null },
): Promise<boolean> {
  if (stored.sizeBytes !== sizeBytes || !stored.fileHash) return false;
  try {
    return (await computeFileHash(path)) === stored.fileHash;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return false;
    throw error;
  }
}
