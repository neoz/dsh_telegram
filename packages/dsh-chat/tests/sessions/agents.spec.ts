import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMap } from '../../src/sessions/session-map.ts'
import { ChatAgents, type AgentRegistryLike } from '../../src/sessions/agents.ts'
import { pathSafe } from '../../src/keys.ts'

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }))

interface FakeAgent { id: string; status: 'idle' | 'running'; cancel: ReturnType<typeof vi.fn>; whenIdle: () => Promise<void>; session: { header: { cwd: string } } }

function fakeRegistry() {
  const live = new Map<string, FakeAgent>()
  const disposed: string[] = []
  const registry = {
    created: [] as unknown[],
    resumed: [] as unknown[],
    failResume: false,
    get: (id: string) => live.get(id),
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown, agent: unknown) => void }) => {
      const agent: FakeAgent = { id: options.sessionId, status: 'idle', cancel: vi.fn(), whenIdle: async () => {}, session: { header: { cwd: options.meta?.cwd ?? '' } } }
      options.setup?.({}, agent)
      live.set(agent.id, agent)
      registry.created.push(options)
      return { agent, dispose: async () => { live.delete(agent.id); disposed.push(agent.id) } }
    }),
    resume: vi.fn(async (options: { resumeSessionId: string; setup?: (ctx: unknown, agent: unknown) => void }) => {
      if (registry.failResume) throw new Error('corrupt log')
      const agent: FakeAgent = { id: options.resumeSessionId, status: 'idle', cancel: vi.fn(), whenIdle: async () => {}, session: { header: { cwd: '/w/1' } } }
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
  it('maps a live agent id back to its chat', async () => {
    const { agents } = await build()
    const { agent } = await agents.resolve('telegram:1')
    expect(agents.chatOf(String(agent.id))).toBe('telegram:1')
    expect(agents.chatOf('telegram-unknown')).toBeUndefined()
    await agents.reset('telegram:1')
    expect(agents.chatOf(String(agent.id))).toBeUndefined()
  })

  it('creates a session and workspace on first contact and stores the map entry', async () => {
    const { agents, registry, map, setup } = await build()
    const { agent, resumed } = await agents.resolve('telegram:1')
    expect(resumed).toBe(false)
    expect(registry.created).toHaveLength(1)
    expect((await stat(join(dir, 'ws', 'telegram', '1'))).isDirectory()).toBe(true)
    expect(map.get('telegram:1')?.sessionId).toBe(agent.id)
    expect(setup).toHaveBeenCalledWith({}, agent, 'telegram:1')
  })

  it('reuses the live agent', async () => {
    const { agents, registry } = await build()
    const first = await agents.resolve('telegram:1')
    const second = await agents.resolve('telegram:1')
    expect(second.agent).toBe(first.agent)
    expect(registry.created).toHaveLength(1)
  })

  it('resumes from the map when the agent is not live', async () => {
    const { agents, registry, map } = await build()
    await map.set('telegram:1', { sessionId: 'old', lastTurnMessageId: '4' })
    const { agent, resumed } = await agents.resolve('telegram:1')
    expect(resumed).toBe(true)
    expect(agent.id).toBe('old')
    expect(registry.resumed[0]).toMatchObject({ resumeSessionId: 'old' })
    expect(agents.lastTurnMessageId('telegram:1')).toBe('4')
  })

  it('falls back to a fresh session when resume fails', async () => {
    const { agents, registry, map } = await build(true)
    await map.set('telegram:1', { sessionId: 'old', lastTurnMessageId: '4' })
    const { agent, resumed, resumeFailed } = await agents.resolve('telegram:1')
    expect(resumed).toBe(false)
    expect(resumeFailed).toContain('corrupt log')
    expect(agent.id).not.toBe('old')
    expect(registry.created).toHaveLength(1)
    expect(map.get('telegram:1')?.sessionId).toBe(agent.id)
  })

  it('reset disposes the live agent and forgets the chat', async () => {
    const { agents, map, disposed } = await build()
    const { agent } = await agents.resolve('telegram:1')
    await agents.reset('telegram:1')
    expect(disposed).toEqual([agent.id])
    expect(map.get('telegram:1')).toBeUndefined()
  })

  it('reset cancels a running agent before disposing it', async () => {
    const { agents, live, disposed } = await build()
    const { agent } = await agents.resolve('telegram:1')
    live.get(agent.id)!.status = 'running'
    await agents.reset('telegram:1')
    expect(live.get(agent.id)).toBeUndefined()
    expect(disposed).toEqual([agent.id])
  })

  it('stop cancels only a running agent', async () => {
    const { agents, live } = await build()
    const { agent } = await agents.resolve('telegram:1')
    expect(agents.stop('telegram:1')).toBe(false)
    live.get(agent.id)!.status = 'running'
    expect(agents.stop('telegram:1')).toBe(true)
    expect(live.get(agent.id)!.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('markTurn persists the anchor and disposeAll tears down every live agent', async () => {
    const { agents, map, disposed } = await build()
    await agents.resolve('telegram:1')
    await agents.resolve('telegram:2')
    await agents.markTurn('telegram:1', '55')
    expect(map.get('telegram:1')?.lastTurnMessageId).toBe('55')
    await agents.disposeAll()
    expect(disposed).toHaveLength(2)
  })

  it('records the running turn per chat', async () => {
    const { agents } = await build()
    const ann = { id: '7', name: 'Ann', username: 'ann' }
    expect(agents.turnOf('telegram:1')).toBeUndefined()
    agents.setTurn('telegram:1', { sender: ann, isGroup: false, isSuperAdmin: false })
    agents.setTurn('telegram:2', { sender: ann, isGroup: true, isSuperAdmin: false })
    expect(agents.turnOf('telegram:1')).toEqual({ sender: ann, isGroup: false, isSuperAdmin: false })
    expect(agents.turnOf('telegram:2')).toEqual({ sender: ann, isGroup: true, isSuperAdmin: false })
  })

  it('tracks memory injection per chat and session', async () => {
    const { agents } = await build()
    const id = String((await agents.resolve('telegram:1')).agent.id)
    await agents.resolve('telegram:2')
    expect(agents.memoryInjected('telegram:1', id)).toBe(false)
    await agents.markMemoryInjected('telegram:1', id)
    expect(agents.memoryInjected('telegram:1', id)).toBe(true)
    expect(agents.memoryInjected('telegram:1', 'other')).toBe(false)
    expect(agents.memoryInjected('telegram:2', id)).toBe(false)
  })

  it('remembers memory injection across a restart', async () => {
    const first = await build()
    const id = String((await first.agents.resolve('telegram:1')).agent.id)
    await first.agents.markMemoryInjected('telegram:1', id)
    const second = await build()
    expect(second.agents.memoryInjected('telegram:1', id)).toBe(true)
  })

  it('reset forgets the turn and injection records', async () => {
    const { agents } = await build()
    const id = String((await agents.resolve('telegram:1')).agent.id)
    agents.setTurn('telegram:1', { sender: { id: '7', name: 'Ann' }, isGroup: false, isSuperAdmin: false })
    await agents.markMemoryInjected('telegram:1', id)
    await agents.reset('telegram:1')
    expect(agents.turnOf('telegram:1')).toBeUndefined()
    expect(agents.memoryInjected('telegram:1', id)).toBe(false)
  })
})

describe('ChatAgents across channels', () => {
  it('names zalo sessions and workspaces with the path-safe id', async () => {
    const { agents, registry } = await build()
    expect(agents.workspaceFor('zalo:a/b')).toBe(join(dir, 'ws', 'zalo', pathSafe('a/b')))
    await agents.resolve('zalo:a/b')
    expect((registry.created[0] as { sessionId: string }).sessionId).toMatch(new RegExp(`^zalo-${pathSafe('a/b')}-`))
  })

  it('returns the chat key of a live agent', async () => {
    const { agents, registry } = await build()
    const { agent } = await agents.resolve('telegram:-5')
    expect((registry.created[0] as { sessionId: string }).sessionId).toMatch(/^telegram--5-/)
    expect(agents.chatOf(String(agent.id))).toBe('telegram:-5')
  })

  it('exposes the model route', async () => {
    const { agents } = await build()
    expect(agents.selection).toEqual({ provider: 'deepseek-official', model: 'm' })
  })
})

describe('ChatAgents shutdown', () => {
  it('lets a running turn wind down before disposing its agent', async () => {
    const { agents, live, disposed } = await build()
    const { agent } = await agents.resolve('telegram:1')
    const fake = live.get(String(agent.id))!
    fake.status = 'running'
    let finish!: () => void
    fake.whenIdle = () => new Promise<void>((resolve) => { finish = resolve })
    const done = agents.disposeAll()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(disposed).toEqual([])
    finish()
    await done
    expect(disposed).toEqual([fake.id])
  })
})
