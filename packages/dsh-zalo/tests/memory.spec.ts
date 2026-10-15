import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, renderMemoryBlock } from '../src/memory.ts'
import { pathSafe } from '../src/media.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const limits = { maxEntries: 2, maxGlobalEntries: 2, maxEntryChars: 20 }

describe('MemoryStore', () => {
  it('saves, replaces and forgets chat entries under a safe file name', async () => {
    const store = new MemoryStore(dir, limits)
    const scope = { kind: 'chat', chatId: 'a/b' } as const
    const first = await store.save(scope, 'likes tea')
    await store.save(scope, 'likes coffee', first.id)
    expect((await store.list(scope)).map(e => e.text)).toEqual(['likes coffee'])
    await store.forget(scope, first.id)
    expect(await store.list(scope)).toEqual([])
    expect(await readdir(dir)).toEqual([`${pathSafe('a/b')}.json`])
  })
  it('rejects text over the limit and a full store', async () => {
    const store = new MemoryStore(dir, limits)
    await expect(store.save({ kind: 'global' }, 'x'.repeat(21))).rejects.toThrow(/limit is 20/)
    await store.save({ kind: 'global' }, 'a')
    await store.save({ kind: 'global' }, 'b')
    await expect(store.save({ kind: 'global' }, 'c')).rejects.toThrow(/memory is full/)
  })
  it('renders an empty block as empty text', () => {
    expect(renderMemoryBlock([], [])).toBe('')
    expect(renderMemoryBlock([{ id: 1, text: 'x', ts: '' }], [])).toBe('<memory>\n[Memory of this conversation]\n- [#1] x\n</memory>')
  })
})
