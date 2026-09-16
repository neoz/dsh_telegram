import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { outboundKind, resolveInsideWorkspace, sanitizeFilename, uniquePath } from '../src/media.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'media-'))) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('FakeTelegramApi', () => {
  it('records calls, mints ids and replays queued failures', async () => {
    const api = new FakeTelegramApi()
    expect((await api.sendMessage(1, 'a')).messageId).toBe(100)
    expect((await api.sendMessage(1, 'b')).messageId).toBe(101)
    api.failNext('editMessageText', new Error('boom'))
    await expect(api.editMessageText(1, 100, 'x')).rejects.toThrow('boom')
    await api.editMessageText(1, 100, 'y')
    expect(api.callsTo('editMessageText')).toHaveLength(2)
  })
})

describe('sanitizeFilename', () => {
  it('keeps a plain name', () => expect(sanitizeFilename('report.pdf', '.bin')).toBe('report.pdf'))
  it('strips directories and odd characters', () => {
    expect(sanitizeFilename('../../etc/passwd', '.bin')).toBe('passwd')
    expect(sanitizeFilename('a b:c*d?.txt', '.bin')).toBe('a_b_c_d_.txt')
  })
  it('generates a name with the fallback extension', () => {
    expect(sanitizeFilename(undefined, '.ogg')).toMatch(/^file-\d+\.ogg$/)
    expect(sanitizeFilename('', '.ogg')).toMatch(/^file-\d+\.ogg$/)
  })
})

describe('resolveInsideWorkspace', () => {
  it('resolves a relative path inside the workspace', async () => {
    await writeFile(join(dir, 'out.txt'), 'x')
    expect(await resolveInsideWorkspace(dir, 'out.txt')).toBe(join(dir, 'out.txt'))
  })
  it('rejects escapes and missing files', async () => {
    await writeFile(join(tmpdir(), 'dsh-telegram-outside.txt'), 'x')
    await expect(resolveInsideWorkspace(dir, '../dsh-telegram-outside.txt')).rejects.toThrow(/outside/)
    await expect(resolveInsideWorkspace(dir, 'missing.txt')).rejects.toThrow()
    await rm(join(tmpdir(), 'dsh-telegram-outside.txt'), { force: true })
  })
})

describe('outboundKind', () => {
  it.each([['a.png', 'photo'], ['b.JPG', 'photo'], ['c.webp', 'photo'], ['d.pdf', 'document'], ['e', 'document']])(
    '%s -> %s', (path, kind) => expect(outboundKind(path)).toBe(kind))
})

describe('uniquePath', () => {
  it('adds a numeric suffix on collision', async () => {
    await mkdir(join(dir, 'inbox'))
    await writeFile(join(dir, 'inbox', 'a.txt'), '')
    await writeFile(join(dir, 'inbox', 'a-1.txt'), '')
    expect(await uniquePath(join(dir, 'inbox'), 'a.txt')).toBe(join(dir, 'inbox', 'a-2.txt'))
    expect(await uniquePath(join(dir, 'inbox'), 'b.txt')).toBe(join(dir, 'inbox', 'b.txt'))
  })
})
