import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as logPlugin from '../../src/log/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-log-plugin-'))
  root = new Context()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/log', () => {
  it('waits for chatData, then provides chatLog and emits chat/message', async () => {
    root.plugin(logPlugin, logPlugin.Config({}))
    expect(root.get('chatLog')).toBeUndefined()
    root.provide('chatData', { dataDir: dir, workspaceRoot: join(dir, 'ws') })
    await vi.waitFor(() => expect(root.get('chatLog')).toBeDefined())
    const heard: string[] = []
    root.on('chat/message', (key) => { heard.push(key) })
    await root.get('chatLog')!.append('zalo:1', { ts: 't', message_id: '1', user_id: 'u', name: 'n', text: 'x' })
    expect(heard).toEqual(['zalo:1'])
  })

  it('only warns when a chat/message listener throws', async () => {
    root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
    root.plugin(logPlugin, logPlugin.Config({}))
    await vi.waitFor(() => expect(root.get('chatLog')).toBeDefined())
    root.on('chat/message', () => { throw new Error('boom') })
    await expect(root.get('chatLog')!.append('zalo:1', { ts: 't', message_id: '1', user_id: 'u', name: 'n', text: 'x' })).resolves.toBeUndefined()
  })

  it('defaults maxEntries to 15000', () => {
    expect(logPlugin.Config({})).toEqual({ maxEntries: 15_000 })
  })
})
