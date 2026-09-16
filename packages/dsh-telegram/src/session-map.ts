import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ChatSessionRecord {
  sessionId: string
  lastTurnMessageId: number
}

/** `chat_id -> session` map persisted as one JSON file, rewritten atomically. */
export class SessionMap {
  private records = new Map<number, ChatSessionRecord>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as Record<string, ChatSessionRecord>
    this.records = new Map(Object.entries(parsed).map(([chatId, record]) => [Number(chatId), record]))
  }

  get(chatId: number): ChatSessionRecord | undefined {
    return this.records.get(chatId)
  }

  async set(chatId: number, record: ChatSessionRecord): Promise<void> {
    this.records.set(chatId, record)
    await this.flush()
  }

  async delete(chatId: number): Promise<void> {
    this.records.delete(chatId)
    await this.flush()
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
