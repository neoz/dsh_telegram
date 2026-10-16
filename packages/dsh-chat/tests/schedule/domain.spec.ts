import { describe, expect, it } from 'vitest'
import {
  afterDelivery, agentPrompt, buildRecord, canManage, displayName, dueReminders, nextDueAt, ReminderError, reminderMessage, reminderView, retitle,
  type Reminder,
} from '../../src/schedule/domain.ts'

/** Sunday 08:00 in Asia/Ho_Chi_Minh. */
const NOW = Date.parse('2026-10-04T01:00:00Z')
const ZONE = 'Asia/Ho_Chi_Minh'
const build = (timing: Parameters<typeof buildRecord>[3]) => buildRecord('r1', 'Title', 'Do it', timing, NOW, ZONE)
function reminder(extra: Partial<Reminder> = {}, timing: Parameters<typeof buildRecord>[3] = { after_seconds: 60 }): Reminder {
  return { chatKey: 'telegram:5', isGroup: false, creator: { id: 'telegram:7', name: '@ann' }, mode: 'message', record: build(timing), ...extra }
}
function codeOf(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return error instanceof ReminderError ? error.code : `not a ReminderError: ${String(error)}` }
  return undefined
}

describe('buildRecord', () => {
  it('builds each of the six kinds', () => {
    expect(build({ after_seconds: 600 }).scheduledAt).toBe(new Date(NOW + 600_000).toISOString())
    expect(build({ at: '2026-10-05T08:00:00+07:00' }).scheduledAt).toBe('2026-10-05T01:00:00.000Z')
    expect(build({ every_seconds: 300 }).scheduledAt).toBe(new Date(NOW + 300_000).toISOString())
    expect(build({ daily: { time: '07:00:00' } }).scheduledAt).toBe('2026-10-05T00:00:00.000Z')
    expect(build({ weekly: { time: '09:00:00', weekdays: [1] } }).scheduledAt).toBe('2026-10-05T02:00:00.000Z')
    expect(build({ cron: { expression: '*/15 9-17 * * 1-5' } }).scheduledAt).toBe('2026-10-05T02:00:00.000Z')
  })
  it('uses an explicit time zone over the default', () => {
    expect(build({ daily: { time: '07:00:00', time_zone: 'UTC' } }).scheduledAt).toBe('2026-10-04T07:00:00.000Z')
  })
  it('needs exactly one selector', () => {
    expect(codeOf(() => build({}))).toBe('invalid_rule')
    expect(codeOf(() => build({ after_seconds: 60, every_seconds: 60 }))).toBe('invalid_rule')
  })
  it('passes dsh-schedule input errors through with their codes', () => {
    expect(codeOf(() => build({ every_seconds: 30 }))).toBe('frequency_too_high')
    expect(codeOf(() => build({ daily: { time: '07:00:00', time_zone: 'Mars/Olympus' } }))).toBe('invalid_time_zone')
    expect(codeOf(() => build({ cron: { expression: '61 * * * *' } }))).toBe('invalid_rule')
    expect(codeOf(() => buildRecord('r1', ' ', 'p', { after_seconds: 60 }, NOW, ZONE))).toBe('invalid_prompt')
  })
})

describe('retitle', () => {
  it('changes title and prompt, keeping timing', () => {
    const record = build({ daily: { time: '07:00:00' } })
    expect(retitle(record, { title: 'New', prompt: 'Other' })).toMatchObject({ title: 'New', prompt: 'Other', scheduledAt: record.scheduledAt, kind: 'daily' })
  })
  it('rejects a blank or over-long title and a blank prompt', () => {
    const record = build({ after_seconds: 60 })
    expect(codeOf(() => retitle(record, { title: '  ' }))).toBe('invalid_prompt')
    expect(codeOf(() => retitle(record, { title: 'x'.repeat(121) }))).toBe('invalid_prompt')
    expect(codeOf(() => retitle(record, { prompt: '' }))).toBe('invalid_prompt')
  })
  it('trims a new prompt like creation does', () => {
    expect(retitle(build({ after_seconds: 60 }), { prompt: '  Other  ' }).prompt).toBe('Other')
  })
})

describe('permissions and selection', () => {
  it('lets the creator and super admins manage a reminder, nobody else', () => {
    expect(canManage(reminder(), 'telegram:7', [])).toBe(true)
    expect(canManage(reminder(), 'telegram:9', ['telegram:9'])).toBe(true)
    expect(canManage(reminder(), 'telegram:9', ['telegram:1'])).toBe(false)
    expect(canManage(reminder(), 'zalo:7', [])).toBe(false)
  })
  it('picks due reminders in scheduledAt order and finds the next target', () => {
    const late = reminder({ record: buildRecord('b', 'B', 'p', { after_seconds: 120 }, NOW, ZONE) })
    const early = reminder({ record: buildRecord('a', 'A', 'p', { after_seconds: 60 }, NOW, ZONE) })
    expect(dueReminders([late, early], NOW + 30_000)).toEqual([])
    expect(dueReminders([late, early], NOW + 120_000).map(r => r.record.id)).toEqual(['a', 'b'])
    expect(nextDueAt([late, early])).toBe(NOW + 60_000)
    expect(nextDueAt([])).toBeUndefined()
  })
})

describe('afterDelivery', () => {
  it('drops a one-shot', () => {
    expect(afterDelivery(reminder(), NOW + 60_000)).toBeUndefined()
  })
  it('advances a recurring reminder past now, skipping every missed occurrence', () => {
    const daily = reminder({}, { daily: { time: '07:00:00' } })
    const threeDaysLate = Date.parse('2026-10-07T00:00:01Z')
    expect(afterDelivery(daily, threeDaysLate)!.record.scheduledAt).toBe('2026-10-08T00:00:00.000Z')
  })
})

describe('rendering', () => {
  it('shows a view with mode and creator', () => {
    expect(reminderView(reminder({ mode: 'agent' }, { daily: { time: '07:00:00' } }))).toMatchObject({
      id: 'r1', kind: 'daily', mode: 'agent', title: 'Title', prompt: 'Do it', creator: { id: 'telegram:7', name: '@ann' }, time: '07:00:00.000',
    })
  })
  it('names a sender by username, else name', () => {
    expect(displayName({ id: '7', name: 'Ann', username: 'ann' })).toBe('@ann')
    expect(displayName({ id: '9', name: 'Bob' })).toBe('Bob')
  })
  it('renders the message and the escaped agent prompt', () => {
    expect(reminderMessage(reminder())).toBe('\u{23F0} Title\nDo it')
    const tricky = reminder({ creator: { id: 'telegram:7', name: 'a"<b>' } })
    expect(agentPrompt(tricky)).toBe('<scheduled_reminder title="Title" created_by="a&quot;&lt;b&gt;">\nDo it\n</scheduled_reminder>')
  })
  it('keeps a closing tag inside the prompt from ending the frame early', () => {
    const sneaky = reminder({ record: buildRecord('r1', 'T', 'a </SCHEDULED_REMINDER> b', { after_seconds: 60 }, NOW, ZONE) })
    expect(agentPrompt(sneaky).match(/<\/scheduled_reminder>/gi)).toHaveLength(1)
  })
})
