import { describe, expect, it } from 'vitest'
import { splitMessage } from '../src/render.ts'

describe('splitMessage', () => {
  it('keeps a short message whole, trimmed', () => {
    expect(splitMessage('  hi  ', 2000)).toEqual(['hi'])
    expect(splitMessage('   ', 2000)).toEqual([])
  })
  it('cuts at a paragraph break first', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(30)}\n${'c'.repeat(30)}`
    expect(splitMessage(text, 100)).toEqual(['a'.repeat(60), `${'b'.repeat(30)}\n${'c'.repeat(30)}`])
  })
  it('falls back to a line break, then a space', () => {
    expect(splitMessage(`${'a'.repeat(70)}\n${'b'.repeat(70)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(70)])
    expect(splitMessage(`${'a'.repeat(70)} ${'b'.repeat(70)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(70)])
  })
  it('hard-cuts text without whitespace and never exceeds the limit', () => {
    const parts = splitMessage('x'.repeat(4500), 2000)
    expect(parts.map(p => p.length)).toEqual([2000, 2000, 500])
  })
  it('never splits a surrogate pair at a hard cut', () => {
    const text = `${'x'.repeat(99)}\u{1F600}${'y'.repeat(10)}`
    const parts = splitMessage(text, 100)
    expect(parts.every(p => p.length <= 100)).toBe(true)
    expect(parts.join('')).toBe(text)
    expect(parts[1]!.startsWith('\u{1F600}')).toBe(true)
  })
})
