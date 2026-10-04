# Telegram Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `dsh-telegram/schedule` plugin that lets the agent create, list, update and delete reminders per chat and delivers them as a fixed message or an agent turn.

**Architecture:** The core `telegram` service gains `dataDir`, `superAdmins`, `chatOf`, `turnOf` and `prompt` (a queued agent turn nobody typed). The plugin reuses `@deepseek-ai/dsh-schedule`'s pure record and recurrence helpers, keeps reminders in `dataDir/schedule.json`, registers four tools on its own context and runs one timer that delivers due reminders.

**Tech Stack:** TypeScript (strict, `nodenext`), `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/dsh-schedule` 0.2.0-rc.2 (peer), `@deepseek-ai/dsh-tools` `defineTool`, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-04-telegram-schedule-design.md`

## Global Constraints

- All commands run from `packages/dsh-telegram` (`pnpm test`, `pnpm run typecheck`, `pnpm run build`).
- Relative imports use the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`: never assign `undefined` to an optional property, spread it in conditionally).
- Everything in the repo is English; no emoji literals (the alarm clock is written `'\u{23F0}'`).
- dsh packages stay pinned at exactly `0.2.0-rc.2`.
- Times in tests are fixed: `NOW = Date.parse('2026-10-04T01:00:00Z')` is Sunday 08:00 in `Asia/Ho_Chi_Minh`. Never assert the stored zone name: the runtime may canonicalise `Asia/Ho_Chi_Minh` to `Asia/Saigon`.
- Existing tests keep passing unchanged unless a step says otherwise.

## Review Focus

- Bot down for days with a recurring reminder: on start it delivers once and advances, never a flood. Pinned in Task 2 (`afterDelivery` from far past) and Task 5 (`delivers a stale recurring reminder once`).
- Several reminders due in the same tick, same chat: all delivered, in `scheduledAt` order. Pinned in Task 5.
- A reminder deleted or re-timed after the timer was armed: not delivered. Pinned in Task 5.
- A subagent (no chat) calling a reminder tool: `no_chat`, nothing stored. Pinned in Task 4.
- `schedule.json` corrupted: the plugin fails to start and leaves the file untouched. Pinned in Task 3 and Task 5.

---

### Task 1: Core: service additions and prompt turns

**Files:**
- Modify: `packages/dsh-telegram/src/turn.ts` (optional `replyToMessageId`)
- Modify: `packages/dsh-telegram/src/bot.ts` (`runChatTurn`, `promptTurn`, `Dispatcher.prompt`)
- Modify: `packages/dsh-telegram/src/sessions.ts` (`chatOf`)
- Modify: `packages/dsh-telegram/src/service.ts`, `packages/dsh-telegram/src/index.ts`
- Modify: `docs/superpowers/specs/2026-10-04-telegram-schedule-design.md` (record the rulings)
- Test: `packages/dsh-telegram/tests/bot.spec.ts`, `packages/dsh-telegram/tests/sessions.spec.ts`

**Interfaces:**
- Produces:
  - `TelegramService` gains `dataDir: string`, `superAdmins: readonly number[]`, `chatOf(agentId: string): number | undefined`, `turnOf(chatId: number): TurnContext | undefined`, `prompt(chatId: number, input: PromptInput): void`.
  - `src/bot.ts`: `export interface PromptInput { text: string; sender: TelegramUser }`; `Dispatcher.prompt(chatId: number, input: PromptInput): void`; `runChatTurn(deps, input: ChatTurnInput)`; `promptTurn(deps, chatId, input)`.
  - `src/sessions.ts`: `ChatAgents.chatOf(agentId: string): number | undefined`.

- [ ] **Step 1: Write the failing tests**

In `packages/dsh-telegram/tests/sessions.spec.ts`, inside `describe('ChatAgents', ...)`, add:

```ts
  it('maps a live agent id back to its chat', async () => {
    const { agents } = await build()
    const { agent } = await agents.resolve(1)
    expect(agents.chatOf(String(agent.id))).toBe(1)
    expect(agents.chatOf('telegram-unknown')).toBeUndefined()
    await agents.reset(1)
    expect(agents.chatOf(String(agent.id))).toBeUndefined()
  })
```

In `packages/dsh-telegram/tests/bot.spec.ts`, inside `describe('handleMessage', ...)`, add:

```ts
  it('prompt queues a turn with no message to quote, react to or mark', async () => {
    const notes: number[] = []
    deps.noteTurn = chatId => notes.push(chatId)
    const dispatcher = createDispatcher(deps)
    dispatcher.prompt(5, { text: 'remind me', sender: ann })
    await vi.waitFor(() => expect(dispatcher.isBusy(5)).toBe(false))
    expect((followups[0] as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'remind me' }])
    expect(agents.setTurn).toHaveBeenCalledWith(5, { sender: ann, isGroup: false })
    expect(api.callsTo('setReaction')).toHaveLength(0)
    expect(agents.markTurn).not.toHaveBeenCalled()
    expect(api.callsTo('sendMessage')[0]!.args[2]).not.toHaveProperty('replyTo')
    expect(notes).toEqual([5])
  })

  it('prompt in a group adds no group block and counts as a group turn', async () => {
    await deps.chatLog.append(-100, { ts: 't', message_id: 8, user_id: 9, name: 'Bob', text: 'earlier note' })
    const dispatcher = createDispatcher(deps)
    dispatcher.prompt(-100, { text: 'remind me', sender: ann })
    await vi.waitFor(() => expect(dispatcher.isBusy(-100)).toBe(false))
    expect((followups[0] as { content: Array<{ text: string }> }).content[0]!.text).toBe('remind me')
    expect(agents.setTurn).toHaveBeenCalledWith(-100, { sender: ann, isGroup: true })
  })

  it('prompt waits behind a running message turn', async () => {
    const order: string[] = []
    let release!: () => void
    agents.resolve.mockImplementationOnce(async () => {
      order.push('message')
      await new Promise<void>((resolve) => { release = resolve })
      return { agent: (await agents.resolve.getMockImplementation()!()).agent, resumed: false }
    })
    const dispatcher = createDispatcher(deps)
    dispatcher.dispatch(msg({ text: 'hello' }))
    dispatcher.prompt(5, { text: 'remind me', sender: ann })
    await vi.waitFor(() => expect(order).toEqual(['message']))
    expect(followups).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(dispatcher.isBusy(5)).toBe(false))
    expect(followups).toHaveLength(2)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/sessions.spec.ts tests/bot.spec.ts`
Expected: FAIL: `agents.chatOf is not a function`, `dispatcher.prompt is not a function`.

- [ ] **Step 3: Make the reply target optional in `turn.ts`**

In `src/turn.ts`:
- Add `type ReplyTarget` to the existing import from `./telegram-api.ts` (it already exports `interface ReplyTarget { readonly messageId: number }`).
- In `TurnOptions`, change `replyToMessageId: number` to:
  ```ts
  /** The message this turn answers; undefined for a turn nobody typed, which quotes nothing. */
  replyToMessageId?: number
  ```
- Add above `sendPart`:
  ```ts
  /** Reply parameters for a send; empty when the turn answers no message. */
  function replyTarget(messageId: number | undefined): { replyTo?: ReplyTarget } {
    return messageId === undefined ? {} : { replyTo: { messageId } }
  }
  ```
- `sendPart`: change the parameter to `replyToMessageId: number | undefined`, replace `const replyTo = { messageId: replyToMessageId }` with `const reply = replyTarget(replyToMessageId)`, and the three sends to `{ parseMode: 'HTML', ...reply }`, `{ parseMode: 'HTML', ...reply }`, `{ ...reply }`.
- `sendMarkdownDocument`: replace `replyTo: { messageId: options.replyToMessageId },` with `...replyTarget(options.replyToMessageId),`.
- The placeholder send in `runTurn`: `{ ...replyTarget(options.replyToMessageId) }` instead of `{ replyTo: { messageId: options.replyToMessageId } }`.
- The `UNDELIVERED_NOTICE` send: same replacement.

- [ ] **Step 4: Add `chatOf` to `ChatAgents`**

In `src/sessions.ts`, after `turnOf`:

```ts
  /** Chat whose live agent has this id; undefined for subagents and unknown sessions. */
  chatOf(agentId: string): number | undefined {
    for (const [chatId, handle] of this.handles) {
      if (String(handle.agent.id) === agentId) return chatId
    }
    return undefined
  }
```

- [ ] **Step 5: Split the turn out of `handleMessage` and add prompt turns**

In `src/bot.ts`:

Add `type TurnResult` to the import from `./turn.ts`. Add after `memoryBlock`:

```ts
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** A turn to run in a chat; `messageId` is the Telegram message it answers (quoted, given group context, marked), absent for a prompt. */
export interface ChatTurnInput {
  chatId: number
  sender: TelegramUser
  isGroup: boolean
  text: string
  images: Parameters<ImageStore['saveImages']>[0]
  messageId?: number
  startedAt: number
}

/** Resolves the chat's agent, runs one turn and logs the reply; shared by messages and prompts. */
export async function runChatTurn(deps: BotDeps, input: ChatTurnInput): Promise<{ result: TurnResult; prepMs: number }> {
  const { chatId, messageId } = input
  const resolved = await deps.agents.resolve(chatId)
  if (resolved.resumeFailed !== undefined) {
    await deps.api.sendMessage(chatId, 'The previous conversation could not be restored; starting a new one.')
  }

  deps.agents.setTurn(chatId, { sender: input.sender, isGroup: input.isGroup })

  let text = input.text
  if (input.isGroup && messageId !== undefined) {
    const recent = await deps.chatLog.recent(chatId, deps.agents.lastTurnMessageId(chatId), messageId, deps.config.recentMessagesLimit)
    if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
  }
  // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
  const sessionId = resolved.agent.id
  const memoryText = deps.agents.memoryInjected(chatId, sessionId) ? '' : await memoryBlock(deps, chatId)
  if (memoryText !== undefined && memoryText !== '') text = `${memoryText}\n\n${text}`
  if (messageId !== undefined) await deps.agents.markTurn(chatId, messageId)

  const content: ContentBlock[] = [{ type: 'text', text }]
  if (input.images.length > 0) {
    const refs = await deps.attachments.saveImages(input.images)
    for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
  }

  const prepMs = Date.now() - input.startedAt
  if (memoryText !== undefined) deps.agents.markMemoryInjected(chatId, sessionId)
  const workspaceDir = deps.agents.workspaceFor(chatId)
  const result = await runTurn({
    api: deps.api,
    agent: resolved.agent,
    feed: deps.feed,
    chatId,
    ...(messageId === undefined ? {} : { replyToMessageId: messageId }),
    content,
    outboxDir: join(workspaceDir, 'outbox'),
    messageSize: deps.config.messageSize,
    statusEditIntervalMs: deps.config.statusEditIntervalMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    status: deps.config.status,
    log: deps.log,
  })

  if (result.text !== '') {
    await deps.chatLog.append(chatId, {
      ts: new Date().toISOString(),
      message_id: result.sentMessageId ?? 0,
      user_id: deps.botId,
      name: deps.botUsername,
      text: result.text,
      ...(messageId === undefined ? {} : { reply_to: messageId }),
      bot: true,
    })
  }
  return { result, prepMs }
}

export interface PromptInput { text: string; sender: TelegramUser }

/** A turn nobody typed (a scheduled reminder): nothing to quote, react to or mark. */
export async function promptTurn(deps: BotDeps, chatId: number, input: PromptInput): Promise<void> {
  deps.noteTurn?.(chatId)
  const { result, prepMs } = await runChatTurn(deps, {
    chatId, sender: input.sender, isGroup: chatId < 0, text: input.text, images: [], startedAt: Date.now(),
  })
  deps.log.info(`dsh-telegram: chat ${chatId} prompt -> ${result.outcome}`
    + ` (prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
}
```

Replace the body of `handleMessage` from `const resolved = await deps.agents.resolve(chatId)` to the end of the function with:

```ts
  const { result, prepMs } = await runChatTurn(deps, {
    chatId,
    sender: inbound.sender,
    isGroup: inbound.isGroup,
    text: inbound.text,
    images: inbound.images,
    messageId: message.message_id,
    startedAt: receivedAt,
  })
  deps.log.info(`dsh-telegram: chat ${chatId} message ${message.message_id} -> ${result.outcome}`
    + ` (lag ${seconds(lagMs)}, prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
}
```

(Delete the old local `const seconds = ...` inside `handleMessage`; `workspaceDir` stays, `parseInbound` still uses it.)

In `interface Dispatcher` add:

```ts
  /** Queues an agent turn nobody typed; it waits behind the chat's running and queued tasks. */
  prompt(chatId: number, input: PromptInput): void
```

and in the object returned by `createDispatcher` add:

```ts
    prompt: (chatId, input) => enqueue(chatId, () => promptTurn(deps, chatId, input)),
```

- [ ] **Step 6: Extend the service**

In `src/service.ts`, add imports:

```ts
import type { PromptInput } from './bot.ts'
import type { TurnContext } from './sessions.ts'
```

(merge `PromptInput` into the existing `import type { Dispatcher } from './bot.ts'`), and add to `TelegramService` after `selection`:

```ts
  /** Where plugins keep their own durable files. */
  readonly dataDir: string
  readonly superAdmins: readonly number[]
  /** Chat whose live agent has this id; undefined for subagents and unknown sessions. */
  chatOf(agentId: string): number | undefined
  /** Sender of the running turn in that chat. */
  turnOf(chatId: number): TurnContext | undefined
  /** Queues an agent turn in the chat as if `sender` had written `text`; the reply quotes no message. */
  prompt(chatId: number, input: PromptInput): void
```

In `src/index.ts`, extend the `service` object returned by `start()`:

```ts
    service: {
      api,
      chatLog,
      queue: dispatcher,
      bot: { id: bot.botInfo.id, username: bot.botInfo.username },
      selection: { provider: config.provider, model: config.model },
      dataDir: config.dataDir,
      superAdmins: config.superAdmins,
      chatOf: agentId => agents.chatOf(agentId),
      turnOf: chatId => agents.turnOf(chatId),
      prompt: (chatId, input) => dispatcher.prompt(chatId, input),
    },
```

- [ ] **Step 7: Record the rulings in the spec**

In `docs/superpowers/specs/2026-10-04-telegram-schedule-design.md`:
- In the `TelegramService` code block, add `dataDir: string` above `superAdmins`, with the comment `/** Where plugins keep their own durable files. */`.
- In the Files list, add `- src/schedule-delivery.ts: the timer and delivery of due reminders.` and drop "the timer" from the `schedule-plugin.ts` line.
- In the `schedule_create` bullet, replace "`at` takes the `dsh-schedule` `AtInput`." with "`at` is an ISO 8601 instant with an offset (for example `2026-10-05T08:00:00+07:00`)."
- In the error table, replace the `invalid_rule` row with:
  `| invalid_rule, invalid_time_zone, frequency_too_high, invalid_prompt | Passed through from dsh-schedule's ScheduleInputError (bad time, cron field or 'at'; unknown zone; interval below 60 s; blank or over-long title or prompt). invalid_rule also covers zero or several selectors. |`

- [ ] **Step 8: Run the suite and typecheck**

Run: `pnpm test && pnpm run typecheck`
Expected: all tests PASS (including the 4 new ones), typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/dsh-telegram/src/turn.ts packages/dsh-telegram/src/bot.ts packages/dsh-telegram/src/sessions.ts packages/dsh-telegram/src/service.ts packages/dsh-telegram/src/index.ts packages/dsh-telegram/tests/bot.spec.ts packages/dsh-telegram/tests/sessions.spec.ts docs/superpowers/specs/2026-10-04-telegram-schedule-design.md
git commit -m "feat(telegram): let plugins queue prompt turns and look up chats on the telegram service"
```

---

### Task 2: Reminder domain logic on `dsh-schedule`

**Files:**
- Modify: `packages/dsh-telegram/package.json`, `packages/dsh-telegram/pnpm-lock.yaml`
- Create: `packages/dsh-telegram/src/schedule.ts`
- Test: `packages/dsh-telegram/tests/schedule.spec.ts`

**Interfaces:**
- Consumes: `TelegramUser` from `src/inbound.ts`.
- Produces (all from `src/schedule.ts`):
  - `interface Reminder { chatId: number; creator: { id: number; name: string }; mode: ReminderMode; record: ScheduleRecord }`, `type ReminderMode = 'message' | 'agent'`.
  - `interface TimingInput { after_seconds?: number; at?: string; every_seconds?: number; daily?: { time: string; time_zone?: string }; weekly?: { time: string; time_zone?: string; weekdays: number[] }; cron?: { expression: string; time_zone?: string } }`.
  - `class ReminderError extends Error { readonly code: string }`.
  - `buildRecord(id: string, title: string, prompt: string, timing: TimingInput, now: number, zone: string): ScheduleRecord`
  - `retitle(record: ScheduleRecord, changes: { title?: string; prompt?: string }): ScheduleRecord`
  - `canManage(reminder: Reminder, userId: number, superAdmins: readonly number[]): boolean`
  - `dueReminders(reminders: readonly Reminder[], now: number): Reminder[]`
  - `nextDueAt(reminders: readonly Reminder[]): number | undefined`
  - `afterDelivery(reminder: Reminder, now: number): Reminder | undefined`
  - `reminderView(reminder: Reminder): Record<string, unknown>`
  - `displayName(user: TelegramUser): string`
  - `reminderMessage(reminder: Reminder): string`, `agentPrompt(reminder: Reminder): string`

- [ ] **Step 1: Add the dependency**

```bash
pnpm add -D @deepseek-ai/dsh-schedule@0.2.0-rc.2 @deepseek-ai/dsh-typert-protocol@0.2.0-rc.2 @deepseek-ai/dsh-storage-domain@0.2.0-rc.2
```

Then in `package.json` add to `peerDependencies` (same exact pin as the other dsh peers):

```json
    "@deepseek-ai/dsh-schedule": "0.2.0-rc.2",
```

Run: `node -e "import('@deepseek-ai/dsh-schedule').then(m => console.log(typeof m.createDailyScheduleRecord, typeof m.resolveRecurringOccurrence))"`
Expected: `function function`. If an import of a further peer fails, add that `@deepseek-ai/*` package at `0.2.0-rc.2` as a devDependency the same way and rerun.

- [ ] **Step 2: Write the failing test**

Create `packages/dsh-telegram/tests/schedule.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  afterDelivery, agentPrompt, buildRecord, canManage, displayName, dueReminders, nextDueAt, ReminderError, reminderMessage, reminderView, retitle,
  type Reminder,
} from '../src/schedule.ts'

/** Sunday 08:00 in Asia/Ho_Chi_Minh. */
const NOW = Date.parse('2026-10-04T01:00:00Z')
const ZONE = 'Asia/Ho_Chi_Minh'
const build = (timing: Parameters<typeof buildRecord>[3]) => buildRecord('r1', 'Title', 'Do it', timing, NOW, ZONE)
function reminder(extra: Partial<Reminder> = {}, timing: Parameters<typeof buildRecord>[3] = { after_seconds: 60 }): Reminder {
  return { chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record: build(timing), ...extra }
}
function codeOf(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return error instanceof ReminderError ? error.code : `not a ReminderError: ${String(error)}` }
  return undefined
}

describe('buildRecord', () => {
  it('builds each of the six kinds', () => {
    expect(build({ after_seconds: 600 }).scheduledAt).toBe(new Date(NOW + 600_000).toISOString())
    expect(build({ at: '2026-10-05T08:00:00+07:00' }).scheduledAt).toBe('2026-10-05T01:00:00.000Z')
    expect(build({ every_seconds: 300 }).scheduledAt).toBe(new Date(NOW + 300_000).toISOString())
    expect(build({ daily: { time: '07:00:00' } }).scheduledAt).toBe('2026-10-05T00:00:00.000Z')
    expect(build({ weekly: { time: '09:00:00', weekdays: [1] } }).scheduledAt).toBe('2026-10-05T02:00:00.000Z')
    expect(build({ cron: { expression: '*/15 9-17 * * 1-5' } }).scheduledAt).toBe('2026-10-05T02:00:00.000Z')
  })
  it('uses an explicit time zone over the default', () => {
    expect(build({ daily: { time: '07:00:00', time_zone: 'UTC' } }).scheduledAt).toBe('2026-10-04T07:00:00.000Z')
  })
  it('needs exactly one selector', () => {
    expect(codeOf(() => build({}))).toBe('invalid_rule')
    expect(codeOf(() => build({ after_seconds: 60, every_seconds: 60 }))).toBe('invalid_rule')
  })
  it('passes dsh-schedule input errors through with their codes', () => {
    expect(codeOf(() => build({ every_seconds: 30 }))).toBe('frequency_too_high')
    expect(codeOf(() => build({ daily: { time: '07:00:00', time_zone: 'Mars/Olympus' } }))).toBe('invalid_time_zone')
    expect(codeOf(() => build({ cron: { expression: '61 * * * *' } }))).toBe('invalid_rule')
    expect(codeOf(() => buildRecord('r1', ' ', 'p', { after_seconds: 60 }, NOW, ZONE))).toBe('invalid_prompt')
  })
})

describe('retitle', () => {
  it('changes title and prompt, keeping timing', () => {
    const record = build({ daily: { time: '07:00:00' } })
    expect(retitle(record, { title: 'New', prompt: 'Other' })).toMatchObject({ title: 'New', prompt: 'Other', scheduledAt: record.scheduledAt, kind: 'daily' })
  })
  it('rejects a blank or over-long title and a blank prompt', () => {
    const record = build({ after_seconds: 60 })
    expect(codeOf(() => retitle(record, { title: '  ' }))).toBe('invalid_prompt')
    expect(codeOf(() => retitle(record, { title: 'x'.repeat(121) }))).toBe('invalid_prompt')
    expect(codeOf(() => retitle(record, { prompt: '' }))).toBe('invalid_prompt')
  })
})

describe('permissions and selection', () => {
  it('lets the creator and super admins manage a reminder, nobody else', () => {
    expect(canManage(reminder(), 7, [])).toBe(true)
    expect(canManage(reminder(), 9, [9])).toBe(true)
    expect(canManage(reminder(), 9, [1])).toBe(false)
  })
  it('picks due reminders in scheduledAt order and finds the next target', () => {
    const late = reminder({ record: buildRecord('b', 'B', 'p', { after_seconds: 120 }, NOW, ZONE) })
    const early = reminder({ record: buildRecord('a', 'A', 'p', { after_seconds: 60 }, NOW, ZONE) })
    expect(dueReminders([late, early], NOW + 30_000)).toEqual([])
    expect(dueReminders([late, early], NOW + 120_000).map(r => r.record.id)).toEqual(['a', 'b'])
    expect(nextDueAt([late, early])).toBe(NOW + 60_000)
    expect(nextDueAt([])).toBeUndefined()
  })
})

describe('afterDelivery', () => {
  it('drops a one-shot', () => {
    expect(afterDelivery(reminder(), NOW + 60_000)).toBeUndefined()
  })
  it('advances a recurring reminder past now, skipping every missed occurrence', () => {
    const daily = reminder({}, { daily: { time: '07:00:00' } })
    const threeDaysLate = Date.parse('2026-10-07T00:00:01Z')
    expect(afterDelivery(daily, threeDaysLate)!.record.scheduledAt).toBe('2026-10-08T00:00:00.000Z')
  })
})

describe('rendering', () => {
  it('shows a view with mode and creator', () => {
    expect(reminderView(reminder({ mode: 'agent' }, { daily: { time: '07:00:00' } }))).toMatchObject({
      id: 'r1', kind: 'daily', mode: 'agent', title: 'Title', prompt: 'Do it', creator: { id: 7, name: '@ann' }, time: '07:00:00.000',
    })
  })
  it('names a user by username, else first name', () => {
    expect(displayName({ id: 7, is_bot: false, username: 'ann', first_name: 'Ann' })).toBe('@ann')
    expect(displayName({ id: 9, is_bot: false, first_name: 'Bob' })).toBe('Bob')
  })
  it('renders the message and the escaped agent prompt', () => {
    expect(reminderMessage(reminder())).toBe('\u{23F0} Title\nDo it')
    const tricky = reminder({ creator: { id: 7, name: 'a"<b>' } })
    expect(agentPrompt(tricky)).toBe('<scheduled_reminder title="Title" created_by="a&quot;&lt;b&gt;">\nDo it\n</scheduled_reminder>')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run tests/schedule.spec.ts`
Expected: FAIL, cannot resolve `../src/schedule.ts`.

- [ ] **Step 4: Implement `src/schedule.ts`**

```ts
import {
  createAfterScheduleRecord, createAtScheduleRecord, createCronScheduleRecord, createDailyScheduleRecord, createEveryScheduleRecord,
  createWeeklyScheduleRecord, isRecurringScheduleRecord, MAX_TITLE_LENGTH, resolveRecurringOccurrence, ScheduleId, ScheduleInputError,
  scheduleView, type ScheduleRecord,
} from '@deepseek-ai/dsh-schedule'
import type { TelegramUser } from './inbound.ts'

export type ReminderMode = 'message' | 'agent'

/** One active reminder; `record` is a dsh-schedule record (id, kind, title, prompt, scheduledAt and the rule). */
export interface Reminder {
  chatId: number
  creator: { id: number; name: string }
  mode: ReminderMode
  record: ScheduleRecord
}

/** Tool-facing timing selectors; a missing time_zone falls back to the configured zone. */
export interface TimingInput {
  after_seconds?: number
  at?: string
  every_seconds?: number
  daily?: { time: string; time_zone?: string }
  weekly?: { time: string; time_zone?: string; weekdays: number[] }
  cron?: { expression: string; time_zone?: string }
}

/** A failure the tools report to the model as `{ code, message }`. */
export class ReminderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReminderError'
  }
}

const SELECTORS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

/** dsh-schedule input errors keep their own codes. */
function translated<T>(build: () => T): T {
  try {
    return build()
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new ReminderError(String(error.code), error.message)
    throw error
  }
}

export function buildRecord(id: string, title: string, prompt: string, timing: TimingInput, now: number, zone: string): ScheduleRecord {
  const given = SELECTORS.filter(key => timing[key] !== undefined)
  if (given.length !== 1) throw new ReminderError('invalid_rule', `give exactly one of ${SELECTORS.join(', ')}`)
  const sid = ScheduleId(id)
  return translated(() => {
    const { after_seconds, at, every_seconds, daily, weekly, cron } = timing
    if (after_seconds !== undefined) return createAfterScheduleRecord(sid, prompt, after_seconds, now, title)
    if (at !== undefined) return createAtScheduleRecord(sid, prompt, at, now, title)
    if (every_seconds !== undefined) return createEveryScheduleRecord(sid, prompt, every_seconds, now, title)
    if (daily !== undefined) return createDailyScheduleRecord(sid, prompt, { time: daily.time, time_zone: daily.time_zone ?? zone }, now, title)
    if (weekly !== undefined) {
      return createWeeklyScheduleRecord(sid, prompt, { time: weekly.time, time_zone: weekly.time_zone ?? zone, weekdays: weekly.weekdays }, now, title)
    }
    return createCronScheduleRecord(sid, prompt, { expression: cron!.expression, time_zone: cron!.time_zone ?? zone }, now, title)
  })
}

/** New title and prompt for a record whose timing stays; the same limits as creation. */
export function retitle(record: ScheduleRecord, changes: { title?: string; prompt?: string }): ScheduleRecord {
  const title = changes.title?.trim() ?? record.title
  const prompt = changes.prompt ?? record.prompt
  if (title === '' || title.length > MAX_TITLE_LENGTH) throw new ReminderError('invalid_prompt', `title must be 1-${MAX_TITLE_LENGTH} characters`)
  if (prompt.trim() === '') throw new ReminderError('invalid_prompt', 'prompt must be non-empty')
  return { ...record, title, prompt }
}

export function canManage(reminder: Reminder, userId: number, superAdmins: readonly number[]): boolean {
  return reminder.creator.id === userId || superAdmins.includes(userId)
}

const dueAt = (reminder: Reminder) => Date.parse(reminder.record.scheduledAt)

export function dueReminders(reminders: readonly Reminder[], now: number): Reminder[] {
  return reminders.filter(r => dueAt(r) <= now).sort((a, b) => dueAt(a) - dueAt(b))
}

export function nextDueAt(reminders: readonly Reminder[]): number | undefined {
  return reminders.length === 0 ? undefined : Math.min(...reminders.map(dueAt))
}

/** The reminder after delivering at `now`: undefined for a one-shot or an exhausted rule, else the next target. */
export function afterDelivery(reminder: Reminder, now: number): Reminder | undefined {
  if (!isRecurringScheduleRecord(reminder.record)) return undefined
  const { nextScheduledAt } = resolveRecurringOccurrence(reminder.record, now)
  return nextScheduledAt === undefined ? undefined : { ...reminder, record: { ...reminder.record, scheduledAt: nextScheduledAt } }
}

export function reminderView(reminder: Reminder): Record<string, unknown> {
  const { state: _state, deliveryMode: _deliveryMode, ...view } = scheduleView(reminder.record) as unknown as Record<string, unknown>
  return { ...view, mode: reminder.mode, creator: reminder.creator }
}

export function displayName(user: TelegramUser): string {
  return user.username === undefined ? user.first_name : `@${user.username}`
}

export function reminderMessage(reminder: Reminder): string {
  return `\u{23F0} ${reminder.record.title}\n${reminder.record.prompt}`
}

const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** The instruction an agent reminder submits as its turn's text. */
export function agentPrompt(reminder: Reminder): string {
  return `<scheduled_reminder title="${attribute(reminder.record.title)}" created_by="${attribute(reminder.creator.name)}">\n`
    + `${reminder.record.prompt}\n</scheduled_reminder>`
}
```

If `typecheck` reports that `ScheduleRecord`, `MAX_TITLE_LENGTH` or `scheduleView` are not exported from the package root, import them from where `lib/types/index.d.ts` re-exports them and ledger the ruling.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm vitest run tests/schedule.spec.ts && pnpm run typecheck`
Expected: PASS (13 tests), typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-telegram/package.json packages/dsh-telegram/pnpm-lock.yaml packages/dsh-telegram/src/schedule.ts packages/dsh-telegram/tests/schedule.spec.ts
git commit -m "feat(telegram): reminder domain logic on dsh-schedule records"
```

---

### Task 3: Reminder store

**Files:**
- Create: `packages/dsh-telegram/src/schedule-store.ts`
- Test: `packages/dsh-telegram/tests/schedule-store.spec.ts`

**Interfaces:**
- Consumes: `Reminder` from `src/schedule.ts`.
- Produces: `class ReminderStore { constructor(file: string); load(): void; all(): readonly Reminder[]; update<T>(change: (reminders: Reminder[]) => T): Promise<T> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-telegram/tests/schedule-store.spec.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRecord, type Reminder } from '../src/schedule.ts'
import { ReminderStore } from '../src/schedule-store.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
const one = (id: string): Reminder => ({
  chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record: buildRecord(id, 'T', 'p', { after_seconds: 60 }, NOW, 'UTC'),
})

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'schedule-store-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('ReminderStore', () => {
  it('starts empty without a file and round-trips through it', async () => {
    const file = join(dir, 'schedule.json')
    const store = new ReminderStore(file)
    store.load()
    expect(store.all()).toEqual([])
    expect(await store.update((list) => { list.push(one('a')); return list.length })).toBe(1)
    const reloaded = new ReminderStore(file)
    reloaded.load()
    expect(reloaded.all()).toEqual([one('a')])
  })

  it('runs updates in order', async () => {
    const store = new ReminderStore(join(dir, 'schedule.json'))
    store.load()
    await Promise.all([store.update(list => list.push(one('a'))), store.update(list => list.push(one('b')))])
    expect(store.all().map(r => r.record.id)).toEqual(['a', 'b'])
  })

  it('keeps the previous state when a change throws or the write fails', async () => {
    const store = new ReminderStore(join(dir, 'schedule.json'))
    store.load()
    await store.update(list => list.push(one('a')))
    await expect(store.update(() => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(store.all()).toHaveLength(1)
    await writeFile(join(dir, 'blocker'), 'x')
    // No load(): reading a path under a file fails with ENOTDIR; an unloaded store starts empty.
    const broken = new ReminderStore(join(dir, 'blocker', 'schedule.json'))
    await expect(broken.update(list => list.push(one('b')))).rejects.toThrow()
    expect(broken.all()).toEqual([])
    await store.update(list => list.push(one('c')))
    expect(store.all()).toHaveLength(2)
  })

  it('rejects an invalid file without touching it', async () => {
    const file = join(dir, 'schedule.json')
    for (const text of ['{not json', '{"version":2,"reminders":[]}', '{"version":1,"reminders":[{"chatId":"x"}]}']) {
      await writeFile(file, text)
      expect(() => new ReminderStore(file).load()).toThrow(/schedule\.json/)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/schedule-store.spec.ts`
Expected: FAIL, cannot resolve `../src/schedule-store.ts`.

- [ ] **Step 3: Implement `src/schedule-store.ts`**

```ts
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Reminder } from './schedule.ts'

interface ScheduleFile { version: 1; reminders: Reminder[] }

function isReminder(value: unknown): value is Reminder {
  const r = value as Partial<Reminder> | null
  return typeof r === 'object' && r !== null
    && Number.isInteger(r.chatId) && Number.isInteger(r.creator?.id) && typeof r.creator?.name === 'string'
    && (r.mode === 'message' || r.mode === 'agent')
    && typeof r.record?.id === 'string' && typeof r.record.title === 'string' && typeof r.record.prompt === 'string'
    && !Number.isNaN(Date.parse(r.record.scheduledAt))
}

/** Active reminders in one JSON file; changes run one at a time and replace the list only once written. */
export class ReminderStore {
  private reminders: Reminder[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Synchronous so the plugin loads before it registers anything; a missing file is an empty store. */
  load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.reminders = []
        return
      }
      throw error
    }
    let data: Partial<ScheduleFile>
    try {
      data = JSON.parse(text) as Partial<ScheduleFile>
    } catch {
      throw new Error(`dsh-telegram: ${this.file} is not valid JSON; fix or remove it`)
    }
    if (data.version !== 1 || !Array.isArray(data.reminders) || !data.reminders.every(isReminder)) {
      throw new Error(`dsh-telegram: ${this.file} is not a valid reminder file; fix or remove it`)
    }
    this.reminders = data.reminders
  }

  all(): readonly Reminder[] {
    return this.reminders
  }

  update<T>(change: (reminders: Reminder[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = [...this.reminders]
      const result = change(draft)
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const data: ScheduleFile = { version: 1, reminders: draft }
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, this.file)
      this.reminders = draft
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/schedule-store.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/schedule-store.ts packages/dsh-telegram/tests/schedule-store.spec.ts
git commit -m "feat(telegram): persist reminders in an atomic JSON store"
```

---

### Task 4: Reminder tools

**Files:**
- Create: `packages/dsh-telegram/src/schedule-tools.ts`
- Test: `packages/dsh-telegram/tests/schedule-tools.spec.ts`

**Interfaces:**
- Consumes: everything Task 2 produces; `ReminderStore` (Task 3); `TelegramService` fields `chatOf`, `turnOf`, `superAdmins` (Task 1).
- Produces:
  ```ts
  export interface ScheduleToolDeps {
    telegram: Pick<TelegramService, 'chatOf' | 'turnOf' | 'superAdmins'>
    store: ReminderStore
    timeZone: string
    maxPerChat: number
    /** Called after every committed change, so the timer can re-arm. */
    changed: () => void
    now?: () => number
    newId?: () => string
  }
  export function createScheduleTools(deps: ScheduleToolDeps): ToolDefinition[]   // [create, list, update, delete]
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-telegram/tests/schedule-tools.spec.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TurnContext } from '../src/sessions.ts'
import { ReminderStore } from '../src/schedule-store.ts'
import { createScheduleTools } from '../src/schedule-tools.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
const admin = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const member = { id: 9, is_bot: false, first_name: 'Bob' }

let dir: string
let store: ReminderStore
let turn: TurnContext | undefined
let changes: number
let ids: number
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-tools-'))
  store = new ReminderStore(join(dir, 'schedule.json'))
  store.load()
  turn = { sender: admin, isGroup: false }
  changes = 0
  ids = 0
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function tools(maxPerChat = 20) {
  const [create, list, update, remove] = createScheduleTools({
    telegram: { chatOf: id => (id === 'agent-5' ? 5 : id === 'agent-6' ? 6 : undefined), turnOf: () => turn, superAdmins: [7] },
    store, timeZone: 'Asia/Ho_Chi_Minh', maxPerChat, changed: () => { changes++ }, now: () => NOW, newId: () => `r${++ids}`,
  })
  return { create: create!, list: list!, update: update!, remove: remove! }
}
const exec = (agentId?: string) => ({
  callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  ...(agentId === undefined ? {} : { agent: { id: agentId } }),
}) as never
const call = async (tool: { execute(args: never, exec: never): Promise<unknown> }, args: object, agentId: string | undefined = 'agent-5') =>
  JSON.parse(String(await tool.execute(args as never, exec(agentId)))) as Record<string, any>

describe('schedule tools', () => {
  it('names the four tools', () => {
    expect(createScheduleTools({ telegram: { chatOf: () => undefined, turnOf: () => undefined, superAdmins: [] }, store, timeZone: 'UTC', maxPerChat: 1, changed: () => {} })
      .map(t => t.name)).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
  })

  it('creates a message reminder in the default zone and lists it for the chat only', async () => {
    const { create, list } = tools()
    const created = await call(create, { title: 'Standup', prompt: 'Join the call', daily: { time: '07:00:00' } })
    expect(created).toMatchObject({ id: 'r1', kind: 'daily', mode: 'message', scheduledAt: '2026-10-05T00:00:00.000Z', creator: { id: 7, name: '@ann' } })
    expect(changes).toBe(1)
    expect((await call(list, {})).map((r: { id: string }) => r.id)).toEqual(['r1'])
    expect(await call(list, {}, 'agent-6')).toEqual([])
  })

  it('lets only super admins create agent reminders', async () => {
    const { create } = tools()
    turn = { sender: member, isGroup: true }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).code).toBe('forbidden')
    turn = { sender: admin, isGroup: true }
    expect((await call(create, { title: 'T', prompt: 'p', mode: 'agent', after_seconds: 60 })).mode).toBe('agent')
  })

  it('reports input errors and the per-chat limit without storing anything', async () => {
    const { create } = tools(1)
    expect((await call(create, { title: 'T', prompt: 'p' })).code).toBe('invalid_rule')
    expect((await call(create, { title: 'T', prompt: 'p', every_seconds: 30 })).code).toBe('frequency_too_high')
    await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })
    expect((await call(create, { title: 'T2', prompt: 'p', after_seconds: 60 })).code).toBe('limit_reached')
    expect(store.all()).toHaveLength(1)
  })

  it('answers no_chat outside a chat turn', async () => {
    const { create } = tools()
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, undefined)).code).toBe('no_chat')
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 }, 'subagent')).code).toBe('no_chat')
    turn = undefined
    expect((await call(create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('no_chat')
    expect(store.all()).toEqual([])
  })

  it('updates and deletes only for the creator or a super admin, and only in the same chat', async () => {
    const { create, update, remove } = tools()
    turn = { sender: { ...member, id: 11 }, isGroup: true }
    await call(create, { title: 'Mine', prompt: 'p', daily: { time: '07:00:00' } })
    turn = { sender: member, isGroup: true }
    expect((await call(update, { id: 'r1', title: 'Hijack' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' })).code).toBe('forbidden')
    expect((await call(remove, { id: 'r1' }, 'agent-6')).code).toBe('schedule_not_found')
    turn = { sender: admin, isGroup: true }
    expect(await call(update, { id: 'r1', title: 'Renamed', weekly: { time: '09:00:00', weekdays: [1] } })).toMatchObject({
      id: 'r1', title: 'Renamed', kind: 'weekly', scheduledAt: '2026-10-05T02:00:00.000Z',
    })
    expect((await call(update, { id: 'r1', after_seconds: 60 })).code).toBe('invalid_rule')
    expect(await call(remove, { id: 'r1' })).toEqual({ id: 'r1', deleted: true })
    expect((await call(remove, { id: 'r1' })).code).toBe('schedule_not_found')
    expect(changes).toBe(3)
  })

  it('reports storage_failed when the store cannot be written', async () => {
    await writeFile(join(dir, 'blocker'), 'x')
    // No load(): reading a path under a file fails with ENOTDIR; an unloaded store starts empty.
    store = new ReminderStore(join(dir, 'blocker', 'schedule.json'))
    expect((await call(tools().create, { title: 'T', prompt: 'p', after_seconds: 60 })).code).toBe('storage_failed')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/schedule-tools.spec.ts`
Expected: FAIL, cannot resolve `../src/schedule-tools.ts`.

- [ ] **Step 3: Implement `src/schedule-tools.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TelegramUser } from './inbound.ts'
import { buildRecord, canManage, displayName, ReminderError, reminderView, retitle, type Reminder, type ReminderMode, type TimingInput } from './schedule.ts'
import type { ReminderStore } from './schedule-store.ts'
import type { TelegramService } from './service.ts'

export interface ScheduleToolDeps {
  telegram: Pick<TelegramService, 'chatOf' | 'turnOf' | 'superAdmins'>
  store: ReminderStore
  timeZone: string
  maxPerChat: number
  /** Called after every committed change, so the timer can re-arm. */
  changed: () => void
  now?: () => number
  newId?: () => string
}

const ZONE = { type: 'string', description: 'IANA time zone; defaults to the bot zone' } as const
const TIMING = {
  after_seconds: { type: 'integer', description: 'One-shot: seconds from now' },
  at: { type: 'string', description: 'One-shot: ISO 8601 instant with offset, e.g. 2026-10-05T08:00:00+07:00' },
  every_seconds: { type: 'integer', description: 'Repeat every N seconds (at least 60)' },
  daily: {
    type: 'object', description: 'Every day at a local time',
    properties: { time: { type: 'string', required: true, description: 'HH:mm:ss' }, time_zone: ZONE },
  },
  weekly: {
    type: 'object', description: 'Weekly at a local time',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss' },
      weekdays: { type: 'array', items: { type: 'integer' }, required: true, description: 'ISO weekdays, Monday 1 to Sunday 7' },
      time_zone: ZONE,
    },
  },
  cron: {
    type: 'object', description: 'Five-field cron: minute hour day-of-month month day-of-week',
    properties: { expression: { type: 'string', required: true, description: 'e.g. 0 9 * * 1-5' }, time_zone: ZONE },
  },
} as const
const JSON_OUTPUT = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

function timingOf(args: TimingInput): TimingInput {
  const timing: TimingInput = {}
  for (const key of ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const) {
    if (args[key] !== undefined) Object.assign(timing, { [key]: args[key] })
  }
  return timing
}

/** Resolves the calling chat and sender, runs `body`, and renders the result or a `{ code, message }` failure as JSON. */
async function inChat(deps: ScheduleToolDeps, exec: ToolRunContext, body: (chatId: number, sender: TelegramUser) => Promise<unknown>): Promise<string> {
  try {
    const chatId = exec.agent === undefined ? undefined : deps.telegram.chatOf(String(exec.agent.id))
    const turn = chatId === undefined ? undefined : deps.telegram.turnOf(chatId)
    if (chatId === undefined || turn === undefined) throw new ReminderError('no_chat', 'reminders can only be managed from a chat turn')
    return JSON.stringify(await body(chatId, turn.sender))
  } catch (error) {
    if (error instanceof ReminderError) return JSON.stringify({ code: error.code, message: error.message })
    throw error
  }
}

/** Store changes report a failed write as storage_failed; a ReminderError from the change itself passes through. */
async function commit<T>(deps: ScheduleToolDeps, change: (reminders: Reminder[]) => T): Promise<T> {
  let result: T
  try {
    result = await deps.store.update(change)
  } catch (error) {
    if (error instanceof ReminderError) throw error
    throw new ReminderError('storage_failed', `the reminder could not be saved: ${error instanceof Error ? error.message : String(error)}`)
  }
  deps.changed()
  return result
}

/** The chat's reminder with this id, or schedule_not_found (another chat's reminder counts as missing). */
function find(reminders: Reminder[], chatId: number, id: string): number {
  const index = reminders.findIndex(r => r.chatId === chatId && r.record.id === id)
  if (index < 0) throw new ReminderError('schedule_not_found', `no reminder ${id} in this chat`)
  return index
}

function assertCanManage(deps: ScheduleToolDeps, reminder: Reminder, sender: TelegramUser): void {
  if (!canManage(reminder, sender.id, deps.telegram.superAdmins)) {
    throw new ReminderError('forbidden', 'only the creator or a super admin can change this reminder')
  }
}

export function createScheduleTools(deps: ScheduleToolDeps): ToolDefinition[] {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => randomUUID().slice(0, 8))

  const create = defineTool({
    name: 'schedule_create',
    description: 'Create a reminder in this chat. mode "message" sends the prompt as a message when due; mode "agent" (super admins only) runs the prompt as an instruction. Give exactly one timing field.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short name, at most 120 characters' },
      prompt: { type: 'string', required: true, description: 'Message text, or the instruction for mode "agent"' },
      mode: { type: 'string', enum: ['message', 'agent'], description: 'Defaults to "message"' },
      ...TIMING,
    },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => {
      const mode: ReminderMode = args.mode === 'agent' ? 'agent' : 'message'
      if (mode === 'agent' && !deps.telegram.superAdmins.includes(sender.id)) {
        throw new ReminderError('forbidden', 'only super admins can create agent reminders')
      }
      const record = buildRecord(newId(), args.title, args.prompt, timingOf(args as TimingInput), now(), deps.timeZone)
      const reminder: Reminder = { chatId, creator: { id: sender.id, name: displayName(sender) }, mode, record }
      await commit(deps, (reminders) => {
        if (reminders.filter(r => r.chatId === chatId).length >= deps.maxPerChat) {
          throw new ReminderError('limit_reached', `this chat already has ${deps.maxPerChat} reminders; delete one first`)
        }
        reminders.push(reminder)
      })
      return reminderView(reminder)
    }),
  })

  const list = defineTool({
    name: 'schedule_list',
    description: 'List the reminders of this chat.',
    parameters: {},
    output: JSON_OUTPUT,
    execute: (_args, exec) => inChat(deps, exec, async chatId => deps.store.all().filter(r => r.chatId === chatId).map(reminderView)),
  })

  const { after_seconds: _after, ...UPDATE_TIMING } = TIMING
  const update = defineTool({
    name: 'schedule_update',
    description: 'Change the title, prompt or timing of a reminder in this chat (creator or super admins). A timing change re-anchors from now; after_seconds is not accepted.',
    parameters: {
      id: { type: 'string', required: true, description: 'Reminder id' },
      title: { type: 'string', description: 'New title' },
      prompt: { type: 'string', description: 'New message or instruction' },
      after_seconds: { type: 'integer', description: 'Not accepted for updates' },
      ...UPDATE_TIMING,
    },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => {
      if (args.after_seconds !== undefined) throw new ReminderError('invalid_rule', 'after_seconds cannot be used to update a reminder; use at')
      const timing = timingOf(args as TimingInput)
      const changes = { ...(args.title === undefined ? {} : { title: args.title }), ...(args.prompt === undefined ? {} : { prompt: args.prompt }) }
      return commit(deps, (reminders) => {
        const index = find(reminders, chatId, args.id)
        const current = reminders[index]!
        assertCanManage(deps, current, sender)
        const titled = retitle(current.record, changes)
        const record = Object.keys(timing).length === 0
          ? titled
          : buildRecord(current.record.id, titled.title, titled.prompt, timing, now(), deps.timeZone)
        reminders[index] = { ...current, record }
        return reminderView(reminders[index]!)
      })
    }),
  })

  const remove = defineTool({
    name: 'schedule_delete',
    description: 'Delete a reminder in this chat (creator or super admins).',
    parameters: { id: { type: 'string', required: true, description: 'Reminder id' } },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => commit(deps, (reminders) => {
      const index = find(reminders, chatId, args.id)
      assertCanManage(deps, reminders[index]!, sender)
      reminders.splice(index, 1)
      return { id: args.id, deleted: true }
    })),
  })

  return [create, list, update, remove]
}
```

If `defineTool` rejects one of the parameter shapes at typecheck (nested `required`, `as const` spreads), adjust the literal to the shape `ParameterSchemaSpec` in `@deepseek-ai/dsh-tools/lib/types/schema.d.ts` accepts and ledger the ruling; the tool names and argument names must stay as written.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tests/schedule-tools.spec.ts && pnpm run typecheck`
Expected: PASS (7 tests), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/schedule-tools.ts packages/dsh-telegram/tests/schedule-tools.spec.ts
git commit -m "feat(telegram): reminder tools with per-chat permissions"
```

---

### Task 5: Delivery, plugin and bundle row

**Files:**
- Create: `packages/dsh-telegram/src/schedule-delivery.ts`
- Create: `packages/dsh-telegram/src/schedule-plugin.ts`
- Modify: `packages/dsh-telegram/cordis.patch.yml` (row `telegram-schedule`)
- Modify: `packages/dsh-telegram/package.json` (`exports["./schedule"]`)
- Modify: `README.md` (Behaviour bullet)
- Test: `packages/dsh-telegram/tests/schedule-delivery.spec.ts`, `packages/dsh-telegram/tests/schedule-plugin.spec.ts`, `packages/dsh-telegram/tests/profile.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`dueReminders`, `nextDueAt`, `afterDelivery`, `reminderMessage`, `agentPrompt`), Task 3 (`ReminderStore`), Task 4 (`createScheduleTools`), Task 1 service fields.
- Produces:
  - `startScheduler(deps: SchedulerDeps): SchedulerHandle` with `SchedulerDeps = { store; telegram: Pick<TelegramService, 'api' | 'chatLog' | 'bot' | 'superAdmins' | 'prompt'>; log: { info(m: string): void; warn(m: string): void }; now?: () => number }` and `SchedulerHandle = { changed(): void; tick(): Promise<void>; stop(): void }`.
  - Plugin module `src/schedule-plugin.ts`: `name = 'dsh-telegram-schedule'`, `interface ScheduleConfig { timeZone: string; maxPerChat: number }`, `Config`, `assertScheduleConfig`, `apply`.

- [ ] **Step 1: Write the failing delivery test**

Create `packages/dsh-telegram/tests/schedule-delivery.spec.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { buildRecord, type Reminder } from '../src/schedule.ts'
import { startScheduler } from '../src/schedule-delivery.ts'
import { ReminderStore } from '../src/schedule-store.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

const NOW = Date.parse('2026-10-04T01:00:00Z')
let dir: string
let api: FakeTelegramApi
let chatLog: ChatLog
let store: ReminderStore
let prompts: Array<{ chatId: number; text: string; sender: { id: number } }>
let infos: string[]
let warns: string[]
let now: number
let superAdmins: number[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-delivery-'))
  api = new FakeTelegramApi()
  chatLog = new ChatLog(join(dir, 'log'))
  store = new ReminderStore(join(dir, 'schedule.json'))
  store.load()
  prompts = []
  infos = []
  warns = []
  now = NOW
  superAdmins = [7]
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function scheduler() {
  return startScheduler({
    store,
    telegram: { api, chatLog, bot: { id: 1, username: 'dshbot' }, superAdmins, prompt: (chatId, input) => { prompts.push({ chatId, ...input }) } },
    log: { info: m => infos.push(m), warn: m => warns.push(m) },
    now: () => now,
  })
}
async function add(id: string, timing: Parameters<typeof buildRecord>[3], extra: Partial<Reminder> = {}): Promise<void> {
  const reminder: Reminder = { chatId: 5, creator: { id: 7, name: '@ann' }, mode: 'message', record: buildRecord(id, `T${id}`, `p${id}`, timing, NOW, 'Asia/Ho_Chi_Minh'), ...extra }
  await store.update(list => list.push(reminder))
}

describe('startScheduler', () => {
  it('sends a due message reminder, logs it, and drops a one-shot', async () => {
    await add('a', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(api.callsTo('sendMessage')[0]!.args.slice(0, 2)).toEqual([5, '\u{23F0} Ta\npa'])
    expect((await chatLog.readAll(5))[0]).toMatchObject({ bot: true, text: '\u{23F0} Ta\npa', user_id: 1 })
    expect(store.all()).toEqual([])
    expect(infos).toContain('dsh-telegram: chat 5 reminder a -> message')
    s.stop()
  })

  it('delivers several due reminders in scheduledAt order', async () => {
    await add('late', { after_seconds: 120 })
    await add('early', { after_seconds: 60 })
    const s = scheduler()
    now = NOW + 120_000
    await s.tick()
    expect(api.callsTo('sendMessage').map(c => c.args[1])).toEqual(['\u{23F0} Tearly\npearly', '\u{23F0} Tlate\nplate'])
    s.stop()
  })

  it('delivers a stale recurring reminder once and advances it', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    const s = scheduler()
    now = Date.parse('2026-10-07T00:00:01Z')
    await s.tick()
    expect(api.callsTo('sendMessage')).toHaveLength(1)
    expect(store.all()[0]!.record.scheduledAt).toBe('2026-10-08T00:00:00.000Z')
    s.stop()
  })

  it('runs an agent reminder as a prompt from its creator', async () => {
    await add('g', { after_seconds: 60 }, { mode: 'agent' })
    const s = scheduler()
    now = NOW + 60_000
    await s.tick()
    expect(prompts).toEqual([{
      chatId: 5,
      text: '<scheduled_reminder title="Tg" created_by="@ann">\npg\n</scheduled_reminder>',
      sender: { id: 7, is_bot: false, first_name: '@ann' },
    }])
    expect(infos).toContain('dsh-telegram: chat 5 reminder g -> agent')
    s.stop()
  })

  it('stops an agent reminder whose creator lost super admin', async () => {
    await add('g', { daily: { time: '07:00:00' } }, { mode: 'agent' })
    superAdmins.length = 0
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(prompts).toEqual([])
    expect(store.all()).toEqual([])
    expect(String(api.callsTo('sendMessage')[0]!.args[1])).toMatch(/Stopped reminder "Tg"/)
    s.stop()
  })

  it('skips a reminder deleted or re-timed after the timer was armed', async () => {
    await add('a', { after_seconds: 60 })
    await add('b', { after_seconds: 60 })
    const s = scheduler()
    await store.update(list => list.splice(0, 1))
    await store.update((list) => { list[0] = { ...list[0]!, record: buildRecord('b', 'Tb', 'pb', { after_seconds: 600 }, NOW, 'UTC') } })
    now = NOW + 60_000
    await s.tick()
    expect(api.callsTo('sendMessage')).toHaveLength(0)
    s.stop()
  })

  it('logs a failed send and keeps the next occurrence', async () => {
    await add('d', { daily: { time: '07:00:00' } })
    api.failNext('sendMessage', new Error('Forbidden: bot was kicked'))
    const s = scheduler()
    now = Date.parse('2026-10-05T00:00:01Z')
    await s.tick()
    expect(warns[0]).toMatch(/chat 5 reminder d failed: .*kicked/)
    expect(store.all()[0]!.record.scheduledAt).toBe('2026-10-06T00:00:00.000Z')
    s.stop()
  })

  it('arms one timer for the earliest reminder and clears it on stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await add('a', { after_seconds: 60 })
    const s = scheduler()
    expect(vi.getTimerCount()).toBe(1)
    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

`FakeTelegramApi.failNext(method, error)` (already in `tests/helpers/fake-api.ts`) makes the next call to that method throw.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/schedule-delivery.spec.ts`
Expected: FAIL, cannot resolve `../src/schedule-delivery.ts`.

- [ ] **Step 3: Implement `src/schedule-delivery.ts`**

```ts
import { afterDelivery, agentPrompt, dueReminders, nextDueAt, reminderMessage, type Reminder } from './schedule.ts'
import type { ReminderStore } from './schedule-store.ts'
import type { TelegramService } from './service.ts'

/** Node keeps timers in a signed 32-bit millisecond field; longer waits are re-armed in steps. */
const MAX_DELAY_MS = 2_147_483_647

export interface SchedulerDeps {
  store: ReminderStore
  telegram: Pick<TelegramService, 'api' | 'chatLog' | 'bot' | 'superAdmins' | 'prompt'>
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
}

export interface SchedulerHandle {
  /** Re-arms the timer after a change to the store. */
  changed(): void
  /** Delivers every due reminder now; the timer calls it. */
  tick(): Promise<void>
  stop(): void
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { store, telegram, log } = deps
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const at = nextDueAt(store.all())
    if (stopped || at === undefined) return
    timer = setTimeout(() => { void tick() }, Math.min(Math.max(at - now(), 0), MAX_DELAY_MS))
  }

  /** Advances or drops the reminder first, then sends: a crash in between loses one delivery, never duplicates it. */
  const deliver = async (id: string): Promise<void> => {
    let due: Reminder | undefined
    let revoked = false
    await store.update((reminders) => {
      const index = reminders.findIndex(r => r.record.id === id)
      const current = reminders[index]
      if (current === undefined || Date.parse(current.record.scheduledAt) > now()) return
      due = current
      revoked = current.mode === 'agent' && !telegram.superAdmins.includes(current.creator.id)
      const next = revoked ? undefined : afterDelivery(current, now())
      if (next === undefined) reminders.splice(index, 1)
      else reminders[index] = next
    })
    const reminder = due
    if (reminder === undefined) return
    const { chatId } = reminder
    if (revoked) {
      await telegram.api.sendMessage(chatId, `Stopped reminder "${reminder.record.title}": its creator is no longer a super admin.`)
    } else if (reminder.mode === 'message') {
      const text = reminderMessage(reminder)
      const sent = await telegram.api.sendMessage(chatId, text)
      await telegram.chatLog.append(chatId, {
        ts: new Date(now()).toISOString(), message_id: sent.messageId, user_id: telegram.bot.id, name: telegram.bot.username, text, bot: true,
      })
    } else {
      telegram.prompt(chatId, { text: agentPrompt(reminder), sender: { id: reminder.creator.id, is_bot: false, first_name: reminder.creator.name } })
    }
    log.info(`dsh-telegram: chat ${chatId} reminder ${reminder.record.id} -> ${revoked ? 'stopped' : reminder.mode}`)
  }

  const tick = (): Promise<void> => {
    running = running.then(async () => {
      for (const reminder of dueReminders(store.all(), now())) {
        if (stopped) return
        try {
          await deliver(reminder.record.id)
        } catch (error) {
          log.warn(`dsh-telegram: chat ${reminder.chatId} reminder ${reminder.record.id} failed: ${errorText(error)}`)
        }
      }
    }).finally(arm)
    return running
  }

  arm()
  return {
    changed: arm,
    tick,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
```

- [ ] **Step 4: Run the delivery tests**

Run: `pnpm vitest run tests/schedule-delivery.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing plugin and profile tests**

Create `packages/dsh-telegram/tests/schedule-plugin.spec.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import * as schedulePlugin from '../src/schedule-plugin.ts'
import { Config } from '../src/schedule-plugin.ts'
import type { TelegramService } from '../src/service.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

/** `FiberState` is a const enum that Cordis does not export at runtime. */
const ACTIVE = 2
const FAILED = 3

let dir: string
let root: Context
let registered: string[]
let disposed: string[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schedule-plugin-'))
  registered = []
  disposed = []
  root = new Context()
  root.provide('tools', {
    register: (tool: { name: string }) => { registered.push(tool.name); return () => { disposed.push(tool.name) } },
  })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function service(): TelegramService {
  return {
    api: new FakeTelegramApi(), chatLog: new ChatLog(join(dir, 'log')), queue: { enqueue: () => {}, isBusy: () => false },
    bot: { id: 1, username: 'dshbot' }, selection: { provider: 'p', model: 'm' }, dataDir: dir, superAdmins: [7],
    chatOf: () => undefined, turnOf: () => undefined, prompt: () => {},
  }
}

describe('schedule Config', () => {
  it('fills defaults', () => {
    expect(Config({})).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })
})

describe('schedule plugin', () => {
  it('stays inert without the telegram service', async () => {
    const fiber = root.plugin(schedulePlugin, Config({}))
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    expect(registered).toEqual([])
  })

  it('rejects an invalid config at load, before the bot provides telegram', async () => {
    const badZone = root.plugin(schedulePlugin, { timeZone: 'Mars/Olympus', maxPerChat: 20 })
    const badMax = root.plugin(schedulePlugin, { timeZone: 'UTC', maxPerChat: 0 })
    await vi.waitFor(() => expect([badZone.state, badMax.state]).toEqual([FAILED, FAILED]))
  })

  it('registers the four tools while telegram is provided and removes them on revoke', async () => {
    root.plugin(schedulePlugin, Config({}))
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(registered).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']))
    revoke()
    await vi.waitFor(() => expect(disposed).toHaveLength(4))
  })

  it('does not start on a corrupted schedule.json and leaves it untouched', async () => {
    await writeFile(join(dir, 'schedule.json'), '{broken')
    root.plugin(schedulePlugin, Config({}))
    root.provide('telegram', service())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(registered).toEqual([])
    expect(await readFile(join(dir, 'schedule.json'), 'utf8')).toBe('{broken')
  })
})
```

In `packages/dsh-telegram/tests/profile.spec.ts`, add at the end of `describe('profile patch', ...)`:

```ts
  it('mounts the reminder plugin with the local zone', async () => {
    const reminders = row(await rows('../cordis.patch.yml'), 'telegram-schedule')
    expect(reminders.name).toBe('dsh-telegram/schedule')
    expect(reminders.config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run tests/schedule-plugin.spec.ts tests/profile.spec.ts`
Expected: FAIL: cannot resolve `../src/schedule-plugin.ts`; the profile test fails reading `name` of an undefined row.

- [ ] **Step 7: Implement `src/schedule-plugin.ts`**

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { startScheduler } from './schedule-delivery.ts'
import { ReminderStore } from './schedule-store.ts'
import { createScheduleTools } from './schedule-tools.ts'
import type {} from './service.ts'

export interface ScheduleConfig {
  /** Zone for daily, weekly and cron rules that name none. */
  readonly timeZone: string
  readonly maxPerChat: number
}

export const Config: z<ScheduleConfig> = z.object({
  timeZone: z.string().default('Asia/Ho_Chi_Minh'),
  maxPerChat: z.number().min(1).default(20),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertScheduleConfig(config: ScheduleConfig): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`dsh-telegram: schedule.timeZone must be an IANA time zone, got ${config.timeZone}`)
  }
}

/** Cordis plugin name. */
export const name = 'dsh-telegram-schedule'

/**
 * Injects nothing itself, so Cordis validates the config at load even when the bot never starts;
 * the store, timer and tools live while the bot provides `telegram`.
 */
export function apply(ctx: Context, config: ScheduleConfig): void {
  assertScheduleConfig(config)
  ctx.inject(['telegram', 'tools'], (ctx) => {
    const logger = ctx.logger('dsh-telegram')
    const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) }
    const store = new ReminderStore(join(ctx.telegram.dataDir, 'schedule.json'))
    // A corrupted file throws here: this fiber fails and the file stays as it was.
    store.load()
    const scheduler = startScheduler({ store, telegram: ctx.telegram, log })
    ctx.effect(() => () => scheduler.stop(), 'dsh-telegram: reminder timer')
    const tools = createScheduleTools({
      telegram: ctx.telegram, store, timeZone: config.timeZone, maxPerChat: config.maxPerChat, changed: scheduler.changed,
    })
    for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `dsh-telegram: ${tool.name}`)
  })
}
```

- [ ] **Step 8: Mount the plugin**

In `packages/dsh-telegram/cordis.patch.yml`, append to `insert:` after the `telegram-idle` row, at the same indentation:

```yaml

    - id: telegram-schedule
      name: dsh-telegram/schedule
      config:
        timeZone: Asia/Ho_Chi_Minh
        maxPerChat: 20
```

In `packages/dsh-telegram/package.json` `exports`, after the `"./idle"` entry:

```json
    "./schedule": {
      "types": "./lib/schedule-plugin.d.ts",
      "default": "./lib/schedule-plugin.js"
    },
```

In `README.md` `## Behaviour`, after the `time-context` bullet:

```markdown
- The agent can set reminders with `schedule_create` (one-shot, every N seconds, daily, weekly or cron), list, update and delete them; they live in `./data/schedule.json`. A reminder either sends its text or, when a super admin creates it with `mode: agent`, runs it as an instruction. Only the creator or a super admin can change one; each chat holds at most `maxPerChat` (20) on the `telegram-schedule` row.
```

- [ ] **Step 9: Full verification**

Run: `pnpm test && pnpm run typecheck && pnpm run build && ls lib/schedule-plugin.js lib/schedule-delivery.js`
Expected: all tests PASS, typecheck and build exit 0, both files listed.

- [ ] **Step 10: Commit**

```bash
git add packages/dsh-telegram/src/schedule-delivery.ts packages/dsh-telegram/src/schedule-plugin.ts packages/dsh-telegram/tests/schedule-delivery.spec.ts packages/dsh-telegram/tests/schedule-plugin.spec.ts packages/dsh-telegram/tests/profile.spec.ts packages/dsh-telegram/cordis.patch.yml packages/dsh-telegram/package.json README.md
git commit -m "feat(telegram): deliver reminders from the telegram-schedule plugin"
```
