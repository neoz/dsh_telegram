import { readFile } from 'node:fs/promises'
import { SerialQueue, writeJsonAtomic } from 'dsh-chat'

export interface ChatSessionRecord {
  sessionId: string
  /** `ts` of the last message that got a turn; '' before the first. Group context starts after it. */
  lastTurnAt: string
  /** Set once the memory block is in this session's history; a resumed session must not get it again. */
  memoryInjected?: true
}

/** `chat_id -> session` map persisted as one JSON file, rewritten atomically. */
export class SessionMap {
  private records = new Map<string, ChatSessionRecord>()
  private readonly writes = new SerialQueue()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.records = new Map(Object.entries(JSON.parse(raw) as Record<string, ChatSessionRecord>))
  }

  get(chatId: string): ChatSessionRecord | undefined {
    return this.records.get(chatId)
  }

  async set(chatId: string, record: ChatSessionRecord): Promise<void> {
    this.records.set(chatId, record)
    await this.flush()
  }

  async delete(chatId: string): Promise<void> {
    this.records.delete(chatId)
    await this.flush()
  }

  /** Chats flush concurrently; each queued write snapshots the map when it runs, so the last one holds every change. */
  private flush(): Promise<void> {
    return this.writes.run(() => writeJsonAtomic(this.file, Object.fromEntries(this.records)))
  }
}
