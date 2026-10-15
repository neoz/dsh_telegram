import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { MemoryStore } from '../src/memory.ts'
import type { TurnContext } from '../src/sessions.ts'
import { createChatHistoryTool, createMemorySaveTool, type ToolDeps } from '../src/tools.ts'

let dir: string
let deps: ToolDeps
let turn: TurnContext
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tools-'))
  turn = { sender: { id: 'admin' }, isGroup: false }
  deps = {
    chatLog: new ChatLog(join(dir, 'log')), chatId: 'c1',
    memory: new MemoryStore(join(dir, 'mem'), { maxEntries: 5, maxGlobalEntries: 5, maxEntryChars: 100 }),
    superAdmins: ['admin'], currentTurn: () => turn,
  }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const run = (tool: { execute: (args: never, ctx: never) => unknown }, args: object) => tool.execute(args as never, {} as never)

describe('tools', () => {
  it('zalo_chat_history returns logged messages before a timestamp', async () => {
    await deps.chatLog.append('c1', { ts: '2026-10-15T05:00:00.000Z', message_id: 'a', user_id: 'u', name: 'Ann', text: 'hello' })
    await deps.chatLog.append('c1', { ts: '2026-10-15T06:00:00.000Z', message_id: 'b', user_id: 'u', name: 'Ann', text: 'later' })
    const tool = createChatHistoryTool(deps)
    expect(tool.name).toBe('zalo_chat_history')
    const out = await run(tool as never, { before: '2026-10-15T05:30:00.000Z' })
    expect(out).toBe('<chat_history>\n[2026-10-15T05:00:00.000Z] id:u (Ann): hello\n</chat_history>')
  })

  it('global memory needs a super admin in a private chat', async () => {
    const tool = createMemorySaveTool(deps)
    await expect(run(tool as never, { text: 'x', scope: 'global' })).resolves.toMatch(/^Saved/)
    turn = { sender: { id: 'other' }, isGroup: false }
    await expect(run(tool as never, { text: 'y', scope: 'global' })).rejects.toThrow(/super admins/)
    turn = { sender: { id: 'admin' }, isGroup: true }
    await expect(run(tool as never, { text: 'z', scope: 'global' })).rejects.toThrow(/private chat/)
  })
})
