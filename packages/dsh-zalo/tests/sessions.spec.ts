import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMap } from '../src/session-map.ts'
import { ChatAgents } from '../src/sessions.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sessions-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function setup() {
  const live = new Map<string, unknown>()
  const handle = (id: string) => {
    const agent = { id, status: 'idle', cancel: vi.fn(), whenIdle: async () => {} }
    live.set(id, agent)
    return { agent, dispose: vi.fn(async () => { live.delete(id) }) }
  }
  const registry = {
    get: (id: string) => live.get(id),
    create: vi.fn(async (o: { sessionId: string }) => handle(o.sessionId)),
    resume: vi.fn(async (o: { resumeSessionId: string }) => handle(o.resumeSessionId)),
  }
  const map = new SessionMap(join(dir, 'map.json'))
  const agents = new ChatAgents({
    agents: registry as never, map, workspaceRoot: join(dir, 'ws'),
    selection: { provider: 'p', model: 'm' }, setup: () => {}, log: { info: () => {}, warn: () => {} },
  })
  return { agents, map, registry }
}

describe('ChatAgents', () => {
  it('creates one zalo session per chat in a safe workspace and reuses it', async () => {
    const { agents, map, registry } = setup()
    const first = await agents.resolve('a/b')
    expect(String(first.agent.id)).toMatch(/^zalo-a_b-/)
    expect(agents.workspaceFor('a/b')).toBe(join(dir, 'ws', 'a_b'))
    expect(map.get('a/b')).toMatchObject({ lastTurnAt: '' })
    await agents.resolve('a/b')
    expect(registry.create).toHaveBeenCalledTimes(1)
    expect(agents.chatOf(String(first.agent.id))).toBe('a/b')
  })

  it('records the last turn time and the memory flag per session', async () => {
    const { agents } = setup()
    const { agent } = await agents.resolve('c1')
    await agents.markTurn('c1', '2026-10-15T05:00:00.000Z')
    expect(agents.lastTurnAt('c1')).toBe('2026-10-15T05:00:00.000Z')
    expect(agents.memoryInjected('c1', String(agent.id))).toBe(false)
    await agents.markMemoryInjected('c1', String(agent.id))
    expect(agents.memoryInjected('c1', String(agent.id))).toBe(true)
  })

  it('reset forgets the chat', async () => {
    const { agents, map } = setup()
    await agents.resolve('c1')
    await agents.reset('c1')
    expect(map.get('c1')).toBeUndefined()
  })
})
