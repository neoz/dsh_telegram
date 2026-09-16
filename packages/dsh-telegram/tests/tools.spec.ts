import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { createChatHistoryTool, createSendFileTool, registerChatTools } from '../src/tools.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'tools-'))); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

function deps() {
  return { api, chatLog: new ChatLog(join(dir, 'log')), chatId: 5, workspaceDir: dir, maxUploadBytes: 100 }
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
    expect(registered).toEqual(['telegram_send_file', 'telegram_chat_history'])
  })
})
