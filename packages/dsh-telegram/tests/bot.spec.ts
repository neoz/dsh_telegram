import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandOf, createDispatcher, gate, handleMessage, isAllowed, type BotDeps } from '../src/bot.ts'
import { ChatLog } from '../src/chatlog.ts'
import { Config } from '../src/config.ts'
import type { TelegramMessage } from '../src/inbound.ts'
import { THINKING_TEXT } from '../src/render.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const bob = { id: 9, is_bot: false, first_name: 'Bob' }
const mention = [{ type: 'mention', offset: 0, length: 7 }]
function msg(extra: Partial<TelegramMessage>, type: TelegramMessage['chat']['type'] = 'private', id = 10): TelegramMessage {
  return { message_id: id, date: 1_700_000_000, chat: { id: 5, type }, from: ann, ...extra }
}

describe('isAllowed / gate / commandOf', () => {
  it('matches ids and usernames case-insensitively', () => {
    expect(isAllowed(ann, ['7'])).toBe(true)
    expect(isAllowed(ann, ['ANN'])).toBe(true)
    expect(isAllowed(ann, ['@ann'])).toBe(true)
    expect(isAllowed(bob, ['ann'])).toBe(false)
  })
  const g = { allowFrom: ['ann'], botId: 1, botUsername: 'dshbot' }
  it('DM: allowed handles, others ignore', () => {
    expect(gate(msg({ text: 'x' }), g)).toBe('handle')
    expect(gate(msg({ text: 'x', from: bob }), g)).toBe('ignore')
  })
  it('group: requires allowlist and mention or reply-to-bot; otherwise log-only', () => {
    expect(gate(msg({ text: 'hello' }, 'supergroup'), g)).toBe('log-only')
    expect(gate(msg({ text: '@dshbot hi', entities: mention }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ caption: '@dshbot hi', caption_entities: mention }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ text: 'yes', reply_to_message: { ...msg({ text: 'q' }), from: { id: 1, is_bot: true, first_name: 'dsh' } } }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ text: '@dshbot hi', entities: mention, from: bob }, 'supergroup'), g)).toBe('log-only')
    expect(gate({ ...msg({ text: 'x' }), from: undefined }, g)).toBe('ignore')
  })
  it('recognises commands with and without the bot suffix', () => {
    expect(commandOf('/reset', 'dshbot')).toBe('reset')
    expect(commandOf('/stop@dshbot', 'dshbot')).toBe('stop')
    expect(commandOf('/stop@other', 'dshbot')).toBeUndefined()
    expect(commandOf('reset please', 'dshbot')).toBeUndefined()
  })
})

describe('handleMessage', () => {
  let dir: string
  let api: FakeTelegramApi
  let deps: BotDeps
  let agents: {
    resolve: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>
    markTurn: ReturnType<typeof vi.fn>; lastTurnMessageId: ReturnType<typeof vi.fn>; workspaceFor: ReturnType<typeof vi.fn>
  }
  let followups: unknown[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bot-'))
    api = new FakeTelegramApi()
    followups = []
    const agent = {
      id: 's1', status: 'idle',
      session: { seq: 0, eventAt: () => undefined, header: { cwd: join(dir, 'ws', '5') } },
      followup: (m: unknown) => { followups.push(m) }, whenIdle: async () => {}, cancel: () => {},
    }
    agents = {
      resolve: vi.fn(async () => ({ agent, resumed: false })),
      reset: vi.fn(async () => {}), stop: vi.fn(() => true), markTurn: vi.fn(async () => {}),
      lastTurnMessageId: vi.fn(() => 0), workspaceFor: vi.fn(() => join(dir, 'ws', '5')),
    }
    deps = {
      api, config: Config({ botToken: 't', allowFrom: ['ann'], workspaceRoot: join(dir, 'ws'), dataDir: dir, model: 'm' }),
      chatLog: new ChatLog(join(dir, 'log')), agents: agents as never, feed: () => () => {},
      attachments: { saveImages: vi.fn(async (images: unknown[]) => images.map((_, i) => ({ attachmentId: `att${i}` }))) },
      botId: 1, botUsername: 'dshbot', log: { info: () => {}, warn: () => {}, error: () => {} },
    }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('ignores strangers in DMs without logging', async () => {
    await handleMessage(msg({ text: 'hi', from: bob }), deps)
    expect(api.calls).toHaveLength(0)
    expect(await deps.chatLog.readAll(5)).toEqual([])
  })

  it('logs untargeted group messages without running a turn', async () => {
    await handleMessage(msg({ text: 'chatter', from: bob }, 'supergroup'), deps)
    expect(api.calls).toHaveLength(0)
    expect((await deps.chatLog.readAll(5))[0]).toMatchObject({ user_id: 9, text: 'chatter' })
    expect(agents.resolve).not.toHaveBeenCalled()
  })

  it('handles /reset and /stop without touching the agent turn', async () => {
    await handleMessage(msg({ text: '/reset' }), deps)
    expect(agents.reset).toHaveBeenCalledWith(5)
    expect(api.callsTo('sendMessage')[0]!.args[1]).toBe('Started a new conversation.')
    await handleMessage(msg({ text: '/stop@dshbot' }), deps)
    expect(agents.stop).toHaveBeenCalledWith(5)
    expect(api.callsTo('sendMessage')).toHaveLength(1)
    agents.stop.mockReturnValueOnce(false)
    await handleMessage(msg({ text: '/stop' }), deps)
    expect(api.callsTo('sendMessage')[1]!.args[1]).toBe('Nothing is running.')
  })

  it('runs a turn: reacts, marks the turn, submits text, logs the reply', async () => {
    await handleMessage(msg({ text: 'hello' }), deps)
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, expect.any(String)])
    expect(agents.markTurn).toHaveBeenCalledWith(5, 10)
    expect(followups).toHaveLength(1)
    expect((followups[0] as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'hello' }])
    expect(api.callsTo('sendMessage')[0]!.args[1]).toBe(THINKING_TEXT)
    const log = await deps.chatLog.readAll(5)
    expect(log[0]).toMatchObject({ user_id: 7, text: 'hello' })
  })

  it('injects recent group messages and image blocks', async () => {
    await deps.chatLog.append(5, { ts: 't', message_id: 8, user_id: 9, name: 'Bob', text: 'earlier note' })
    api.files.set('big', { data: Buffer.from('jpg'), filePath: 'p.jpg' })
    await handleMessage(msg({ caption: '@dshbot see', caption_entities: mention, photo: [{ file_id: 'big', width: 2, height: 2 }] }, 'supergroup'), deps)
    const content = (followups[0] as { content: Array<{ type: string; text?: string }> }).content
    expect(content[0]!.text).toBe('Recent group messages:\n- id:9 (Bob): earlier note\n\n@ann (Ann): see')
    expect(content[1]).toEqual({ type: 'image', attachment: { attachmentId: 'att0' } })
  })

  it('tells the chat when a resume failed', async () => {
    const { agent } = await agents.resolve()
    agents.resolve.mockResolvedValueOnce({ agent, resumed: false, resumeFailed: 'corrupt' })
    await handleMessage(msg({ text: 'hi' }), deps)
    expect(api.callsTo('sendMessage')[0]!.args[1]).toMatch(/could not be restored/)
  })

  it('dispatcher serialises turns per chat and survives handler errors', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    agents.resolve
      .mockImplementationOnce(async () => {
        order.push('a-start')
        await new Promise<void>((r) => { releaseFirst = r })
        order.push('a-end')
        throw new Error('boom')
      })
      .mockImplementationOnce(async () => { order.push('b-start'); throw new Error('boom') })
    const dispatch = createDispatcher(deps)
    dispatch(msg({ text: 'one' }, 'private', 11))
    dispatch(msg({ text: 'two' }, 'private', 12))
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual(['a-start'])
    releaseFirst()
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })

  it('dispatcher runs /stop immediately while a turn is queued', async () => {
    let releaseFirst!: () => void
    agents.resolve.mockImplementationOnce(async () => { await new Promise<void>((r) => { releaseFirst = r }); throw new Error('boom') })
    const dispatch = createDispatcher(deps)
    dispatch(msg({ text: 'long task' }, 'private', 11))
    dispatch(msg({ text: '/stop' }, 'private', 12))
    await new Promise(r => setTimeout(r, 5))
    expect(agents.stop).toHaveBeenCalledWith(5)
    releaseFirst()
  })
})
