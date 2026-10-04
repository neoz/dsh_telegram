import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import * as schedulePlugin from '../src/schedule-plugin.ts'
import { Config } from '../src/schedule-plugin.ts'
import type { TelegramService } from '../src/service.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

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
  })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function service(): TelegramService {
  return {
    api: new FakeTelegramApi(), chatLog: new ChatLog(join(dir, 'log')), queue: { enqueue: () => {}, isBusy: () => false },
    bot: { id: 1, username: 'dshbot' }, selection: { provider: 'p', model: 'm' }, dataDir: dir, superAdmins: [7],
    chatOf: () => undefined, turnOf: () => undefined, prompt: () => {},
  }
}

describe('schedule Config', () => {
  it('fills defaults', () => {
    expect(Config({})).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })
})

describe('schedule plugin', () => {
  it('stays inert without the telegram service', async () => {
    const fiber = root.plugin(schedulePlugin, Config({}))
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    expect(registered).toEqual([])
  })

  it('rejects an invalid config at load, before the bot provides telegram', async () => {
    const badZone = root.plugin(schedulePlugin, { timeZone: 'Mars/Olympus', maxPerChat: 20 })
    const badMax = root.plugin(schedulePlugin, { timeZone: 'UTC', maxPerChat: 0 })
    await vi.waitFor(() => expect([badZone.state, badMax.state]).toEqual([FAILED, FAILED]))
  })

  it('registers the four tools while telegram is provided and removes them on revoke', async () => {
    root.plugin(schedulePlugin, Config({}))
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(registered).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']))
    revoke()
    await vi.waitFor(() => expect(disposed).toHaveLength(4))
  })

  it('does not start on a corrupted schedule.json and leaves it untouched', async () => {
    await writeFile(join(dir, 'schedule.json'), '{broken')
    root.plugin(schedulePlugin, Config({}))
    root.provide('telegram', service())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(registered).toEqual([])
    expect(await readFile(join(dir, 'schedule.json'), 'utf8')).toBe('{broken')
  })
})
