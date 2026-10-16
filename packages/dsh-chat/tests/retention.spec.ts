import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepOldFiles } from '../src/retention/sweep.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'retention-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const DAY = 86_400_000
const now = Date.UTC(2026, 8, 24)

async function file(path: string, ageDays: number): Promise<void> {
  const full = join(root, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, 'x')
  const time = new Date(now - ageDays * DAY)
  await utimes(full, time, time)
}

describe('sweepOldFiles', () => {
  it('deletes old inbox and outbox files, drops emptied folders, and leaves everything else', async () => {
    await file('telegram/5/inbox/uold/old.pdf', 40)
    await file('telegram/5/inbox/unew/new.pdf', 1)
    await file('telegram/5/inbox/legacy.txt', 40)
    await file('telegram/5/outbox/response-1.md', 40)
    await file('telegram/5/outbox/response-2.md', 1)
    await file('telegram/5/notes.txt', 40)
    await file('telegram/-7/inbox/uold/voice.ogg', 40)

    await sweepOldFiles(root, 30 * DAY, now)

    expect(await readdir(join(root, 'telegram', '5', 'inbox'))).toEqual(['unew'])
    expect(await readdir(join(root, 'telegram', '5', 'outbox'))).toEqual(['response-2.md'])
    expect(await readdir(join(root, 'telegram', '5'))).toContain('notes.txt')
    expect(await readdir(join(root, 'telegram', '-7', 'inbox'))).toEqual([])
  })

  it('tolerates a missing workspace root and chats without inbox or outbox', async () => {
    await mkdir(join(root, 'telegram', '5'), { recursive: true })
    await sweepOldFiles(join(root, 'missing'), DAY, now)
    await sweepOldFiles(root, DAY, now)
  })
})

describe('sweepOldFiles across channels', () => {
  it('sweeps every channel and leaves files outside inbox and outbox alone', async () => {
    await file('telegram/1/inbox/a.jpg', 10)
    await file('zalo/x/outbox/b.txt', 10)
    await file('zalo/x/notes.md', 10)
    await file('stray.txt', 10)
    await sweepOldFiles(root, 5 * DAY, now)
    expect(await readdir(join(root, 'telegram', '1', 'inbox'))).toEqual([])
    expect(await readdir(join(root, 'zalo', 'x', 'outbox'))).toEqual([])
    expect(await readdir(join(root, 'zalo', 'x'))).toContain('notes.md')
    expect(await readdir(root)).toContain('stray.txt')
  })
})

describe('dsh-chat/retention', () => {
  it('defaults to 90 days and sweeps once chatData is provided', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { vi } = await import('vitest')
    const plugin = await import('../src/retention/index.ts')
    expect(plugin.Config({})).toEqual({ fileRetentionDays: 90 })
    await file('telegram/1/inbox/old.jpg', 400)
    const ctx = new Context()
    ctx.plugin(plugin, plugin.Config({}))
    ctx.provide('chatData', { dataDir: root, workspaceRoot: root })
    await vi.waitFor(async () => expect(await readdir(join(root, 'telegram', '1', 'inbox'))).toEqual([]))
  })
})
