import * as fs from 'node:fs';
import { dirname } from 'node:path';

type AtomicFs = Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'>;

/**
 * Write `content` to `targetPath` with crash-safety: either the old content
 * remains (if anything before the rename fails), or the new content is there
 * in full. The target is never left in a partial state.
 *
 * Why this exists: a direct writeFileSync interrupted mid-write — process
 * crash, power loss, OOM — leaves the target with partial content, a state
 * no reader can reason about. Staging to a tempfile and renaming delegates
 * atomicity to the filesystem, which handles it as a single operation from
 * a reader's perspective on POSIX (real atomic rename) and on Windows
 * (MoveFileExW with MOVEFILE_REPLACE_EXISTING).
 *
 * Tempfile name carries pid + timestamp so concurrent writers from
 * different processes never collide on staging. If rename fails, the
 * tempfile is orphaned but the target is untouched — cleanup concern,
 * not correctness concern.
 *
 * The optional `fsImpl` parameter accepts a partial `node:fs` implementation;
 * defaults to the real `node:fs`. Tests use it to inject failures and verify
 * the atomicity guarantee directly. Production callers never pass it.
 */
export function atomicWriteSync(
  targetPath: string,
  content: string | Buffer,
  fsImpl: AtomicFs = fs,
): void {
  fsImpl.mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fsImpl.writeFileSync(tmp, content, typeof content === 'string' ? 'utf-8' : undefined);
  fsImpl.renameSync(tmp, targetPath);
}
