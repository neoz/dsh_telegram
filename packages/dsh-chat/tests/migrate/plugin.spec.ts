import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as migratePlugin from '../../src/migrate/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-migrate-plugin-'))
  root = new Context()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/migrate', () => {
  it('provides chatData after migrating', async () => {
    root.plugin(migratePlugin, migratePlugin.Config({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w'), legacyChannel: 'zalo' }))
    await vi.waitFor(() => expect(root.get('chatData')).toEqual({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w') }))
  })

  it('withholds chatData when the migration fails', async () => {
    await writeFile(join(dir, 'd'), 'a file where the data dir should be')
    root.plugin(migratePlugin, migratePlugin.Config({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w') }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(root.get('chatData')).toBeUndefined()
  })

  it('rejects relative paths and odd channel names', () => {
    expect(() => migratePlugin.assertConfig(migratePlugin.Config({ dataDir: 'data', workspaceRoot: '/w' }))).toThrow('dsh-chat: dataDir must be an absolute path')
    expect(() => migratePlugin.assertConfig(migratePlugin.Config({ dataDir: '/d', workspaceRoot: '/w', legacyChannel: '../x' }))).toThrow('dsh-chat: legacyChannel must be lowercase letters')
    expect(() => migratePlugin.assertConfig(migratePlugin.Config({ dataDir: 'C:\\d', workspaceRoot: '/w', legacyChannel: 'telegram' }))).not.toThrow()
  })
})
