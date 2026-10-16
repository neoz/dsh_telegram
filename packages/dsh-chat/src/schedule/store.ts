import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { writeJsonAtomic } from '../json-file.ts'
import { chatKey } from '../keys.ts'
import type { Reminder } from './domain.ts'

interface ScheduleFile { version: 1; reminders: Reminder[] }

function isReminder(value: unknown): value is Reminder {
  const r = value as Partial<Reminder> | null
  return typeof r === 'object' && r !== null
    && typeof r.chatKey === 'string' && typeof r.isGroup === 'boolean'
    && typeof r.creator?.id === 'string' && typeof r.creator?.name === 'string'
    && (r.mode === 'message' || r.mode === 'agent')
    && decodes(r.record)
}

/** dsh-schedule's own decoder checks the rule fields, so a hand-edited record fails at load rather than at delivery. */
function decodes(record: unknown): boolean {
  try {
    decodeScheduleRecord(record)
    return true
  } catch {
    return false
  }
}

/** Reminders written before dsh-chat carry a bare numeric chat id and creator id, and no isGroup. */
function normalize(raw: unknown, channel: string): unknown {
  const r = raw as { chatKey?: unknown; chatId?: unknown; isGroup?: unknown; creator?: { id?: unknown; name?: unknown } } | null
  if (typeof r !== 'object' || r === null || typeof r.chatKey === 'string') return raw
  if (typeof r.chatId !== 'number' && typeof r.chatId !== 'string') return raw
  const { chatId, ...rest } = r
  const creatorId = r.creator?.id
  return {
    ...rest,
    chatKey: chatKey(channel, chatId),
    isGroup: typeof r.isGroup === 'boolean' ? r.isGroup : Number(chatId) < 0,
    creator: { ...r.creator, id: typeof creatorId === 'number' ? chatKey(channel, creatorId) : creatorId },
  }
}

/** Active reminders of one channel in one JSON file; changes run one at a time and replace the list only once written. */
export class ReminderStore {
  private reminders: Reminder[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly file: string, private readonly channel: string) {}

  /** Synchronous so the plugin loads before it registers anything; a missing file is an empty store. */
  load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.reminders = []
        return
      }
      throw error
    }
    let data: Partial<ScheduleFile>
    try {
      data = JSON.parse(text) as Partial<ScheduleFile>
    } catch {
      throw new Error(`dsh-chat: ${this.file} is not valid JSON; fix or remove it`)
    }
    const reminders = Array.isArray(data.reminders) ? data.reminders.map(r => normalize(r, this.channel)) : undefined
    if (data.version !== 1 || reminders === undefined || !reminders.every(isReminder)) {
      throw new Error(`dsh-chat: ${this.file} is not a valid reminder file; fix or remove it`)
    }
    this.reminders = reminders
  }

  all(): readonly Reminder[] {
    return this.reminders
  }

  /** Later updates reject without writing, so a store replaced by a reload cannot overwrite its successor's file. */
  close(): void {
    this.closed = true
  }

  update<T>(change: (reminders: Reminder[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.closed) throw new Error('reminder store is closed')
      const draft = [...this.reminders]
      const result = change(draft)
      const data: ScheduleFile = { version: 1, reminders: draft }
      await writeJsonAtomic(this.file, data)
      this.reminders = draft
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }
}

/** One reminder file per channel, `<dataDir>/<channel>/schedule.json`; a channel file is created on its first change. */
export class ReminderBook {
  private readonly stores = new Map<string, ReminderStore>()

  constructor(private readonly dataDir: string) {}

  /** Synchronous so the plugin loads before it registers anything; a corrupted file throws. */
  load(): void {
    const entries = existsSync(this.dataDir) ? readdirSync(this.dataDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(this.dataDir, entry.name, 'schedule.json'))) this.storeOf(entry.name)
    }
  }

  all(): readonly Reminder[] {
    return [...this.stores.values()].flatMap(store => store.all())
  }

  update<T>(channel: string, change: (reminders: Reminder[]) => T): Promise<T> {
    return this.storeOf(channel).update(change)
  }

  /** Later updates reject without writing; see `ReminderStore.close`. */
  close(): void {
    for (const store of this.stores.values()) store.close()
  }

  private storeOf(channel: string): ReminderStore {
    let store = this.stores.get(channel)
    if (store === undefined) {
      store = new ReminderStore(join(this.dataDir, channel, 'schedule.json'), channel)
      store.load()
      this.stores.set(channel, store)
    }
    return store
  }
}
