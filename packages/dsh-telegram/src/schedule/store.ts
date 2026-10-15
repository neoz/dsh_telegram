import { readFileSync } from 'node:fs'
import { decodeScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { writeJsonAtomic } from '../json-file.ts'
import type { Reminder } from './domain.ts'

interface ScheduleFile { version: 1; reminders: Reminder[] }

function isReminder(value: unknown): value is Reminder {
  const r = value as Partial<Reminder> | null
  return typeof r === 'object' && r !== null
    && Number.isInteger(r.chatId) && Number.isInteger(r.creator?.id) && typeof r.creator?.name === 'string'
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

/** Active reminders in one JSON file; changes run one at a time and replace the list only once written. */
export class ReminderStore {
  private reminders: Reminder[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly file: string) {}

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
      throw new Error(`dsh-telegram: ${this.file} is not valid JSON; fix or remove it`)
    }
    if (data.version !== 1 || !Array.isArray(data.reminders) || !data.reminders.every(isReminder)) {
      throw new Error(`dsh-telegram: ${this.file} is not a valid reminder file; fix or remove it`)
    }
    this.reminders = data.reminders
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
