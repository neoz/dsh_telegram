import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MARKER, migrate } from '../../src/migrate/migrate.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, rename: vi.fn(real.rename) }
})

let data: string
let ws: string
beforeEach(async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'chat-migrate-'))
  data = join(base, 'data')
  ws = join(base, 'workspace')
})
afterEach(async () => { await fs.rm(dirname(data), { recursive: true, force: true }) })

async function put(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, text)
}

async function legacyTelegram(): Promise<void> {
  await put(join(data, 'chatlog', '-100.jsonl'), `${JSON.stringify({ ts: 't', message_id: 5, user_id: 7, name: 'n', text: 'x', reply_to: 4 })}\n`)
  await put(join(data, 'memory', '-100.json'), '{"nextId":2,"entries":[{"id":1,"text":"a","ts":"t"}]}')
  await put(join(data, 'memory', 'global.json'), '{"nextId":1,"entries":[]}')
  await put(join(data, 'telegram-sessions.json'), '{"-100":{"sessionId":"s","lastTurnMessageId":5}}')
  await put(join(data, 'idle-decisions.jsonl'), '{}\n')
  await put(join(data, 'schedule.json'), '[]')
  await put(join(ws, '-100', 'inbox', 'a.jpg'), 'img')
}

describe('migrate', () => {
  it('moves a Telegram volume to the per-channel layout and stringifies log ids', async () => {
    await legacyTelegram()
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('migrated')
    const line = JSON.parse((await fs.readFile(join(data, 'telegram', 'chatlog', '-100.jsonl'), 'utf8')).trim())
    expect(line).toEqual({ ts: 't', message_id: '5', user_id: '7', name: 'n', text: 'x', reply_to: '4' })
    expect(existsSync(join(data, 'telegram', 'memory', '-100.json'))).toBe(true)
    expect(existsSync(join(data, 'memory', 'global.json'))).toBe(true)
    expect(existsSync(join(data, 'memory', '-100.json'))).toBe(false)
    expect(existsSync(join(data, 'telegram', 'idle-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(data, 'telegram', 'schedule.json'))).toBe(true)
    expect(existsSync(join(data, 'telegram-sessions.json'))).toBe(false)
    expect(existsSync(join(ws, 'telegram', '-100', 'inbox', 'a.jpg'))).toBe(true)
    expect(existsSync(join(ws, '-100'))).toBe(false)
    expect(existsSync(join(data, MARKER))).toBe(true)
  })

  it('moves a Zalo volume without touching its string ids', async () => {
    const line = `${JSON.stringify({ ts: 't', message_id: 'm1', user_id: 'u1', name: 'n', text: 'x' })}\n`
    await put(join(data, 'chatlog', 'abc.jsonl'), line)
    await put(join(data, 'zalo-sessions.json'), '{}')
    await put(join(ws, 'abc', 'inbox', 'p.png'), 'img')
    await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'zalo' })
    expect(await fs.readFile(join(data, 'zalo', 'chatlog', 'abc.jsonl'), 'utf8')).toBe(line)
    expect(existsSync(join(ws, 'zalo', 'abc', 'inbox', 'p.png'))).toBe(true)
    expect(existsSync(join(data, 'zalo-sessions.json'))).toBe(false)
  })

  it('does nothing once the marker exists', async () => {
    await legacyTelegram()
    await put(join(data, MARKER), 'done')
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('current')
    expect(existsSync(join(data, 'chatlog', '-100.jsonl'))).toBe(true)
  })

  it('only writes the marker when there is no legacy channel', async () => {
    expect(await migrate({ dataDir: data, workspaceRoot: ws })).toBe('migrated')
    expect(existsSync(join(data, MARKER))).toBe(true)
  })

  it('moves only chat folders out of the workspace root', async () => {
    await legacyTelegram()
    await put(join(ws, 'repo', '.git', 'HEAD'), 'ref')
    await put(join(ws, '42', 'notes.md'), 'no chat log for this one')
    await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })
    expect(existsSync(join(ws, 'telegram', '-100', 'inbox', 'a.jpg'))).toBe(true)
    expect(existsSync(join(ws, 'repo', '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(ws, '42', 'notes.md'))).toBe(true)
  })

  it('keeps an unparsable chat-log line instead of failing the whole migration', async () => {
    await legacyTelegram()
    await fs.appendFile(join(data, 'chatlog', '-100.jsonl'), '{"ts":"t","message_id":6,"tru')
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('migrated')
    const lines = (await fs.readFile(join(data, 'telegram', 'chatlog', '-100.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0]!).message_id).toBe('5')
    expect(lines[1]).toBe('{"ts":"t","message_id":6,"tru')
  })

  it('never deletes a source whose target already exists', async () => {
    await legacyTelegram()
    await put(join(data, 'telegram', 'memory', '-100.json'), 'newer')
    await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })
    expect(await fs.readFile(join(data, 'telegram', 'memory', '-100.json'), 'utf8')).toBe('newer')
    expect(existsSync(join(data, 'memory', '-100.json'))).toBe(true)
  })

  it('completes on a rerun after failing half-way, without a marker in between', async () => {
    await legacyTelegram()
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await fs.copyFile(from, to)
      throw new Error('disk gone')
    })
    await expect(migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).rejects.toThrow('disk gone')
    expect(existsSync(join(data, MARKER))).toBe(false)
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('migrated')
    expect((await fs.readFile(join(data, 'telegram', 'chatlog', '-100.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    // The copy left behind by the failed rename stays: the migration never deletes data.
    expect(existsSync(join(data, 'chatlog', '-100.jsonl'))).toBe(true)
    expect(existsSync(join(ws, 'telegram', '-100', 'inbox', 'a.jpg'))).toBe(true)
  })
})
