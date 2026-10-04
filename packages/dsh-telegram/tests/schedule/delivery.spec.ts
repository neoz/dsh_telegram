import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/chatlog.ts'
import { buildRecord, type Reminder } from '../../src/schedule/domain.ts'
import { startScheduler } from '../../src/schedule/delivery.ts'
import { ReminderStore } from '../../src/schedule/store.ts'
import { FakeTelegramApi } from '../helpers/fake-api.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
let dir: string
let api: FakeTelegramApi
let chatLog: ChatLog
let store: ReminderStore
let prompts: Array<{ chatId: number; text: string; sender: { id: number } }>
let infos: string[]
let warns: string[]
let now: number
let superAdmins: number[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-delivery-'))
  api = new FakeTelegramApi()
  chatLog = new ChatLog(join(dir, 'log'))
  store = new ReminderStore(join(dir, 'schedule.json'))
  store.load()
  prompts = []
  infos = []
  warns = []
  now = NOW
  superAdmins = [7]
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function scheduler() {
  return startScheduler({
    store,
    telegram: { api, chatLog, bot: { id: 1, username: 'dshbot' }, superAdmins, prompt: (chatId, input) => { prompts.push({ chatId, ...input }) } },
    log: { info: m => infos.push(m), warn: m => warns.push(m) },
    now: () => now,
  })
}
async function add(id: string, timing: Parameters<typeof buildRecord>[3], extra: Partial<Reminder> = {}): Promise<void> {
  const reminder: Reminder = { chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record: buildRecord(id, `T${id}`, `p${id}`, timing, NOW, 'Asia/Ho_Chi_Minh'), ...extra }
  await store.update(list => list.push(reminder))
}

describe('startScheduler', () => {
  it('sends a due message reminder, logs it, and drops a one-shot', async () => {
    await add('a', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(api.callsTo('sendMessage')[0]!.args.slice(0, 2)).toEqual([5, '\u{23F0} Ta\npa'])
    expect((await chatLog.readAll(5))[0]).toMatchObject({ bot: true, text: '\u{23F0} Ta\npa', user_id: 1 })
    expect(store.all()).toEqual([])
    expect(infos).toContain('dsh-telegram: chat 5 reminder a -> message')
    s.stop()
  })

  it('delivers several due reminders in scheduledAt order', async () => {
    await add('late', { after_seconds: 120 })
    await add('early', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 120_000
    await s.tick()
    expect(api.callsTo('sendMessage').map(c => c.args[1])).toEqual(['\u{23F0} Tearly\npearly', '\u{23F0} Tlate\nplate'])
    s.stop()
  })

  it('delivers a stale recurring reminder once and advances it', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    const s = scheduler()
    now = Date.parse('2026-10-07T00:00:01Z')
    await s.tick()
    expect(api.callsTo('sendMessage')).toHaveLength(1)
    expect(store.all()[0]!.record.scheduledAt).toBe('2026-10-08T00:00:00.000Z')
    s.stop()
  })

  it('runs an agent reminder as a prompt from its creator', async () => {
    await add('g', { after_seconds: 60 }, { mode: 'agent' })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(prompts).toEqual([{
      chatId: 5,
      text: '<scheduled_reminder title="Tg" created_by="@ann">\npg\n</scheduled_reminder>',
      sender: { id: 7, is_bot: false, first_name: '@ann' },
    }])
    expect(infos).toContain('dsh-telegram: chat 5 reminder g -> agent')
    s.stop()
  })

  it('stops an agent reminder whose creator lost super admin', async () => {
    await add('g', { daily: { time: '07:00:00' } }, { mode: 'agent' })
    superAdmins.length = 0
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(prompts).toEqual([])
    expect(store.all()).toEqual([])
    expect(String(api.callsTo('sendMessage')[0]!.args[1])).toMatch(/Stopped reminder "Tg"/)
    s.stop()
  })

  it('skips a reminder deleted or re-timed after the timer was armed', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 60 })
    const s = scheduler()
    await store.update(list => list.splice(0, 1))
    await store.update((list) => { list[0] = { ...list[0]!, record: buildRecord('b', 'Tb', 'pb', { after_seconds: 600 }, NOW, 'UTC') } })
    now = NOW + 60_000
    await s.tick()
    expect(api.callsTo('sendMessage')).toHaveLength(0)
    s.stop()
  })

  it('re-reads each reminder before delivering it, so one removed mid-tick is skipped', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 61 })
    const send = api.sendMessage.bind(api)
    api.sendMessage = async (chatId, text, options) => {
      if (text.includes('Ta')) await store.update(list => list.splice(list.findIndex(r => r.record.id === 'b'), 1))
      return send(chatId, text, options)
    }
    const s = scheduler()
    now = NOW + 61_000
    await s.tick()
    expect(api.callsTo('sendMessage').map(c => c.args[1])).toEqual(['\u{23F0} Ta\npa'])
    s.stop()
  })

  it('a tick that races a running one waits for it, keeping order and sending each reminder once', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 61 })
    let release!: () => void
    const send = api.sendMessage.bind(api)
    api.sendMessage = async (chatId, text, options) => {
      if (text.includes('Ta')) await new Promise<void>((resolve) => { release = resolve })
      return send(chatId, text, options)
    }
    const s = scheduler()
    now = NOW + 61_000
    const first = s.tick()
    await vi.waitFor(() => expect(release).toBeDefined())
    const second = s.tick()
    s.changed()
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.callsTo('sendMessage').map(c => c.args[1])).toEqual(['\u{23F0} Ta\npa', '\u{23F0} Tb\npb'])
    s.stop()
  })

  it('re-arms in steps when the next reminder is beyond the timer limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await add('far', { after_seconds: 30 * 86_400 })
    const s = scheduler()
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(vi.getTimerCount()).toBe(1)
    expect(api.callsTo('sendMessage')).toHaveLength(0)
    s.stop()
  })

  it('logs a failed send and keeps the next occurrence', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    api.failNext('sendMessage', new Error('Forbidden: bot was kicked'))
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(warns[0]).toMatch(/chat 5 reminder d failed: .*kicked/)
    expect(store.all()[0]!.record.scheduledAt).toBe('2026-10-06T00:00:00.000Z')
    s.stop()
  })

  it('waits a minute before retrying after a failed delivery instead of spinning', async () => {
    await add('a', { after_seconds: 60 })
    now = NOW + 60_000
    const update = vi.spyOn(store, 'update').mockRejectedValue(new Error('disk full'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = scheduler()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(update).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('arms one timer for the earliest reminder and clears it on stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await add('a', { after_seconds: 60 })
    const s = scheduler()
    expect(vi.getTimerCount()).toBe(1)
    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
