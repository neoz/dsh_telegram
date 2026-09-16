import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMap } from '../src/session-map.ts'
import { ChatAgents, type AgentRegistryLike } from '../src/sessions.ts'

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }))

interface FakeAgent { id: string; status: 'idle' | 'running'; cancel: ReturnType<typeof vi.fn>; session: { header: { cwd: string } } }

function fakeRegistry() {
  const live = new Map<string, FakeAgent>()
  const disposed: string[] = []
  const registry = {
    created: [] as unknown[],
    resumed: [] as unknown[],
    failResume: false,
    get: (id: string) => live.get(id),
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown, agent: unknown) => void }) => {
      const agent: FakeAgent = { id: options.sessionId, status: 'idle', cancel: vi.fn(), session: { header: { cwd: options.meta?.cwd ?? '' } } }
      options.setup?.({}, agent)
      live.set(agent.id, agent)
      registry.created.push(options)
      return { agent, dispose: async () => { live.delete(agent.id); disposed.push(agent.id) } }
    }),
    resume: vi.fn(async (options: { resumeSessionId: string; setup?: (ctx: unknown, agent: unknown) => void }) => {
      if (registry.failResume) throw new Error('corrupt log')
      const agent: FakeAgent = { id: options.resumeSessionId, status: 'idle', cancel: vi.fn(), session: { header: { cwd: '/w/1' } } }
      options.setup?.({}, agent)
      live.set(agent.id, agent)
      registry.resumed.push(options)
      return { agent, dispose: async () => { live.delete(agent.id); disposed.push(agent.id) } }
    }),
  }
  return { registry: registry as unknown as AgentRegistryLike & typeof registry, live, disposed }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agents-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function build(failResume = false) {
  const { registry, live, disposed } = fakeRegistry()
  registry.failResume = failResume
  const map = new SessionMap(join(dir, 'map.json'))
  await map.load()
  const setup = vi.fn()
  const agents = new ChatAgents({
    agents: registry, map, workspaceRoot: join(dir, 'ws'),
    selection: { provider: 'deepseek-official', model: 'm' }, setup,
    log: { info: () => {}, warn: () => {} },
  })
  return { agents, registry, live, disposed, map, setup }
}

describe('ChatAgents', () => {
  it('creates a session and workspace on first contact and stores the map entry', async () => {
    const { agents, registry, map, setup } = await build()
    const { agent, resumed } = await agents.resolve(1)
    expect(resumed).toBe(false)
    expect(registry.created).toHaveLength(1)
    expect((await stat(join(dir, 'ws', '1'))).isDirectory()).toBe(true)
    expect(map.get(1)?.sessionId).toBe(agent.id)
    expect(setup).toHaveBeenCalledWith({}, agent, 1)
  })

  it('reuses the live agent', async () => {
    const { agents, registry } = await build()
    const first = await agents.resolve(1)
    const second = await agents.resolve(1)
    expect(second.agent).toBe(first.agent)
    expect(registry.created).toHaveLength(1)
  })

  it('resumes from the map when the agent is not live', async () => {
    const { agents, registry, map } = await build()
    await map.set(1, { sessionId: 'old', lastTurnMessageId: 4 })
    const { agent, resumed } = await agents.resolve(1)
    expect(resumed).toBe(true)
    expect(agent.id).toBe('old')
    expect(registry.resumed[0]).toMatchObject({ resumeSessionId: 'old' })
    expect(agents.lastTurnMessageId(1)).toBe(4)
  })

  it('falls back to a fresh session when resume fails', async () => {
    const { agents, registry, map } = await build(true)
    await map.set(1, { sessionId: 'old', lastTurnMessageId: 4 })
    const { agent, resumed, resumeFailed } = await agents.resolve(1)
    expect(resumed).toBe(false)
    expect(resumeFailed).toContain('corrupt log')
    expect(agent.id).not.toBe('old')
    expect(registry.created).toHaveLength(1)
    expect(map.get(1)?.sessionId).toBe(agent.id)
  })

  it('reset disposes the live agent and forgets the chat', async () => {
    const { agents, map, disposed } = await build()
    const { agent } = await agents.resolve(1)
    await agents.reset(1)
    expect(disposed).toEqual([agent.id])
    expect(map.get(1)).toBeUndefined()
  })

  it('stop cancels only a running agent', async () => {
    const { agents, live } = await build()
    const { agent } = await agents.resolve(1)
    expect(agents.stop(1)).toBe(false)
    live.get(agent.id)!.status = 'running'
    expect(agents.stop(1)).toBe(true)
    expect(live.get(agent.id)!.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('markTurn persists the anchor and disposeAll tears down every live agent', async () => {
    const { agents, map, disposed } = await build()
    await agents.resolve(1)
    await agents.resolve(2)
    await agents.markTurn(1, 55)
    expect(map.get(1)?.lastTurnMessageId).toBe(55)
    await agents.disposeAll()
    expect(disposed).toHaveLength(2)
  })
})
