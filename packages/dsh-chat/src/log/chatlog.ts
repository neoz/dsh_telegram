import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SerialQueue, writeFileAtomic } from '../json-file.ts'
import { keyPath, type ChatKey } from '../keys.ts'

/** One observed chat message; bot replies carry `bot: true`, messages that got a turn carry `handled: true`. */
export interface ChatLogEntry {
  ts: string
  message_id: string
  user_id: string
  username?: string
  name: string
  text: string
  reply_to?: string
  media?: string[]
  bot?: true
  handled?: true
}

/** Tags that fence untrusted text in prompts; a lookalike bracket keeps text from opening or closing one. */
const FENCE_TAG = /<(\/?)(group_messages|chat_history|memory)\b/gi

/** Folds line breaks so text rendered as one line of a block cannot forge another line (e.g. a fake sender), and defuses fence tags. */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(FENCE_TAG, '‹$1$2')
}

export function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'username' | 'name' | 'bot'>): string {
  if (entry.bot) return 'assistant'
  const base = entry.username === undefined ? `id:${oneLine(entry.user_id)}` : `@${oneLine(entry.username)}`
  return entry.name === '' ? base : `${base} (${oneLine(entry.name)})`
}

export function formatEntry(entry: ChatLogEntry): string {
  const media = entry.media === undefined ? '' : ` [media: ${entry.media.join(', ')}]`
  return `[${entry.ts}] ${senderLabel(entry)}: ${oneLine(entry.text)}${media}`
}

/** Index of the last human entry with this id, or -1; ids are opaque, so the log's order is the only order. */
function lastHumanIndex(entries: readonly ChatLogEntry[], messageId: string): number {
  if (messageId === '') return -1
  return entries.findLastIndex(e => e.bot !== true && e.message_id === messageId)
}

/** A log is trimmed back to `maxEntries` only once it grows this much past it, so trims stay rare. */
const TRIM_SLACK = 1.2

/**
 * Append-only per-chat JSONL log at `<dataDir>/<channel>/chatlog/<id>.jsonl`; `onAppend` hears every line once it is written.
 * Readers parse the whole file, so it is trimmed to the newest `maxEntries` to keep each read bounded.
 */
export class ChatLog {
  /** Lines per chat file, counted from disk on the first append after start. */
  private readonly counts = new Map<ChatKey, number>()
  private readonly writes = new SerialQueue()

  constructor(
    private readonly dataDir: string,
    private readonly onAppend?: (key: ChatKey, entry: ChatLogEntry) => void,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  private file(key: ChatKey): string {
    return keyPath(this.dataDir, key, 'chatlog', '.jsonl')
  }

  async append(key: ChatKey, entry: ChatLogEntry): Promise<void> {
    await this.writes.run(async () => {
      const file = this.file(key)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      const count = this.counts.get(key) ?? (await this.readAll(key)).length - 1
      this.counts.set(key, count + 1)
      if (count + 1 > this.maxEntries * TRIM_SLACK) await this.trim(key)
    })
    this.onAppend?.(key, entry)
  }

  private async trim(key: ChatKey): Promise<void> {
    const kept = (await this.readAll(key)).slice(-this.maxEntries)
    await writeFileAtomic(this.file(key), kept.map(e => `${JSON.stringify(e)}\n`).join(''))
    this.counts.set(key, kept.length)
  }

  async readAll(key: ChatKey): Promise<ChatLogEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ChatLogEntry)
  }

  /** Entries after the last turn's message (all when it is absent or trimmed away), minus the trigger, keeping the newest `limit`. */
  async recent(key: ChatKey, afterMessageId: string, excludeMessageId: string, limit: number): Promise<ChatLogEntry[]> {
    if (limit === 0) return []
    const entries = await this.readAll(key)
    return entries.slice(lastHumanIndex(entries, afterMessageId) + 1).filter(e => e.message_id !== excludeMessageId).slice(-limit)
  }

  /** Newest `limit` entries (oldest first) before `beforeMessageId` (ignored when unknown), optionally containing `query`. */
  async history(key: ChatKey, options: { limit: number; beforeMessageId?: string; query?: string }): Promise<ChatLogEntry[]> {
    const all = await this.readAll(key)
    const end = options.beforeMessageId === undefined ? -1 : lastHumanIndex(all, options.beforeMessageId)
    const needle = options.query?.toLowerCase()
    return (end === -1 ? all : all.slice(0, end))
      .filter(e => needle === undefined || e.text.toLowerCase().includes(needle))
      .slice(-options.limit)
  }
}
