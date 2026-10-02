import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleMessage, type BotDeps } from '../src/bot.ts'
import { ChatLog } from '../src/chatlog.ts'
import { Config } from '../src/config.ts'
import { MemoryStore } from '../src/memory.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

// Driving a real turn to a non-empty reply needs a full session event feed; the reply text is all this test needs.
vi.mock('../src/turn.ts', () => ({
  runTurn: vi.fn(async () => ({ outcome: 'edited', text: 'hi there', sentMessageId: 100, timing: { agentMs: 0, deliverMs: 0 } })),
}))

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bot-log-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('logs the bot reply with reply_to pointing at the handled message', async () => {
  const chatLog = new ChatLog(join(dir, 'log'))
  const agents = {
    resolve: async () => ({ agent: { id: 's1' }, resumed: false }),
    setTurn: () => {}, markTurn: async () => {}, lastTurnMessageId: () => 0,
    workspaceFor: () => join(dir, 'ws', '5'), memoryInjected: () => true, markMemoryInjected: () => {},
  }
  const deps: BotDeps = {
    api: new FakeTelegramApi(),
    config: Config({ botToken: 't', allowFrom: ['ann'], workspaceRoot: join(dir, 'ws'), dataDir: dir, model: 'm' }),
    chatLog,
    memory: new MemoryStore(join(dir, 'memory'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
    agents: agents as never, feed: () => () => {}, attachments: { saveImages: async () => [] },
    botId: 1, botUsername: 'dshbot', log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  await handleMessage({ message_id: 10, date: 1_700_000_000, chat: { id: 5, type: 'private' }, from: { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }, text: 'hello' }, deps)
  expect((await chatLog.readAll(5)).find(e => e.bot === true)).toMatchObject({ text: 'hi there', message_id: 100, reply_to: 10 })
})
