import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { MemoryStore } from '../src/memory.ts'
import type { TurnContext } from '../src/sessions.ts'
import {
  createChatHistoryTool,
  createMemoryForgetTool,
  createMemoryRecallTool,
  createMemorySaveTool,
  createSendFileTool,
  registerChatTools,
} from '../src/tools.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
let turn: TurnContext | undefined
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'tools-'))); api = new FakeTelegramApi(); turn = undefined })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

const admin = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const member = { id: 9, is_bot: false, first_name: 'Bob' }

function deps() {
  return {
    api,
    chatLog: new ChatLog(join(dir, 'log')),
    chatId: 5,
    workspaceDir: dir,
    maxUploadBytes: 100,
    memory: new MemoryStore(join(dir, 'memory'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
    superAdmins: [7],
    currentTurn: () => turn,
  }
}

describe('telegram_send_file', () => {
  it('sends an image as a photo and other files as documents', async () => {
    await writeFile(join(dir, 'pic.png'), 'png')
    await writeFile(join(dir, 'notes.txt'), 'txt')
    const tool = createSendFileTool(deps())
    expect(tool.name).toBe('telegram_send_file')
    expect(await tool.execute({ path: 'pic.png' }, exec)).toBe('Sent pic.png')
    expect(await tool.execute({ path: join(dir, 'notes.txt'), caption: 'here' }, exec)).toBe('Sent notes.txt')
    expect(api.callsTo('sendPhoto')).toHaveLength(1)
    const [, , opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption?: string }]
    expect(opts).toMatchObject({ filename: 'notes.txt', caption: 'here' })
  })

  it('refuses paths outside the workspace and oversized files', async () => {
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(200))
    await writeFile(join(tmpdir(), 'dsh-telegram-secret'), 'x')
    const tool = createSendFileTool(deps())
    await expect(tool.execute({ path: '../dsh-telegram-secret' }, exec)).rejects.toThrow(/outside/)
    await expect(tool.execute({ path: 'big.bin' }, exec)).rejects.toThrow(/exceeds/)
    await rm(join(tmpdir(), 'dsh-telegram-secret'), { force: true })
  })
})

describe('telegram_chat_history', () => {
  it('returns formatted lines oldest first, honouring limit, before and query', async () => {
    const d = deps()
    for (let i = 1; i <= 5; i++) {
      await d.chatLog.append(5, { ts: `t${i}`, message_id: i, user_id: 1, username: 'u', name: 'U', text: i % 2 ? `odd${i}` : `even${i}` })
    }
    const tool = createChatHistoryTool(d)
    expect(tool.name).toBe('telegram_chat_history')
    expect(await tool.execute({ limit: 2 }, exec)).toBe('[t4] @u (U): even4\n[t5] @u (U): odd5')
    expect(await tool.execute({ limit: 10, before_message_id: 3, query: 'odd' }, exec)).toBe('[t1] @u (U): odd1')
    expect(await tool.execute({ limit: 10, query: 'zzz' }, exec)).toBe('(no messages)')
  })
})

describe('registerChatTools', () => {
  it('registers both tools through ctx.effect', () => {
    const registered: string[] = []
    const ctx = {
      tools: { register: (tool: { name: string }) => { registered.push(tool.name); return () => {} } },
      effect: (fn: () => () => void) => { fn() },
    }
    registerChatTools(ctx, deps())
    expect(registered).toEqual(['telegram_send_file', 'telegram_chat_history', 'memory_save', 'memory_recall', 'memory_forget'])
  })
})

describe('memory_save / memory_recall / memory_forget', () => {
  it('saves to the chat scope by default and recalls both scopes with headings', async () => {
    const d = deps()
    turn = { sender: admin, isGroup: false }
    const save = createMemorySaveTool(d)
    expect(save.name).toBe('memory_save')
    expect(await save.execute({ text: 'likes tea' }, exec)).toBe('Saved [#1] likes tea')
    expect(await save.execute({ text: 'stand-up 9:00', scope: 'global' }, exec)).toBe('Saved [#1] stand-up 9:00')
    expect(await save.execute({ text: 'likes black tea', replace_id: 1 }, exec)).toBe('Replaced [#1] likes black tea')
    expect((await d.memory.list({ kind: 'chat', chatId: 5 })).map(e => e.text)).toEqual(['likes black tea'])

    const recall = createMemoryRecallTool(d)
    expect(recall.name).toBe('memory_recall')
    expect(await recall.execute({}, exec)).toBe('Chat memory:\n[#1] likes black tea\n\nGlobal memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'chat' }, exec)).toBe('Chat memory:\n[#1] likes black tea')
    expect(await recall.execute({ scope: 'global', query: 'STAND' }, exec)).toBe('Global memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'all', query: 'zzz' }, exec)).toBe('Chat memory:\n(none)\n\nGlobal memory:\n(none)')
  })

  it('forgets by scope and id', async () => {
    const d = deps()
    turn = { sender: admin, isGroup: false }
    await createMemorySaveTool(d).execute({ text: 'a' }, exec)
    const forget = createMemoryForgetTool(d)
    expect(forget.name).toBe('memory_forget')
    expect(await forget.execute({ scope: 'chat', id: 1 }, exec)).toBe('Forgot [#1]')
    expect(await d.memory.list({ kind: 'chat', chatId: 5 })).toEqual([])
    await expect(forget.execute({ scope: 'chat', id: 1 }, exec)).rejects.toThrow(/no memory entry #1/)
  })

  it('lets only a super admin in a private chat edit global memory', async () => {
    const d = deps()
    const save = createMemorySaveTool(d)
    const forget = createMemoryForgetTool(d)

    turn = { sender: member, isGroup: false }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/only super admins/)
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow(/only super admins/)
    expect(await save.execute({ text: 'mine' }, exec)).toBe('Saved [#1] mine')

    turn = { sender: admin, isGroup: true }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/private chat/)
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow(/private chat/)

    turn = undefined
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/only super admins/)

    turn = { sender: admin, isGroup: false }
    expect(await save.execute({ text: 'x', scope: 'global' }, exec)).toBe('Saved [#1] x')
    expect(await forget.execute({ scope: 'global', id: 1 }, exec)).toBe('Forgot [#1]')
    expect(await d.memory.list({ kind: 'global' })).toEqual([])
  })
})
