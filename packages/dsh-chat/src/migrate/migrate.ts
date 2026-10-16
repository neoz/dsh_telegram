import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../json-file.ts'

export const MARKER = '.migrated-v1'

export interface MigrateOptions {
  readonly dataDir: string
  readonly workspaceRoot: string
  /** Channel whose pre-dsh-chat files live directly in `dataDir` and `workspaceRoot`; absent for a fresh or multi-channel volume. */
  readonly legacyChannel?: string
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(() => true, () => false)
}

async function names(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Renames `from` to `to`; when `to` already exists (written by something else), both stay, so nothing is ever deleted. */
async function move(from: string, to: string): Promise<void> {
  if (!(await exists(from)) || await exists(to)) return
  await fs.mkdir(dirname(to), { recursive: true })
  await fs.rename(from, to)
}

/** Telegram logged numeric ids; the core compares ids as strings. */
async function stringifyLogIds(dir: string): Promise<void> {
  for (const name of await names(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(line => line !== '')
    let changed = false
    const out = lines.map((line) => {
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        // A line cut short by a crash stays as it was; it must not keep every chat down.
        return line
      }
      for (const field of ['message_id', 'user_id', 'reply_to']) {
        if (typeof entry[field] === 'number') {
          entry[field] = String(entry[field])
          changed = true
        }
      }
      return JSON.stringify(entry)
    })
    if (changed) await writeFileAtomic(file, out.map(line => `${line}\n`).join(''))
  }
}

/**
 * Moves one channel's legacy files into `<dataDir>/<channel>/` and `<workspaceRoot>/<channel>/`, then writes the marker.
 * Every step is safe to repeat, so a run that failed half-way completes on the next start; without the marker no chat plugin starts.
 */
export async function migrate(options: MigrateOptions): Promise<'current' | 'migrated'> {
  const { dataDir, workspaceRoot, legacyChannel: channel } = options
  if (await exists(join(dataDir, MARKER))) return 'current'
  if (channel !== undefined) {
    const target = join(dataDir, channel)
    for (const name of await names(join(dataDir, 'chatlog'))) await move(join(dataDir, 'chatlog', name), join(target, 'chatlog', name))
    if (channel === 'telegram') await stringifyLogIds(join(target, 'chatlog'))
    for (const name of await names(join(dataDir, 'memory'))) {
      if (name !== 'global.json') await move(join(dataDir, 'memory', name), join(target, 'memory', name))
    }
    for (const name of ['idle-decisions.jsonl', 'schedule.json']) await move(join(dataDir, name), join(target, name))
    // Stored sessions keep their old cwd, so every chat starts a new session; memory and chat log carry the continuity.
    await fs.rm(join(dataDir, `${channel}-sessions.json`), { force: true })
    // Only chat folders move: the workspace root may hold anything else (a cloned repo, a cache, the data dir).
    for (const name of await names(workspaceRoot)) {
      if (!(await exists(join(target, 'chatlog', `${name}.jsonl`)))) continue
      const from = join(workspaceRoot, name)
      if ((await fs.stat(from)).isDirectory()) await move(from, join(workspaceRoot, channel, name))
    }
  }
  await writeFileAtomic(join(dataDir, MARKER), `${new Date().toISOString()}\n`)
  return 'migrated'
}
