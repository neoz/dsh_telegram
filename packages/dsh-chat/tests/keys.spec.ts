import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatKey, idIn, keyPath, pathSafe, splitKey } from '../src/keys.ts'

/** The Zalo implementation before the move; files written by it must keep their names. */
function legacyZaloPathSafe(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

describe('chat keys', () => {
  it('joins channel and id, numbers included', () => {
    expect(chatKey('telegram', -1001234)).toBe('telegram:-1001234')
    expect(chatKey('zalo', 'abc')).toBe('zalo:abc')
  })

  it('splits at the first colon only', () => {
    expect(splitKey('zalo:a:b')).toEqual({ channel: 'zalo', id: 'a:b' })
  })

  it('rejects a key without channel or id', () => {
    expect(() => splitKey('telegram')).toThrow('invalid chat key "telegram"')
    expect(() => splitKey(':1')).toThrow()
    expect(() => splitKey('telegram:')).toThrow()
  })

  it('returns the id only for the matching channel', () => {
    expect(idIn('telegram', 'telegram:42')).toBe('42')
    expect(idIn('telegram', 'zalo:42')).toBeUndefined()
  })

  it('keeps safe ids and matches the legacy Zalo names for unsafe ones', () => {
    for (const id of ['-1001234', 'abc_DEF-9', 'a/b', '../x', 'a b']) expect(pathSafe(id)).toBe(legacyZaloPathSafe(id))
  })

  it('builds per-channel paths', () => {
    expect(keyPath('/data', 'telegram:-5', 'chatlog', '.jsonl')).toBe(join('/data', 'telegram', 'chatlog', '-5.jsonl'))
    expect(keyPath('/ws', 'zalo:a/b', '')).toBe(join('/ws', 'zalo', legacyZaloPathSafe('a/b')))
  })
})
