import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRecord, type Reminder } from '../../src/schedule/domain.ts'
import { ReminderStore } from '../../src/schedule/store.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
const one = (id: string): Reminder => ({
  chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record: buildRecord(id, 'T', 'p', { after_seconds: 60 }, NOW, 'UTC'),
})

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'schedule-store-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('ReminderStore', () => {
  it('starts empty without a file and round-trips through it', async () => {
    const file = join(dir, 'schedule.json')
    const store = new ReminderStore(file)
    store.load()
    expect(store.all()).toEqual([])
    expect(await store.update((list) => { list.push(one('a')); return list.length })).toBe(1)
    const reloaded = new ReminderStore(file)
    reloaded.load()
    expect(reloaded.all()).toEqual([one('a')])
  })

  it('runs updates in order', async () => {
    const store = new ReminderStore(join(dir, 'schedule.json'))
    store.load()
    await Promise.all([store.update(list => list.push(one('a'))), store.update(list => list.push(one('b')))])
    expect(store.all().map(r => r.record.id)).toEqual(['a', 'b'])
  })

  it('keeps the previous state when a change throws or the write fails', async () => {
    const store = new ReminderStore(join(dir, 'schedule.json'))
    store.load()
    await store.update(list => list.push(one('a')))
    await expect(store.update(() => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(store.all()).toHaveLength(1)
    await writeFile(join(dir, 'blocker'), 'x')
    // No load(): reading a path under a file fails with ENOTDIR; an unloaded store starts empty.
    const broken = new ReminderStore(join(dir, 'blocker', 'schedule.json'))
    await expect(broken.update(list => list.push(one('b')))).rejects.toThrow()
    expect(broken.all()).toEqual([])
    await store.update(list => list.push(one('c')))
    expect(store.all()).toHaveLength(2)
  })

  it('rejects an invalid file without touching it', async () => {
    const file = join(dir, 'schedule.json')
    for (const text of ['{not json', '{"version":2,"reminders":[]}', '{"version":1,"reminders":[{"chatId":"x"}]}']) {
      await writeFile(file, text)
      expect(() => new ReminderStore(file).load()).toThrow(/schedule\.json/)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })

  it('refuses to write once closed, so a replaced store cannot overwrite the file', async () => {
    const file = join(dir, 'schedule.json')
    const old = new ReminderStore(file)
    old.load()
    await old.update(list => list.push(one('a')))
    old.close()
    await expect(old.update(list => list.push(one('b')))).rejects.toThrow(/closed/)
    const reloaded = new ReminderStore(file)
    reloaded.load()
    expect(reloaded.all().map(r => r.record.id)).toEqual(['a'])
  })

  it('rejects a record whose rule dsh-schedule cannot decode', async () => {
    const file = join(dir, 'schedule.json')
    const bad = { ...one('a'), record: { ...buildRecord('a', 'T', 'p', { every_seconds: 300 }, NOW, 'UTC'), everySeconds: '60' } }
    await writeFile(file, JSON.stringify({ version: 1, reminders: [bad] }))
    expect(() => new ReminderStore(file).load()).toThrow(/schedule\.json/)
  })
})
