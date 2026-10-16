import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sessionsPlugin from '../../src/sessions/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-sessions-plugin-'))
  root = new Context()
  root.provide('chatData', { dataDir: dir, workspaceRoot: join(dir, 'ws') })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/sessions', () => {
  it('waits for agents, loads sessions.json, then provides chatAgents with the model route', async () => {
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({ 'zalo:a': { sessionId: 's1', lastTurnMessageId: 'm9' } }))
    root.plugin(sessionsPlugin, sessionsPlugin.Config({ model: 'deepseek-flash' }))
    expect(root.get('chatAgents')).toBeUndefined()
    root.provide('agents', { get: () => undefined, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } } as never)
    await vi.waitFor(() => expect(root.get('chatAgents')).toBeDefined())
    expect(root.get('chatAgents')!.lastTurnMessageId('zalo:a')).toBe('m9')
    expect(root.get('chatAgents')!.selection).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('requires a model', () => {
    expect(() => sessionsPlugin.Config({})).toThrow()
  })
})
