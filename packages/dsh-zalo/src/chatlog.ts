import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SerialQueue, writeFileAtomic } from './json-file.ts'
import { pathSafe } from './media.ts'

/** One observed Zalo message; bot replies carry `bot: true`, messages that got a turn carry `handled: true`. `ts` is ISO, so it sorts as text. */
export interface ChatLogEntry {
  ts: string
  message_id: string
  user_id: string
  name: string
  text: string
  media?: string[]
  bot?: true
  handled?: true
}

/** Folds line breaks so text rendered as one line of a block cannot forge another line (e.g. a fake sender). */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

export function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'name' | 'bot'>): string {
  if (entry.bot) return 'assistant'
  const base = `id:${oneLine(entry.user_id)}`
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
  private readonly counts = new Map<string, number>()
  private readonly writes = new SerialQueue()

  constructor(
    private readonly dir: string,
    private readonly onAppend?: (chatId: string, entry: ChatLogEntry) => void,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  private file(chatId: string): string {
    return join(this.dir, `${pathSafe(chatId)}.jsonl`)
  }

  async append(chatId: string, entry: ChatLogEntry): Promise<void> {
    await this.writes.run(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(chatId), `${JSON.stringify(entry)}\n`, 'utf8')
      const count = this.counts.get(chatId) ?? (await this.readAll(chatId)).length - 1
      this.counts.set(chatId, count + 1)
      if (count + 1 > this.maxEntries * TRIM_SLACK) await this.trim(chatId)
    })
    this.onAppend?.(chatId, entry)
  }

  private async trim(chatId: string): Promise<void> {
    const kept = (await this.readAll(chatId)).slice(-this.maxEntries)
    await writeFileAtomic(this.file(chatId), kept.map(e => `${JSON.stringify(e)}\n`).join(''))
    this.counts.set(chatId, kept.length)
  }

  async readAll(chatId: string): Promise<ChatLogEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file(chatId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ChatLogEntry)
  }

  /** Entries logged after `afterTs`, minus the trigger, keeping the newest `limit`. Zalo ids carry no order, so time does. */
  async recent(chatId: string, afterTs: string, excludeMessageId: string, limit: number): Promise<ChatLogEntry[]> {
    if (limit === 0) return []
    const entries = (await this.readAll(chatId)).filter(e => e.ts > afterTs && e.message_id !== excludeMessageId)
    return entries.slice(-limit)
  }

  /** Newest `limit` entries (oldest first) logged before `before`, optionally containing `query`. */
  async history(chatId: string, options: { limit: number; before?: string; query?: string }): Promise<ChatLogEntry[]> {
    const needle = options.query?.toLowerCase()
    const entries = (await this.readAll(chatId)).filter(e =>
      (options.before === undefined || e.ts < options.before)
      && (needle === undefined || e.text.toLowerCase().includes(needle)))
    return entries.slice(-options.limit)
  }
}
