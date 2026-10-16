# dsh-chat Plan A: chat router and channel adapters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the gate, commands, per-chat queue and turn orchestration that `dsh-telegram` and `dsh-zalo` each duplicate into one `dsh-chat` router plugin that provides `chat`, and reduce both adapters to a `ChatChannel` (transport, rendering, `send`/`react` intents) plus inbound normalization.

**Architecture:** `dsh-chat` (the package root) becomes a Cordis plugin that injects `chatLog`, `chatMemory`, `chatAgents`, `attachments` and provides `chat: ChatRouter`. Adapters inject `chat`, register a `ChatChannel` before polling starts, and hand each update to `chat.inbound(message)`; the router decides log-only / command / turn, runs the agent turn through the channel's `TurnSink`, and logs the reply. `dsh-telegram/idle` and `dsh-telegram/schedule` keep running unchanged on a thin `TelegramService` built on `chat` until Plan B moves them.

**Tech Stack:** TypeScript 6 (nodenext, `.ts` imports), Cordis 4, Schemastery, Vitest 4, pnpm 10 workspace, Node >= 22.19.

**Spec:** `docs/superpowers/specs/2026-10-16-dsh-chat-plugin-core-design.md` (rollout step 3, with Amendment 1).

## Global Constraints

- `chatKey = "<channel>:<id>"` and `userKey = "<channel>:<id>"`, both strings; channels are `telegram` and `zalo`.
- Router config `allowFrom` and `superAdmins` hold userKeys. A Telegram username entry is `telegram:@<lowercase username>`.
- Super admins are always allowed (today's Zalo rule, now for both channels).
- Prompt cache: the `<memory>` block, the `<group_messages>` block, the order "memory, then group block, then text" and the turn text built by each adapter's `parseInbound` stay byte-identical to today's output.
- Router notices keep today's wording: `Started a new conversation.`, `Nothing is running.`, `The previous conversation could not be restored; starting a new one.`, and the help text `/reset - start a new conversation\n/stop - cancel the running reply\n/help - show this list`.
- Every repository text is English; no emoji literals in code (use `\u{...}` escapes as today); no new `.md` files beyond this plan.
- Every plugin follows the existing pattern: `export const name`, `export const inject`, `export const Config` (Schemastery), `export function apply(ctx, config)`, services provided with `ctx.effect(() => ctx.provide(...), label)`.
- Run commands from the repo root `D:\working\nodejs\dsh` unless a step says otherwise. Package tests: `pnpm --filter <pkg> exec vitest run <path>`. Adapters import `dsh-chat` from its build output, so after changing `dsh-chat` run `pnpm --filter dsh-chat run build` before adapter tests.

## Clarifications (decided while planning)

- `ChatChannel.agentTools` and `ChatChannel.stop` from the spec are not added: adapters already register per-chat tools on `chat/agent` and own their own lifecycle; nothing in the core would call either.
- The "log what was posted" rule of Amendment 1 applies to idle and schedule (Plan B). Router notices (commands, resume failure) stay out of the chat log, as today.
- Zalo `react` sends the emoji as text in this plan (`fallback`); stickers arrive in Plan B. Nothing calls `react` on Zalo before Plan B.
- `/reset` follows today's Zalo rule for both channels: it stops the running turn at once and disposes the agent only after queued work, so no queued turn runs on a disposed agent. `/stop` and `/help` bypass the queue.
- Telegram keeps its gate rule: in a group, a message is addressed only by an `@mention` or a reply to the bot. `/cmd@thisbot` is normalized to `/cmd` so the core command parser sees it; `/cmd@otherbot` stays unparsed and becomes an ordinary message.
- A DM from a stranger is logged once per userKey (today's Zalo behavior), now for Telegram too.
- `chat/turn(key)` is emitted when an addressed message arrives, again when its turn starts, and when a prompt starts (today's Telegram points). `dsh-telegram` re-emits it as `telegram/turn(Number(id))` for idle until Plan B.

## Review Focus

1. A message arrives between the bot connecting and the channel registering: it must not be dropped as "channel offline" (the adapter registers before polling starts; test in Task 5).
2. An adapter is disposed while turns are queued: queued work for that channel is skipped, not run on a stopped bot (test in Task 3).
3. Telegram and Zalo in one process with the same numeric-looking chat id `5`: queues, turn contexts and logs never mix (test in Task 3).
4. `TELEGRAM_ALLOW_FROM` containing `@Ann` and `123`: the router allows `ann` by username case-insensitively and `123` by id (test in Task 7).
5. A `TurnSink.deliver` that throws: the sink is still closed (Telegram placeholder timers cleared, Zalo typing stopped) and the next queued turn runs (tests in Task 2 and Task 3).

---

## File Structure

`packages/dsh-chat`
- Create `src/router/channel.ts`: the channel contract types (`ChatChannel`, `TurnSink`, `TurnReport`, `Delivered`, `InboundMessage`, `LoadedMessage`, `InboundImage`, `ImageMediaType`, `PromptInput`).
- Create `src/router/queue.ts`: `ChatQueue`, per-chatKey serial queue.
- Create `src/router/turn.ts`: `TurnAgent`, `SessionEventFeed`, `summarizeTurn`, `runAgentTurn` (timeout, cancel, tool status, deliver, close).
- Create `src/router/router.ts`: `ChatRouter` (registry, gate, commands, turn assembly, prompt), `commandOf`, `HELP_TEXT`, `RouterConfig`, `ImageStore`.
- Create `src/router/plugin.ts`: Cordis plugin `dsh-chat` (`Config`, `assertRouterConfig`, `apply`, `chat` service and `chat/turn` event typings).
- Modify `src/index.ts`: export the router and plugin.
- Modify `package.json`: peer and dev dependency `@deepseek-ai/dsh-attachment`.
- Tests: `tests/router/fake-channel.ts`, `tests/router/queue.spec.ts`, `tests/router/turn.spec.ts`, `tests/router/router.spec.ts`, `tests/router/plugin.spec.ts`.

`packages/dsh-telegram`
- Create `src/channel.ts`: `createTelegramChannel` (placeholder sink, document fallback, `send`, `react`, ack reaction).
- Modify `src/inbound.ts`: add `toInbound`.
- Modify `src/index.ts`, `src/service.ts`, `src/config.ts`, `src/idle/scheduler.ts`, `cordis.patch.yml`.
- Delete `src/bot.ts`, `src/turn.ts`.
- Tests: create `tests/channel.spec.ts`; extend `tests/inbound.spec.ts`; update `tests/config.spec.ts`, `tests/profile.spec.ts`, `tests/idle/scheduler.spec.ts`; delete `tests/bot.spec.ts`, `tests/bot-reply-log.spec.ts`, `tests/turn.spec.ts`.

`packages/dsh-zalo`
- Create `src/channel.ts`: `createZaloChannel` (typing sink, chunked delivery, `send`, `react`).
- Modify `src/inbound.ts`: add `toInbound`.
- Modify `src/index.ts`, `src/config.ts`, `cordis.patch.yml`.
- Delete `src/bot.ts`, `src/turn.ts`, `src/service.ts`.
- Tests: create `tests/channel.spec.ts`; extend `tests/inbound.spec.ts`; update `tests/config.spec.ts`, `tests/profile.spec.ts`; delete `tests/bot.spec.ts`, `tests/turn.spec.ts`.

`profile/telegram/cordis.patch.yml`, `profile/zalo/cordis.patch.yml`: drop `allowFrom` and `superAdmins` from the restated adapter rows.

---

### Task 1: Channel contract and per-chat queue

**Files:**
- Create: `packages/dsh-chat/src/router/channel.ts`
- Create: `packages/dsh-chat/src/router/queue.ts`
- Test: `packages/dsh-chat/tests/router/queue.spec.ts`

**Interfaces:**
- Consumes: `ChatKey` (`src/keys.ts`), `ChatLogEntry` (`src/log/chatlog.ts`), `ChatSender` (`src/sessions/agents.ts`).
- Produces: the types below, exactly; `class ChatQueue { constructor(onError: (key: ChatKey, error: unknown) => void); enqueue(key: ChatKey, task: () => Promise<void>): void; isBusy(key: ChatKey): boolean }`.

- [ ] **Step 1: Write the channel contract**

`packages/dsh-chat/src/router/channel.ts`:

```ts
import type { ChatKey } from '../keys.ts'
import type { ChatLogEntry } from '../log/chatlog.ts'
import type { ChatSender } from '../sessions/agents.ts'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface InboundImage { data: Uint8Array; mediaType: ImageMediaType }

/** What reached the chat. `messageId` and `text` are set when a new message was posted. */
export interface Delivered {
  as: 'native' | 'fallback'
  messageId?: string
  text?: string
}

/** How a turn ended, for the channel to render; `text` is empty for `empty`. */
export interface TurnReport {
  kind: 'reply' | 'timeout' | 'error' | 'stopped' | 'empty'
  text: string
  error?: string
  timeoutMs: number
}

/** One turn's view of the chat, opened right before the agent runs. */
export interface TurnSink {
  /** The agent called this tool; Telegram edits its placeholder, Zalo ignores it. */
  status(tool: string): void
  /** Renders the end of the turn; `outcome` is the channel's own word for what it did, for the log line. */
  deliver(report: TurnReport): Promise<{ outcome: string; messageId?: string }>
  /** Always called once, after `deliver` or after a failure. */
  close(): void
}

/** A chat transport; the core states intents and the channel decides how its platform carries them. */
export interface ChatChannel {
  readonly id: string
  /** `name` is written as the chat-log name of the bot's own lines. */
  readonly bot: { id: string; name: string }
  openTurn(chatId: string, origin: { replyTo?: string }): Promise<TurnSink>
  /** Sends a message outside any turn (commands, idle, schedule). */
  send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<Delivered>
  /** Reacts to one message the way this platform can. */
  react(chatId: string, messageId: string, emoji: string): Promise<Delivered>
}

/** What `InboundMessage.load` returns; `text` and `images` are empty in `log` mode. */
export interface LoadedMessage { logEntry: ChatLogEntry; text: string; images: InboundImage[] }

/** One incoming message, normalized by its adapter. Bots and the bot itself never reach the core. */
export interface InboundMessage {
  chatKey: ChatKey
  messageId: string
  sender: ChatSender
  isGroup: boolean
  /** The adapter decides whether the bot was mentioned, replied to or triggered. */
  addressed: boolean
  /** Text with the mention or trigger stripped; commands are read from it. */
  text: string
  /** When the sender sent it, in epoch ms. */
  at: number
  /** Runs inside the chat's queue: downloads media and builds the log line and, in `turn` mode, the agent text. */
  load(mode: 'log' | 'turn'): Promise<LoadedMessage>
}

/** A turn nobody typed (a scheduled reminder): nothing to quote, react to or mark. */
export interface PromptInput { text: string; sender: ChatSender; isGroup: boolean }
```

- [ ] **Step 2: Write the failing queue test**

`packages/dsh-chat/tests/router/queue.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ChatQueue } from '../../src/router/queue.ts'

describe('ChatQueue', () => {
  it('runs tasks of one key in order and tasks of other keys alongside', async () => {
    const queue = new ChatQueue(() => {})
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    queue.enqueue('telegram:5', async () => { await held; order.push('a1') })
    queue.enqueue('telegram:5', async () => { order.push('a2') })
    queue.enqueue('zalo:5', async () => { order.push('b1') })
    await vi.waitFor(() => expect(order).toEqual(['b1']))
    expect(queue.isBusy('telegram:5')).toBe(true)
    release()
    await vi.waitFor(() => expect(order).toEqual(['b1', 'a1', 'a2']))
    await vi.waitFor(() => expect(queue.isBusy('telegram:5')).toBe(false))
  })

  it('reports a failing task and still runs the next one', async () => {
    const errors: string[] = []
    const queue = new ChatQueue((key, error) => errors.push(`${key} ${(error as Error).message}`))
    const ran: string[] = []
    queue.enqueue('zalo:1', async () => { throw new Error('boom') })
    queue.enqueue('zalo:1', async () => { ran.push('next') })
    await vi.waitFor(() => expect(ran).toEqual(['next']))
    expect(errors).toEqual(['zalo:1 boom'])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/queue.spec.ts`
Expected: FAIL, cannot resolve `../../src/router/queue.ts`.

- [ ] **Step 4: Implement the queue**

`packages/dsh-chat/src/router/queue.ts`:

```ts
import type { ChatKey } from '../keys.ts'

/** Serialises tasks per chat key; a failing task is reported and never blocks the next one. */
export class ChatQueue {
  private readonly chains = new Map<ChatKey, Promise<void>>()

  constructor(private readonly onError: (key: ChatKey, error: unknown) => void) {}

  enqueue(key: ChatKey, task: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch((error: unknown) => this.onError(key, error))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key)
      })
    this.chains.set(key, next)
  }

  /** Whether the chat has a running or waiting task. */
  isBusy(key: ChatKey): boolean {
    return this.chains.has(key)
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/queue.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-chat/src/router/channel.ts packages/dsh-chat/src/router/queue.ts packages/dsh-chat/tests/router/queue.spec.ts
git commit -m "feat(chat): add the channel contract and the per-chat queue"
```

---

### Task 2: Agent turn runner

**Files:**
- Create: `packages/dsh-chat/src/router/turn.ts`
- Test: `packages/dsh-chat/tests/router/turn.spec.ts`

**Interfaces:**
- Consumes: `TurnSink`, `TurnReport` (Task 1).
- Produces:
  - `interface TurnAgent { readonly id: string; readonly session: { readonly seq: number; eventAt(seq: SessionSeq): SessionEvent | undefined }; followup(message: UserMessage): void; whenIdle(): Promise<void>; cancel(cause: { kind: 'user' }): void }`
  - `type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void`
  - `function summarizeTurn(session: TurnAgent['session'], firstSeq: number): { text: string; error?: string; aborted: boolean }`
  - `function runAgentTurn(options: { agent: TurnAgent; feed: SessionEventFeed; content: ContentBlock[]; sink: TurnSink; turnTimeoutMs: number; now?: () => number }): Promise<AgentTurnResult>`
  - `interface AgentTurnResult { outcome: string; text: string; messageId?: string; timing: { agentMs: number; deliverMs: number } }`

- [ ] **Step 1: Write the failing tests**

`packages/dsh-chat/tests/router/turn.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TurnReport, TurnSink } from '../../src/router/channel.ts'
import { runAgentTurn, summarizeTurn, type SessionEventFeed, type TurnAgent } from '../../src/router/turn.ts'

type AnyEvent = { type: string; data: unknown }

/** Fake agent: `script` runs when followup is called and may emit events. */
export function fakeAgent(script: (emit: (event: AnyEvent) => void) => Promise<void> | void) {
  const events: AnyEvent[] = []
  const listeners = new Set<(sessionId: string, event: AnyEvent) => void>()
  let running: Promise<void> = Promise.resolve()
  const emit = (event: AnyEvent) => {
    events.push(event)
    for (const l of listeners) l('s1', event)
  }
  const agent: TurnAgent = {
    id: 's1',
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never },
    followup: () => { running = Promise.resolve().then(() => script(emit)) },
    whenIdle: () => running,
    cancel: () => { emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }) },
  }
  const feed: SessionEventFeed = (listener) => {
    listeners.add(listener as never)
    return () => listeners.delete(listener as never)
  }
  return { agent, feed, events }
}

const reply = (text: string): AnyEvent => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const toolCall = (name: string): AnyEvent => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name, arguments: '{}' } })
const turnStart: AnyEvent = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = (reason: object): AnyEvent => ({ type: 'turn/end', data: { turn: 1, reason } })

function recordingSink(deliverImpl?: (report: TurnReport) => Promise<{ outcome: string; messageId?: string }>) {
  const calls: { status: string[]; reports: TurnReport[]; closed: number } = { status: [], reports: [], closed: 0 }
  const sink: TurnSink = {
    status: tool => { calls.status.push(tool) },
    deliver: async (report) => {
      calls.reports.push(report)
      return deliverImpl === undefined ? { outcome: 'sent', messageId: 'm1' } : deliverImpl(report)
    },
    close: () => { calls.closed++ },
  }
  return { sink, calls }
}

const content = [{ type: 'text' as const, text: 'hi' }]

describe('summarizeTurn', () => {
  it('keeps the last assistant text, the error and the abort flag after turn/start', () => {
    const { agent } = fakeAgent(() => {})
    const events = [reply('before'), turnStart, reply('one'), reply('two'), turnEnd({ kind: 'error', error: { code: 'X', message: 'bad' } })]
    const session = { seq: events.length, eventAt: (seq: number) => events[seq] as never }
    expect(summarizeTurn(session, 0)).toEqual({ text: 'two', aborted: false, error: 'X: bad' })
    expect(agent.id).toBe('s1')
  })
})

describe('runAgentTurn', () => {
  it('delivers a reply, forwards tool names to the sink and closes it', async () => {
    const a = fakeAgent((emit) => { emit(turnStart); emit(toolCall('bash')); emit(reply('done')); emit(turnEnd({ kind: 'completed' })) })
    const { sink, calls } = recordingSink()
    const result = await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })
    expect(calls.status).toEqual(['bash'])
    expect(calls.reports).toEqual([{ kind: 'reply', text: 'done', timeoutMs: 10_000 }])
    expect(calls.closed).toBe(1)
    expect(result).toMatchObject({ outcome: 'sent', text: 'done', messageId: 'm1' })
  })

  it('cancels and reports a timeout', async () => {
    let release!: () => void
    const a = fakeAgent((emit) => { emit(turnStart); return new Promise<void>((resolve) => { release = resolve }) })
    const { sink, calls } = recordingSink()
    await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 20 })
    release()
    expect(calls.reports[0]!.kind).toBe('timeout')
  })

  it('maps error, aborted and empty turns', async () => {
    for (const [events, kind] of [
      [[turnStart, turnEnd({ kind: 'error', error: { code: 'LLM_AUTH', message: 'no key' } })], 'error'],
      [[turnStart, turnEnd({ kind: 'aborted', reason: { kind: 'user' } })], 'stopped'],
      [[turnStart, reply('   '), turnEnd({ kind: 'completed' })], 'empty'],
    ] as const) {
      const a = fakeAgent((emit) => { for (const e of events) emit(e) })
      const { sink, calls } = recordingSink()
      const result = await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })
      expect(calls.reports[0]!.kind).toBe(kind)
      if (kind === 'empty') expect(result.text).toBe('')
      if (kind === 'error') expect(calls.reports[0]!.error).toBe('LLM_AUTH: no key')
    }
  })

  it('closes the sink when delivery throws', async () => {
    const a = fakeAgent((emit) => { emit(turnStart); emit(reply('x')); emit(turnEnd({ kind: 'completed' })) })
    const { sink, calls } = recordingSink(async () => { throw new Error('send failed') })
    await expect(runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })).rejects.toThrow('send failed')
    expect(calls.closed).toBe(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/turn.spec.ts`
Expected: FAIL, cannot resolve `../../src/router/turn.ts`.

- [ ] **Step 3: Implement the runner**

`packages/dsh-chat/src/router/turn.ts` (`summarizeTurn` is today's function from `dsh-telegram/src/turn.ts`, moved unchanged):

```ts
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnReport, TurnSink } from './channel.ts'

/** Structural slice of dsh's Agent used by the runner (the real Agent satisfies it). */
export interface TurnAgent {
  readonly id: string
  readonly session: {
    readonly seq: number
    eventAt(seq: SessionSeq): SessionEvent | undefined
  }
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'user' }): void
}

/** Session event feed abstraction over `ctx.on('session/event')`. */
export type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void

export interface TurnSummary { text: string; error?: string; aborted: boolean }

/** Last assistant text, any error reason, and whether the turn was cancelled, since `firstSeq`. */
export function summarizeTurn(session: TurnAgent['session'], firstSeq: number): TurnSummary {
  let started = false
  let text = ''
  let error: string | undefined
  let aborted = false
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq as SessionSeq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind: string; error?: { code: string; message: string } }
      if (reason.kind === 'error' && reason.error !== undefined) error = `${reason.error.code}: ${reason.error.message}`
      if (reason.kind === 'aborted') aborted = true
    }
  }
  return { text, aborted, ...(error === undefined ? {} : { error }) }
}

export interface AgentTurnOptions {
  agent: TurnAgent
  feed: SessionEventFeed
  content: ContentBlock[]
  sink: TurnSink
  turnTimeoutMs: number
  now?: () => number
}

export interface AgentTurnResult {
  /** The channel's word for what it delivered. */
  outcome: string
  /** The agent's final text; empty when the turn produced none. */
  text: string
  messageId?: string
  /** Wall-clock breakdown: agent work versus delivery. */
  timing: { agentMs: number; deliverMs: number }
}

function reportOf(summary: TurnSummary, timedOut: boolean, timeoutMs: number): TurnReport {
  if (timedOut) return { kind: 'timeout', text: summary.text, timeoutMs }
  if (summary.error !== undefined) return { kind: 'error', text: summary.text, error: summary.error, timeoutMs }
  if (summary.aborted) return { kind: 'stopped', text: summary.text, timeoutMs }
  if (summary.text.trim() === '') return { kind: 'empty', text: '', timeoutMs }
  return { kind: 'reply', text: summary.text, timeoutMs }
}

/** Submits `content`, waits for the agent or the timeout, and lets the sink render the end; the sink is always closed. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { agent, sink } = options
  const now = options.now ?? Date.now
  try {
    const firstSeq = agent.session.seq
    const unsubscribe = options.feed((sessionId, event) => {
      if (sessionId === agent.id && event.type === 'tool/call') sink.status(event.data.name)
    })
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const agentStart = now()
    try {
      agent.followup(createUserMessage({ content: options.content, source: { kind: 'user' } }))
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          agent.cancel({ kind: 'user' })
          resolve()
        }, options.turnTimeoutMs)
      })
      await Promise.race([agent.whenIdle(), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
    const agentMs = now() - agentStart
    const report = reportOf(summarizeTurn(agent.session, firstSeq), timedOut, options.turnTimeoutMs)
    const deliverStart = now()
    const delivered = await sink.deliver(report)
    return {
      outcome: delivered.outcome,
      text: report.text,
      ...(delivered.messageId === undefined ? {} : { messageId: delivered.messageId }),
      timing: { agentMs, deliverMs: now() - deliverStart },
    }
  } finally {
    sink.close()
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/turn.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-chat/src/router/turn.ts packages/dsh-chat/tests/router/turn.spec.ts
git commit -m "feat(chat): add the channel-neutral agent turn runner"
```

---

### Task 3: ChatRouter

**Files:**
- Create: `packages/dsh-chat/src/router/router.ts`
- Create: `packages/dsh-chat/tests/router/fake-channel.ts`
- Test: `packages/dsh-chat/tests/router/router.spec.ts`

**Interfaces:**
- Consumes: Task 1 types and `ChatQueue`; Task 2 `runAgentTurn`, `SessionEventFeed`; `ChatLog`, `oneLine`, `senderLabel` (`src/log/chatlog.ts`); `MemoryStore`, `renderMemoryBlock` (`src/memory/store.ts`); `ChatAgents`, `ChatSender`, `TurnContext` (`src/sessions/agents.ts`); `chatKey`, `splitKey` (`src/keys.ts`).
- Produces:
  - `interface RouterConfig { allowFrom: string[]; superAdmins: string[]; recentMessagesLimit: number; turnTimeoutMs: number }`
  - `interface ImageStore { saveImages(images: ReadonlyArray<InboundImage>): Promise<ReadonlyArray<{ attachmentId: unknown }>> }`
  - `const HELP_TEXT: string`, `function commandOf(text: string): 'reset' | 'stop' | 'help' | undefined`
  - `class ChatRouter` with `register(channel: ChatChannel): () => void`, `channel(id: string): ChatChannel | undefined`, `inbound(message: InboundMessage): void`, `enqueue(key: ChatKey, task: () => Promise<void>): void`, `isBusy(key: ChatKey): boolean`, `prompt(key: ChatKey, input: PromptInput): void`, `chatOf(agentId: string): ChatKey | undefined`, `turnOf(key: ChatKey): TurnContext | undefined`, `get superAdmins(): readonly string[]`.

- [ ] **Step 1: Write the fake channel**

`packages/dsh-chat/tests/router/fake-channel.ts`:

```ts
import type { ChatChannel, Delivered, TurnReport, TurnSink } from '../../src/router/channel.ts'

/** Records everything the core asks of a channel; `failDeliver` makes the next delivery throw. */
export class FakeChannel implements ChatChannel {
  readonly bot: { id: string; name: string }
  sent: { chatId: string; text: string; replyTo?: string }[] = []
  reactions: { chatId: string; messageId: string; emoji: string }[] = []
  turns: { chatId: string; replyTo?: string; status: string[]; reports: TurnReport[]; closed: boolean }[] = []
  failDeliver = false

  constructor(readonly id: string) {
    this.bot = { id: `${id}-bot`, name: `${id}bot` }
  }

  async openTurn(chatId: string, origin: { replyTo?: string }): Promise<TurnSink> {
    const turn = { chatId, ...origin, status: [] as string[], reports: [] as TurnReport[], closed: false }
    this.turns.push(turn)
    return {
      status: tool => { turn.status.push(tool) },
      deliver: async (report) => {
        turn.reports.push(report)
        if (this.failDeliver) {
          this.failDeliver = false
          throw new Error('deliver failed')
        }
        return { outcome: 'sent', messageId: `r${this.turns.length}` }
      },
      close: () => { turn.closed = true },
    }
  }

  async send(chatId: string, text: string, opts: { replyTo?: string } = {}): Promise<Delivered> {
    this.sent.push({ chatId, text, ...opts })
    return { as: 'native', messageId: `s${this.sent.length}`, text }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<Delivered> {
    this.reactions.push({ chatId, messageId, emoji })
    return { as: 'native' }
  }
}
```

- [ ] **Step 2: Write the failing router tests**

`packages/dsh-chat/tests/router/router.spec.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/log/chatlog.ts'
import { MemoryStore } from '../../src/memory/store.ts'
import type { InboundMessage } from '../../src/router/channel.ts'
import { ChatRouter, commandOf, HELP_TEXT, type RouterConfig } from '../../src/router/router.ts'
import type { ChatSender } from '../../src/sessions/agents.ts'
import { FakeChannel } from './fake-channel.ts'

const ann: ChatSender = { id: '7', name: 'Ann', username: 'Ann' }
const bob: ChatSender = { id: '9', name: 'Bob' }
const turnStart = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

let dir: string
let chatLog: ChatLog
let memory: MemoryStore
let telegram: FakeChannel
let zalo: FakeChannel
let followups: { key: string; text: string; images: number }[]
let agents: Record<string, ReturnType<typeof vi.fn>>
let turnsNoted: string[]
let warnings: string[]
let infos: string[]
/** Each turn replies `ok`; `hold` keeps the next turn running until released. */
let hold: Promise<void> | undefined

function fakeAgentFor(key: string) {
  const events: unknown[] = []
  let running = Promise.resolve()
  return {
    id: `agent-${key}`,
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never },
    followup: (message: { content: { type: string; text?: string }[] }) => {
      followups.push({ key, text: message.content[0]!.text!, images: message.content.length - 1 })
      const wait = hold
      running = (wait ?? Promise.resolve()).then(() => {
        events.push(turnStart, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } }, turnEnd)
      })
    },
    whenIdle: () => running,
    cancel: () => {},
  }
}

function router(config: Partial<RouterConfig> = {}): ChatRouter {
  const r = new ChatRouter({
    config: { allowFrom: ['telegram:@ann', 'zalo:7'], superAdmins: ['telegram:7'], recentMessagesLimit: 30, turnTimeoutMs: 10_000, ...config },
    chatLog,
    memory,
    agents: agents as never,
    attachments: { saveImages: vi.fn(async (images: unknown[]) => images.map((_, i) => ({ attachmentId: `att${i}` }))) },
    feed: () => () => {},
    emitTurn: key => turnsNoted.push(key),
    log: { info: msg => infos.push(msg), warn: msg => warnings.push(msg), error: msg => warnings.push(msg) },
  })
  r.register(telegram)
  r.register(zalo)
  return r
}

function message(extra: Partial<InboundMessage> & { chatKey: string }, loadText = 'hello'): InboundMessage {
  const { chatKey: key } = extra
  const id = extra.messageId ?? '10'
  const sender = extra.sender ?? ann
  return {
    messageId: id, sender, isGroup: false, addressed: true, text: loadText, at: Date.now(),
    load: async mode => ({
      logEntry: { ts: new Date().toISOString(), message_id: id, user_id: sender.id, name: sender.name, text: loadText },
      text: mode === 'turn' ? loadText : '',
      images: [],
    }),
    ...extra,
    chatKey: key,
  }
}

const idle = (r: ChatRouter, key: string) => vi.waitFor(() => expect(r.isBusy(key)).toBe(false))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-'))
  chatLog = new ChatLog(join(dir, 'data'))
  memory = new MemoryStore(join(dir, 'data'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  telegram = new FakeChannel('telegram')
  zalo = new FakeChannel('zalo')
  followups = []
  turnsNoted = []
  warnings = []
  infos = []
  hold = undefined
  const turns = new Map<string, unknown>()
  const lastTurn = new Map<string, string>()
  const injected = new Set<string>()
  agents = {
    resolve: vi.fn(async (key: string) => ({ agent: fakeAgentFor(key), resumed: false })),
    reset: vi.fn(async () => {}),
    stop: vi.fn(() => false),
    setTurn: vi.fn((key: string, turn: unknown) => { turns.set(key, turn) }),
    turnOf: vi.fn((key: string) => turns.get(key)),
    chatOf: vi.fn(() => undefined),
    lastTurnMessageId: vi.fn((key: string) => lastTurn.get(key) ?? ''),
    markTurn: vi.fn(async (key: string, id: string) => { lastTurn.set(key, id) }),
    memoryInjected: vi.fn((key: string, session: string) => injected.has(`${key}/${session}`)),
    markMemoryInjected: vi.fn(async (key: string, session: string) => { injected.add(`${key}/${session}`) }),
  }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('commandOf', () => {
  it('reads bare commands only', () => {
    expect(commandOf('/reset')).toBe('reset')
    expect(commandOf('  /stop ')).toBe('stop')
    expect(commandOf('/help')).toBe('help')
    expect(commandOf('/stop@other')).toBeUndefined()
    expect(commandOf('reset please')).toBeUndefined()
  })
})

describe('ChatRouter', () => {
  it('runs a DM turn: logs both sides, opens the turn on the message and records the turn context', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:5' }))
    await idle(r, 'telegram:5')
    expect(telegram.turns).toMatchObject([{ chatId: '5', replyTo: '10', reports: [{ kind: 'reply', text: 'ok' }], closed: true }])
    expect(agents.setTurn).toHaveBeenCalledWith('telegram:5', { sender: ann, isGroup: false, isSuperAdmin: true })
    expect(agents.markTurn).toHaveBeenCalledWith('telegram:5', '10')
    const log = await chatLog.readAll('telegram:5')
    expect(log.map(e => [e.message_id, e.text, e.handled, e.bot, e.reply_to, e.name])).toEqual([
      ['10', 'hello', true, undefined, undefined, 'Ann'],
      ['r1', 'ok', undefined, true, '10', 'telegrambot'],
    ])
    expect(turnsNoted).toEqual(['telegram:5', 'telegram:5'])
  })

  it('allows a Telegram username case-insensitively and a super admin not in allowFrom', async () => {
    const r = router({ allowFrom: ['telegram:@ann'], superAdmins: ['zalo:9'] })
    r.inbound(message({ chatKey: 'telegram:5' }))
    r.inbound(message({ chatKey: 'zalo:6', sender: bob }))
    await idle(r, 'telegram:5')
    await idle(r, 'zalo:6')
    expect(telegram.turns).toHaveLength(1)
    expect(zalo.turns).toHaveLength(1)
  })

  it('ignores a DM stranger without logging the chat, and names the stranger once', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:9', sender: bob }))
    r.inbound(message({ chatKey: 'telegram:9', sender: bob }))
    await idle(r, 'telegram:9')
    expect(await chatLog.readAll('telegram:9')).toEqual([])
    expect(infos.filter(m => m.includes('telegram:9'))).toHaveLength(1)
  })

  it('logs an unaddressed group message, and an addressed one from a stranger, without a turn', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, addressed: false }))
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, sender: bob, messageId: '11' }))
    await idle(r, 'telegram:-5')
    expect(telegram.turns).toEqual([])
    expect((await chatLog.readAll('telegram:-5')).map(e => [e.message_id, e.handled])).toEqual([['10', undefined], ['11', undefined]])
    expect(turnsNoted).toEqual([])
  })

  it('gives a group turn the messages since the last turn, after the memory block', async () => {
    await memory.save({ kind: 'chat', key: 'telegram:-5' }, 'likes tea')
    const r = router()
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, addressed: false, sender: bob, messageId: '1' }, 'first\nline'))
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, messageId: '2' }, 'ask'))
    await idle(r, 'telegram:-5')
    const text = followups[0]!.text
    expect(text.indexOf('<memory>')).toBe(0)
    expect(text).toContain('<group_messages>\n- id:9 (Bob): first line\n</group_messages>\n\nask')
  })

  it('runs commands for super admins only; /help and /stop bypass the queue', async () => {
    const r = router()
    let release!: () => void
    hold = new Promise<void>((resolve) => { release = resolve })
    r.inbound(message({ chatKey: 'telegram:5' }))
    await vi.waitFor(() => expect(followups).toHaveLength(1))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }, '/help'))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '12' }, '/stop'))
    await vi.waitFor(() => expect(telegram.sent.map(s => s.text)).toEqual([HELP_TEXT, 'Nothing is running.']))
    hold = undefined
    release()
    await idle(r, 'telegram:5')
    r.inbound(message({ chatKey: 'zalo:7', sender: { id: '7', name: 'Z' } }, '/stop'))
    await idle(r, 'zalo:7')
    expect(zalo.turns).toHaveLength(1)
    expect(agents.stop).toHaveBeenCalledTimes(1)
  })

  it('/reset stops the running turn at once and resets after queued work', async () => {
    const r = router()
    let release!: () => void
    hold = new Promise<void>((resolve) => { release = resolve })
    r.inbound(message({ chatKey: 'telegram:5' }))
    await vi.waitFor(() => expect(followups).toHaveLength(1))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }, '/reset'))
    expect(agents.stop).toHaveBeenCalledWith('telegram:5')
    expect(agents.reset).not.toHaveBeenCalled()
    hold = undefined
    release()
    await idle(r, 'telegram:5')
    expect(agents.reset).toHaveBeenCalledWith('telegram:5')
    expect(telegram.sent.map(s => s.text)).toEqual(['Started a new conversation.'])
  })

  it('tells the chat when a resume failed', async () => {
    agents.resolve!.mockImplementationOnce(async (key: string) => ({ agent: fakeAgentFor(key), resumed: false, resumeFailed: 'gone' }))
    const r = router()
    r.inbound(message({ chatKey: 'zalo:7', sender: { id: '7', name: 'Z' } }))
    await idle(r, 'zalo:7')
    expect(zalo.sent[0]!.text).toBe('The previous conversation could not be restored; starting a new one.')
  })

  it('prompt runs a turn with nothing to quote or mark, behind queued work', async () => {
    const r = router()
    r.prompt('telegram:-5', { text: 'remind me', sender: ann, isGroup: true })
    await idle(r, 'telegram:-5')
    expect(followups.map(f => f.text)[0]!.endsWith('remind me')).toBe(true)
    expect(followups[0]!.text).not.toContain('<group_messages>')
    expect(telegram.turns[0]!.replyTo).toBeUndefined()
    expect(agents.markTurn).not.toHaveBeenCalled()
    expect(agents.setTurn).toHaveBeenCalledWith('telegram:-5', { sender: ann, isGroup: true, isSuperAdmin: true })
    expect(turnsNoted).toEqual(['telegram:-5'])
  })

  it('keeps two channels with the same chat id apart', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:5' }, 'from telegram'))
    r.inbound(message({ chatKey: 'zalo:5', sender: { id: '7', name: 'Z' } }, 'from zalo'))
    await idle(r, 'telegram:5')
    await idle(r, 'zalo:5')
    expect(followups.map(f => f.key).sort()).toEqual(['telegram:5', 'zalo:5'])
    expect(telegram.turns.map(t => t.chatId)).toEqual(['5'])
    expect(zalo.turns.map(t => t.chatId)).toEqual(['5'])
    expect((await chatLog.readAll('telegram:5')).map(e => e.text)).toEqual(['from telegram', 'ok'])
    expect((await chatLog.readAll('zalo:5')).map(e => e.text)).toEqual(['from zalo', 'ok'])
  })

  it('skips queued work of an unregistered channel', async () => {
    const r = router()
    const unregister = r.register(new FakeChannel('other'))
    const ran: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    r.enqueue('other:1', () => held)
    r.enqueue('other:1', async () => { ran.push('x') })
    await vi.waitFor(() => expect(r.isBusy('other:1')).toBe(true))
    unregister()
    release()
    await idle(r, 'other:1')
    expect(ran).toEqual([])
    expect(warnings.some(w => w.includes('other:1') && w.includes('channel offline'))).toBe(true)
  })

  it('a failed delivery closes the sink and the next turn still runs', async () => {
    const r = router()
    telegram.failDeliver = true
    r.inbound(message({ chatKey: 'telegram:5' }))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }))
    await idle(r, 'telegram:5')
    expect(telegram.turns.map(t => t.closed)).toEqual([true, true])
    expect(telegram.turns[1]!.reports).toHaveLength(1)
  })

  it('refuses a second channel with the same id', () => {
    const r = router()
    expect(() => r.register(new FakeChannel('zalo'))).toThrow('already registered')
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/router.spec.ts`
Expected: FAIL, cannot resolve `../../src/router/router.ts`.

- [ ] **Step 4: Implement the router**

`packages/dsh-chat/src/router/router.ts`. `recentBlock` and `memoryBlock` are today's adapter functions, moved unchanged so the rendered text stays byte-identical.

```ts
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { chatKey, splitKey, type ChatKey } from '../keys.ts'
import { oneLine, senderLabel, type ChatLog, type ChatLogEntry } from '../log/chatlog.ts'
import { renderMemoryBlock, type MemoryStore } from '../memory/store.ts'
import type { ChatAgents, ChatSender, TurnContext } from '../sessions/agents.ts'
import type { ChatChannel, InboundImage, InboundMessage, PromptInput } from './channel.ts'
import { ChatQueue } from './queue.ts'
import { runAgentTurn, type AgentTurnResult, type SessionEventFeed } from './turn.ts'

export interface RouterConfig {
  /** userKeys allowed to get a turn; a Telegram username is written `telegram:@name`. */
  readonly allowFrom: string[]
  /** userKeys that may run commands and edit global memory; always allowed. */
  readonly superAdmins: string[]
  readonly recentMessagesLimit: number
  readonly turnTimeoutMs: number
}

export interface ImageStore {
  saveImages(images: ReadonlyArray<InboundImage>): Promise<ReadonlyArray<{ attachmentId: unknown }>>
}

type RouterAgents = Pick<ChatAgents,
  'resolve' | 'reset' | 'stop' | 'setTurn' | 'turnOf' | 'chatOf' | 'lastTurnMessageId' | 'markTurn' | 'memoryInjected' | 'markMemoryInjected'>

export interface RouterDeps {
  config: RouterConfig
  chatLog: ChatLog
  memory: MemoryStore
  agents: RouterAgents
  attachments: ImageStore
  feed: SessionEventFeed
  /** Emits `chat/turn`; idle work for that chat sees the turn coming and cancels. */
  emitTurn: (key: ChatKey) => void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

export type Command = 'reset' | 'stop' | 'help'

export const HELP_TEXT = '/reset - start a new conversation\n/stop - cancel the running reply\n/help - show this list'
const RESET_DONE = 'Started a new conversation.'
const NOTHING_RUNNING = 'Nothing is running.'
const RESUME_FAILED = 'The previous conversation could not be restored; starting a new one.'
/** Strangers named in the log before the set starts over. */
const MAX_STRANGERS = 1000

export function commandOf(text: string): Command | undefined {
  const match = /^\s*\/(reset|stop|help)\s*$/.exec(text)
  return match === null ? undefined : match[1] as Command
}

const errorText = (error: unknown) => (error instanceof Error ? error.stack ?? error.message : String(error))
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** Untrusted group text (other members included) fenced off from the user's own message; the persona names the tag as data. */
function recentBlock(entries: ChatLogEntry[]): string {
  return `<group_messages>\n${entries.map(e => `- ${senderLabel(e)}: ${oneLine(e.text)}`).join('\n')}\n</group_messages>`
}

interface ChatTurnInput {
  key: ChatKey
  sender: ChatSender
  isGroup: boolean
  text: string
  images: InboundImage[]
  /** The message this turn answers (quoted, given group context, marked); absent for a prompt. */
  messageId?: string
  startedAt: number
}

/** The `chat` service: channel registry, shared gate and commands, per-chat queue and turn orchestration. */
export class ChatRouter {
  private readonly channels = new Map<string, ChatChannel>()
  private readonly queue: ChatQueue
  private readonly strangers = new Set<string>()

  constructor(private readonly deps: RouterDeps) {
    this.queue = new ChatQueue((key, error) => deps.log.error(`dsh-chat: queued task in ${key} failed: ${errorText(error)}`))
  }

  get superAdmins(): readonly string[] {
    return this.deps.config.superAdmins
  }

  /** Adds a channel; the returned function removes it, and its queued work is skipped from then on. */
  register(channel: ChatChannel): () => void {
    if (this.channels.has(channel.id)) throw new Error(`dsh-chat: channel ${channel.id} is already registered`)
    this.channels.set(channel.id, channel)
    return () => {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    }
  }

  channel(id: string): ChatChannel | undefined {
    return this.channels.get(id)
  }

  /** Appends a task to the chat's queue; tasks of one chat never overlap. Skipped when its channel is offline by then. */
  enqueue(key: ChatKey, task: () => Promise<void>): void {
    const { channel } = splitKey(key)
    this.queue.enqueue(key, async () => {
      if (!this.channels.has(channel)) {
        this.deps.log.warn(`dsh-chat: ${key} skipped queued work: channel offline`)
        return
      }
      await task()
    })
  }

  isBusy(key: ChatKey): boolean {
    return this.queue.isBusy(key)
  }

  chatOf(agentId: string): ChatKey | undefined {
    return this.deps.agents.chatOf(agentId)
  }

  turnOf(key: ChatKey): TurnContext | undefined {
    return this.deps.agents.turnOf(key)
  }

  private isSuperAdmin(key: ChatKey, sender: ChatSender): boolean {
    return this.deps.config.superAdmins.includes(chatKey(splitKey(key).channel, sender.id))
  }

  private isAllowed(key: ChatKey, sender: ChatSender): boolean {
    const { channel } = splitKey(key)
    const userKey = chatKey(channel, sender.id)
    const byName = sender.username === undefined ? undefined : `${channel}:@${sender.username.toLowerCase()}`
    return this.isSuperAdmin(key, sender)
      || this.deps.config.allowFrom.some(entry => entry === userKey || (byName !== undefined && entry.toLowerCase() === byName))
  }

  /** Ids are opaque on some platforms, so this line is how an operator learns what to put in allowFrom; once per sender. */
  private noteStranger(key: ChatKey, sender: ChatSender): void {
    const userKey = chatKey(splitKey(key).channel, sender.id)
    if (this.strangers.has(userKey)) return
    if (this.strangers.size >= MAX_STRANGERS) this.strangers.clear()
    this.strangers.add(userKey)
    this.deps.log.info(`dsh-chat: ignored a private message in ${key} from ${userKey} (${sender.name}), who is not in allowFrom`)
  }

  inbound(message: InboundMessage): void {
    const key = message.chatKey
    const allowed = this.isAllowed(key, message.sender)
    if (!message.isGroup && !allowed) {
      this.noteStranger(key, message.sender)
      return
    }
    if (!allowed || !message.addressed) {
      this.enqueue(key, async () => {
        await this.deps.chatLog.append(key, (await message.load('log')).logEntry)
      })
      return
    }
    const command = this.isSuperAdmin(key, message.sender) ? commandOf(message.text) : undefined
    if (command === 'stop' || command === 'help') {
      void this.runCommand(key, command).catch((error: unknown) => {
        this.deps.log.error(`dsh-chat: /${command} in ${key} failed: ${errorText(error)}`)
      })
      return
    }
    if (command === 'reset') {
      // Cancel at once, dispose only after queued work, so no queued turn runs on a disposed agent.
      this.deps.agents.stop(key)
      this.enqueue(key, () => this.runCommand(key, 'reset'))
      return
    }
    // Noted on arrival as well, so idle work already queued for this chat sees the turn coming and cancels.
    this.deps.emitTurn(key)
    this.enqueue(key, () => this.handle(message))
  }

  /** Queues an agent turn nobody typed; it waits behind the chat's running and queued tasks. */
  prompt(key: ChatKey, input: PromptInput): void {
    this.enqueue(key, async () => {
      this.deps.emitTurn(key)
      const { result, prepMs } = await this.runChatTurn({ key, sender: input.sender, isGroup: input.isGroup, text: input.text, images: [], startedAt: Date.now() })
      this.deps.log.info(`dsh-chat: ${key} prompt -> ${result.outcome}`
        + ` (prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
    })
  }

  private channelOf(key: ChatKey): { channel: ChatChannel; id: string } {
    const { channel: channelId, id } = splitKey(key)
    const channel = this.channels.get(channelId)
    if (channel === undefined) throw new Error(`dsh-chat: ${key}: channel offline`)
    return { channel, id }
  }

  private async runCommand(key: ChatKey, command: Command): Promise<void> {
    const { channel, id } = this.channelOf(key)
    if (command === 'reset') {
      await this.deps.agents.reset(key)
      await channel.send(id, RESET_DONE)
    } else if (command === 'stop') {
      // A cancelled turn reports "Stopped." on its own; only an idle agent needs a reply here.
      if (!this.deps.agents.stop(key)) await channel.send(id, NOTHING_RUNNING)
    } else {
      await channel.send(id, HELP_TEXT)
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    const key = message.chatKey
    this.deps.emitTurn(key)
    const receivedAt = Date.now()
    const lagMs = Math.max(0, receivedAt - message.at)
    const loaded = await message.load('turn')
    await this.deps.chatLog.append(key, { ...loaded.logEntry, handled: true })
    const { result, prepMs } = await this.runChatTurn({
      key, sender: message.sender, isGroup: message.isGroup, text: loaded.text, images: loaded.images, messageId: message.messageId, startedAt: receivedAt,
    })
    this.deps.log.info(`dsh-chat: ${key} message ${message.messageId} -> ${result.outcome}`
      + ` (lag ${seconds(lagMs)}, prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
  }

  /** Chat plus global memory for the first turn of a session; undefined when reading failed, so the session stays unmarked. */
  private async memoryBlock(key: ChatKey): Promise<string | undefined> {
    try {
      const [chat, global] = await Promise.all([this.deps.memory.list({ kind: 'chat', key }), this.deps.memory.list({ kind: 'global' })])
      return renderMemoryBlock(chat, global)
    } catch (error) {
      this.deps.log.warn(`dsh-chat: reading memory for ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Resolves the chat's agent, assembles the turn text, runs it through the channel and logs the reply. */
  private async runChatTurn(input: ChatTurnInput): Promise<{ result: AgentTurnResult; prepMs: number }> {
    const { key, messageId } = input
    const { channel, id } = this.channelOf(key)
    const { agents } = this.deps
    const resolved = await agents.resolve(key)
    if (resolved.resumeFailed !== undefined) await channel.send(id, RESUME_FAILED)
    agents.setTurn(key, { sender: input.sender, isGroup: input.isGroup, isSuperAdmin: this.isSuperAdmin(key, input.sender) })

    let text = input.text
    if (input.isGroup && messageId !== undefined) {
      const recent = await this.deps.chatLog.recent(key, agents.lastTurnMessageId(key), messageId, this.deps.config.recentMessagesLimit)
      if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
    }
    // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
    const sessionId = String(resolved.agent.id)
    const memoryText = agents.memoryInjected(key, sessionId) ? '' : await this.memoryBlock(key)
    if (memoryText !== undefined && memoryText !== '') text = `${memoryText}\n\n${text}`
    if (messageId !== undefined) await agents.markTurn(key, messageId)

    const content: ContentBlock[] = [{ type: 'text', text }]
    if (input.images.length > 0) {
      const refs = await this.deps.attachments.saveImages(input.images)
      for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
    }
    const prepMs = Date.now() - input.startedAt
    if (memoryText !== undefined) await agents.markMemoryInjected(key, sessionId)

    const sink = await channel.openTurn(id, messageId === undefined ? {} : { replyTo: messageId })
    const result = await runAgentTurn({ agent: resolved.agent, feed: this.deps.feed, content, sink, turnTimeoutMs: this.deps.config.turnTimeoutMs })
    if (result.text !== '') {
      await this.deps.chatLog.append(key, {
        ts: new Date().toISOString(),
        message_id: result.messageId ?? '',
        user_id: channel.bot.id,
        name: channel.bot.name,
        text: result.text,
        ...(messageId === undefined ? {} : { reply_to: messageId }),
        bot: true,
      })
    }
    return { result, prepMs }
  }
}
```

- [ ] **Step 5: Run the router tests**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/router.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-chat/src/router/router.ts packages/dsh-chat/tests/router/fake-channel.ts packages/dsh-chat/tests/router/router.spec.ts
git commit -m "feat(chat): add ChatRouter with the shared gate, commands, queue and turn"
```

---

### Task 4: The `dsh-chat` router plugin

**Files:**
- Create: `packages/dsh-chat/src/router/plugin.ts`
- Modify: `packages/dsh-chat/src/index.ts`
- Modify: `packages/dsh-chat/package.json`
- Test: `packages/dsh-chat/tests/router/plugin.spec.ts`

**Interfaces:**
- Consumes: `ChatRouter`, `RouterConfig` (Task 3); services `chatLog`, `chatMemory`, `chatAgents`, `attachments`; event `session/event`.
- Produces: package root exports `name = 'dsh-chat'`, `inject`, `Config`, `apply`, `assertRouterConfig`, `ChatRouter`, `commandOf`, `HELP_TEXT`, `ChatQueue`, `summarizeTurn`, all Task 1 types, `RouterConfig`, `ImageStore`, `TurnAgent`, `SessionEventFeed`; Cordis typings `Context.chat: ChatRouter` and event `'chat/turn'(key: ChatKey)`.

- [ ] **Step 1: Add the attachment dependency**

In `packages/dsh-chat/package.json` add `"@deepseek-ai/dsh-attachment": "0.2.0-rc.2"` to both `peerDependencies` and `devDependencies` (same version as in `packages/dsh-telegram/package.json`), then run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing plugin test**

`packages/dsh-chat/tests/router/plugin.spec.ts`:

```ts
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as chat from '../../src/index.ts'

describe('dsh-chat router plugin', () => {
  it('defaults the turn limits and requires allowFrom', () => {
    expect(chat.Config({ allowFrom: ['zalo:1'] })).toEqual({ allowFrom: ['zalo:1'], superAdmins: [], recentMessagesLimit: 30, turnTimeoutMs: 900_000 })
    expect(() => chat.Config({})).toThrow()
  })

  it('rejects an empty allowFrom and entries that are not user keys', () => {
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: [] }))).toThrow('allowFrom')
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: ['12345'] }))).toThrow('12345')
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: ['zalo:1'], superAdmins: ['7'] }))).toThrow('7')
  })

  it('provides chat once its stores are up', async () => {
    const root = new Context()
    root.plugin(chat, chat.Config({ allowFrom: ['zalo:1'] }))
    expect(root.get('chat')).toBeUndefined()
    root.provide('chatLog', {} as never)
    root.provide('chatMemory', {} as never)
    root.provide('chatAgents', {} as never)
    root.provide('attachments', {} as never)
    await vi.waitFor(() => expect(root.get('chat')).toBeInstanceOf(chat.ChatRouter))
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter dsh-chat exec vitest run tests/router/plugin.spec.ts`
Expected: FAIL, `chat.Config` is not a function.

- [ ] **Step 4: Implement the plugin**

`packages/dsh-chat/src/router/plugin.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { splitKey, type ChatKey } from '../keys.ts'
import type {} from '../log/index.ts'
import type {} from '../memory/index.ts'
import type {} from '../sessions/index.ts'
import { ChatRouter, type RouterConfig } from './router.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chat: ChatRouter
  }
  interface Events {
    /** An addressed message arrived or a turn is about to run in this chat. */
    'chat/turn'(key: ChatKey): void
  }
}

export const Config: z<RouterConfig> = z.object({
  allowFrom: z.array(z.string()).required(),
  superAdmins: z.array(z.string()).default([]),
  recentMessagesLimit: z.number().min(0).default(30),
  turnTimeoutMs: z.number().min(1).default(900_000),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertRouterConfig(config: RouterConfig): void {
  if (config.allowFrom.length === 0) throw new Error('dsh-chat: allowFrom must list at least one user key')
  for (const entry of [...config.allowFrom, ...config.superAdmins]) {
    try {
      splitKey(entry)
    } catch {
      throw new Error(`dsh-chat: "${entry}" is not a user key like telegram:123 or zalo:abc`)
    }
  }
}

/** Cordis plugin name. */
export const name = 'dsh-chat'
export const inject = ['chatLog', 'chatMemory', 'chatAgents', 'attachments']

export function apply(ctx: Context, config: RouterConfig): void {
  assertRouterConfig(config)
  const logger = ctx.logger('dsh-chat')
  const router = new ChatRouter({
    config,
    chatLog: ctx.chatLog,
    memory: ctx.chatMemory,
    agents: ctx.chatAgents,
    attachments: ctx.attachments,
    feed: listener => ctx.on('session/event', (session, event) => listener(String(session.id), event)),
    emitTurn: key => ctx.emit('chat/turn', key),
    log: { info: msg => logger.info(msg), warn: msg => logger.warn(msg), error: msg => logger.error(msg) },
  })
  ctx.effect(() => ctx.provide('chat', router), 'dsh-chat: chat')
}
```

Append to `packages/dsh-chat/src/index.ts`:

```ts
export type { ChatChannel, Delivered, ImageMediaType, InboundImage, InboundMessage, LoadedMessage, PromptInput, TurnReport, TurnSink } from './router/channel.ts'
export { ChatQueue } from './router/queue.ts'
export { ChatRouter, commandOf, HELP_TEXT, type ImageStore, type RouterConfig } from './router/router.ts'
export { runAgentTurn, summarizeTurn, type AgentTurnResult, type SessionEventFeed, type TurnAgent } from './router/turn.ts'
export { apply, assertRouterConfig, Config, inject, name } from './router/plugin.ts'
```

If `ctx.attachments` does not type-check against `ImageStore`, pass `images => ctx.attachments.saveImages(images)` instead, the way `dsh-telegram/src/idle/index.ts` does.

- [ ] **Step 5: Run the dsh-chat suite and build**

Run: `pnpm --filter dsh-chat exec vitest run` then `pnpm --filter dsh-chat run build`
Expected: all dsh-chat tests PASS; build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-chat pnpm-lock.yaml
git commit -m "feat(chat): provide the chat router as the dsh-chat plugin"
```

---

### Task 5: Telegram as a ChatChannel

**Files:**
- Create: `packages/dsh-telegram/src/channel.ts`
- Modify: `packages/dsh-telegram/src/inbound.ts` (add `toInbound`)
- Modify: `packages/dsh-telegram/src/index.ts`, `src/service.ts`, `src/config.ts`, `src/idle/scheduler.ts`
- Delete: `packages/dsh-telegram/src/bot.ts`, `packages/dsh-telegram/src/turn.ts`
- Test: create `tests/channel.spec.ts`; extend `tests/inbound.spec.ts`; update `tests/config.spec.ts`, `tests/idle/scheduler.spec.ts`; delete `tests/bot.spec.ts`, `tests/bot-reply-log.spec.ts`, `tests/turn.spec.ts`

**Interfaces:**
- Consumes: from `dsh-chat`: `ChatChannel`, `TurnSink`, `TurnReport`, `Delivered`, `InboundMessage`, `ChatQueue`, `ImageStore`, `chatKey`, `idIn`; `ctx.chat` (Task 4).
- Produces:
  - `createTelegramChannel(deps: TelegramChannelDeps): ChatChannel` with `TelegramChannelDeps = { api: TelegramApi; bot: { id: number; username: string }; config: Pick<Config, 'messageSize' | 'statusEditIntervalMs' | 'status'>; outboxFor(chatId: number): string; log: { warn(msg: string): void; error(msg: string): void }; now?: () => number }`
  - `ACK_REACTION` (moved from `bot.ts`, same value `'\u{1F47E}'`)
  - `toInbound(message: TelegramMessage, deps: { api: TelegramApi; botId: number; botUsername: string; inboxFor(chatId: number): string; log: { warn(msg: string): void } }): InboundMessage | undefined`
  - `TelegramService` keeps its fields for idle and schedule; `queue` becomes `{ enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }`; `PromptInput` moves into `service.ts` as `{ text: string; sender: TelegramUser }`.

- [ ] **Step 1: Write the failing channel tests**

Port every case of today's `tests/turn.spec.ts` that checks delivery into `tests/channel.spec.ts`, driving `openTurn(...).deliver(report)` instead of `runTurn`. Each old agent script maps to one report: reply text `t` -> `{ kind: 'reply', text: t, timeoutMs }`; `turnEnd({ kind: 'error', error: { code, message } })` -> `{ kind: 'error', text: '', error: 'code: message', timeoutMs }`; aborted -> `{ kind: 'stopped', text: '', timeoutMs }`; timeout -> `{ kind: 'timeout', text: '', timeoutMs: 10_000 }`; no text -> `{ kind: 'empty', text: '', timeoutMs }`. Keep each case's assertions on `api.calls`. Tool-status cases call `sink.status('bash')` etc. directly. The file starts as follows; the first four cases are complete examples of the mapping:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACK_REACTION, createTelegramChannel } from '../src/channel.ts'
import { Config } from '../src/config.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'channel-')); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const config = Config({ botToken: 't' })
const channel = () => createTelegramChannel({
  api, bot: { id: 1, username: 'dshbot' }, config: { ...config, statusEditIntervalMs: 0 },
  outboxFor: () => join(dir, 'outbox'), log: { warn: () => {}, error: () => {} },
})
const reply = (text: string) => ({ kind: 'reply' as const, text, timeoutMs: 10_000 })

describe('Telegram turn sink', () => {
  it('acks the message, shows typing and a reply placeholder, then edits it into the answer', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, ACK_REACTION])
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([5, config.status.thinking, { replyTo: { messageId: 10 } }])
    const delivered = await sink.deliver(reply('**done**'))
    sink.close()
    expect(delivered).toEqual({ outcome: 'edited', messageId: '100' })
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toContain('<b>done</b>')
  })

  it('a prompt turn neither acks nor quotes', async () => {
    const sink = await channel().openTurn('5', {})
    await sink.deliver(reply('ok'))
    sink.close()
    expect(api.callsTo('setReaction')).toHaveLength(0)
    expect(api.callsTo('sendMessage')[0]!.args[2]).toEqual({})
  })

  it('still answers when the ack reaction or typing fails', async () => {
    api.failNext('setReaction', new Error('reactions off'))
    api.failNext('sendChatAction', new Error('nope'))
    const sink = await channel().openTurn('5', { replyTo: '10' })
    expect((await sink.deliver(reply('ok'))).outcome).toBe('edited')
    sink.close()
  })

  it('edits the placeholder with group labels and skips repeats', async () => {
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    const sink = await channel().openTurn('5', { replyTo: '10' })
    sink.status('bash')
    await tick()
    sink.status('bash')
    await tick()
    sink.status('read')
    await tick()
    await sink.deliver(reply('ok'))
    sink.close()
    const edits = api.callsTo('editMessageText').map(c => c.args[2])
    expect(edits.slice(0, -1)).toEqual([config.status.command, config.status.read])
  })
})

describe('Telegram send and react', () => {
  it('sends natively, quoting when asked', async () => {
    expect(await channel().send('5', 'hi', { replyTo: '10' })).toEqual({ as: 'native', messageId: '100', text: 'hi' })
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([5, 'hi', { replyTo: { messageId: 10 } }])
  })

  it('reacts natively and posts nothing', async () => {
    expect(await channel().react('5', '10', '\u{1F44D}')).toEqual({ as: 'native' })
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, '\u{1F44D}'])
  })
})
```

Then add the ported cases from `tests/turn.spec.ts` (fresh send when the edit fails; retry without the collapse wrapper then plain text; markdown document over 4096 bytes written to `outbox`; undelivered when the document upload fails; error, timeout, stopped and empty notices replacing the placeholder) under `describe('Telegram turn sink')`.

- [ ] **Step 2: Write the failing inbound tests**

Append to `tests/inbound.spec.ts` (reuse that file's existing message helpers if it has them; otherwise this block is self-contained):

```ts
import { toInbound } from '../src/inbound.ts'

describe('toInbound', () => {
  const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
  const deps = (api = new FakeTelegramApi()) => ({ api, botId: 1, botUsername: 'dshbot', inboxFor: () => join(tmpdir(), 'inbox-unused'), log: { warn: () => {} } })
  const base = (extra: object = {}, type: 'private' | 'supergroup' = 'private') => ({ message_id: 10, date: 1_700_000_000, chat: { id: 5, type }, from: ann, text: 'hi', ...extra })

  it('drops messages without a sender and from bots', () => {
    expect(toInbound({ ...base(), from: undefined } as never, deps())).toBeUndefined()
    expect(toInbound(base({ from: { ...ann, is_bot: true } }) as never, deps())).toBeUndefined()
  })

  it('keys the chat, keeps the sender channel-neutral and dates the message', () => {
    const m = toInbound(base() as never, deps())!
    expect(m).toMatchObject({ chatKey: 'telegram:5', messageId: '10', sender: { id: '7', name: 'Ann', username: 'ann' }, isGroup: false, addressed: true, at: 1_700_000_000_000 })
  })

  it('addresses a group message by mention or reply to the bot only', () => {
    const mention = [{ type: 'mention', offset: 0, length: 7 }]
    expect(toInbound(base({ text: 'hello' }, 'supergroup') as never, deps())!.addressed).toBe(false)
    expect(toInbound(base({ text: '@dshbot hi', entities: mention }, 'supergroup') as never, deps())!.addressed).toBe(true)
    expect(toInbound(base({ reply_to_message: { ...base(), from: { id: 1, is_bot: true, first_name: 'b' } } }, 'supergroup') as never, deps())!.addressed).toBe(true)
  })

  it('normalizes a command addressed to this bot and leaves one for another bot alone', () => {
    expect(toInbound(base({ text: '/stop@dshbot' }) as never, deps())!.text).toBe('/stop')
    expect(toInbound(base({ text: '/stop@other' }) as never, deps())!.text).toBe('/stop@other')
  })

  it('loads the log line in log mode and the turn text in turn mode', async () => {
    const m = toInbound(base({ text: 'hi' }) as never, deps())!
    expect(await m.load('log')).toMatchObject({ logEntry: { message_id: '10', text: 'hi' }, text: '', images: [] })
    expect((await m.load('turn')).text).toBe('hi')
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter dsh-telegram exec vitest run tests/channel.spec.ts tests/inbound.spec.ts`
Expected: FAIL, `../src/channel.ts` missing and `toInbound` not exported.

- [ ] **Step 4: Implement `src/channel.ts`**

Move `Placeholder`, `replyTarget`, `sendPart`, `sendMarkdownDocument` and `deliver` from `src/turn.ts` into `src/channel.ts` unchanged except as shown, then add the channel:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatChannel, TurnReport, TurnSink } from 'dsh-chat'
import type { Config } from './config.ts'
import {
  CAPTION_MAX_BYTES, TELEGRAM_MAX_MESSAGE_BYTES, UNDELIVERED_NOTICE, UTF8_BOM,
  byteLength, captionPrefix, markdownToTelegramHTML, renderMessage, stripCollapse, toolStatus,
} from './render.ts'
import type { ReplyTarget, TelegramApi } from './telegram-api.ts'

/** Reaction placed on every message the agent will answer. */
export const ACK_REACTION = '\u{1F47E}'

export interface TelegramChannelDeps {
  api: TelegramApi
  bot: { id: number; username: string }
  config: Pick<Config, 'messageSize' | 'statusEditIntervalMs' | 'status'>
  /** Where a too-long answer is written before it is sent as a document. */
  outboxFor(chatId: number): string
  log: { warn(msg: string): void; error(msg: string): void }
  now?: () => number
}

export type TurnOutcome = 'edited' | 'sent' | 'document' | 'undelivered' | 'error' | 'timeout' | 'stopped' | 'empty'

// class Placeholder ... (moved unchanged from turn.ts)
// function replyTarget ... (moved unchanged)
// async function sendPart(api, chatId, part, replyToMessageId, log) ... (moved unchanged; `log` typed as TelegramChannelDeps['log'])

interface TurnTarget { deps: TelegramChannelDeps; chatId: number; replyTo?: number }

async function sendMarkdownDocument(target: TurnTarget, markdown: string, html: string): Promise<number> {
  const outboxDir = target.deps.outboxFor(target.chatId)
  await mkdir(outboxDir, { recursive: true })
  const filename = `response-${Date.now()}.md`
  const data = Buffer.from(UTF8_BOM + markdown, 'utf8')
  await writeFile(join(outboxDir, filename), data)
  const sent = await target.deps.api.sendDocument(target.chatId, data, {
    filename, caption: captionPrefix(html, CAPTION_MAX_BYTES), parseMode: 'HTML', ...replyTarget(target.replyTo),
  })
  return sent.messageId
}

/** Turns the report into what the chat sees: placeholder text, a fresh message, or a document. */
async function deliver(target: TurnTarget, placeholder: Placeholder, report: TurnReport): Promise<{ outcome: TurnOutcome; sentMessageId?: number }> {
  const { deps, chatId } = target
  const placeholderId = placeholder.messageId
  if (report.kind === 'timeout') {
    await placeholder.replace(`The reply timed out after ${Math.round(report.timeoutMs / 1000)}s and was stopped.`)
    return { outcome: 'timeout', sentMessageId: placeholderId }
  }
  if (report.kind === 'error') {
    await placeholder.replace(`Error: ${report.error}`)
    return { outcome: 'error', sentMessageId: placeholderId }
  }
  if (report.kind === 'stopped') {
    await placeholder.replace('Stopped.')
    return { outcome: 'stopped', sentMessageId: placeholderId }
  }
  if (report.kind === 'empty') {
    await placeholder.replace('(no reply)')
    return { outcome: 'empty', sentMessageId: placeholderId }
  }
  const html = markdownToTelegramHTML(report.text)
  const rendered = renderMessage(html, deps.config.messageSize)
  if (byteLength(rendered) > TELEGRAM_MAX_MESSAGE_BYTES) {
    await placeholder.drop()
    try {
      return { outcome: 'document', sentMessageId: await sendMarkdownDocument(target, report.text, html) }
    } catch (error) {
      deps.log.error(`dsh-telegram: markdown document send failed (${String(error)})`)
      await deps.api.sendMessage(chatId, UNDELIVERED_NOTICE, { ...replyTarget(target.replyTo) })
      return { outcome: 'undelivered' }
    }
  }
  if (await placeholder.replace(rendered, 'HTML')) return { outcome: 'edited', sentMessageId: placeholderId }
  await placeholder.drop()
  return { outcome: 'sent', sentMessageId: await sendPart(deps.api, chatId, rendered, target.replyTo, deps.log) }
}

async function openTurn(deps: TelegramChannelDeps, chatId: number, replyTo: number | undefined): Promise<TurnSink> {
  const { api, log } = deps
  const now = deps.now ?? Date.now
  // The reaction is a courtesy; a chat with reactions disabled must still get its answer.
  if (replyTo !== undefined) {
    await api.setReaction(chatId, replyTo, ACK_REACTION).catch((error: unknown) => {
      log.warn(`dsh-telegram: chat ${chatId} acknowledgement reaction failed (${String(error)})`)
    })
  }
  await api.sendChatAction(chatId, 'typing').catch((error: unknown) => {
    log.warn(`dsh-telegram: typing indicator failed (${String(error)})`)
  })
  const { status } = deps.config
  const placeholderId = (await api.sendMessage(chatId, status.thinking, { ...replyTarget(replyTo) })).messageId
  const placeholder = new Placeholder(api, chatId, placeholderId, deps.config.statusEditIntervalMs, now, status.thinking)
  const target: TurnTarget = { deps, chatId, ...(replyTo === undefined ? {} : { replyTo }) }
  return {
    status: tool => placeholder.status(toolStatus(tool, status)),
    deliver: async (report) => {
      const d = await deliver(target, placeholder, report)
      return { outcome: d.outcome, ...(d.sentMessageId === undefined ? {} : { messageId: String(d.sentMessageId) }) }
    },
    close: () => { void placeholder.settle() },
  }
}

export function createTelegramChannel(deps: TelegramChannelDeps): ChatChannel {
  return {
    id: 'telegram',
    bot: { id: String(deps.bot.id), name: deps.bot.username },
    openTurn: (chatId, origin) => openTurn(deps, Number(chatId), origin.replyTo === undefined ? undefined : Number(origin.replyTo)),
    async send(chatId, text, opts = {}) {
      const sent = await deps.api.sendMessage(Number(chatId), text, { ...replyTarget(opts.replyTo === undefined ? undefined : Number(opts.replyTo)) })
      return { as: 'native', messageId: String(sent.messageId), text }
    },
    async react(chatId, messageId, emoji) {
      await deps.api.setReaction(Number(chatId), Number(messageId), emoji)
      return { as: 'native' }
    },
  }
}
```

- [ ] **Step 5: Implement `toInbound` in `src/inbound.ts`**

```ts
import { chatKey, type InboundMessage } from 'dsh-chat'

export interface ToInboundDeps {
  api: TelegramApi
  botId: number
  botUsername: string
  inboxFor(chatId: number): string
  log: { warn(msg: string): void }
}

/** `/cmd@thisbot` becomes `/cmd`; a command for another bot stays as typed, so the core never runs it. */
function commandText(text: string | undefined, botUsername: string): string {
  const match = /^\/(reset|stop|help)(?:@(\w+))?\s*$/.exec(text ?? '')
  if (match !== null && (match[2] === undefined || match[2].toLowerCase() === botUsername.toLowerCase())) return `/${match[1]}`
  return text ?? ''
}

/** Normalizes one Telegram message for the chat core; undefined for messages the core never sees. */
export function toInbound(message: TelegramMessage, deps: ToInboundDeps): InboundMessage | undefined {
  const sender = message.from
  if (sender === undefined || sender.is_bot) return undefined
  const isGroup = message.chat.type !== 'private'
  const addressed = !isGroup
    || hasBotMention(message.text, message.entities, deps.botUsername)
    || hasBotMention(message.caption, message.caption_entities, deps.botUsername)
    || message.reply_to_message?.from?.id === deps.botId
  return {
    chatKey: chatKey('telegram', message.chat.id),
    messageId: String(message.message_id),
    sender: { id: String(sender.id), name: sender.first_name, ...(sender.username === undefined ? {} : { username: sender.username }) },
    isGroup,
    addressed,
    text: commandText(message.text, deps.botUsername),
    // Telegram stamps `date` when the sender hit send.
    at: message.date * 1000,
    async load(mode) {
      const inboxDir = deps.inboxFor(message.chat.id)
      if (mode === 'log') {
        const saved = await saveObservedPhoto(message, deps.api, inboxDir).catch((error: unknown) => {
          deps.log.warn(`dsh-telegram: saving photo of message ${message.message_id} in chat ${message.chat.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          return []
        })
        return { logEntry: logEntryFor(message, saved), text: '', images: [] }
      }
      const parsed = await parseInbound(message, { api: deps.api, inboxDir, botId: deps.botId, botUsername: deps.botUsername })
      return { logEntry: parsed.logEntry, text: parsed.text, images: parsed.images }
    },
  }
}
```

- [ ] **Step 6: Slim the config**

In `src/config.ts` remove `allowFrom`, `recentMessagesLimit`, `turnTimeoutMs`, `superAdmins` from `Config` and its Schemastery object, and delete `assertConfig` (it only checked `allowFrom`). Update `tests/config.spec.ts`: drop cases for removed fields and the `assertConfig` case; keep the rest.

- [ ] **Step 7: Rewrite `src/service.ts`**

```ts
import type { ChatLog, ChatLogEntry, TurnContext } from 'dsh-chat'
import type { TelegramUser } from './inbound.ts'
import type { TelegramApi } from './telegram-api.ts'

/** The running turn in Telegram terms, for the schedule tools. */
export interface TelegramTurn { sender: TelegramUser; isGroup: boolean }

export function telegramTurn(turn: TurnContext | undefined): TelegramTurn | undefined {
  if (turn === undefined) return undefined
  const { id, name, username } = turn.sender
  return { isGroup: turn.isGroup, sender: { id: Number(id), is_bot: false, first_name: name, ...(username === undefined ? {} : { username }) } }
}

export interface PromptInput { text: string; sender: TelegramUser }

/** Telegram view of the chat router for `dsh-telegram/idle` and `dsh-telegram/schedule`; provided only while the bot polls. */
export interface TelegramService {
  readonly api: TelegramApi
  /** The shared dsh-chat log, keyed by `telegram:<chatId>`. */
  readonly chatLog: ChatLog
  /** The router's per-chat queue; tasks of one chat never overlap. */
  readonly queue: { enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }
  readonly bot: { readonly id: number; readonly username: string }
  readonly selection: { readonly provider: string; readonly model: string }
  /** Where plugins keep their own durable files. */
  readonly dataDir: string
  readonly superAdmins: readonly number[]
  chatOf(agentId: string): number | undefined
  turnOf(chatId: number): TelegramTurn | undefined
  /** Queues an agent turn in the chat as if `sender` had written `text`; the reply quotes no message. */
  prompt(chatId: number, input: PromptInput): void
}
```

Keep the `declare module '@deepseek-ai/cordis'` block that follows it unchanged (`telegram` service, `telegram/turn` and `telegram/message` events).

- [ ] **Step 8: Rewrite `src/index.ts`**

Replace `start` and `apply`; keep `retryStart`, `startPolling`, `loggerFor`, `STARTUP_BACKOFF` as they are.

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { autoRetry } from '@grammyjs/auto-retry'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { chatKey, idIn } from 'dsh-chat'
import type {} from 'dsh-chat/log'
import type {} from 'dsh-chat/migrate'
import type {} from 'dsh-chat/sessions'
import { Bot } from 'grammy'
import { createTelegramChannel } from './channel.ts'
import { Config } from './config.ts'
import { toInbound, type TelegramMessage } from './inbound.ts'
import { telegramTurn, type TelegramService } from './service.ts'
import { createGrammyApi, type TelegramApi } from './telegram-api.ts'
import { createSendFileTool } from './tools.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'
export type { TelegramService } from './service.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** The router and stores come from the dsh-chat plugins. */
export const inject = ['loader', 'chatData', 'chatLog', 'chatAgents', 'chat']

interface Started { polling: Polling; api: TelegramApi; unregister: () => void; service: TelegramService }

const telegramIds = (keys: readonly string[]) => keys.flatMap((key) => {
  const id = idIn('telegram', key)
  return id === undefined ? [] : [Number(id)]
})

async function start(ctx: Context, config: Config): Promise<Started> {
  const log = loggerFor(ctx)
  // Wait for the complete application so agent-scoped tools and adapters are composed.
  await ctx.get('loader')?.await()

  const bot = new Bot(config.botToken)
  bot.api.config.use(autoRetry({ maxRetryAttempts: config.retry.maxAttempts, maxDelaySeconds: config.retry.maxDelayMs / 1000 }))
  await bot.init()
  const api = createGrammyApi(bot, config.botToken, config.retry)
  const agents = ctx.chatAgents
  const workspaceOf = (chatId: number) => agents.workspaceFor(chatKey('telegram', chatId))
  const botId = bot.botInfo.id
  const botUsername = bot.botInfo.username

  // Registered before polling starts, so the first update never finds the channel offline.
  const unregister = ctx.chat.register(createTelegramChannel({
    api, bot: { id: botId, username: botUsername }, config, log,
    outboxFor: chatId => join(workspaceOf(chatId), 'outbox'),
  }))
  bot.on('message', (update) => {
    const inbound = toInbound(update.message as unknown as TelegramMessage, {
      api, botId, botUsername, log, inboxFor: chatId => join(workspaceOf(chatId), 'inbox'),
    })
    if (inbound !== undefined) ctx.chat.inbound(inbound)
  })
  bot.catch((error) => { log.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const polling = startPolling(bot, config, log)
  log.info(`dsh-telegram: polling as @${botUsername}`)
  const key = (chatId: number) => chatKey('telegram', chatId)
  return {
    polling,
    api,
    unregister,
    service: {
      api,
      chatLog: ctx.chatLog,
      queue: { enqueue: (chatId, task) => ctx.chat.enqueue(key(chatId), task), isBusy: chatId => ctx.chat.isBusy(key(chatId)) },
      bot: { id: botId, username: botUsername },
      selection: agents.selection,
      dataDir: join(ctx.chatData.dataDir, 'telegram'),
      superAdmins: telegramIds(ctx.chat.superAdmins),
      chatOf: (agentId) => {
        const found = ctx.chat.chatOf(agentId)
        const id = found === undefined ? undefined : idIn('telegram', found)
        return id === undefined ? undefined : Number(id)
      },
      turnOf: chatId => telegramTurn(ctx.chat.turnOf(key(chatId))),
      prompt: (chatId, input) => ctx.chat.prompt(key(chatId), {
        text: input.text,
        sender: { id: String(input.sender.id), name: input.sender.first_name, ...(input.sender.username === undefined ? {} : { username: input.sender.username }) },
        isGroup: chatId < 0,
      }),
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  const log = loggerFor(ctx)
  let started: Started | undefined
  let revoke: (() => void) | undefined
  let stopped = false
  ctx.on('chat/agent', (agentCtx, key) => {
    const id = idIn('telegram', key)
    if (id === undefined) return
    const tool = createSendFileTool({ api: () => started?.api, chatId: Number(id), workspaceDir: ctx.chatAgents.workspaceFor(key), maxUploadBytes: config.retry.maxUploadMb * 1024 * 1024 })
    agentCtx.effect(() => agentCtx.tools.register(tool), 'dsh-telegram: telegram_send_file')
  })
  // Idle engagement listens to telegram/* with numeric chat ids until it moves to dsh-chat.
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/message', Number(id), entry)
  })
  ctx.on('chat/turn', (key) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/turn', Number(id))
  })
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        result.unregister()
        void result.polling.stop()
        return
      }
      started = result
      // Provided only now: Cordis starts dependants as soon as a name is provided, with or without a value.
      revoke = ctx.provide('telegram', result.service)
    }, (error, delayMs) => {
      log.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}; retrying in ${delayMs}ms`)
    }, STARTUP_BACKOFF)
    return () => {
      stopped = true
      cancel()
      if (started === undefined) return
      const { polling, unregister } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls; queued turns are then skipped.
      revoke?.()
      revoke = undefined
      unregister()
      return polling.stop()
    }
  }, 'dsh-telegram: bot runner')
}
```

The `ctx.chat` typing comes with the `dsh-chat` root import above.

- [ ] **Step 9: Point idle at the core types and delete the old modules**

In `src/idle/scheduler.ts` replace `import type { ImageStore } from '../bot.ts'` with `import type { ImageStore } from 'dsh-chat'` (merge into the existing `dsh-chat` import). In `tests/idle/scheduler.spec.ts` replace `import { createDispatcher } from '../../src/bot.ts'` with `import { ChatQueue } from 'dsh-chat'`, and the dispatcher lines with:

```ts
    const chatQueue = new ChatQueue(() => {})
    const dispatcher = { enqueue: (chatId: number, task: () => Promise<void>) => chatQueue.enqueue(String(chatId), task) }
```

Delete `src/bot.ts`, `src/turn.ts`, `tests/bot.spec.ts`, `tests/bot-reply-log.spec.ts`, `tests/turn.spec.ts` (their behavior is now covered by the router tests in Task 3 and the channel and inbound tests above). Run `pnpm --filter dsh-telegram run typecheck` and fix any remaining import of the deleted modules.

- [ ] **Step 10: Run the Telegram suite**

Run: `pnpm --filter dsh-chat run build` then `pnpm --filter dsh-telegram exec vitest run` and `pnpm --filter dsh-telegram run typecheck`
Expected: all PASS except `tests/profile.spec.ts` cases about the telegram row's `allowFrom`/`superAdmins`, which Task 7 updates.

- [ ] **Step 11: Commit**

```bash
git add -A packages/dsh-telegram
git commit -m "refactor(telegram): run on the dsh-chat router as a ChatChannel"
```

---

### Task 6: Zalo as a ChatChannel

**Files:**
- Create: `packages/dsh-zalo/src/channel.ts`
- Modify: `packages/dsh-zalo/src/inbound.ts` (add `toInbound`), `src/index.ts`, `src/config.ts`
- Delete: `packages/dsh-zalo/src/bot.ts`, `src/turn.ts`, `src/service.ts`
- Test: create `tests/channel.spec.ts`; extend `tests/inbound.spec.ts`; update `tests/config.spec.ts`; delete `tests/bot.spec.ts`, `tests/turn.spec.ts`

**Interfaces:**
- Consumes: from `dsh-chat`: `ChatChannel`, `TurnSink`, `TurnReport`, `InboundMessage`, `chatKey`; `ctx.chat`.
- Produces: `createZaloChannel(deps: { api: ZaloApi; bot: { id: string; accountName: string }; config: Pick<Config, 'messageSize' | 'typingIntervalMs'>; log: { warn(msg: string): void; error(msg: string): void } }): ChatChannel`; `startTyping` (moved, same signature); `toInbound(update: ZaloUpdate, deps: TriggerOptions & { api: ZaloApi; botId: string; inboxFor(chatId: string): string; log: { warn(msg: string): void } }): InboundMessage | undefined`.

- [ ] **Step 1: Write the failing channel tests**

Port the delivery cases of today's `tests/turn.spec.ts` (`sends the reply as markdown`, `long reply as ordered chunks`, `resends a rejected chunk as plain text`, `undelivered when plain text fails too`, `no plain resend after a network error`, `still replies when typing fails`, `error, aborted and empty notices`, `timeout notice`, `startTyping repeats until stopped`) into `tests/channel.spec.ts`, driving `openTurn(chatId, {})` then `deliver(report)` with the same report mapping as Task 5 Step 1. Start the file with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createZaloChannel, startTyping } from '../src/channel.ts'
import { Config } from '../src/config.ts'
import { ZaloApiError } from '../src/zalo-api.ts'
import { FakeZaloApi } from './helpers/fake-api.ts'

let api: FakeZaloApi
beforeEach(() => { api = new FakeZaloApi() })
afterEach(() => { vi.useRealTimers() })

const config = Config({ botToken: 't' })
const channel = () => createZaloChannel({ api, bot: { id: 'bot1', accountName: 'dshbot' }, config, log: { warn: () => {}, error: () => {} } })
const reply = (text: string) => ({ kind: 'reply' as const, text, timeoutMs: 10_000 })

describe('Zalo turn sink', () => {
  it('shows typing, sends the reply as markdown and stops typing', async () => {
    vi.useFakeTimers()
    const sink = await channel().openTurn('c1', { replyTo: 'm1' })
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    expect(await sink.deliver(reply('**hi**'))).toEqual({ outcome: 'sent', messageId: '100' })
    sink.close()
    await vi.advanceTimersByTimeAsync(config.typingIntervalMs * 3)
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    expect(api.callsTo('sendMessage')[0]!.args).toEqual(['c1', '**hi**', { parseMode: 'markdown' }])
  })

  it('resends a chunk Zalo rejects as plain text', async () => {
    api.failNext('sendMessage', new ZaloApiError('bad markdown', 400))
    const sink = await channel().openTurn('c1', {})
    expect((await sink.deliver(reply('x'))).outcome).toBe('sent')
    sink.close()
    expect(api.callsTo('sendMessage').map(c => c.args[2])).toEqual([{ parseMode: 'markdown' }, undefined])
  })
})

describe('Zalo send and react', () => {
  it('sends plainly; a reply target is a fallback since Zalo cannot quote', async () => {
    expect(await channel().send('c1', 'hi')).toEqual({ as: 'native', messageId: '100', text: 'hi' })
    expect(await channel().send('c1', 'yo', { replyTo: 'm1' })).toEqual({ as: 'fallback', messageId: '101', text: 'yo' })
    expect(api.callsTo('sendMessage').map(c => c.args)).toEqual([['c1', 'hi'], ['c1', 'yo']])
  })

  it('reacts by posting the emoji as text', async () => {
    expect(await channel().react('c1', 'm1', '\u{1F44D}')).toEqual({ as: 'fallback', messageId: '100', text: '\u{1F44D}' })
  })
})
```

Check `FakeZaloApi.sendMessage` records `options` as the third arg only when passed; if it always records it, compare against `['c1', 'hi', undefined]` instead.

- [ ] **Step 2: Write the failing inbound tests**

Append to `tests/inbound.spec.ts` (use that file's existing `update(...)` helper if present; the shape below matches `ZaloUpdate`):

```ts
import { toInbound } from '../src/inbound.ts'

describe('toInbound', () => {
  const deps = (api = new FakeZaloApi()) => ({ api, botId: 'bot1', accountName: 'dshbot', displayName: 'Dsh Bot', groupPrefix: '/ask', inboxFor: () => '/tmp/unused', log: { warn: () => {} } })
  const make = (text: string, chatType = 'PRIVATE', from: object = { id: 'u7', display_name: 'Ann' }) => ({
    event_name: 'message.text.received',
    message: { message_id: 'm1', date: 1_700_000_000_000, chat: { id: 'c1', chat_type: chatType }, from, text },
  }) as never

  it('drops bots and the bot itself', () => {
    expect(toInbound(make('hi', 'PRIVATE', { id: 'bot1' }), deps())).toBeUndefined()
    expect(toInbound(make('hi', 'PRIVATE', { id: 'x', is_bot: true }), deps())).toBeUndefined()
  })

  it('keys the chat and addresses a group message by mention or prefix', () => {
    expect(toInbound(make('hi'), deps())).toMatchObject({ chatKey: 'zalo:c1', messageId: 'm1', sender: { id: 'u7', name: 'Ann' }, isGroup: false, addressed: true, at: 1_700_000_000_000 })
    expect(toInbound(make('hi', 'GROUP'), deps())!.addressed).toBe(false)
    expect(toInbound(make('@Dsh Bot /reset', 'GROUP'), deps())).toMatchObject({ addressed: true, text: '/reset' })
    expect(toInbound(make('/ask what', 'GROUP'), deps())).toMatchObject({ addressed: true, text: 'what' })
  })

  it('loads only the log line in log mode', async () => {
    expect(await toInbound(make('hi', 'GROUP'), deps())!.load('log')).toMatchObject({ logEntry: { message_id: 'm1', text: 'hi' }, text: '', images: [] })
  })
})
```

Adjust `chat_type` to the field name `isGroupChat` reads in `src/zalo-api.ts`.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter dsh-zalo exec vitest run tests/channel.spec.ts tests/inbound.spec.ts`
Expected: FAIL, `../src/channel.ts` missing and `toInbound` not exported.

- [ ] **Step 4: Implement `src/channel.ts`**

Move `startTyping`, `isRejection`, `sendPart` from `src/turn.ts` unchanged; replace `notice` and `deliver`:

```ts
import type { ChatChannel, TurnReport, TurnSink } from 'dsh-chat'
import type { Config } from './config.ts'
import { splitMessage } from './render.ts'
import { ZaloApiError, type ZaloApi } from './zalo-api.ts'

export interface ZaloChannelDeps {
  api: ZaloApi
  bot: { id: string; accountName: string }
  config: Pick<Config, 'messageSize' | 'typingIntervalMs'>
  log: { warn(msg: string): void; error(msg: string): void }
}

export type TurnOutcome = 'sent' | 'undelivered' | 'error' | 'timeout' | 'stopped' | 'empty'

// export function startTyping(...) ... (moved unchanged)
// const isRejection = ... (moved unchanged)
// async function sendPart(api, chatId, part, log) ... (moved unchanged; `log` typed as ZaloChannelDeps['log'])

async function notice(deps: ZaloChannelDeps, chatId: string, text: string): Promise<string | undefined> {
  try {
    return (await deps.api.sendMessage(chatId, text)).messageId
  } catch (error) {
    deps.log.error(`dsh-zalo: notice failed in chat ${chatId} (${String(error)})`)
    return undefined
  }
}

const withId = (outcome: TurnOutcome, id: string | undefined) => ({ outcome, ...(id === undefined ? {} : { messageId: id }) })

async function deliver(deps: ZaloChannelDeps, chatId: string, report: TurnReport): Promise<{ outcome: TurnOutcome; messageId?: string }> {
  if (report.kind === 'timeout') return withId('timeout', await notice(deps, chatId, `The reply timed out after ${Math.round(report.timeoutMs / 1000)}s and was stopped.`))
  if (report.kind === 'error') return withId('error', await notice(deps, chatId, `Error: ${report.error}`))
  if (report.kind === 'stopped') return withId('stopped', await notice(deps, chatId, 'Stopped.'))
  if (report.kind === 'empty') return withId('empty', await notice(deps, chatId, '(no reply)'))
  let lastId: string | undefined
  for (const part of splitMessage(report.text, deps.config.messageSize)) {
    const id = await sendPart(deps.api, chatId, part, deps.log)
    if (id === undefined) return withId('undelivered', lastId)
    lastId = id
  }
  return withId('sent', lastId)
}

export function createZaloChannel(deps: ZaloChannelDeps): ChatChannel {
  return {
    id: 'zalo',
    bot: { id: deps.bot.id, name: deps.bot.accountName },
    async openTurn(chatId): Promise<TurnSink> {
      // Zalo cannot quote a message, so the origin is not used.
      const stopTyping = startTyping(deps.api, chatId, deps.config.typingIntervalMs, deps.log)
      return {
        status: () => {},
        deliver: (report) => {
          stopTyping()
          return deliver(deps, chatId, report)
        },
        close: stopTyping,
      }
    },
    async send(chatId, text, opts = {}) {
      const sent = await deps.api.sendMessage(chatId, text)
      return { as: opts.replyTo === undefined ? 'native' : 'fallback', messageId: sent.messageId, text }
    },
    // Zalo has no reactions; stickers come with Plan B, until then the emoji is posted as text.
    async react(chatId, _messageId, emoji) {
      const sent = await deps.api.sendMessage(chatId, emoji)
      return { as: 'fallback', messageId: sent.messageId, text: emoji }
    },
  }
}
```

Keep `ZaloApiError` imported only if `isRejection` uses it (it does).

- [ ] **Step 5: Implement `toInbound` in `src/inbound.ts`**

```ts
import { chatKey, type InboundMessage } from 'dsh-chat'

export type ToInboundDeps = TriggerOptions & {
  api: ZaloApi
  botId: string
  inboxFor(chatId: string): string
  log: { warn(msg: string): void }
}

/** Normalizes one Zalo update for the chat core; undefined for bots and the bot itself. */
export function toInbound(update: ZaloUpdate, deps: ToInboundDeps): InboundMessage | undefined {
  const { message } = update
  const sender = message.from
  if (sender === undefined || sender.is_bot === true || sender.id === deps.botId) return undefined
  const isGroup = isGroupChat(message.chat)
  const body = bodyText(message)
  return {
    chatKey: chatKey('zalo', message.chat.id),
    messageId: message.message_id,
    sender: { id: sender.id, name: sender.display_name ?? '' },
    isGroup,
    addressed: !isGroup || hasTrigger(body, deps),
    text: stripTrigger(body, deps),
    at: message.date,
    async load(mode) {
      if (mode === 'log') return { logEntry: logEntryFor(update), text: '', images: [] }
      const parsed = await parseInbound(update, { ...deps, inboxDir: deps.inboxFor(message.chat.id) })
      return { logEntry: parsed.logEntry, text: parsed.text, images: parsed.images }
    },
  }
}
```

- [ ] **Step 6: Slim the config**

In `src/config.ts` remove `allowFrom`, `recentMessagesLimit`, `turnTimeoutMs`, `superAdmins` from `Config` and the Schemastery object, and delete `assertConfig`. Update `tests/config.spec.ts` the same way as Task 5 Step 6.

- [ ] **Step 7: Rewrite `src/index.ts`**

Keep `retryStart`, `loggerFor`, `STARTUP_BACKOFF`. Replace the rest:

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import { chatKey } from 'dsh-chat'
import type {} from 'dsh-chat/sessions'
import { createZaloChannel } from './channel.ts'
import { Config } from './config.ts'
import { toInbound } from './inbound.ts'
import { startPolling, type Poller } from './poller.ts'
import { createZaloApi } from './zalo-api.ts'

export { Config } from './config.ts'
export type { Config as ZaloConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-zalo'
/** The router and stores come from the dsh-chat plugins. */
export const inject = ['loader', 'chatAgents', 'chat']

interface Started { poller: Poller; unregister: () => void }

async function start(ctx: Context, config: Config): Promise<Started> {
  const log = loggerFor(ctx)
  // Wait for the complete application so agent-scoped tools and adapters are composed.
  await ctx.get('loader')?.await()
  const api = createZaloApi(config.botToken, config.retry, fetch, config.maxDownloadMb * 1024 * 1024)
  const me = await api.getMe()
  // Registered before polling starts, so the first update never finds the channel offline.
  const unregister = ctx.chat.register(createZaloChannel({ api, bot: me, config, log }))
  const trigger = { accountName: me.accountName, ...(me.displayName === undefined ? {} : { displayName: me.displayName }), groupPrefix: config.groupPrefix }
  const poller = startPolling({
    api,
    timeoutSec: config.pollTimeoutSec,
    onUpdate: (update) => {
      const inbound = toInbound(update, {
        ...trigger, api, botId: me.id, log,
        inboxFor: chatId => join(ctx.chatAgents.workspaceFor(chatKey('zalo', chatId)), 'inbox'),
      })
      if (inbound !== undefined) ctx.chat.inbound(inbound)
    },
    backoff: { startDelayMs: config.retry.startDelayMs, maxDelayMs: config.retry.maxDelayMs },
    log,
  })
  log.info(`dsh-zalo: polling as ${me.accountName}`)
  return { poller, unregister }
}

export function apply(ctx: Context, config: Config): void {
  const log = loggerFor(ctx)
  let started: Started | undefined
  let stopped = false
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        result.unregister()
        void result.poller.stop()
        return
      }
      started = result
    }, (error, delayMs) => {
      log.error(`dsh-zalo: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}; retrying in ${delayMs}ms`)
    }, STARTUP_BACKOFF)
    return () => {
      stopped = true
      cancel()
      if (started === undefined) return
      const { poller, unregister } = started
      started = undefined
      // Queued messages must not start turns on a bot that is going away.
      unregister()
      return poller.stop()
    }
  }, 'dsh-zalo: bot runner')
}
```

- [ ] **Step 8: Delete the old modules**

Delete `src/bot.ts`, `src/turn.ts`, `src/service.ts`, `tests/bot.spec.ts`, `tests/turn.spec.ts`. Run `pnpm --filter dsh-zalo run typecheck` and fix any remaining import of them (`ImageMediaType` stays in `src/media.ts`; `InboundImage` in `src/inbound.ts` stays as is).

- [ ] **Step 9: Run the Zalo suite**

Run: `pnpm --filter dsh-zalo exec vitest run` and `pnpm --filter dsh-zalo run typecheck`
Expected: all PASS except `tests/profile.spec.ts` cases about the zalo row's `allowFrom`/`superAdmins`, which Task 7 updates.

- [ ] **Step 10: Commit**

```bash
git add -A packages/dsh-zalo
git commit -m "refactor(zalo): run on the dsh-chat router as a ChatChannel"
```

---

### Task 7: Patches, profiles and the full suite

**Files:**
- Modify: `packages/dsh-telegram/cordis.patch.yml`, `packages/dsh-zalo/cordis.patch.yml`
- Modify: `profile/telegram/cordis.patch.yml`, `profile/zalo/cordis.patch.yml`
- Test: `packages/dsh-telegram/tests/profile.spec.ts`, `packages/dsh-zalo/tests/profile.spec.ts`

**Interfaces:**
- Consumes: router `Config` keys `allowFrom`, `superAdmins` (Task 4).
- Produces: a `chat` row (`name: dsh-chat`) in each bundle patch, inserted after `chat-history` and before the adapter row.

- [ ] **Step 1: Write the failing profile tests**

Add to `packages/dsh-telegram/tests/profile.spec.ts` (it already has `rows`, `row`, `evalJs`):

```ts
describe('chat router row', () => {
  it('maps Telegram ids and usernames to user keys', async () => {
    const config = row(await rows('../cordis.patch.yml'), 'chat').config!
    expect(evalJs(config.allowFrom, { TELEGRAM_ALLOW_FROM: '123, @Ann ,bob,' })).toEqual(['telegram:123', 'telegram:@ann', 'telegram:@bob'])
    expect(evalJs(config.superAdmins, { TELEGRAM_SUPER_ADMINS: '7, x, -3' })).toEqual(['telegram:7'])
    expect(evalJs(config.allowFrom, {})).toEqual([])
  })

  it('mounts the router before the bot and keeps the allowlist off the telegram row', async () => {
    const bundle = await rows('../cordis.patch.yml')
    const ids = bundle.flatMap(r => r.insert ?? []).map(r => r.id)
    expect(ids.indexOf('chat')).toBeLessThan(ids.indexOf('telegram'))
    expect(row(bundle, 'chat').name).toBe('dsh-chat')
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const telegram = row(await rows(path), 'telegram').config!
      expect(telegram).not.toHaveProperty('allowFrom')
      expect(telegram).not.toHaveProperty('superAdmins')
    }
  })
})
```

Add the Zalo counterpart to `packages/dsh-zalo/tests/profile.spec.ts` (copy its `rows`/`row`/`evalJs` helpers from the Telegram spec if it lacks them):

```ts
describe('chat router row', () => {
  it('maps Zalo ids to user keys', async () => {
    const config = row(await rows('../cordis.patch.yml'), 'chat').config!
    expect(evalJs(config.allowFrom, { ZALO_ALLOW_FROM: 'a1, b2,' })).toEqual(['zalo:a1', 'zalo:b2'])
    expect(evalJs(config.superAdmins, { ZALO_SUPER_ADMINS: 'a1' })).toEqual(['zalo:a1'])
  })

  it('mounts the router before the bot and keeps the allowlist off the zalo row', async () => {
    const bundle = await rows('../cordis.patch.yml')
    const ids = bundle.flatMap(r => r.insert ?? []).map(r => r.id)
    expect(ids.indexOf('chat')).toBeLessThan(ids.indexOf('zalo'))
    for (const path of ['../../../profile/zalo/cordis.patch.yml', '../cordis.patch.yml']) {
      const zalo = row(await rows(path), 'zalo').config!
      expect(zalo).not.toHaveProperty('allowFrom')
      expect(zalo).not.toHaveProperty('superAdmins')
    }
  })
})
```

Remove any existing profile-spec assertion that expects `allowFrom` or `superAdmins` on the adapter rows.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter dsh-telegram exec vitest run tests/profile.spec.ts` and `pnpm --filter dsh-zalo exec vitest run tests/profile.spec.ts`
Expected: FAIL, no `chat` row.

- [ ] **Step 3: Edit the patches**

In `packages/dsh-telegram/cordis.patch.yml`, insert after the `chat-history` row:

```yaml
    - id: chat
      name: dsh-chat
      config:
        allowFrom: !!js (process.env.TELEGRAM_ALLOW_FROM ?? '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean).map(s => /^\d+$/.test(s) ? 'telegram:' + s : 'telegram:@' + s.toLowerCase())
        superAdmins: !!js (process.env.TELEGRAM_SUPER_ADMINS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0).map(n => 'telegram:' + n)
```

and remove `allowFrom` and `superAdmins` from its `telegram` row (keep `botToken`).

In `packages/dsh-zalo/cordis.patch.yml`, insert after the `chat-history` row:

```yaml
    - id: chat
      name: dsh-chat
      config:
        allowFrom: !!js (process.env.ZALO_ALLOW_FROM ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => 'zalo:' + s)
        superAdmins: !!js (process.env.ZALO_SUPER_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => 'zalo:' + s)
```

and remove `allowFrom` and `superAdmins` from its `zalo` row.

In `profile/telegram/cordis.patch.yml` and `profile/zalo/cordis.patch.yml`, remove the `allowFrom` and `superAdmins` lines from the restated `telegram` / `zalo` rows. The profiles do not restate the `chat` row, so the bundle's env mapping applies.

- [ ] **Step 4: Run the profile tests**

Run the two commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Run the whole workspace**

Run: `pnpm typecheck` then `pnpm test` (repo root)
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-telegram/cordis.patch.yml packages/dsh-zalo/cordis.patch.yml profile packages/dsh-telegram/tests/profile.spec.ts packages/dsh-zalo/tests/profile.spec.ts
git commit -m "build(chat): mount the dsh-chat router in both bundles and move the allowlists to it"
```
