import { describe, expect, it } from 'vitest'
import { extensionFor, pathSafe, sniffImageType } from '../src/media.ts'

describe('pathSafe', () => {
  it('keeps plain Zalo ids', () => {
    expect(pathSafe('6ede9afa66b88fe6d6a9')).toBe('6ede9afa66b88fe6d6a9')
  })
  it('replaces separators and dots so an id never leaves its directory', () => {
    expect(pathSafe('../x')).toBe('___x')
    expect(pathSafe('a/b\\c')).toBe('a_b_c')
    expect(pathSafe('')).toBe('_')
  })
})

describe('sniffImageType', () => {
  it('recognises png, jpeg, webp and gif signatures', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png')
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp')
    expect(sniffImageType(Buffer.from('GIF89a', 'latin1'))).toBe('image/gif')
  })
  it('returns undefined for anything else', () => {
    expect(sniffImageType(Buffer.from('<html>'))).toBeUndefined()
  })
  it('maps types to file extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('image/png')).toBe('.png')
  })
})
