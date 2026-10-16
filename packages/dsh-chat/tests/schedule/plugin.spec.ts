import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/log/chatlog.ts'
import { buildRecord } from '../../src/schedule/domain.ts'
import * as schedulePlugin from '../../src/schedule/index.ts'
import { Config } from '../../src/schedule/index.ts'

/** `FiberState` is a const enum that Cordis does not export at runtime. */
const ACTIVE = 2
const FAILED = 3

let dir: string
let root: Context
let registered: string[]
let disposed: string[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-plugin-'))
  registered = []
  disposed = []
  root = new Context()
  root.provide('tools', {
    register: (tool: { name: string }) => { registered.push(tool.name); return () => { disposed.push(tool.name) } },
  } as never)
  root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
  root.provide('chatLog', new ChatLog(join(dir, 'log')))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const chat = () => ({ channel: () => undefined, prompt: () => {}, superAdmins: [], chatOf: () => undefined, turnOf: () => undefined }) as never

/** Collects every log line, errors included, as text. */
function capture(): string[] {
  const lines: string[] = []
  root.logger.exporter({ levels: { default: 3 }, export: message => lines.push(message.args.map(String).join(' ')) })
  return lines
}

describe('schedule Config', () => {
  it('fills defaults', () => {
    expect(Config({})).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })
})

describe('schedule plugin', () => {
  it('stays inert without the chat router', async () => {
    const fiber = root.plugin(schedulePlugin, Config({}))
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    expect(registered).toEqual([])
  })

  it('rejects an invalid config at load, before the router is up', async () => {
    const badZone = root.plugin(schedulePlugin, { timeZone: 'Mars/Olympus', maxPerChat: 20 })
    const badMax = root.plugin(schedulePlugin, { timeZone: 'UTC', maxPerChat: 0 })
    await vi.waitFor(() => expect([badZone.state, badMax.state]).toEqual([FAILED, FAILED]))
  })

  it('registers the four tools while chat is provided and removes them on revoke', async () => {
    root.plugin(schedulePlugin, Config({}))
    const revoke = root.provide('chat', chat())
    await vi.waitFor(() => expect(registered).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']))
    revoke()
    await vi.waitFor(() => expect(disposed).toHaveLength(4))
  })

  it('does not start on a corrupted schedule.json, leaves it untouched and names it in the error', async () => {
    const lines = capture()
    const file = join(dir, 'telegram', 'schedule.json')
    await mkdir(join(dir, 'telegram'), { recursive: true })
    await writeFile(file, '{broken')
    root.plugin(schedulePlugin, Config({}))
    root.provide('chat', chat())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(registered).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('{broken')
    expect(lines.some(line => line.includes(file))).toBe(true)
  })

  it('logs once that reminders are on, with the count', async () => {
    const lines = capture()
    root.plugin(schedulePlugin, Config({}))
    root.provide('chat', chat())
    await vi.waitFor(() => expect(registered).toHaveLength(4))
    expect(lines.filter(line => line === 'dsh-chat: reminders on (0 active)')).toHaveLength(1)
  })

  it('names the next target when reminders are stored, reading the old Telegram file', async () => {
    const record = buildRecord('r1', 'T', 'p', { after_seconds: 3600 }, Date.now(), 'UTC')
    await mkdir(join(dir, 'telegram'), { recursive: true })
    await writeFile(join(dir, 'telegram', 'schedule.json'), JSON.stringify({ version: 1, reminders: [{ chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record }] }))
    const lines = capture()
    root.plugin(schedulePlugin, Config({}))
    root.provide('chat', chat())
    await vi.waitFor(() => expect(registered).toHaveLength(4))
    expect(lines).toContain(`dsh-chat: reminders on (1 active, next ${record.scheduledAt})`)
  })
})
