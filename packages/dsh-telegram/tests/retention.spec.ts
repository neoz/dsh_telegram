import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepOldFiles } from '../src/retention.ts'

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
    await file('5/inbox/uold/old.pdf', 40)
    await file('5/inbox/unew/new.pdf', 1)
    await file('5/inbox/legacy.txt', 40)
    await file('5/outbox/response-1.md', 40)
    await file('5/outbox/response-2.md', 1)
    await file('5/notes.txt', 40)
    await file('-7/inbox/uold/voice.ogg', 40)

    await sweepOldFiles(root, 30 * DAY, now)

    expect(await readdir(join(root, '5', 'inbox'))).toEqual(['unew'])
    expect(await readdir(join(root, '5', 'outbox'))).toEqual(['response-2.md'])
    expect(await readdir(join(root, '5'))).toContain('notes.txt')
    expect(await readdir(join(root, '-7', 'inbox'))).toEqual([])
  })

  it('tolerates a missing workspace root and chats without inbox or outbox', async () => {
    await mkdir(join(root, '5'))
    await sweepOldFiles(join(root, 'missing'), DAY, now)
    await sweepOldFiles(root, DAY, now)
  })
})
