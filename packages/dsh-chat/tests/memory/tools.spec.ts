import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../../src/memory/store.ts'
import { createMemoryTools, registerMemoryTools } from '../../src/memory/tools.ts'
import type { TurnContext } from '../../src/sessions/agents.ts'

let dir: string
let memory: MemoryStore
let turn: TurnContext | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memory-tools-'))
  memory = new MemoryStore(dir, { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  turn = undefined
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

const admin = { id: '7', name: 'Ann', username: 'ann' }
const member = { id: '9', name: 'Bob' }
const K = 'telegram:5'

function tools(key = K) {
  return createMemoryTools({ memory, key, currentTurn: () => turn })
}

describe('memory_save / memory_recall / memory_forget', () => {
  it('saves to the chat scope by default and recalls both scopes with headings', async () => {
    turn = { sender: admin, isGroup: false, isSuperAdmin: true }
    const { save, recall } = tools()
    expect(save.name).toBe('memory_save')
    expect(await save.execute({ text: 'likes tea' }, exec)).toBe('Saved [#1] likes tea')
    expect(await save.execute({ text: 'stand-up 9:00', scope: 'global' }, exec)).toBe('Saved [#1] stand-up 9:00')
    expect(await save.execute({ text: 'likes black tea', replace_id: 1 }, exec)).toBe('Replaced [#1] likes black tea')
    expect((await memory.list({ kind: 'chat', key: K })).map(e => e.text)).toEqual(['likes black tea'])

    expect(recall.name).toBe('memory_recall')
    expect(await recall.execute({}, exec)).toBe('Chat memory:\n[#1] likes black tea\n\nGlobal memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'chat' }, exec)).toBe('Chat memory:\n[#1] likes black tea')
    expect(await recall.execute({ scope: 'global', query: 'STAND' }, exec)).toBe('Global memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'all', query: 'zzz' }, exec)).toBe('Chat memory:\n(none)\n\nGlobal memory:\n(none)')
  })

  it('forgets by scope and id', async () => {
    turn = { sender: admin, isGroup: false, isSuperAdmin: true }
    const { save, forget } = tools()
    await save.execute({ text: 'a' }, exec)
    expect(forget.name).toBe('memory_forget')
    expect(await forget.execute({ scope: 'chat', id: 1 }, exec)).toBe('Forgot [#1]')
    expect(await memory.list({ kind: 'chat', key: K })).toEqual([])
    await expect(forget.execute({ scope: 'chat', id: 1 }, exec)).rejects.toThrow(/no memory entry #1/)
  })

  it('lets only a super admin in a private chat edit global memory', async () => {
    const { save, forget } = tools()

    turn = { sender: member, isGroup: false, isSuperAdmin: false }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow('only super admins can edit global memory')
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow('only super admins can edit global memory')
    expect(await save.execute({ text: 'mine' }, exec)).toBe('Saved [#1] mine')

    turn = { sender: admin, isGroup: true, isSuperAdmin: true }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow('global memory can only be edited from a private chat with the bot')
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow('global memory can only be edited from a private chat with the bot')

    turn = undefined
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow('only super admins can edit global memory')
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow('only super admins can edit global memory')

    turn = { sender: admin, isGroup: false, isSuperAdmin: true }
    expect(await save.execute({ text: 'x', scope: 'global' }, exec)).toBe('Saved [#1] x')
    expect(await forget.execute({ scope: 'global', id: 1 }, exec)).toBe('Forgot [#1]')
  })

  it('keeps chat memory of different channels apart', async () => {
    turn = { sender: admin, isGroup: false, isSuperAdmin: true }
    await tools('zalo:5').save.execute({ text: 'zalo fact' }, exec)
    expect(await tools('telegram:5').recall.execute({ scope: 'chat' }, exec)).toBe('Chat memory:\n(none)')
  })
})

describe('registerMemoryTools', () => {
  it('registers the three tools through ctx.effect', () => {
    const registered: string[] = []
    const ctx = {
      tools: { register: (tool: { name: string }) => { registered.push(tool.name); return () => {} } },
      effect: (fn: () => () => void) => { fn() },
    }
    registerMemoryTools(ctx, { memory, key: K, currentTurn: () => turn })
    expect(registered).toEqual(['memory_save', 'memory_recall', 'memory_forget'])
  })
})
