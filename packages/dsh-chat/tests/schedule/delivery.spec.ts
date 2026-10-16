import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/log/chatlog.ts'
import type { PromptInput } from '../../src/router/channel.ts'
import { buildRecord, type Reminder } from '../../src/schedule/domain.ts'
import { startScheduler } from '../../src/schedule/delivery.ts'
import { ReminderBook } from '../../src/schedule/store.ts'
import { FakeChannel } from '../router/fake-channel.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
let dir: string
let telegram: FakeChannel
let online: boolean
let chatLog: ChatLog
let book: ReminderBook
let prompts: Array<{ key: string } & PromptInput>
let infos: string[]
let warns: string[]
let now: number
let superAdmins: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-delivery-'))
  telegram = new FakeChannel('telegram')
  online = true
  chatLog = new ChatLog(join(dir, 'log'))
  book = new ReminderBook(join(dir, 'data'))
  book.load()
  prompts = []
  infos = []
  warns = []
  now = NOW
  superAdmins = ['telegram:7']
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function scheduler() {
  return startScheduler({
    book,
    chat: { channel: id => (online && id === 'telegram' ? telegram : undefined), prompt: (key, input) => { prompts.push({ key, ...input }) }, superAdmins },
    chatLog,
    log: { info: m => infos.push(m), warn: m => warns.push(m) },
    now: () => now,
  })
}
async function add(id: string, timing: Parameters<typeof buildRecord>[3], extra: Partial<Reminder> = {}): Promise<void> {
  const reminder: Reminder = {
    chatKey: 'telegram:5', isGroup: false, creator: { id: 'telegram:7', name: '@ann' }, mode: 'message',
    record: buildRecord(id, `T${id}`, `p${id}`, timing, NOW, 'Asia/Ho_Chi_Minh'), ...extra,
  }
  await book.update('telegram', list => list.push(reminder))
}
const sentTexts = () => telegram.sent.map(s => s.text)
/** Lets real file writes finish while fake timers hold the clock: spins the event loop until `done` holds. */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000 && !done(); i++) await new Promise(resolve => setImmediate(resolve))
}

describe('startScheduler', () => {
  it('sends a due message reminder, logs it, and drops a one-shot', async () => {
    await add('a', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(telegram.sent).toEqual([{ chatId: '5', text: '\u{23F0} Ta\npa' }])
    expect((await chatLog.readAll('telegram:5'))[0]).toMatchObject({ bot: true, text: '\u{23F0} Ta\npa', message_id: 's1', user_id: 'telegram-bot', name: 'telegrambot' })
    expect(book.all()).toEqual([])
    expect(infos).toContain('dsh-chat: telegram:5 reminder a -> message')
    s.stop()
  })

  it('delivers several due reminders in scheduledAt order', async () => {
    await add('late', { after_seconds: 120 })
    await add('early', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 120_000
    await s.tick()
    expect(sentTexts()).toEqual(['\u{23F0} Tearly\npearly', '\u{23F0} Tlate\nplate'])
    s.stop()
  })

  it('delivers a stale recurring reminder once and advances it', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    const s = scheduler()
    now = Date.parse('2026-10-07T00:00:01Z')
    await s.tick()
    expect(telegram.sent).toHaveLength(1)
    expect(book.all()[0]!.record.scheduledAt).toBe('2026-10-08T00:00:00.000Z')
    s.stop()
  })

  it('runs an agent reminder as a prompt from its creator, in a group when it was made in one', async () => {
    await add('g', { after_seconds: 60 }, { mode: 'agent', chatKey: 'telegram:-5', isGroup: true })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(prompts).toEqual([{
      key: 'telegram:-5',
      text: '<scheduled_reminder title="Tg" created_by="@ann">\npg\n</scheduled_reminder>',
      sender: { id: '7', name: '@ann' },
      isGroup: true,
    }])
    expect(infos).toContain('dsh-chat: telegram:-5 reminder g -> agent')
    s.stop()
  })

  it('stops an agent reminder whose creator lost super admin', async () => {
    await add('g', { daily: { time: '07:00:00' } }, { mode: 'agent' })
    superAdmins.length = 0
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(prompts).toEqual([])
    expect(book.all()).toEqual([])
    expect(sentTexts()[0]).toMatch(/Stopped reminder "Tg"/)
    expect(await chatLog.readAll('telegram:5')).toEqual([])
    s.stop()
  })

  it('leaves a due reminder alone while its channel is offline and delivers it once the channel is back', async () => {
    await add('a', { after_seconds: 60 })
    online = false
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(book.all()).toHaveLength(1)
    expect(telegram.sent).toEqual([])
    expect(warns[0]).toMatch(/telegram:5 reminder a failed: .*offline/)
    online = true
    // A failed reminder waits out the retry delay before it is tried again.
    await s.tick()
    expect(telegram.sent).toEqual([])
    now += 60_000
    await s.tick()
    expect(sentTexts()).toEqual(['\u{23F0} Ta\npa'])
    expect(book.all()).toEqual([])
    s.stop()
  })

  it('an overdue reminder of an offline channel does not hold back another channel', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const stale = buildRecord('z', 'Tz', 'pz', { after_seconds: 60 }, NOW - 120_000, 'UTC')
    await book.update('zalo', list => list.push({ chatKey: 'zalo:c1', isGroup: false, creator: { id: 'zalo:u1', name: 'U' }, mode: 'message', record: stale }))
    await book.update('telegram', list => list.push({
      chatKey: 'telegram:5', isGroup: false, creator: { id: 'telegram:7', name: '@ann' }, mode: 'message', record: buildRecord('t', 'Tt', 'pt', { after_seconds: 90 }, NOW - 60_000, 'UTC'),
    }))
    const s = startScheduler({
      book, chat: { channel: id => (id === 'telegram' ? telegram : undefined), prompt: () => {}, superAdmins }, chatLog,
      log: { info: m => infos.push(m), warn: m => warns.push(m) }, now: () => Date.now(),
    })
    await vi.advanceTimersByTimeAsync(0)
    await settle(() => warns.length === 1)
    expect(warns.filter(w => w.includes('zalo:c1'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(() => infos.includes('dsh-chat: telegram:5 reminder t -> message'))
    expect(sentTexts()).toEqual(['\u{23F0} Tt\npt'])
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(() => warns.length === 2)
    expect(warns.filter(w => w.includes('zalo:c1'))).toHaveLength(2)
    expect(book.all().map(r => r.chatKey)).toEqual(['zalo:c1'])
    s.stop()
  })

  it('puts a reminder back when its channel goes away between advancing it and sending', async () => {
    await add('a', { after_seconds: 60 })
    let lookups = 0
    const s = startScheduler({
      book, chat: { channel: () => (++lookups === 1 ? telegram : undefined), prompt: () => {}, superAdmins }, chatLog,
      log: { info: m => infos.push(m), warn: m => warns.push(m) }, now: () => now,
    })
    now = NOW + 60_000
    await s.tick()
    expect(telegram.sent).toEqual([])
    expect(book.all().map(r => [r.record.id, r.record.scheduledAt])).toEqual([['a', new Date(NOW + 60_000).toISOString()]])
    s.stop()
  })

  it('skips a reminder deleted or re-timed after the timer was armed', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 60 })
    const s = scheduler()
    await book.update('telegram', list => list.splice(0, 1))
    await book.update('telegram', (list) => { list[0] = { ...list[0]!, record: buildRecord('b', 'Tb', 'pb', { after_seconds: 600 }, NOW, 'UTC') } })
    now = NOW + 60_000
    await s.tick()
    expect(telegram.sent).toHaveLength(0)
    s.stop()
  })

  it('re-reads each reminder before delivering it, so one removed mid-tick is skipped', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 61 })
    const send = telegram.send.bind(telegram)
    telegram.send = async (chatId, text, opts) => {
      if (text.includes('Ta')) await book.update('telegram', list => list.splice(list.findIndex(r => r.record.id === 'b'), 1))
      return send(chatId, text, opts)
    }
    const s = scheduler()
    now = NOW + 61_000
    await s.tick()
    expect(sentTexts()).toEqual(['\u{23F0} Ta\npa'])
    s.stop()
  })

  it('a tick that races a running one waits for it, keeping order and sending each reminder once', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 61 })
    let release!: () => void
    const send = telegram.send.bind(telegram)
    telegram.send = async (chatId, text, opts) => {
      if (text.includes('Ta')) await new Promise<void>((resolve) => { release = resolve })
      return send(chatId, text, opts)
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
    expect(sentTexts()).toEqual(['\u{23F0} Ta\npa', '\u{23F0} Tb\npb'])
    s.stop()
  })

  it('re-arms in steps when the next reminder is beyond the timer limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await add('far', { after_seconds: 30 * 86_400 })
    const s = scheduler()
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(vi.getTimerCount()).toBe(1)
    expect(telegram.sent).toHaveLength(0)
    s.stop()
  })

  it('logs a failed send and keeps the next occurrence', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    telegram.send = async () => { throw new Error('Forbidden: bot was kicked') }
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(warns[0]).toMatch(/telegram:5 reminder d failed: .*kicked/)
    expect(book.all()[0]!.record.scheduledAt).toBe('2026-10-06T00:00:00.000Z')
    s.stop()
  })

  it('waits a minute before retrying after a failed delivery instead of spinning', async () => {
    await add('a', { after_seconds: 60 })
    const update = vi.spyOn(book, 'update').mockRejectedValue(new Error('disk full'))
    vi.useFakeTimers({ now: NOW + 60_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = startScheduler({ book, chat: { channel: () => telegram, prompt: () => {}, superAdmins }, chatLog, log: { info: () => {}, warn: () => {} }, now: () => Date.now() })
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
