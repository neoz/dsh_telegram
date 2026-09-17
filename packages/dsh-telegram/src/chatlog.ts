import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One observed Telegram message; bot replies carry `bot: true`. */
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
  return `[${entry.ts}] ${senderLabel(entry)}: ${oneLine(entry.text)}`
}

/** Append-only per-chat JSONL log under `dir`. */
export class ChatLog {
  constructor(private readonly dir: string) {}

  private file(chatId: number): string {
    return join(this.dir, `${chatId}.jsonl`)
  }

  async append(chatId: number, entry: ChatLogEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.file(chatId), `${JSON.stringify(entry)}\n`, 'utf8')
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
