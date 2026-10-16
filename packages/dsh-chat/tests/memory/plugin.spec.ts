import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as memoryPlugin from '../../src/memory/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-memory-plugin-'))
  root = new Context()
  root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
  root.provide('chatAgents', { turnOf: () => undefined } as never)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/memory', () => {
  it('provides chatMemory and registers the memory tools on every chat agent', async () => {
    root.plugin(memoryPlugin, memoryPlugin.Config({}))
    await vi.waitFor(() => expect(root.get('chatMemory')).toBeDefined())
    const registered: string[] = []
    const agentCtx = { tools: { register: (t: { name: string }) => { registered.push(t.name); return () => {} } }, effect: (fn: () => () => void) => { fn() } }
    root.emit('chat/agent', agentCtx as never, 'zalo:a')
    expect(registered).toEqual(['memory_save', 'memory_recall', 'memory_forget'])
  })

  it('fills the limits defaults', () => {
    expect(memoryPlugin.Config({})).toEqual({ maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  })
})
