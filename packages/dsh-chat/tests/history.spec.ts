import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as historyPlugin from '../src/history/index.ts'
import { createChatHistoryTool } from '../src/history/index.ts'
import { ChatLog } from '../src/log/chatlog.ts'

let dir: string
let chatLog: ChatLog
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-history-'))
  chatLog = new ChatLog(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never
const K = 'telegram:5'

describe('chat_history', () => {
  it('returns formatted lines oldest first, honouring limit, before and query', async () => {
    for (let i = 1; i <= 5; i++) {
      await chatLog.append(K, { ts: `t${i}`, message_id: String(i), user_id: '1', username: 'u', name: 'U', text: i % 2 ? `odd${i}` : `even${i}` })
    }
    const tool = createChatHistoryTool({ chatLog, key: K })
    expect(tool.name).toBe('chat_history')
    expect(await tool.execute({ limit: 2 }, exec)).toBe('<chat_history>\n[t4] @u (U): even4\n[t5] @u (U): odd5\n</chat_history>')
    expect(await tool.execute({ limit: 10, before_message_id: '3', query: 'odd' }, exec)).toBe('<chat_history>\n[t1] @u (U): odd1\n</chat_history>')
    expect(await tool.execute({ limit: 10, query: 'zzz' }, exec)).toBe('(no messages)')
  })

  it('returns the newest entries when before_message_id is unknown', async () => {
    for (const id of ['1', '2', '3']) await chatLog.append(K, { ts: `t${id}`, message_id: id, user_id: 'u', name: 'n', text: id })
    const out = await createChatHistoryTool({ chatLog, key: K }).execute({ limit: 2, before_message_id: 'missing' }, exec)
    expect(out).toBe('<chat_history>\n[t2] id:u (n): 2\n[t3] id:u (n): 3\n</chat_history>')
  })

  it('reads only the calling chat', async () => {
    await chatLog.append('zalo:5', { ts: 't', message_id: '1', user_id: 'u', name: 'n', text: 'zalo' })
    expect(await createChatHistoryTool({ chatLog, key: K }).execute({}, exec)).toBe('(no messages)')
  })
})

describe('dsh-chat/history', () => {
  it('waits for chatAgents too, so its listener exists before the first chat agent', async () => {
    const root = new Context()
    root.provide('chatLog', chatLog)
    const fiber = root.plugin(historyPlugin)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fiber.state).not.toBe(2)
    root.provide('chatAgents', {} as never)
    await vi.waitFor(() => expect(fiber.state).toBe(2))
  })

  it('registers chat_history on every chat agent once chatLog is up', async () => {
    const root = new Context()
    root.provide('chatLog', chatLog)
    root.provide('chatAgents', {} as never)
    root.plugin(historyPlugin)
    const registered: string[] = []
    const agentCtx = { tools: { register: (t: { name: string }) => { registered.push(t.name); return () => {} } }, effect: (fn: () => () => void) => { fn() } }
    await vi.waitFor(() => {
      registered.length = 0
      root.emit('chat/agent', agentCtx as never, 'zalo:a')
      expect(registered).toEqual(['chat_history'])
    })
  })
})
