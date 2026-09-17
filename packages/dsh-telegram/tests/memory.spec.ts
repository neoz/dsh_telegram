import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, formatMemoryEntry, renderMemoryBlock } from '../src/memory.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const limits = { maxEntries: 3, maxGlobalEntries: 2, maxEntryChars: 20 }
const chat = { kind: 'chat', chatId: 5 } as const
const global = { kind: 'global' } as const

describe('MemoryStore', () => {
  it('lists an empty scope when no file exists', async () => {
    const store = new MemoryStore(join(dir, 'missing'), limits)
    expect(await store.list(chat)).toEqual([])
    expect(await store.list(global)).toEqual([])
  })

  it('saves, replaces and forgets entries; ids never repeat', async () => {
    const store = new MemoryStore(dir, limits)
    const a = await store.save(chat, ' coffee ')
    const b = await store.save(chat, 'tea')
    expect([a.id, b.id]).toEqual([1, 2])
    expect(a.text).toBe('coffee')
    const replaced = await store.save(chat, 'black coffee', 1)
    expect(replaced).toMatchObject({ id: 1, text: 'black coffee' })
    await store.forget(chat, 2)
    const c = await store.save(chat, 'milk')
    expect(c.id).toBe(3)
    expect((await store.list(chat)).map(e => e.text)).toEqual(['black coffee', 'milk'])
  })

  it('rejects empty and over-long text', async () => {
    const store = new MemoryStore(dir, limits)
    await expect(store.save(chat, '   ')).rejects.toThrow(/empty/)
    await expect(store.save(chat, 'x'.repeat(21))).rejects.toThrow(/21 characters, the limit is 20/)
    expect(await store.list(chat)).toEqual([])
  })

  it('rejects unknown ids for replace and forget', async () => {
    const store = new MemoryStore(dir, limits)
    await expect(store.save(chat, 'x', 9)).rejects.toThrow(/no memory entry #9/)
    await expect(store.forget(chat, 9)).rejects.toThrow(/no memory entry #9/)
  })

  it('enforces the chat cap and the global cap, listing existing entries; replace still works when full', async () => {
    const store = new MemoryStore(dir, limits)
    for (const text of ['a', 'b', 'c']) await store.save(chat, text)
    await expect(store.save(chat, 'd')).rejects.toThrow(/full \(3\/3\)[\s\S]*\[#1\] a\n\[#2\] b\n\[#3\] c/)
    await expect(store.save(chat, 'd', 2)).resolves.toMatchObject({ id: 2, text: 'd' })
    await store.save(global, 'g1')
    await store.save(global, 'g2')
    await expect(store.save(global, 'g3')).rejects.toThrow(/full \(2\/2\)/)
  })

  it('keeps chat scopes independent of each other and of global', async () => {
    const store = new MemoryStore(dir, limits)
    await store.save(chat, 'five')
    await store.save({ kind: 'chat', chatId: 6 }, 'six')
    await store.save(global, 'everyone')
    expect((await store.list(chat)).map(e => e.text)).toEqual(['five'])
    expect((await store.list({ kind: 'chat', chatId: 6 })).map(e => e.text)).toEqual(['six'])
    expect((await store.list(global)).map(e => e.text)).toEqual(['everyone'])
  })

  it('writes one JSON file per scope atomically, leaving no temp file', async () => {
    const store = new MemoryStore(dir, limits)
    await store.save(chat, 'x')
    await store.save(global, 'y')
    expect((await readdir(dir)).sort()).toEqual(['5.json', 'global.json'])
    expect(JSON.parse(await readFile(join(dir, '5.json'), 'utf8'))).toEqual({
      nextId: 2,
      entries: [{ id: 1, text: 'x', ts: expect.any(String) }],
    })
  })
})

describe('formatMemoryEntry / renderMemoryBlock', () => {
  const e = (id: number, text: string) => ({ id, text, ts: 't' })

  it('formats one entry as [#id] text', () => {
    expect(formatMemoryEntry(e(4, 'likes tea'))).toBe('[#4] likes tea')
  })

  it('renders only the non-empty scopes and nothing when both are empty', () => {
    expect(renderMemoryBlock([], [])).toBe('')
    expect(renderMemoryBlock([e(1, 'a')], [])).toBe('<memory>\n[Memory of this conversation]\n- [#1] a\n</memory>')
    expect(renderMemoryBlock([], [e(2, 'b')])).toBe('<memory>\n[Global memory]\n- [#2] b\n</memory>')
    expect(renderMemoryBlock([e(1, 'a'), e(3, 'c')], [e(2, 'b')]))
      .toBe('<memory>\n[Memory of this conversation]\n- [#1] a\n- [#3] c\n\n[Global memory]\n- [#2] b\n</memory>')
  })

  it('folds line breaks inside an entry', () => {
    expect(formatMemoryEntry(e(4, 'a\nb'))).toBe('[#4] a b')
  })
})
