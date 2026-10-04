# Event-Driven Idle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Idle engagement evaluates each new group message (hot = enough messages from two or more speakers in a short window) instead of a 10-minute tick, with per-burst slots.

**Architecture:** `ChatLog` gains an `onAppend` listener that the core wires to a new `telegram/message` event. The idle plugin keeps an in-memory window per allowlisted chat (`src/idle/burst.ts`, pure), seeded once from the chat log, and an event-driven scheduler (`src/idle/scheduler.ts`) that evaluates human messages, rolls `chance` once per burst slot and runs the existing LLM decision. `src/idle/engage.ts` keeps only the LLM side.

**Tech Stack:** TypeScript (strict, `nodenext`), `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/schemastery`, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-04-telegram-idle-events-design.md`

## Global Constraints

- All commands run from `packages/dsh-telegram` (`pnpm test`, `pnpm run typecheck`, `pnpm run build`).
- Relative imports use `.ts`; type-only imports use `import type`; `exactOptionalPropertyTypes` is on (spread optional fields in, never assign `undefined` to an optional property).
- English only in the repo; no emoji literals (escapes like `'\u{1F525}'`).
- Idle prompt, output validation, delivery, `maxPerDay`, quiet hours and `telegram/turn` behave as today.
- The minimum number of speakers is the constant `2`, not a config field.
- Test times are fixed: `NOW = Date.parse('2026-10-04T05:00:00Z')` is 12:00 in `Asia/Ho_Chi_Minh`; `NIGHT = Date.parse('2026-10-03T17:30:00Z')` is 00:30 there.

## Review Focus

- A burst that keeps going after the bot's slot is spent must not re-trigger: further messages log one `burst_spent` and enqueue nothing. Pinned in Task 3 (`does not repeat a check while the verdict stays the same`).
- The bot addressed while an idle task waits in the queue: the task cancels. Pinned in Task 3.
- Messages arriving while the window is still being seeded at start must not crash or double-count; evaluation starts only after seeding. Pinned in Task 3 (`seeds the window before evaluating`).
- `maxPerBurst: 2` allows a second engagement only after `idleMinutes` of bot silence within the same burst. Pinned in Task 2.
- A listener exception must never break a chat-log write. Covered by Cordis (`emit` isolates listeners) and the scheduler's own try/catch; pinned in Task 3 (`a corrupted chat log in one chat leaves the others working`).

---

### Task 1: Core: `telegram/message` from `ChatLog.onAppend`

**Files:**
- Modify: `packages/dsh-telegram/src/chatlog.ts:35-46` (constructor, `append`)
- Modify: `packages/dsh-telegram/src/service.ts` (event type)
- Modify: `packages/dsh-telegram/src/index.ts` (wire the listener)
- Test: `packages/dsh-telegram/tests/chatlog.spec.ts`

**Interfaces:**
- Produces: `new ChatLog(dir: string, onAppend?: (chatId: number, entry: ChatLogEntry) => void)`; Cordis event `'telegram/message'(chatId: number, entry: ChatLogEntry): void`.

- [ ] **Step 1: Write the failing test**

In `tests/chatlog.spec.ts`, change the first import to `import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'` and add inside `describe('ChatLog', ...)`:

```ts
  it('calls onAppend after a write, and not after a failed one', async () => {
    const seen: Array<[number, string]> = []
    const log = new ChatLog(dir, (chatId, e) => seen.push([chatId, e.text]))
    await log.append(5, entry(1, 'hi'))
    expect(seen).toEqual([[5, 'hi']])
    await writeFile(join(dir, 'blocker'), 'x')
    const broken = new ChatLog(join(dir, 'blocker', 'log'), () => seen.push([0, 'never']))
    await expect(broken.append(5, entry(2, 'lost'))).rejects.toThrow()
    expect(seen).toEqual([[5, 'hi']])
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/chatlog.spec.ts`
Expected: FAIL: `expected [] to deeply equal [ [ 5, 'hi' ] ]`.

- [ ] **Step 3: Implement**

`src/chatlog.ts`, replace the constructor and `append`:

```ts
/** Append-only per-chat JSONL log under `dir`; `onAppend` hears every line once it is written. */
export class ChatLog {
  constructor(private readonly dir: string, private readonly onAppend?: (chatId: number, entry: ChatLogEntry) => void) {}

  private file(chatId: number): string {
    return join(this.dir, `${chatId}.jsonl`)
  }

  async append(chatId: number, entry: ChatLogEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.file(chatId), `${JSON.stringify(entry)}\n`, 'utf8')
    this.onAppend?.(chatId, entry)
  }
```

(Delete the old `/** Append-only per-chat JSONL log under \`dir\`. */` comment line it replaces.)

`src/service.ts`: add `import type { ChatLog, ChatLogEntry } from './chatlog.ts'` (replacing the `ChatLog`-only import), and in `interface Events` after `'telegram/turn'`:

```ts
    /** A line was appended to a chat's log (human or bot), after it was written. */
    'telegram/message'(chatId: number, entry: ChatLogEntry): void
```

`src/index.ts`, in `start()`, replace `const chatLog = new ChatLog(join(config.dataDir, 'chatlog'))` with:

```ts
  const chatLog = new ChatLog(join(config.dataDir, 'chatlog'), (chatId, entry) => ctx.emit('telegram/message', chatId, entry))
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/chatlog.ts packages/dsh-telegram/src/service.ts packages/dsh-telegram/src/index.ts packages/dsh-telegram/tests/chatlog.spec.ts
git commit -m "feat(telegram): emit telegram/message for every chat-log line"
```

---

### Task 2: Pure burst evaluation (`src/idle/burst.ts`) and new config fields

**Files:**
- Create: `packages/dsh-telegram/src/idle/burst.ts`
- Modify: `packages/dsh-telegram/src/idle/index.ts` (`IdleConfig`, `DEFAULT_IDLE`, `Config`: add three fields; `checkIntervalMinutes` stays until Task 3)
- Test: `packages/dsh-telegram/tests/idle/burst.spec.ts`

**Interfaces:**
- Consumes: `ChatLogEntry`; `IdleConfig` with the new fields.
- Produces (from `src/idle/burst.ts`):
  ```ts
  export type CheckVerdict = 'go' | 'busy' | 'not_hot' | 'one_speaker' | 'not_idle' | 'burst_spent' | 'nothing_pickable' | 'daily_cap' | 'quiet_hours' | 'chance_miss'
  export interface ChatIdleState { recent: ChatLogEntry[]; burst: { since: number; lastHumanAt: number; slotsUsed: number }; lastEngagedAt: number; lastTurnAt: number; day: string; count: number; reacted: number[]; lastVerdict: CheckVerdict | undefined }
  export interface Evaluation { verdict: CheckVerdict; fresh: number; speakers: number; pickable: ReadonlySet<number> }
  export function emptyChatState(): ChatIdleState
  export function observe(state: ChatIdleState, entry: ChatLogEntry, config: IdleConfig): void
  export function evaluate(state: ChatIdleState, now: number, config: IdleConfig, random: () => number, roll?: boolean): Evaluation
  export function dayKey(now: number, timezone: string): string
  export function hourIn(now: number, timezone: string): number
  export function answeredIds(entries: readonly ChatLogEntry[]): Set<number>
  ```
- `IdleConfig` gains `hotWindowMinutes: number` (default 5), `burstGapMinutes: number` (default 15), `maxPerBurst: number` (default 1).

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-telegram/tests/idle/burst.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChatLogEntry } from '../../src/chatlog.ts'
import { answeredIds, dayKey, emptyChatState, evaluate, hourIn, observe, type ChatIdleState } from '../../src/idle/burst.ts'
import { Config, type IdleConfig } from '../../src/idle/index.ts'

/** 12:00 in Asia/Ho_Chi_Minh. */
const NOW = Date.parse('2026-10-04T05:00:00Z')
/** 00:30 in Asia/Ho_Chi_Minh, inside the default quiet hours. */
const NIGHT = Date.parse('2026-10-03T17:30:00Z')
const MIN = 60_000
const base: IdleConfig = Config({ enabled: true, chatIds: [-5], idleMinutes: 10, minNewMessages: 5, chance: 0.5 })

function human(id: number, minutesAgo: number, user = 7, now = NOW): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: user, username: `u${user}`, name: `U${user}`, text: `m${id}` }
}
function bot(id: number, minutesAgo: number, replyTo?: number, now = NOW): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: 1, name: 'dshbot', text: `b${id}`, bot: true, ...(replyTo === undefined ? {} : { reply_to: replyTo }) }
}
/** Five messages in the last four minutes from two speakers. */
const hot = (now = NOW) => [human(1, 4, 7, now), human(2, 3, 8, now), human(3, 2, 7, now), human(4, 1, 8, now), human(5, 0.5, 7, now)]
function stateWith(entries: ChatLogEntry[], config = base): ChatIdleState {
  const state = emptyChatState()
  for (const entry of entries) observe(state, entry, config)
  return state
}
const hit = () => 0.1

describe('evaluate', () => {
  it('goes when a burst is hot, using one slot', () => {
    const state = stateWith(hot())
    const result = evaluate(state, NOW, base, hit)
    expect(result).toMatchObject({ verdict: 'go', fresh: 5, speakers: 2 })
    expect([...result.pickable]).toEqual([1, 2, 3, 4, 5])
    expect(state.burst.slotsUsed).toBe(1)
  })

  it('names the first condition that blocks', () => {
    expect(evaluate(stateWith(hot().slice(0, 4)), NOW, base, hit).verdict).toBe('not_hot')
    expect(evaluate(stateWith(hot().map(e => ({ ...e, user_id: 7 }))), NOW, base, hit).verdict).toBe('one_speaker')
    expect(evaluate(stateWith([...hot(), bot(9, 3)]), NOW, base, hit).verdict).toBe('not_idle')
    const turned = stateWith(hot())
    turned.lastTurnAt = NOW - MIN
    expect(evaluate(turned, NOW, base, hit).verdict).toBe('not_idle')
    expect(evaluate(stateWith(hot().map(e => ({ ...e, handled: true as const }))), NOW, base, hit).verdict).toBe('nothing_pickable')
    const capped = stateWith(hot())
    capped.day = dayKey(NOW, base.timezone)
    capped.count = base.maxPerDay
    expect(evaluate(capped, NOW, base, hit).verdict).toBe('daily_cap')
    expect(evaluate(stateWith(hot(NIGHT)), NIGHT, base, hit).verdict).toBe('quiet_hours')
  })

  it('rolls chance once per slot: a miss spends the slot', () => {
    const state = stateWith(hot())
    expect(evaluate(state, NOW, base, () => 0.9).verdict).toBe('chance_miss')
    expect(evaluate(state, NOW, base, hit).verdict).toBe('burst_spent')
  })

  it('the in-queue re-check neither rolls nor needs a free slot', () => {
    const state = stateWith(hot())
    evaluate(state, NOW, base, hit)
    expect(evaluate(state, NOW, base, () => 0.99, false).verdict).toBe('go')
    expect(state.burst.slotsUsed).toBe(1)
  })

  it('allows a second slot with maxPerBurst 2 once the bot has been idle for idleMinutes', () => {
    const config = { ...base, maxPerBurst: 2 }
    const state = stateWith(hot(), config)
    expect(evaluate(state, NOW, config, hit).verdict).toBe('go')
    const later = NOW + 11 * MIN
    // The burst continues: the gap from the last message stays under burstGapMinutes.
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) observe(state, human(20 + i, m, i % 2 === 0 ? 7 : 8, later), config)
    expect(state.burst.slotsUsed).toBe(1)
    state.lastEngagedAt = NOW + 2 * MIN
    expect(evaluate(state, later, config, hit).verdict).toBe('not_idle')
    state.lastEngagedAt = NOW
    expect(evaluate(state, later, config, hit).verdict).toBe('go')
    expect(evaluate(state, later, config, hit).verdict).toBe('burst_spent')
  })
})

describe('observe', () => {
  it('starts a new burst after burstGapMinutes of silence, resetting slots and the last verdict', () => {
    const state = stateWith(hot())
    evaluate(state, NOW, base, hit)
    state.lastVerdict = 'burst_spent'
    const next = human(30, -16, 8)
    observe(state, next, base)
    expect(state.burst).toEqual({ since: Date.parse(next.ts), lastHumanAt: Date.parse(next.ts), slotsUsed: 0 })
    expect(state.lastVerdict).toBeUndefined()
  })

  it('bot lines join the window but never start or extend a burst', () => {
    const state = stateWith(hot())
    const { burst } = state
    observe(state, bot(40, -1), base)
    expect(state.burst).toEqual(burst)
    expect(state.recent.at(-1)!.message_id).toBe(40)
  })

  it('keeps the retention window but never fewer than contextMessages entries', () => {
    const spread = Array.from({ length: 30 }, (_, i) => human(100 + i, (30 - i) * 60))
    expect(stateWith(spread).recent).toHaveLength(base.contextMessages)
    const dense = Array.from({ length: 25 }, (_, i) => human(200 + i, 1 - i / 100))
    expect(stateWith(dense).recent).toHaveLength(25)
  })
})

describe('helpers', () => {
  it('computes the local day and hour in the configured timezone', () => {
    expect(dayKey(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-10-02')
    expect(hourIn(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe(0)
  })
  it('collects the messages the bot answered or handled', () => {
    expect(answeredIds([human(2, 10), bot(3, 5, 2), bot(4, 4), { ...human(5, 3), handled: true }])).toEqual(new Set([2, 5]))
  })
  it('never offers a message answered or already reacted to', () => {
    const state = stateWith([human(2, 4, 7), bot(3, 3.5, 2), human(4, 3, 8), human(5, 2, 7), human(6, 1, 8), human(7, 0.5, 7)])
    state.lastEngagedAt = 0
    state.reacted = [5]
    expect([...evaluate(state, NOW, { ...base, idleMinutes: 1 }, hit, false).pickable]).toEqual([4, 6, 7])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/idle/burst.spec.ts`
Expected: FAIL, cannot resolve `../../src/idle/burst.ts`.

- [ ] **Step 3: Add the config fields**

In `src/idle/index.ts`:
- `IdleConfig`: after `readonly chance: number` add
  ```ts
  /** Window for a hot burst and for messages the bot may pick. */
  readonly hotWindowMinutes: number
  /** Human silence longer than this ends a burst. */
  readonly burstGapMinutes: number
  /** Engagements allowed per burst; each slot rolls `chance` once. */
  readonly maxPerBurst: number
  ```
- `DEFAULT_IDLE`: after `chance: 0.3,` add `hotWindowMinutes: 5,`, `burstGapMinutes: 15,`, `maxPerBurst: 1,`.
- `Config`: after the `chance` line add
  ```ts
  hotWindowMinutes: z.number().min(1).default(DEFAULT_IDLE.hotWindowMinutes),
  burstGapMinutes: z.number().min(1).default(DEFAULT_IDLE.burstGapMinutes),
  maxPerBurst: z.number().min(1).default(DEFAULT_IDLE.maxPerBurst),
  ```

In `tests/idle/plugin.spec.ts`, the `'fills idle defaults with idle disabled'` expectation gains `hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1,` (keep `checkIntervalMinutes: 10` for now).

- [ ] **Step 4: Implement `src/idle/burst.ts`**

```ts
import type { ChatLogEntry } from '../chatlog.ts'
import type { IdleConfig } from './index.ts'

const MINUTE_MS = 60_000
/** A conversation needs at least two people; one person talking to themselves is not hot. */
const MIN_SPEAKERS = 2

export type CheckVerdict = 'go' | 'busy' | 'not_hot' | 'one_speaker' | 'not_idle' | 'burst_spent' | 'nothing_pickable' | 'daily_cap' | 'quiet_hours' | 'chance_miss'

/** Per-chat idle state fed by chat-log lines; times are epoch milliseconds, `day` is the local `dayKey`. */
export interface ChatIdleState {
  /** Recent lines, oldest first: the retention window, never fewer than the newest `contextMessages`. */
  recent: ChatLogEntry[]
  burst: { since: number; lastHumanAt: number; slotsUsed: number }
  lastEngagedAt: number
  lastTurnAt: number
  day: string
  count: number
  /** Newest messages idle reacted to: reactions are not logged, and a second one would replace the first. */
  reacted: number[]
  /** Last check verdict recorded in this burst, so repeats are not logged again. */
  lastVerdict: CheckVerdict | undefined
}

export interface Evaluation { verdict: CheckVerdict; fresh: number; speakers: number; pickable: ReadonlySet<number> }

export function emptyChatState(): ChatIdleState {
  return { recent: [], burst: { since: 0, lastHumanAt: 0, slotsUsed: 0 }, lastEngagedAt: 0, lastTurnAt: 0, day: '', count: 0, reacted: [], lastVerdict: undefined }
}

export function dayKey(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function hourIn(now: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now))
}

function inQuietHours(hour: number, quiet: IdleConfig['quietHours']): boolean {
  if (quiet.from === quiet.to) return false
  return quiet.from < quiet.to ? hour >= quiet.from && hour < quiet.to : hour >= quiet.from || hour < quiet.to
}

/** Messages that got a turn or a bot reply; the bot's ACK reaction sits on them. */
export function answeredIds(entries: readonly ChatLogEntry[]): Set<number> {
  return new Set(entries.flatMap((e) => {
    if (e.handled === true) return [e.message_id]
    return e.bot === true && e.reply_to !== undefined ? [e.reply_to] : []
  }))
}

const timeOf = (entry: ChatLogEntry) => Date.parse(entry.ts)

/** Adds a line to the window; a human line after more than `burstGapMinutes` of silence starts a new burst. */
export function observe(state: ChatIdleState, entry: ChatLogEntry, config: IdleConfig): void {
  const at = timeOf(entry)
  state.recent.push(entry)
  const cutoff = at - Math.max(config.hotWindowMinutes, config.burstGapMinutes, config.idleMinutes) * MINUTE_MS
  const firstKept = state.recent.findIndex(e => timeOf(e) >= cutoff)
  const stale = firstKept < 0 ? state.recent.length : firstKept
  const drop = Math.min(stale, Math.max(0, state.recent.length - config.contextMessages))
  if (drop > 0) state.recent.splice(0, drop)
  if (entry.bot === true) return
  if (at - state.burst.lastHumanAt > config.burstGapMinutes * MINUTE_MS) {
    state.burst = { since: at, lastHumanAt: at, slotsUsed: 0 }
    state.lastVerdict = undefined
  } else {
    state.burst.lastHumanAt = at
  }
}

function lastBotActivity(state: ChatIdleState): number {
  const lastBot = state.recent.findLast(e => e.bot === true)
  return Math.max(lastBot === undefined ? 0 : timeOf(lastBot), state.lastEngagedAt, state.lastTurnAt)
}

/**
 * The first condition that blocks, else a chance roll that uses the burst's next slot (so this mutates `state`).
 * With `roll` false (the in-queue re-check) it neither needs a free slot nor rolls.
 */
export function evaluate(state: ChatIdleState, now: number, config: IdleConfig, random: () => number, roll = true): Evaluation {
  const after = now - config.hotWindowMinutes * MINUTE_MS
  const window = state.recent.filter(e => e.bot !== true && timeOf(e) > after)
  const taken = new Set([...answeredIds(state.recent), ...state.reacted])
  const pickable = new Set(window.filter(e => !taken.has(e.message_id)).map(e => e.message_id))
  const fresh = window.length
  const speakers = new Set(window.map(e => e.user_id)).size
  const result = (verdict: CheckVerdict): Evaluation => ({ verdict, fresh, speakers, pickable })
  if (fresh < config.minNewMessages) return result('not_hot')
  if (speakers < MIN_SPEAKERS) return result('one_speaker')
  if (now - lastBotActivity(state) <= config.idleMinutes * MINUTE_MS) return result('not_idle')
  if (roll && state.burst.slotsUsed >= config.maxPerBurst) return result('burst_spent')
  if (pickable.size === 0) return result('nothing_pickable')
  const today = state.day === dayKey(now, config.timezone) ? state.count : 0
  if (today >= config.maxPerDay) return result('daily_cap')
  if (inQuietHours(hourIn(now, config.timezone), config.quietHours)) return result('quiet_hours')
  if (!roll) return result('go')
  state.burst.slotsUsed++
  return result(random() < config.chance ? 'go' : 'chance_miss')
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run tests/idle && pnpm run typecheck`
Expected: PASS (burst.spec 11 tests plus the existing idle tests), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-telegram/src/idle/burst.ts packages/dsh-telegram/src/idle/index.ts packages/dsh-telegram/tests/idle/burst.spec.ts packages/dsh-telegram/tests/idle/plugin.spec.ts
git commit -m "feat(telegram): pure burst evaluation for idle engagement"
```

---

### Task 3: Event-driven scheduler wired into the plugin

**Files:**
- Create: `packages/dsh-telegram/src/idle/scheduler.ts`
- Modify: `packages/dsh-telegram/src/idle/engage.ts` (keep only the LLM side)
- Modify: `packages/dsh-telegram/src/idle/index.ts` (drop `checkIntervalMinutes`, wire `telegram/message`, import from `./scheduler.ts`)
- Modify: `docs/superpowers/specs/2026-10-04-telegram-idle-events-design.md` (record the ruling on rolled verdicts)
- Test: create `packages/dsh-telegram/tests/idle/scheduler.spec.ts`; modify `tests/idle/engage.spec.ts`, `tests/idle/plugin.spec.ts`, `tests/profile.spec.ts`

**Interfaces:**
- Consumes: Task 1 `ChatLog` listener and `telegram/message`; Task 2 `burst.ts` exports.
- Produces (from `src/idle/scheduler.ts`):
  ```ts
  export type IdleEvent = { ts: string } & (
    | { event: 'start'; chatIds: number[]; config: Omit<IdleConfig, 'persona' | 'chatIds'> }
    | { event: 'check'; chatId: number; verdict: CheckVerdict; fresh?: number; speakers?: number; pickable?: number; burstSince?: string; slotsUsed?: number }
    | { event: 'decision'; chatId: number; action: IdleAction['kind'] | 'cancelled' | 'error'; messageId?: number; emoji?: string; text?: string; error?: string }
  )
  export interface IdleQueue { enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }
  export interface IdleDeps { config; provider; model; llm: IdleLlm; api; chatLog; queue: IdleQueue; botId; botUsername; log; now?; random?; record? }
  export interface IdleHandle { observe(chatId: number, entry: ChatLogEntry): void; noteTurn(chatId: number): void; ready: Promise<void>; stop(): void }
  export function startIdle(deps: IdleDeps): IdleHandle
  ```
- `src/idle/engage.ts` keeps: `IDLE_EMOJI`, `IdleAction`, `IdleLlm`, `DecideOptions`, `idleSystemPrompt`, `idleTranscript`, `parseDecision`, `decide`.

- [ ] **Step 1: Write the failing scheduler test**

Create `packages/dsh-telegram/tests/idle/scheduler.spec.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog, type ChatLogEntry } from '../../src/chatlog.ts'
import { Config } from '../../src/idle/index.ts'
import { startIdle, type IdleDeps, type IdleEvent, type IdleHandle } from '../../src/idle/scheduler.ts'
import { FakeTelegramApi } from '../helpers/fake-api.ts'

const NOW = Date.parse('2026-10-04T05:00:00Z')
const MIN = 60_000
const CHAT = -5
const base = Config({ enabled: true, chatIds: [CHAT], idleMinutes: 10, minNewMessages: 5, chance: 1 })

function human(id: number, minutesAgo: number, user = id % 2 === 0 ? 8 : 7): ChatLogEntry {
  return { ts: new Date(NOW - minutesAgo * MIN).toISOString(), message_id: id, user_id: user, username: `u${user}`, name: `U${user}`, text: `m${id}` }
}
function fakeLlm(answer: string) {
  const calls: GenerateOptions[] = []
  const llm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } } as never
    },
  }
  return { llm, calls }
}

let dir: string
let api: FakeTelegramApi
let chatLog: ChatLog
let tasks: Array<{ chatId: number; task: () => Promise<void> }>
let busy: Set<number>
let events: IdleEvent[]
let warns: string[]
let calls: GenerateOptions[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idle-scheduler-'))
  api = new FakeTelegramApi()
  chatLog = new ChatLog(join(dir, 'log'))
  tasks = []
  busy = new Set()
  events = []
  warns = []
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function start(answer = '{"action":"reply","message_id":5,"text":"hehe"}', extra: Partial<IdleDeps> = {}): IdleHandle {
  const fake = fakeLlm(answer)
  calls = fake.calls
  return startIdle({
    config: base, provider: 'p', model: 'm', llm: fake.llm, api, chatLog,
    queue: { enqueue: (chatId, task) => { tasks.push({ chatId, task }) }, isBusy: chatId => busy.has(chatId) },
    botId: 1, botUsername: 'dshbot', log: { info: () => {}, warn: m => warns.push(m) },
    now: () => NOW, random: () => 0, record: e => events.push(e), ...extra,
  })
}
/** Writes a line to the chat log and feeds it to idle, as the core's telegram/message does. */
async function say(idle: IdleHandle, entry: ChatLogEntry, chatId = CHAT): Promise<void> {
  await chatLog.append(chatId, entry)
  idle.observe(chatId, entry)
}
async function runQueued(): Promise<void> {
  while (tasks.length > 0) await tasks.shift()!.task()
}
const checks = () => events.filter(e => e.event === 'check').map(e => (e as { verdict: string }).verdict)
const decisions = () => events.filter(e => e.event === 'decision').map(({ ts: _ts, chatId: _chat, event: _event, ...rest }) => rest)

describe('startIdle', () => {
  it('enqueues as soon as a burst gets hot, with no timer, and replies', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] })
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1].entries()) await say(idle, human(i + 1, m))
    expect(tasks).toHaveLength(0)
    await say(idle, human(5, 0.5))
    expect(tasks.map(t => t.chatId)).toEqual([CHAT])
    expect(vi.getTimerCount()).toBe(0)
    await runQueued()
    idle.stop()
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([CHAT, 'hehe', { replyTo: { messageId: 5 } }])
    expect(checks()).toEqual(['go'])
    expect(decisions()).toEqual([{ action: 'reply', messageId: 5, text: 'hehe' }])
  })

  it('records the start with the burst settings and without the persona', async () => {
    const idle = start()
    idle.stop()
    expect(events[0]).toMatchObject({ event: 'start', chatIds: [CHAT], config: { hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1 } })
    expect(events[0]).not.toHaveProperty('config.persona')
  })

  it('records a busy chat and enqueues nothing', async () => {
    const idle = start()
    await idle.ready
    busy.add(CHAT)
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(tasks).toHaveLength(0)
    expect(checks()).toEqual(['busy'])
  })

  it('does not repeat a check while the verdict stays the same', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5, 0.4, 0.3, 0.2].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(tasks).toHaveLength(1)
    expect(checks()).toEqual(['go', 'burst_spent'])
  })

  it('cancels the queued task when the bot was addressed meanwhile', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.noteTurn(CHAT)
    await runQueued()
    idle.stop()
    expect(calls).toHaveLength(0)
    expect(decisions()).toEqual([{ action: 'cancelled' }])
  })

  it('seeds the window before evaluating', async () => {
    for (const [i, m] of [4, 3, 2, 1].entries()) await chatLog.append(CHAT, human(i + 1, m))
    const idle = start()
    await idle.ready
    await say(idle, human(5, 0.5))
    idle.stop()
    expect(tasks).toHaveLength(1)
  })

  it('records a model error and a failed Telegram call', async () => {
    const broken = { async *stream(): AsyncIterable<StreamChunk> { throw new Error('model down') } }
    const failing = start('', { llm: broken })
    await failing.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(failing, human(i + 1, m))
    await runQueued()
    failing.stop()
    api.failNext('setReaction', new Error('REACTION_INVALID'))
    const rejected = start('{"action":"react","message_id":5,"emoji":"\u{1F525}"}')
    await rejected.ready
    await say(rejected, human(6, 0.4))
    await runQueued()
    rejected.stop()
    expect(decisions()).toEqual([
      { action: 'error', error: 'model down' },
      { action: 'react', messageId: 5, emoji: '\u{1F525}', error: 'REACTION_INVALID' },
    ])
  })

  it('a corrupted chat log in one chat leaves the others working', async () => {
    const OTHER = -6
    await mkdir(join(dir, 'log'), { recursive: true })
    await writeFile(join(dir, 'log', `${OTHER}.jsonl`), '{not json\n', 'utf8')
    const idle = start(undefined, { config: { ...base, chatIds: [OTHER, CHAT] } })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(warns.some(m => m.includes(`chat ${OTHER}`))).toBe(true)
    expect(tasks.map(t => t.chatId)).toEqual([CHAT])
  })

  it('ignores chats outside the allowlist, a disabled config, and tasks after stop', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m), -99)
    expect(tasks).toHaveLength(0)
    const off = start(undefined, { config: { ...base, enabled: false } })
    await off.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(off, human(i + 1, m))
    expect(tasks).toHaveLength(0)
    for (const [i, m] of [0.4, 0.3, 0.2, 0.1, 0.05].entries()) await say(idle, human(i + 10, m))
    idle.stop()
    await runQueued()
    expect(calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/idle/scheduler.spec.ts`
Expected: FAIL, cannot resolve `../../src/idle/scheduler.ts`.

- [ ] **Step 3: Implement `src/idle/scheduler.ts`**

```ts
import type { ChatLog, ChatLogEntry } from '../chatlog.ts'
import type { TelegramApi } from '../telegram-api.ts'
import { dayKey, emptyChatState, evaluate, observe, type ChatIdleState, type CheckVerdict, type Evaluation } from './burst.ts'
import { decide, idleSystemPrompt, type IdleAction, type IdleLlm } from './engage.ts'
import type { IdleConfig } from './index.ts'

/** One line of the decision log, so missed conversations can be explained afterwards. */
export type IdleEvent = { ts: string } & (
  | { event: 'start'; chatIds: number[]; config: Omit<IdleConfig, 'persona' | 'chatIds'> }
  | { event: 'check'; chatId: number; verdict: CheckVerdict; fresh?: number; speakers?: number; pickable?: number; burstSince?: string; slotsUsed?: number }
  | { event: 'decision'; chatId: number; action: IdleAction['kind'] | 'cancelled' | 'error'; messageId?: number; emoji?: string; text?: string; error?: string }
)
type IdleEventBody = IdleEvent extends infer E ? E extends IdleEvent ? Omit<E, 'ts'> : never : never

export interface IdleQueue { enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }

export interface IdleDeps {
  config: IdleConfig
  provider: string
  model: string
  llm: IdleLlm
  api: TelegramApi
  chatLog: ChatLog
  queue: IdleQueue
  botId: number
  botUsername: string
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
  random?: () => number
  /** Receives every start, check and decision; the plugin appends them to a JSONL file. */
  record?: (event: IdleEvent) => void
}

export interface IdleHandle {
  /** Feeds one chat-log line; a human line in an allowlisted chat is evaluated. */
  observe(chatId: number, entry: ChatLogEntry): void
  noteTurn(chatId: number): void
  /** Resolves once every allowlisted chat's window is seeded from its log. */
  ready: Promise<void>
  stop(): void
}

const IDLE_TIMEOUT_MS = 60_000
const MAX_REACTED = 50
/** Each roll is its own event, so these are logged even when they repeat. */
const ROLLED: ReadonlySet<CheckVerdict> = new Set(['go', 'chance_miss'])

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function describeAction(action: IdleAction): string {
  if (action.kind === 'skip') return 'skip'
  return action.kind === 'react' ? `react ${action.emoji} on ${action.messageId}` : `reply on ${action.messageId}`
}

/** Lets the bot join a group as soon as a conversation there gets hot, at most `maxPerBurst` times per burst. */
export function startIdle(deps: IdleDeps): IdleHandle {
  const { config, log } = deps
  if (!config.enabled) return { observe: () => {}, noteTurn: () => {}, ready: Promise.resolve(), stop: () => {} }
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const system = idleSystemPrompt(config.persona, deps.model)
  const record = (event: IdleEventBody): void => deps.record?.({ ts: new Date(now()).toISOString(), ...event } as IdleEvent)
  const states = new Map<number, ChatIdleState>(config.chatIds.map(chatId => [chatId, emptyChatState()]))
  const seeded = new Set<number>()
  // Aborted by stop(), so a task queued or running across a plugin reload never acts through the old bot.
  const lifetime = new AbortController()

  const check = (chatId: number, state: ChatIdleState, verdict: CheckVerdict, result?: Evaluation): void => {
    if (state.lastVerdict === verdict && !ROLLED.has(verdict)) return
    state.lastVerdict = verdict
    record({
      event: 'check', chatId, verdict,
      ...(result === undefined ? {} : {
        fresh: result.fresh, speakers: result.speakers, pickable: result.pickable.size,
        burstSince: new Date(state.burst.since).toISOString(), slotsUsed: state.burst.slotsUsed,
      }),
    })
  }

  const engage = async (chatId: number, state: ChatIdleState): Promise<void> => {
    if (lifetime.signal.aborted) return
    // Re-check without rolling or needing a slot: the bot may have been addressed while this task waited.
    const recheck = evaluate(state, now(), config, random, false)
    if (recheck.verdict !== 'go') {
      record({ event: 'decision', chatId, action: 'cancelled' })
      return
    }
    let action: IdleAction
    try {
      action = await decide(deps.llm, state.recent.slice(-config.contextMessages), {
        provider: deps.provider,
        model: deps.model,
        system,
        pickable: recheck.pickable,
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(IDLE_TIMEOUT_MS)]),
      })
    } catch (error) {
      if (!lifetime.signal.aborted) {
        log.warn(`dsh-telegram: chat ${chatId} idle decision failed: ${errorText(error)}`)
        record({ event: 'decision', chatId, action: 'error', error: errorText(error) })
      }
      return
    }
    if (lifetime.signal.aborted) return
    log.info(`dsh-telegram: chat ${chatId} idle -> ${describeAction(action)}`)
    if (action.kind === 'skip') {
      record({ event: 'decision', chatId, action: 'skip' })
      return
    }
    const detail = action.kind === 'react' ? { emoji: action.emoji } : { text: action.text }
    const at = now()
    const day = dayKey(at, config.timezone)
    state.count = state.day === day ? state.count + 1 : 1
    state.day = day
    state.lastEngagedAt = at
    try {
      if (action.kind === 'react') {
        state.reacted = [...state.reacted, action.messageId].slice(-MAX_REACTED)
        await deps.api.setReaction(chatId, action.messageId, action.emoji)
        record({ event: 'decision', chatId, action: 'react', messageId: action.messageId, ...detail })
        return
      }
      const sent = await deps.api.sendMessage(chatId, action.text, { replyTo: { messageId: action.messageId } })
      await deps.chatLog.append(chatId, {
        ts: new Date(at).toISOString(),
        message_id: sent.messageId,
        user_id: deps.botId,
        name: deps.botUsername,
        text: action.text,
        reply_to: action.messageId,
        bot: true,
      })
      record({ event: 'decision', chatId, action: 'reply', messageId: action.messageId, ...detail })
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle ${action.kind} failed: ${errorText(error)}`)
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, ...detail, error: errorText(error) })
    }
  }

  const consider = (chatId: number, state: ChatIdleState): void => {
    if (deps.queue.isBusy(chatId)) {
      check(chatId, state, 'busy')
      return
    }
    const result = evaluate(state, now(), config, random)
    if (result.verdict !== 'not_hot') check(chatId, state, result.verdict, result)
    if (result.verdict !== 'go') return
    deps.queue.enqueue(chatId, () => engage(chatId, state).catch((error: unknown) => {
      log.warn(`dsh-telegram: chat ${chatId} idle task failed: ${errorText(error)}`)
    }))
  }

  const seed = async (chatId: number): Promise<void> => {
    try {
      const fresh = emptyChatState()
      for (const entry of await deps.chatLog.readAll(chatId)) observe(fresh, entry, config)
      const state = states.get(chatId)!
      state.recent = fresh.recent
      state.burst = fresh.burst
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle window could not be seeded: ${errorText(error)}`)
    }
    seeded.add(chatId)
  }

  const ready = Promise.all(config.chatIds.map(seed)).then(() => {})
  log.info(`dsh-telegram: idle engagement on for ${config.chatIds.length} chat(s)`)
  const { persona: _persona, chatIds, enabled: _enabled, ...settings } = config
  record({ event: 'start', chatIds: [...chatIds], config: { enabled: true, ...settings } })
  return {
    observe: (chatId, entry) => {
      const state = states.get(chatId)
      // Lines that arrive while seeding are already in the log the seed reads.
      if (state === undefined || !seeded.has(chatId) || lifetime.signal.aborted) return
      try {
        observe(state, entry, config)
        if (entry.bot !== true) consider(chatId, state)
      } catch (error) {
        log.warn(`dsh-telegram: chat ${chatId} idle check failed: ${errorText(error)}`)
      }
    },
    noteTurn: (chatId) => {
      const state = states.get(chatId)
      if (state !== undefined) state.lastTurnAt = now()
    },
    ready,
    stop: () => { lifetime.abort() },
  }
}
```

- [ ] **Step 4: Trim `src/idle/engage.ts` to the LLM side**

In `src/idle/engage.ts` delete, in order: `IdleState`, `MINUTE_MS`, `MAX_REACTED`, `emptyIdleState`, `dayKey`, `hourIn`, `inQuietHours`, `lastBotActivity`, `answeredIds`, `pickableIds`, `EngageVerdict`, `EngageCheck`, `checkEngage`, `shouldEngage`, and everything from `export interface IdleQueue` to the end of the file (`IdleEvent`, `IdleEventBody`, `IdleDeps`, `IdleHandle`, `IDLE_TIMEOUT_MS`, `errorText`, `describeAction`, `startIdle`). Change the imports at the top to:

```ts
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { oneLine, senderLabel, type ChatLogEntry } from '../chatlog.ts'
```

What remains: `IDLE_EMOJI`, `IdleAction`, `IdleLlm`, `DecideOptions`, `DEFAULT_PERSONA`, `MAX_REPLY_CHARS`, `IDLE_MAX_TOKENS`, `RULES`, `idleSystemPrompt`, `idleSender`, `idleTranscript`, `parseDecision`, `decide`.

- [ ] **Step 5: Update the plugin**

In `src/idle/index.ts`:
- Remove `checkIntervalMinutes` from `IdleConfig`, `DEFAULT_IDLE` and `Config`.
- Replace `import { startIdle, type IdleEvent } from './engage.ts'` with `import { startIdle, type IdleEvent } from './scheduler.ts'`.
- Replace the `record` body's template literal (it currently holds a raw line break) with `` `${JSON.stringify(event)}\n` ``.
- After `ctx.on('telegram/turn', chatId => handle.noteTurn(chatId))` add:
  ```ts
      ctx.on('telegram/message', (chatId, entry) => handle.observe(chatId, entry))
  ```

- [ ] **Step 6: Update the remaining idle tests**

`tests/idle/engage.spec.ts`:
- Delete the `describe` blocks `'shouldEngage'`, `'checkEngage'`, `'idle helpers'` and `'startIdle'` (their subjects moved to `burst.spec.ts` and `scheduler.spec.ts`).
- Trim the import from `../../src/idle/engage.ts` to `decide, IDLE_EMOJI, idleSystemPrompt, idleTranscript, parseDecision`, and drop the now-unused imports and fixtures (`ChatLog`, `FakeTelegramApi`, `mkdir`, `mkdtemp`, `rm`, `writeFile`, `tmpdir`, `join`, `vi`, `beforeEach`, `afterEach`, `IdleConfig`/`Config`/`base`, `state`, `activeAt`, `hit`) that no remaining test uses. Keep `human`, `bot`, `NOON`, `MIN` and `active` if the prompt, parse or decide tests use them.

`tests/idle/plugin.spec.ts`, replace the `describe('idle plugin', ...)` block (keep `describe('idle Config', ...)`, removing `checkIntervalMinutes: 10` from its defaults expectation) with:

```ts
/** `FiberState` is a const enum that Cordis does not export at runtime. */
const ACTIVE = 2
const FAILED = 3

describe('idle plugin', () => {
  const A = -5
  const config = Config({ enabled: true, chatIds: [A], idleMinutes: 1, minNewMessages: 5, chance: 1, quietHours: { from: 0, to: 0 } })
  let dir: string
  let root: Context
  let chatLog: ChatLog
  let queued: number[]

  function service(): TelegramService {
    return {
      api: new FakeTelegramApi(), chatLog,
      queue: { enqueue: (chatId) => { queued.push(chatId) }, isBusy: () => false },
      bot: { id: 1, username: 'dshbot' }, selection: { provider: 'p', model: 'm' }, dataDir: dir,
      superAdmins: [], chatOf: () => undefined, turnOf: () => undefined, prompt: () => {},
    }
  }
  async function burst(): Promise<void> {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await chatLog.append(A, { ts: new Date(now - (5 - i) * 1000).toISOString(), message_id: 10 + i, user_id: i % 2 === 0 ? 7 : 8, name: 'U', text: 'hi' })
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-plugin-'))
    queued = []
    root = new Context()
    // The core wires the chat log to telegram/message the same way.
    chatLog = new ChatLog(join(dir, 'log'), (chatId, entry) => root.emit('telegram/message', chatId, entry))
    root.provide('llm', { async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } as never } })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function started(): Promise<() => void> {
    root.plugin(idlePlugin, config)
    const revoke = root.provide('telegram', service())
    await vi.waitFor(async () => {
      expect((await readFile(join(dir, 'idle-decisions.jsonl'), 'utf8'))).toContain('"event":"start"')
    })
    // Let the window seeding finish before messages arrive.
    await new Promise(resolve => setTimeout(resolve, 20))
    return revoke
  }

  it('stays inert without the telegram service', async () => {
    root.plugin(idlePlugin, config)
    await burst()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(queued).toEqual([])
  })

  it('loads but does nothing when disabled', async () => {
    const fiber = root.plugin(idlePlugin, { ...config, enabled: false })
    root.provide('telegram', service())
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    await burst()
    expect(queued).toEqual([])
  })

  it('rejects an invalid config at load, before the bot provides telegram', async () => {
    const badZone = root.plugin(idlePlugin, { ...config, timezone: 'Mars/Olympus' })
    const badChance = root.plugin(idlePlugin, { ...config, chance: 1.5 })
    await vi.waitFor(() => expect([badZone.state, badChance.state]).toEqual([FAILED, FAILED]))
  })

  it('queues an engagement when lines written through telegram.chatLog make a burst hot', async () => {
    await started()
    await burst()
    expect(queued).toEqual([A])
  })

  it('a turn noted through telegram/turn keeps the bot from joining', async () => {
    await started()
    root.emit('telegram/turn', A)
    await burst()
    expect(queued).toEqual([])
  })

  it('stops listening on revoke and starts again on a new provide', async () => {
    const revoke = await started()
    revoke()
    await burst()
    expect(queued).toEqual([])
    root.provide('telegram', service())
    await new Promise(resolve => setTimeout(resolve, 20))
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await chatLog.append(A, { ts: new Date(now + i).toISOString(), message_id: 50 + i, user_id: i % 2 === 0 ? 7 : 8, name: 'U', text: 'again' })
    }
    expect(queued).toEqual([A])
  })

  it('logs once that idle engagement is on', async () => {
    const lines: string[] = []
    root.logger.exporter({ levels: { default: 3 }, export: message => lines.push(String(message.args[0])) })
    await started()
    expect(lines.filter(line => line.includes('idle engagement on for 1 chat(s)'))).toHaveLength(1)
  })

  it('only warns when the decision log cannot be written', async () => {
    const warnings: string[] = []
    root.logger.exporter({ levels: { default: 3 }, export: message => { if (message.type === 'warn') warnings.push(String(message.args[0])) } })
    await writeFile(join(dir, 'blocker'), 'x')
    root.plugin(idlePlugin, config)
    root.provide('telegram', { ...service(), dataDir: join(dir, 'blocker') })
    await vi.waitFor(() => expect(warnings.some(w => w.includes('idle-decisions.jsonl'))).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 20))
    await burst()
    expect(queued).toEqual([A])
  })
})
```

Adjust this file's imports so they cover what it uses: `mkdtemp, readFile, rm, writeFile` from `node:fs/promises`, `tmpdir`, `join`, `Context`, `type StreamChunk` from `@deepseek-ai/dsh-llm`, `afterEach, beforeEach, describe, expect, it, vi`, `ChatLog`, `* as idlePlugin` and `{ assertIdleConfig, Config }` from `../../src/idle/index.ts`, `type TelegramService`, `FakeTelegramApi`.

`tests/profile.spec.ts`, add at the end of `describe('profile patch', ...)`:

```ts
  it('keeps both idle rows valid for the burst schema', async () => {
    const { Config } = await import('../src/idle/index.ts')
    const resolve = (value: any): any => (value !== null && typeof value === 'object' && 'js' in value
      ? evalJs(value, { TELEGRAM_IDLE_ENABLED: 'true', TELEGRAM_IDLE_CHATS: '-100' })
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value)
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = Config(resolve(telegramIdle(await rows(path))))
      expect(config).toMatchObject({ enabled: true, chatIds: [-100], hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1 })
      expect(config).not.toHaveProperty('checkIntervalMinutes')
    }
  })
```

- [ ] **Step 7: Record the ruling in the spec**

In `docs/superpowers/specs/2026-10-04-telegram-idle-events-design.md`, Decision log section, replace "and only when it differs from the chat's `lastVerdict` in the current burst." with "and only when it differs from the chat's `lastVerdict` in the current burst, except `go` and `chance_miss`, which are recorded every time because each one is a slot's roll."

- [ ] **Step 8: Full verification**

Run: `pnpm test && pnpm run typecheck && pnpm run build && ls lib/idle/scheduler.js lib/idle/burst.js`
Expected: all tests PASS, typecheck and build exit 0, both files listed.

- [ ] **Step 9: Commit**

```bash
git add packages/dsh-telegram/src/idle packages/dsh-telegram/tests/idle packages/dsh-telegram/tests/profile.spec.ts docs/superpowers/specs/2026-10-04-telegram-idle-events-design.md
git commit -m "feat(telegram): trigger idle engagement from chat-log events per burst"
```
