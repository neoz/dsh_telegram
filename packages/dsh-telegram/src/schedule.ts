import {
  createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord, createDailyScheduleRecord, createEveryScheduleRecord,
  createWeeklyScheduleRecord, isRecurringScheduleRecord, MAX_TITLE_LENGTH, resolveRecurringOccurrence, ScheduleId, ScheduleInputError,
  scheduleView, type ScheduleRecord,
} from '@deepseek-ai/dsh-schedule'
import type { TelegramUser } from './inbound.ts'

export type ReminderMode = 'message' | 'agent'

/** One active reminder; `record` is a dsh-schedule record (id, kind, title, prompt, scheduledAt and the rule). */
export interface Reminder {
  chatId: number
  creator: { id: number; name: string }
  mode: ReminderMode
  record: ScheduleRecord
}

/** Tool-facing timing selectors; a missing time_zone falls back to the configured zone. */
export interface TimingInput {
  after_seconds?: number
  at?: string
  every_seconds?: number
  daily?: { time: string; time_zone?: string }
  weekly?: { time: string; time_zone?: string; weekdays: number[] }
  cron?: { expression: string; time_zone?: string }
}

/** A failure the tools report to the model as `{ code, message }`. */
export class ReminderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReminderError'
  }
}

const SELECTORS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

/** dsh-schedule input errors keep their own codes. */
function translated<T>(build: () => T): T {
  try {
    return build()
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new ReminderError(String(error.code), error.message)
    throw error
  }
}

export function buildRecord(id: string, title: string, prompt: string, timing: TimingInput, now: number, zone: string): ScheduleRecord {
  const given = SELECTORS.filter(key => timing[key] !== undefined)
  if (given.length !== 1) throw new ReminderError('invalid_rule', `give exactly one of ${SELECTORS.join(', ')}`)
  const sid = ScheduleId(id)
  return translated(() => {
    const { after_seconds, at, every_seconds, daily, weekly, cron } = timing
    if (after_seconds !== undefined) return createAfterScheduleRecord(sid, prompt, after_seconds, now, title)
    if (at !== undefined) return createAtScheduleRecord(sid, prompt, at, now, title)
    if (every_seconds !== undefined) return createEveryScheduleRecord(sid, prompt, every_seconds, now, title)
    if (daily !== undefined) return createDailyScheduleRecord(sid, prompt, { time: daily.time, time_zone: daily.time_zone ?? zone }, now, title)
    if (weekly !== undefined) {
      return createWeeklyScheduleRecord(sid, prompt, { time: weekly.time, time_zone: weekly.time_zone ?? zone, weekdays: weekly.weekdays }, now, title)
    }
    return createCronScheduleRecord(sid, prompt, { expression: cron!.expression, time_zone: cron!.time_zone ?? zone }, now, title)
  })
}

/** New title and prompt for a record whose timing stays; the same limits as creation. */
export function retitle(record: ScheduleRecord, changes: { title?: string; prompt?: string }): ScheduleRecord {
  const title = changes.title?.trim() ?? record.title
  const prompt = changes.prompt ?? record.prompt
  if (title === '' || title.length > MAX_TITLE_LENGTH) throw new ReminderError('invalid_prompt', `title must be 1-${MAX_TITLE_LENGTH} characters`)
  if (prompt.trim() === '') throw new ReminderError('invalid_prompt', 'prompt must be non-empty')
  return { ...record, title, prompt }
}

export function canManage(reminder: Reminder, userId: number, superAdmins: readonly number[]): boolean {
  return reminder.creator.id === userId || superAdmins.includes(userId)
}

const dueAt = (reminder: Reminder) => Date.parse(reminder.record.scheduledAt)

export function dueReminders(reminders: readonly Reminder[], now: number): Reminder[] {
  return reminders.filter(r => dueAt(r) <= now).sort((a, b) => dueAt(a) - dueAt(b))
}

export function nextDueAt(reminders: readonly Reminder[]): number | undefined {
  return reminders.length === 0 ? undefined : Math.min(...reminders.map(dueAt))
}

/** The reminder after delivering at `now`: undefined for a one-shot or an exhausted rule, else the next target. */
export function afterDelivery(reminder: Reminder, now: number): Reminder | undefined {
  if (!isRecurringScheduleRecord(reminder.record)) return undefined
  const { nextScheduledAt } = resolveRecurringOccurrence(reminder.record, now)
  return nextScheduledAt === undefined ? undefined : { ...reminder, record: { ...reminder.record, scheduledAt: nextScheduledAt } }
}

/** dsh-schedule's view without its Host-only `state` and `deliveryMode` (so the clock it samples does not matter), plus mode and creator. */
export function reminderView(reminder: Reminder): Record<string, unknown> {
  const { state: _state, deliveryMode: _deliveryMode, ...view } = scheduleView(reminder.record, Date.now()) as unknown as Record<string, unknown>
  return { ...view, mode: reminder.mode, creator: reminder.creator }
}

export function displayName(user: TelegramUser): string {
  return user.username === undefined ? user.first_name : `@${user.username}`
}

export function reminderMessage(reminder: Reminder): string {
  return `\u{23F0} ${reminder.record.title}\n${reminder.record.prompt}`
}

const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** The instruction an agent reminder submits as its turn's text. */
export function agentPrompt(reminder: Reminder): string {
  return `<scheduled_reminder title="${attribute(reminder.record.title)}" created_by="${attribute(reminder.creator.name)}">\n`
    + `${reminder.record.prompt}\n</scheduled_reminder>`
}
