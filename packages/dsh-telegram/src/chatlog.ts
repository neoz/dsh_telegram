import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SerialQueue, writeFileAtomic } from './json-file.ts'

/** One observed Telegram message; bot replies carry `bot: true`, messages that got a turn carry `handled: true`. */
export interface ChatLogEntry {
  ts: string
  message_id: number
  user_id: number
  username?: string
  name: string
  text: string
  reply_to?: number
  media?: string[]
  bot?: true
  handled?: true
}

/** Folds line breaks so text rendered as one line of a block cannot forge another line (e.g. a fake sender). */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

export function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'username' | 'name' | 'bot'>): string {
  if (entry.bot) return 'assistant'
  const base = entry.username === undefined ? `id:${entry.user_id}` : `@${oneLine(entry.username)}`
  return entry.name === '' ? base : `${base} (${oneLine(entry.name)})`
}

export function formatEntry(entry: ChatLogEntry): string {
  const media = entry.media === undefined ? '' : ` [media: ${entry.media.join(', ')}]`
  return `[${entry.ts}] ${senderLabel(entry)}: ${oneLine(entry.text)}${media}`
}

/** A log is trimmed back to `maxEntries` only once it grows this much past it, so trims stay rare. */
const TRIM_SLACK = 1.2

/**
 * Append-only per-chat JSONL log under `dir`; `onAppend` hears every line once it is written.
 * Readers parse the whole file, so it is trimmed to the newest `maxEntries` to keep each read bounded.
 */
export class ChatLog {
  /** Lines per chat file, counted from disk on the first append after start. */
  private readonly counts = new Map<number, number>()
  private readonly writes = new SerialQueue()

  constructor(
    private readonly dir: string,
    private readonly onAppend?: (chatId: number, entry: ChatLogEntry) => void,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  private file(chatId: number): string {
    return join(this.dir, `${chatId}.jsonl`)
  }

  async append(chatId: number, entry: ChatLogEntry): Promise<void> {
    await this.writes.run(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(chatId), `${JSON.stringify(entry)}\n`, 'utf8')
      const count = this.counts.get(chatId) ?? (await this.readAll(chatId)).length - 1
      this.counts.set(chatId, count + 1)
      if (count + 1 > this.maxEntries * TRIM_SLACK) await this.trim(chatId)
    })
    this.onAppend?.(chatId, entry)
  }

  private async trim(chatId: number): Promise<void> {
    const kept = (await this.readAll(chatId)).slice(-this.maxEntries)
    await writeFileAtomic(this.file(chatId), kept.map(e => `${JSON.stringify(e)}\n`).join(''))
    this.counts.set(chatId, kept.length)
  }

  async readAll(chatId: number): Promise<ChatLogEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file(chatId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ChatLogEntry)
  }

  /** Messages with id > afterMessageId, minus the trigger, keeping the newest `limit`. */
  async recent(chatId: number, afterMessageId: number, excludeMessageId: number, limit: number): Promise<ChatLogEntry[]> {
    if (limit === 0) return []
    const entries = (await this.readAll(chatId))
      .filter(e => e.message_id > afterMessageId && e.message_id !== excludeMessageId)
    return entries.slice(-limit)
  }

  /** Newest `limit` entries (oldest first) before `beforeMessageId`, optionally containing `query`. */
  async history(chatId: number, options: { limit: number; beforeMessageId?: number; query?: string }): Promise<ChatLogEntry[]> {
    const needle = options.query?.toLowerCase()
    const entries = (await this.readAll(chatId)).filter(e =>
      (options.beforeMessageId === undefined || e.message_id < options.beforeMessageId)
      && (needle === undefined || e.text.toLowerCase().includes(needle)))
    return entries.slice(-options.limit)
  }
}
