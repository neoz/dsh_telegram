import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TurnContext } from '../../src/sessions/agents.ts'
import { ReminderBook } from '../../src/schedule/store.ts'
import { createScheduleTools } from '../../src/schedule/tools.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
const admin = { id: '7', name: 'Ann', username: 'ann' }
const member = { id: '9', name: 'Bob' }

let dir: string
let book: ReminderBook
let turn: TurnContext | undefined
let changes: number
let ids: number
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-tools-'))
  book = new ReminderBook(dir)
  book.load()
  turn = { sender: admin, isGroup: false, isSuperAdmin: true }
  changes = 0
  ids = 0
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function tools(maxPerChat = 20) {
  const [create, list, update, remove] = createScheduleTools({
    chat: { chatOf: id => (id === 'agent-5' ? 'telegram:5' : id === 'agent-6' ? 'telegram:6' : undefined), turnOf: () => turn, superAdmins: ['telegram:7'] },
    book, timeZone: 'Asia/Ho_Chi_Minh', maxPerChat, changed: () => { changes++ }, now: () => NOW, newId: () => `r${++ids}`,
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
  it('keeps after_seconds out of the update schema but still rejects it', async () => {
    const { create, update } = tools()
    expect((update as unknown as { parameters: { properties: object } }).parameters.properties).not.toHaveProperty('after_seconds')
    await call(create, { title: 'T', prompt: 'p', daily: { time: '07:00:00' } })
    expect((await call(update, { id: 'r1', after_seconds: 60 })).code).toBe('invalid_rule')
  })

  it('names the four tools', () => {
    expect(createScheduleTools({ chat: { chatOf: () => undefined, turnOf: () => undefined, superAdmins: [] }, book, timeZone: 'UTC', maxPerChat: 1, changed: () => {} })
      .map(t => t.name)).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
  })

  it('creates a message reminder in the default zone and lists it for the chat only', async () => {
    const { create, list } = tools()
    const created = await call(create, { title: 'Standup', prompt: 'Join the call', daily: { time: '07:00:00' } })
    expect(created).toMatchObject({ id: 'r1', kind: 'daily', mode: 'message', scheduledAt: '2026-10-05T00:00:00.000Z', creator: { id: 'telegram:7', name: '@ann' } })
    expect(book.all()[0]).toMatchObject({ chatKey: 'telegram:5', isGroup: false })
    expect(changes).toBe(1)
    expect((await call(list, {})).map((r: { id: string }) => r.id)).toEqual(['r1'])
    expect(await call(list, {}, 'agent-6')).toEqual([])
  })

  it('remembers that a reminder was made in a group', async () => {
    turn = { sender: admin, isGroup: true, isSuperAdmin: true }
    await call(tools().create, { title: 'T', prompt: 'p', after_seconds: 60 })
    expect(book.all()[0]!.isGroup).toBe(true)
  })

  it('lets only super admins create agent reminders', async () => {
    const { create } = tools()
    turn = { sender: member, isGroup: true, isSuperAdmin: false }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).code).toBe('forbidden')
    turn = { sender: admin, isGroup: true, isSuperAdmin: true }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).mode).toBe('agent')
  })

  it('reports input errors and the per-chat limit without storing anything', async () => {
    const { create } = tools(1)
    expect((await call(create, { title: 'T', prompt: 'p' })).code).toBe('invalid_rule')
    expect((await call(create, { title: 'T', prompt: 'p', every_seconds: 30 })).code).toBe('frequency_too_high')
    await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })
    expect((await call(create, { title: 'T2', prompt: 'p', after_seconds: 60 })).code).toBe('limit_reached')
    expect(book.all()).toHaveLength(1)
  })

  it('answers no_chat outside a chat turn', async () => {
    const { create } = tools()
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, null)).code).toBe('no_chat')
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, 'subagent')).code).toBe('no_chat')
    turn = undefined
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('no_chat')
    expect(book.all()).toEqual([])
  })

  it('updates and deletes only for the creator or a super admin, and only in the same chat', async () => {
    const { create, update, remove } = tools()
    turn = { sender: { ...member, id: '11' }, isGroup: true, isSuperAdmin: false }
    await call(create, { title: 'Mine', prompt: 'p', daily: { time: '07:00:00' } })
    turn = { sender: member, isGroup: true, isSuperAdmin: false }
    expect((await call(update, { id: 'r1', title: 'Hijack' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' }, 'agent-6')).code).toBe('schedule_not_found')
    turn = { sender: admin, isGroup: true, isSuperAdmin: true }
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
    // No load(): reading a path under a file fails with ENOTDIR; an unloaded book starts empty.
    book = new ReminderBook(join(dir, 'blocker'))
    expect((await call(tools().create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('storage_failed')
  })
})
