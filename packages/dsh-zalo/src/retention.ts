import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function sweepDir(dir: string, cutoffMs: number, removeIfEmpty: boolean): Promise<void> {
  for (const entry of await entriesOf(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await sweepDir(path, cutoffMs, true)
    else if ((await lstat(path)).mtimeMs < cutoffMs) await rm(path, { force: true })
  }
  if (removeIfEmpty && (await readdir(dir)).length === 0) await rmdir(dir)
}

/** Deletes files older than `maxAgeMs` from every chat's `inbox/` and `outbox/`, then the folders they leave empty. */
export async function sweepOldFiles(workspaceRoot: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  for (const chat of await entriesOf(workspaceRoot)) {
    if (!chat.isDirectory()) continue
    for (const box of ['inbox', 'outbox']) await sweepDir(join(workspaceRoot, chat.name, box), now - maxAgeMs, false)
  }
}
