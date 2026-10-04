import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TurnContext } from '../src/sessions.ts'
import { ReminderStore } from '../src/schedule-store.ts'
import { createScheduleTools } from '../src/schedule-tools.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
const admin = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const member = { id: 9, is_bot: false, first_name: 'Bob' }

let dir: string
let store: ReminderStore
let turn: TurnContext | undefined
let changes: number
let ids: number
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-tools-'))
  store = new ReminderStore(join(dir, 'schedule.json'))
  store.load()
  turn = { sender: admin, isGroup: false }
  changes = 0
  ids = 0
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function tools(maxPerChat = 20) {
  const [create, list, update, remove] = createScheduleTools({
    telegram: { chatOf: id => (id === 'agent-5' ? 5 : id === 'agent-6' ? 6 : undefined), turnOf: () => turn, superAdmins: [7] },
    store, timeZone: 'Asia/Ho_Chi_Minh', maxPerChat, changed: () => { changes++ }, now: () => NOW, newId: () => `r${++ids}`,
  })
  return { create: create!, list: list!, update: update!, remove: remove! }
}
const exec = (agentId?: string) => ({
  callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  ...(agentId === undefined ? {} : { agent: { id: agentId } }),
}) as never
/** `null` calls without an agent; a default parameter would swallow `undefined`. */
const call = async (tool: { execute(args: never, exec: never): Promise<unknown> }, args: object, agentId: string | null = 'agent-5') =>
  JSON.parse(String(await tool.execute(args as never, exec(agentId ?? undefined)))) as Record<string, any>

describe('schedule tools', () => {
  it('names the four tools', () => {
    expect(createScheduleTools({ telegram: { chatOf: () => undefined, turnOf: () => undefined, superAdmins: [] }, store, timeZone: 'UTC', maxPerChat: 1, changed: () => {} })
      .map(t => t.name)).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
  })

  it('creates a message reminder in the default zone and lists it for the chat only', async () => {
    const { create, list } = tools()
    const created = await call(create, { title: 'Standup', prompt: 'Join the call', daily: { time: '07:00:00' } })
    expect(created).toMatchObject({ id: 'r1', kind: 'daily', mode: 'message', scheduledAt: '2026-10-05T00:00:00.000Z', creator: { id: 7, name: '@ann' } })
    expect(changes).toBe(1)
    expect((await call(list, {})).map((r: { id: string }) => r.id)).toEqual(['r1'])
    expect(await call(list, {}, 'agent-6')).toEqual([])
  })

  it('lets only super admins create agent reminders', async () => {
    const { create } = tools()
    turn = { sender: member, isGroup: true }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).code).toBe('forbidden')
    turn = { sender: admin, isGroup: true }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).mode).toBe('agent')
  })

  it('reports input errors and the per-chat limit without storing anything', async () => {
    const { create } = tools(1)
    expect((await call(create, { title: 'T', prompt: 'p' })).code).toBe('invalid_rule')
    expect((await call(create, { title: 'T', prompt: 'p', every_seconds: 30 })).code).toBe('frequency_too_high')
    await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })
    expect((await call(create, { title: 'T2', prompt: 'p', after_seconds: 60 })).code).toBe('limit_reached')
    expect(store.all()).toHaveLength(1)
  })

  it('answers no_chat outside a chat turn', async () => {
    const { create } = tools()
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, null)).code).toBe('no_chat')
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, 'subagent')).code).toBe('no_chat')
    turn = undefined
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('no_chat')
    expect(store.all()).toEqual([])
  })

  it('updates and deletes only for the creator or a super admin, and only in the same chat', async () => {
    const { create, update, remove } = tools()
    turn = { sender: { ...member, id: 11 }, isGroup: true }
    await call(create, { title: 'Mine', prompt: 'p', daily: { time: '07:00:00' } })
    turn = { sender: member, isGroup: true }
    expect((await call(update, { id: 'r1', title: 'Hijack' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' }, 'agent-6')).code).toBe('schedule_not_found')
    turn = { sender: admin, isGroup: true }
    expect(await call(update, { id: 'r1', title: 'Renamed', weekly: { time: '09:00:00', weekdays: [1] } })).toMatchObject({
      id: 'r1', title: 'Renamed', kind: 'weekly', scheduledAt: '2026-10-05T02:00:00.000Z',
    })
    expect((await call(update, { id: 'r1', after_seconds: 60 })).code).toBe('invalid_rule')
    expect(await call(remove, { id: 'r1' })).toEqual({ id: 'r1', deleted: true })
    expect((await call(remove, { id: 'r1' })).code).toBe('schedule_not_found')
    expect(changes).toBe(3)
  })

  it('reports storage_failed when the store cannot be written', async () => {
    await writeFile(join(dir, 'blocker'), 'x')
    // No load(): reading a path under a file fails with ENOTDIR; an unloaded store starts empty.
    store = new ReminderStore(join(dir, 'blocker', 'schedule.json'))
    expect((await call(tools().create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('storage_failed')
  })
})
