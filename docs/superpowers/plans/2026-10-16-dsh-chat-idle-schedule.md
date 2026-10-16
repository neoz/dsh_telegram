# dsh-chat Plan B: shared idle and schedule, Zalo stickers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `dsh-telegram/idle` and `dsh-telegram/schedule` into channel-agnostic `dsh-chat/idle` and `dsh-chat/schedule` plugins that run on the `chat` router, and turn them on for Zalo, whose `react` intent becomes a sticker.

**Architecture:** Both plugins inject `chat` and act through `ctx.chat.channel(id).send/react`, `ctx.chat.enqueue` and `ctx.chat.prompt`, keyed by `chatKey`. Idle runs one scheduler per channel named in its `chatKeys`, writing `<dataDir>/<channel>/idle-decisions.jsonl`; schedule keeps one reminder file per channel, `<dataDir>/<channel>/schedule.json`, and normalizes the old Telegram file on load. `dsh-telegram` loses its idle, schedule and `TelegramService`; `dsh-zalo` gains `sendSticker` and a `stickers` map.

**Tech Stack:** TypeScript 6 (nodenext, `.ts` imports), Cordis 4, Schemastery, Vitest 4, pnpm 10 workspace, `@deepseek-ai/dsh-schedule`, `@deepseek-ai/dsh-llm`.

**Spec:** `docs/superpowers/specs/2026-10-16-dsh-chat-plugin-core-design.md` (rollout step 4, Amendment 1 sections "Logging what was posted", "Idle", "Schedule", "Zalo stickers").

## Global Constraints

- Prompt cache: the idle decision system prompt (`idleSystemPrompt(persona, model)`), the decision context rendering in `engage.ts` and the allowed emoji list stay byte-identical; `burst.ts` and `engage.ts` move unchanged.
- Whoever calls `send` or `react` appends a bot line to the chat log when `Delivered.messageId` is set, with `Delivered.text` as the text, `user_id`/`name` from `channel.bot`.
- No emoji literals in code or data: use `\u{...}` in TypeScript and `"\U0001F44D"` style escapes in YAML.
- `chatKey = "<channel>:<id>"`; user keys likewise; router `superAdmins` holds user keys.
- Every repository text is English; no new `.md` files beyond this plan.
- Plugins follow the existing pattern (`name`, `inject` or `ctx.inject`, Schemastery `Config`, `apply`).
- Run from `D:\working\nodejs\dsh`. After changing `dsh-chat`, run `pnpm --filter dsh-chat run build` before adapter tests.

## Clarifications (decided while planning)

- Reminders keep `chatKey` (not a bare `chatId`), `isGroup` and `creator.id` as a user key, both in memory and in `<channel>/schedule.json`. The old Telegram form (`chatId: number`, numeric `creator.id`, no `isGroup`) is normalized on load and rewritten on the next save; `isGroup` for an old reminder is `chatId < 0`.
- A reminder whose channel is offline when due is left untouched and retried after the failure delay, instead of being advanced and lost.
- Schedule keeps today's logging: a message reminder is logged as a bot line; the "Stopped reminder" notice is not.
- Idle reads saved context photos of any type the adapters save (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`), so Zalo photos reach the decision too. Telegram only saves `.jpg`, so its behavior is unchanged.
- One idle config serves every channel in the process (one persona). Today each image runs one channel, so each profile restates the row with its own persona.
- The idle decision log keeps its line shape; `chatId` becomes the channel's string id and `decision` lines gain `as`.

## Review Focus

1. A Telegram `schedule.json` written by the old code (numeric ids, no `isGroup`) loads, delivers to the right chat and keeps working after a save (test in Task 3).
2. A due reminder while its channel is offline is not lost (test in Task 3).
3. An emoji with a variation selector (`\u{2764}\u{FE0F}`) still finds its sticker (test in Task 1).
4. Idle on a channel that goes offline mid-decision records an error decision instead of throwing out of the queue (test in Task 2).
5. A Zalo sticker reaction is logged, so the next idle decision sees the bot already answered (test in Task 2).

---

### Task 1: Zalo stickers

**Files:**
- Modify: `packages/dsh-zalo/src/zalo-api.ts` (add `sendSticker`), `src/config.ts` (add `stickers`), `src/channel.ts` (`react`)
- Modify: `packages/dsh-zalo/tests/helpers/fake-api.ts`
- Test: `packages/dsh-zalo/tests/zalo-api.spec.ts`, `tests/channel.spec.ts`, `tests/config.spec.ts`

**Interfaces:**
- Produces: `ZaloApi.sendSticker(chatId: string, sticker: string): Promise<{ messageId: string }>`; `Config.stickers: Record<string, string>` (default `{}`); `ZaloChannelDeps.config` picks `stickers` too.

- [ ] **Step 1: Failing tests.** In `tests/zalo-api.spec.ts` add a case modeled on its existing `sendMessage` case: `sendSticker('c1', 'abc')` posts to `/bot<token>/sendSticker` with JSON body `{ chat_id: 'c1', sticker: 'abc' }` and returns the `message_id` of the result as `messageId`. In `tests/channel.spec.ts` replace the "reacts by posting the emoji as text" case with:

```ts
  it('reacts with the mapped sticker, ignoring the variation selector, and logs it as a sticker', async () => {
    const api = new FakeZaloApi()
    const ch = channel(api, { stickers: { '\u{2764}': 'heart1', '\u{1F44D}': 'like1' } })
    expect(await ch.react('c1', 'm1', '\u{2764}\u{FE0F}')).toEqual({ as: 'fallback', messageId: 'm100', text: '[sticker \u{2764}]' })
    expect(api.callsTo('sendSticker')[0]!.args).toEqual(['c1', 'heart1'])
  })

  it('sends an emoji without a sticker as text', async () => {
    const api = new FakeZaloApi()
    expect(await channel(api).react('c1', 'm1', '\u{1F525}')).toEqual({ as: 'fallback', messageId: 'm100', text: '\u{1F525}' })
    expect(api.callsTo('sendSticker')).toHaveLength(0)
  })
```

In `tests/config.spec.ts` add `stickers: {}` to the defaults expectation. Add to `FakeZaloApi`:

```ts
  async sendSticker(chatId: string, sticker: string) {
    this.record('sendSticker', [chatId, sticker])
    return { messageId: `m${this.nextId++}` }
  }
```

- [ ] **Step 2: Run** `pnpm --filter dsh-zalo exec vitest run tests/zalo-api.spec.ts tests/channel.spec.ts tests/config.spec.ts`. Expected: FAIL on `sendSticker` and `stickers`.

- [ ] **Step 3: Implement.** In `ZaloApi` add `sendSticker(chatId: string, sticker: string): Promise<{ messageId: string }>`, implemented next to `sendMessage` with the same `call` helper and result handling, method `'sendSticker'`, body `{ chat_id: chatId, sticker }`, non-idempotent like `sendMessage`. In `Config` add:

```ts
  /** Emoji to Zalo sticker id, for reactions; Zalo has no native reactions. */
  readonly stickers: Record<string, string>
```

with `stickers: z.dict(z.string()).default({})`. In `channel.ts` change `config: Pick<Config, 'messageSize' | 'typingIntervalMs' | 'stickers'>` and `react`:

```ts
const plain = (emoji: string) => emoji.replaceAll('\u{FE0F}', '')

    // Zalo has no reactions: a mapped sticker stands in, any other emoji is posted as text.
    async react(chatId, _messageId, emoji) {
      const wanted = plain(emoji)
      const sticker = Object.entries(deps.config.stickers).find(([key]) => plain(key) === wanted)?.[1]
      if (sticker === undefined) {
        const sent = await deps.api.sendMessage(chatId, wanted)
        return { as: 'fallback', messageId: sent.messageId, text: wanted }
      }
      const sent = await deps.api.sendSticker(chatId, sticker)
      return { as: 'fallback', messageId: sent.messageId, text: `[sticker ${wanted}]` }
    },
```

- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter dsh-zalo exec vitest run` and `pnpm --filter dsh-zalo run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(zalo): react with mapped stickers through sendSticker`.

---

### Task 2: `dsh-chat/idle`

**Files:**
- Create: `packages/dsh-chat/src/idle/burst.ts`, `engage.ts` (copies of `packages/dsh-telegram/src/idle/burst.ts`, `engage.ts`, byte for byte), `scheduler.ts`, `index.ts`
- Modify: `packages/dsh-chat/package.json` (export `./idle`)
- Test: `packages/dsh-chat/tests/idle/burst.spec.ts`, `engage.spec.ts` (copies, imports fixed), `scheduler.spec.ts`, `plugin.spec.ts` (ported)

**Interfaces:**
- Consumes: `ChatChannel`, `Delivered`, `ImageStore`, `ChatLog`, `ChatLogEntry`, `chatKey`, `splitKey`; services `chat`, `chatData`, `chatAgents`, `chatLog`, `llm`, `attachments`; events `chat/turn`, `chat/message`.
- Produces:
  - `IdleConfig` as today with `chatIds: number[]` replaced by `chatKeys: string[]`.
  - `startIdle(deps: IdleDeps): IdleHandle` where `IdleDeps` is today's with `api`, `chatLog` key, `queue`, `botId`, `botUsername` replaced by `channel: string`, `chatIds: string[]`, `chat: { channel(id: string): ChatChannel | undefined; enqueue(key: string, task: () => Promise<void>): void }`; handle methods take `chatId: string`.
  - `IdleEvent` with `chatId: string` and `as?: 'native' | 'fallback'` on `decision`; `start` carries `chatIds: string[]`.
  - Plugin `name = 'dsh-chat-idle'`, `Config`, `assertIdleConfig`, `apply`.

- [ ] **Step 1: Copy the unchanged modules and their tests.** `cp packages/dsh-telegram/src/idle/{burst,engage}.ts packages/dsh-chat/src/idle/` and `cp packages/dsh-telegram/tests/idle/{burst,engage}.spec.ts packages/dsh-chat/tests/idle/`. Fix only imports: anything from `'dsh-chat'` becomes the relative `../log/chatlog.ts` / `../keys.ts` path inside dsh-chat; `IdleConfig` still comes from `./index.ts`. Run `pnpm --filter dsh-chat exec vitest run tests/idle/burst.spec.ts tests/idle/engage.spec.ts` once `index.ts` exists (Step 3); until then they fail on the missing `index.ts`.

- [ ] **Step 2: Port the scheduler tests (failing).** Copy `packages/dsh-telegram/tests/idle/scheduler.spec.ts` to `packages/dsh-chat/tests/idle/scheduler.spec.ts` and convert:
  - `CHAT = '-5'`; every `chatKey('telegram', CHAT)` stays; `human()` unchanged.
  - `Config({ ... chatIds: [CHAT] ... })` becomes `Config({ ... chatKeys: [chatKey('telegram', CHAT)] ... })`.
  - Replace `FakeTelegramApi` with `FakeChannel` from `../router/fake-channel.ts` (`telegram = new FakeChannel('telegram')`), and `start()` with:

```ts
function start(answer = '{"action":"reply","message_id":5,"text":"hehe"}', extra: Partial<IdleDeps> = {}): IdleHandle {
  const fake = fakeLlm(answer)
  calls = fake.calls
  return startIdle({
    config: base, channel: 'telegram', chatIds: [CHAT], provider: 'p', model: 'm', llm: fake.llm, chatLog,
    chat: { channel: id => (id === 'telegram' && online ? telegram : undefined), enqueue: (key, task) => { tasks.push({ key, task }) } },
    log: { info: () => {}, warn: m => warns.push(m) },
    now: () => NOW, random: () => 0, record: e => events.push(e), ...extra,
  })
}
```

  with `let online = true` reset in `beforeEach`, and `tasks: Array<{ key: string; task: () => Promise<void> }>`. The "real chat queue" case enqueues through `new ChatQueue(() => {})` via `chat: { channel: ..., enqueue: (key, task) => chatQueue.enqueue(key, task) }`.
  - Assertions on `api.callsTo('setReaction')` become `telegram.reactions`; on `api.callsTo('sendMessage')` become `telegram.sent` (`{ chatId, text, replyTo }`).
  - `decisions()` results gain `as: 'native'` for `react` and `reply`.
  - Add the two new cases:

```ts
  it('logs a reaction that posted a message, so the next decision sees the bot answered', async () => {
    telegram.react = async (chatId, messageId, emoji) => {
      telegram.reactions.push({ chatId, messageId, emoji })
      return { as: 'fallback', messageId: 'st1', text: '[sticker \u{1F44D}]' }
    }
    const idle = start('{"action":"react","message_id":5,"emoji":"\u{1F44D}"}')
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    await runQueued()
    const last = (await chatLog.readAll(chatKey('telegram', CHAT))).at(-1)!
    expect(last).toMatchObject({ message_id: 'st1', text: '[sticker \u{1F44D}]', reply_to: '5', bot: true, user_id: 'telegram-bot', name: 'telegrambot' })
    expect(decisions().at(-1)).toMatchObject({ action: 'react', as: 'fallback' })
  })

  it('records an error decision when the channel is offline at engagement time', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    online = false
    await runQueued()
    expect(decisions().at(-1)).toMatchObject({ action: 'reply', error: expect.stringContaining('offline') })
    expect(telegram.sent).toEqual([])
  })

  it('admits a png context photo with its own media type', async () => {
    const photo = join(dir, 'p.png')
    await writeFile(photo, Buffer.from([0x89, 0x50]))
    const saveImages = vi.fn(async (images: unknown[]) => images.map(() => ({ attachmentId: 'a' })))
    const idle = start(undefined, { saveImages })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, { ...human(i + 1, m), ...(i === 4 ? { media: [photo] } : {}) })
    await runQueued()
    expect(saveImages.mock.calls[0]![0]).toEqual([{ data: Buffer.from([0x89, 0x50]), mediaType: 'image/png' }])
  })
```

  Run `pnpm --filter dsh-chat exec vitest run tests/idle/scheduler.spec.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/idle/scheduler.ts`.** Copy today's `packages/dsh-telegram/src/idle/scheduler.ts` and change exactly this:
  - Imports: `ChatLog`, `ChatLogEntry` from `../log/chatlog.ts`; `chatKey` from `../keys.ts`; `ChatChannel`, `Delivered` from `../router/channel.ts`; `ImageStore` from `../router/router.ts`; drop `TelegramApi`.
  - `IdleEvent`: `chatId: string`, `chatIds: string[]`, decision gains `as?: Delivered['as']`.
  - Replace `IdleQueue` and the `api`/`queue`/`botId`/`botUsername` deps with:

```ts
export interface IdleChat {
  channel(id: string): ChatChannel | undefined
  enqueue(key: string, task: () => Promise<void>): void
}

export interface IdleDeps {
  config: IdleConfig
  /** The channel this scheduler serves; its chats are `chatIds`. */
  channel: string
  chatIds: string[]
  chat: IdleChat
  provider: string
  model: string
  llm: IdleLlm
  chatLog: ChatLog
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
  random?: () => number
  /** Admits context photos as attachments; without it the model sees only the `[photo]` text. */
  saveImages?: ImageStore['saveImages']
  /** Receives every start, check and decision; the plugin appends them to a JSONL file. */
  record?: (event: IdleEvent) => void
}
```

  - Every `chatId: number` becomes `chatId: string`; `states`, `seeded`, `pending` are keyed by string and built from `deps.chatIds`; `chatKey('telegram', chatId)` becomes `chatKey(deps.channel, chatId)`; `config.chatIds` uses become `deps.chatIds`; the start record keeps `chatIds: [...deps.chatIds]` and drops `chatKeys` from the logged settings the same way it drops `persona`.
  - Log prefixes `dsh-telegram:` become `dsh-chat:` and name the chat as `${deps.channel}:${chatId}`.
  - Photos: replace the `.jpg` filter and the fixed media type with

```ts
const PHOTO_TYPES: Record<string, InboundImage['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
```

    selecting `e.media` paths whose lowercased `extname` is a key, and passing `{ data, mediaType: PHOTO_TYPES[ext] }`.
  - `consider` enqueues with `deps.chat.enqueue(chatKey(deps.channel, chatId), ...)`.
  - The action block becomes:

```ts
    try {
      const channel = deps.chat.channel(deps.channel)
      if (channel === undefined) throw new Error(`channel ${deps.channel} offline`)
      if (action.kind === 'react') state.reacted = [...state.reacted, action.messageId].slice(-MAX_REACTED)
      const delivered = action.kind === 'react'
        ? await channel.react(chatId, action.messageId, action.emoji)
        : await channel.send(chatId, action.text, { replyTo: action.messageId })
      // A reaction that posted a message (a Zalo sticker) is logged like a reply, so the next decision sees it.
      if (delivered.messageId !== undefined) {
        await deps.chatLog.append(chatKey(deps.channel, chatId), {
          ts: new Date(at).toISOString(),
          message_id: delivered.messageId,
          user_id: channel.bot.id,
          name: channel.bot.name,
          text: delivered.text ?? (action.kind === 'reply' ? action.text : action.emoji),
          reply_to: action.messageId,
          bot: true,
        })
      }
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, as: delivered.as, ...detail })
    } catch (error) {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle ${action.kind} failed: ${errorText(error)}`)
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, ...detail, error: errorText(error) })
    }
```

- [ ] **Step 4: Implement `src/idle/index.ts`.** Copy today's `packages/dsh-telegram/src/idle/index.ts`; replace `chatIds: number[]` by `chatKeys: string[]` (doc: "Chats idle may join, as chat keys like `telegram:-100123`.", Schemastery `z.array(z.string()).default([])`), error prefixes `dsh-telegram:` by `dsh-chat:`, and add to `assertIdleConfig`:

```ts
  for (const key of config.chatKeys) {
    try {
      splitKey(key)
    } catch {
      throw new Error(`dsh-chat: idle.chatKeys entry "${key}" is not a chat key like telegram:-100123`)
    }
  }
```

  The plugin:

```ts
/** Cordis plugin name. */
export const name = 'dsh-chat-idle'

/** Injects nothing itself, so Cordis validates the config at load; one scheduler runs per channel named in `chatKeys`. */
export function apply(ctx: Context, config: IdleConfig): void {
  assertIdleConfig(config)
  if (!config.enabled) return
  ctx.inject(['chat', 'chatData', 'chatAgents', 'chatLog', 'llm', 'attachments'], (ctx) => {
    const logger = ctx.logger('dsh-chat')
    const byChannel = new Map<string, string[]>()
    for (const key of config.chatKeys) {
      const { channel, id } = splitKey(key)
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), id])
    }
    const handles = new Map<string, IdleHandle>()
    for (const [channel, chatIds] of byChannel) {
      const dir = join(ctx.chatData.dataDir, channel)
      const file = join(dir, 'idle-decisions.jsonl')
      // Appends run one after another so lines keep their order; a failed write only warns.
      let writing = mkdir(dir, { recursive: true }).then(() => {})
      const record = (event: IdleEvent): void => {
        writing = writing.then(() => appendFile(file, JSON.stringify(event) + '\n', 'utf8')).catch((error: unknown) => {
          logger.warn(`dsh-chat: writing ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      const { provider, model } = ctx.chatAgents.selection
      handles.set(channel, startIdle({
        config, channel, chatIds, chat: ctx.chat, provider, model, llm: ctx.llm, chatLog: ctx.chatLog,
        saveImages: images => ctx.attachments.saveImages(images),
        log: { info: msg => logger.info(msg), warn: msg => logger.warn(msg) },
        record,
      }))
    }
    ctx.on('chat/turn', (key) => {
      const { channel, id } = splitKey(key)
      handles.get(channel)?.noteTurn(id)
    })
    ctx.on('chat/message', (key, entry) => {
      const { channel, id } = splitKey(key)
      handles.get(channel)?.observe(id, entry)
    })
    ctx.effect(() => () => { for (const handle of handles.values()) handle.stop() }, 'dsh-chat: idle schedulers')
  })
}
```

  Imports: `mkdir`, `appendFile` from `node:fs/promises`; `join`; `Context`; `type {} from '@deepseek-ai/dsh-attachment'`, `'@deepseek-ai/dsh-llm'`, `'../router/plugin.ts'`, `'../migrate/index.ts'`, `'../sessions/index.ts'`, `'../log/index.ts'`; `splitKey`; `startIdle`, `IdleEvent`, `IdleHandle`.
  Add `"./idle": { "types": "./lib/idle/index.d.ts", "default": "./lib/idle/index.js" }` to `packages/dsh-chat/package.json` exports, after `./retention`.

- [ ] **Step 5: Port the plugin tests.** Copy `packages/dsh-telegram/tests/idle/plugin.spec.ts` to `packages/dsh-chat/tests/idle/plugin.spec.ts`. Config cases: `chatIds` becomes `chatKeys` (`['telegram:-1001234567890']`), the timezone error matches `/idle.timezone/` as before, and add `expect(() => assertIdleConfig(Config({ chatKeys: ['-5'] }))).toThrow(/chatKeys/)`. Plugin cases: instead of providing a fake `telegram` service, provide `chat` as `{ channel: () => fake, enqueue: (key, task) => { queued.push(key); void task() } }` with `fake = new FakeChannel('telegram')`, plus `chatData` (`{ dataDir: dir, workspaceRoot: dir }`), `chatAgents` (`{ selection: { provider: 'p', model: 'm' } }`), `chatLog`, `llm`, `attachments`; drive lines with `root.emit('chat/message', 'telegram:-5', entry)` and turns with `root.emit('chat/turn', 'telegram:-5')`; the decision file is `join(dir, 'telegram', 'idle-decisions.jsonl')`. Keep every original behavior case (disabled does nothing, lines flow to decisions, a turn cancels queued work, disposal stops it).

- [ ] **Step 6: Run** `pnpm --filter dsh-chat exec vitest run tests/idle` and `pnpm --filter dsh-chat run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(chat): add dsh-chat/idle, one scheduler per channel on the chat router`.

---

### Task 3: `dsh-chat/schedule`

**Files:**
- Create: `packages/dsh-chat/src/schedule/domain.ts`, `store.ts`, `delivery.ts`, `tools.ts`, `index.ts`
- Modify: `packages/dsh-chat/package.json` (export `./schedule`; peer and dev dependency `@deepseek-ai/dsh-schedule: 0.2.0-rc.2`)
- Test: `packages/dsh-chat/tests/schedule/{domain,store,delivery,tools,plugin}.spec.ts` (ported)

**Interfaces:**
- Consumes: `ChatRouter` (`channel`, `prompt`, `superAdmins`, `chatOf`, `turnOf`), `ChatLog`, `ChatSender`, `chatKey`, `splitKey`, `idIn`, `writeJsonAtomic`; services `chat`, `chatData`, `chatLog`, `tools`.
- Produces:
  - `interface Reminder { chatKey: ChatKey; isGroup: boolean; creator: { id: string /* userKey */; name: string }; mode: ReminderMode; record: ScheduleRecord }`
  - `class ReminderBook { constructor(dataDir: string); load(): void; all(): readonly Reminder[]; update<T>(channel: string, change: (reminders: Reminder[]) => T): Promise<T>; close(): void }` — one `ReminderStore` per `<dataDir>/<channel>/schedule.json`.
  - `displayName(sender: ChatSender): string`, `canManage(reminder, userKey: string, superAdmins: readonly string[]): boolean`.
  - Plugin `name = 'dsh-chat-schedule'`, same `Config` and `assertScheduleConfig` as today.

- [ ] **Step 1: Add the dependency** `@deepseek-ai/dsh-schedule: 0.2.0-rc.2` to `peerDependencies` and `devDependencies` of `packages/dsh-chat/package.json` (edit in place, keep formatting), add the `./schedule` export after `./idle`, run `pnpm install`.

- [ ] **Step 2: Port the tests (failing).** Copy the five specs from `packages/dsh-telegram/tests/schedule/` to `packages/dsh-chat/tests/schedule/` and convert:
  - Reminders: `{ chatId: 5, creator: { id: 7, ... } }` becomes `{ chatKey: 'telegram:5', isGroup: false, creator: { id: 'telegram:7', ... } }` (negative chat ids get `isGroup: true`).
  - Senders: `TelegramUser` values become `ChatSender` (`{ id: '7', name: 'Ann', username: 'ann' }`); `displayName` expectations unchanged (`@ann`, or the name).
  - `superAdmins: [7]` becomes `['telegram:7']`.
  - Delivery: the fake `telegram` service becomes `chat: { channel: id => (online && id === 'telegram' ? fake : undefined), prompt: vi.fn(), superAdmins: ['telegram:7'] }` with `fake = new FakeChannel('telegram')`; `api.callsTo('sendMessage')` becomes `fake.sent`; the prompt expectation becomes `chat.prompt` called with `('telegram:5', { text: agentPrompt(r), sender: { id: '7', name: r.creator.name }, isGroup: false })`; the logged bot line has `user_id: 'telegram-bot', name: 'telegrambot'`.
  - Tools: the fake `telegram` (`chatOf`, `turnOf`, `superAdmins`) becomes `chat` with `chatOf: () => 'telegram:5'`, `turnOf: () => ({ sender, isGroup: false, isSuperAdmin })`, `superAdmins: ['telegram:7']`; created reminders carry `chatKey`, `isGroup` and `creator.id: 'telegram:7'`.
  - Store: `new ReminderStore(file)` cases become `ReminderBook` cases on a temp `dataDir`, writing to `<dataDir>/telegram/schedule.json`.
  - Plugin: provide `chat`, `chatData`, `chatLog`, `tools` instead of `telegram`.
  - Add:

```ts
  it('normalizes an old Telegram reminder file on load and writes the new form on the next save', async () => {
    const file = join(dir, 'telegram', 'schedule.json')
    await mkdir(join(dir, 'telegram'), { recursive: true })
    const record = buildRecord('r1', 'tea', 'drink tea', { after_seconds: 60 }, Date.now(), 'UTC')
    await writeFile(file, JSON.stringify({ version: 1, reminders: [{ chatId: -5, creator: { id: 7, name: '@ann' }, mode: 'agent', record }] }))
    const book = new ReminderBook(dir)
    book.load()
    expect(book.all()).toEqual([{ chatKey: 'telegram:-5', isGroup: true, creator: { id: 'telegram:7', name: '@ann' }, mode: 'agent', record }])
    await book.update('telegram', () => {})
    expect(JSON.parse(await readFile(file, 'utf8')).reminders[0]).toMatchObject({ chatKey: 'telegram:-5', isGroup: true, creator: { id: 'telegram:7' } })
  })

  it('keeps one file per channel and creates a channel file on its first reminder', async () => {
    const book = new ReminderBook(dir)
    book.load()
    const record = buildRecord('z1', 'x', 'y', { after_seconds: 60 }, Date.now(), 'UTC')
    await book.update('zalo', (reminders) => { reminders.push({ chatKey: 'zalo:c1', isGroup: false, creator: { id: 'zalo:u1', name: 'U' }, mode: 'message', record }) })
    expect(JSON.parse(await readFile(join(dir, 'zalo', 'schedule.json'), 'utf8')).reminders).toHaveLength(1)
    const again = new ReminderBook(dir)
    again.load()
    expect(again.all().map(r => r.chatKey)).toEqual(['zalo:c1'])
  })
```

  and in `delivery.spec.ts`:

```ts
  it('leaves a due reminder alone while its channel is offline and delivers it once the channel is back', async () => {
    online = false
    await book.update('telegram', (rs) => { rs.push(dueMessageReminder) })
    const scheduler = startScheduler({ book, chat, chatLog, log, now: () => NOW })
    await scheduler.tick()
    expect(book.all()).toHaveLength(1)
    expect(fake.sent).toEqual([])
    online = true
    await scheduler.tick()
    expect(fake.sent.map(s => s.text)).toEqual([reminderMessage(dueMessageReminder)])
    scheduler.stop()
  })
```

  (`dueMessageReminder` is a `message` reminder for `telegram:5` whose `scheduledAt` is before `NOW`, built with the spec's existing helpers.) Run `pnpm --filter dsh-chat exec vitest run tests/schedule`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `domain.ts`.** Copy today's file; replace `import type { TelegramUser } from '../inbound.ts'` by `import type { ChatKey } from '../keys.ts'` and `import type { ChatSender } from '../sessions/agents.ts'`; then:

```ts
/** One active reminder; `record` is a dsh-schedule record (id, kind, title, prompt, scheduledAt and the rule). */
export interface Reminder {
  chatKey: ChatKey
  /** Whether the chat is a group, for the turn an agent reminder starts. */
  isGroup: boolean
  /** `id` is the creator's user key. */
  creator: { id: string; name: string }
  mode: ReminderMode
  record: ScheduleRecord
}

export function canManage(reminder: Reminder, userKey: string, superAdmins: readonly string[]): boolean {
  return reminder.creator.id === userKey || superAdmins.includes(userKey)
}

export function displayName(sender: ChatSender): string {
  return sender.username === undefined ? sender.name : `@${sender.username}`
}
```

- [ ] **Step 4: Implement `store.ts`.** Keep `ReminderStore` as today with these changes: constructor `(file: string, channel: string)`; `load()` maps each raw entry through `normalize` before validating; error prefixes `dsh-chat:`; `isReminder` checks `typeof r.chatKey === 'string' && typeof r.isGroup === 'boolean' && typeof r.creator?.id === 'string'`. Add:

```ts
/** Reminders written before dsh-chat carry a bare numeric chat id and creator id, and no isGroup. */
function normalize(raw: unknown, channel: string): unknown {
  const r = raw as { chatKey?: unknown; chatId?: unknown; isGroup?: unknown; creator?: { id?: unknown; name?: unknown } } | null
  if (typeof r !== 'object' || r === null || typeof r.chatKey === 'string') return raw
  if (typeof r.chatId !== 'number' && typeof r.chatId !== 'string') return raw
  const { chatId, ...rest } = r
  const creatorId = r.creator?.id
  return {
    ...rest,
    chatKey: chatKey(channel, chatId),
    isGroup: typeof r.isGroup === 'boolean' ? r.isGroup : Number(chatId) < 0,
    creator: { ...r.creator, id: typeof creatorId === 'number' ? chatKey(channel, creatorId) : creatorId },
  }
}

/** One reminder file per channel, `<dataDir>/<channel>/schedule.json`; a channel file is created on its first change. */
export class ReminderBook {
  private readonly stores = new Map<string, ReminderStore>()

  constructor(private readonly dataDir: string) {}

  /** Synchronous so the plugin loads before it registers anything; a corrupted file throws. */
  load(): void {
    const entries = existsSync(this.dataDir) ? readdirSync(this.dataDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      if (!entry.isDirectory() || !existsSync(join(this.dataDir, entry.name, 'schedule.json'))) continue
      this.storeOf(entry.name)
    }
  }

  all(): readonly Reminder[] {
    return [...this.stores.values()].flatMap(store => store.all())
  }

  update<T>(channel: string, change: (reminders: Reminder[]) => T): Promise<T> {
    return this.storeOf(channel).update(change)
  }

  close(): void {
    for (const store of this.stores.values()) store.close()
  }

  private storeOf(channel: string): ReminderStore {
    let store = this.stores.get(channel)
    if (store === undefined) {
      store = new ReminderStore(join(this.dataDir, channel, 'schedule.json'), channel)
      store.load()
      this.stores.set(channel, store)
    }
    return store
  }
}
```

  `writeJsonAtomic` must create the channel directory; if it does not, `mkdir(dirname(this.file), { recursive: true })` before it in `update`. Imports from `../json-file.ts`, `../keys.ts`.

- [ ] **Step 5: Implement `delivery.ts`.** Copy today's file with these changes:

```ts
export interface SchedulerDeps {
  book: ReminderBook
  chat: Pick<ChatRouter, 'channel' | 'prompt' | 'superAdmins'>
  chatLog: ChatLog
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
}
```

  `store.all()` becomes `book.all()`; `deliver(reminder: Reminder)` looks the reminder up by `chatKey` and id:

```ts
  const deliver = async (target: Reminder): Promise<void> => {
    const { channel: channelId, id: chatId } = splitKey(target.chatKey)
    // An offline channel leaves the reminder due, so it is retried instead of advanced and lost.
    if (deps.chat.channel(channelId) === undefined) throw new Error(`channel ${channelId} offline`)
    let due: Reminder | undefined
    let revoked = false
    await book.update(channelId, (reminders) => {
      const index = reminders.findIndex(r => r.chatKey === target.chatKey && r.record.id === target.record.id)
      const current = reminders[index]
      if (current === undefined || Date.parse(current.record.scheduledAt) > now()) return
      due = current
      revoked = current.mode === 'agent' && !deps.chat.superAdmins.includes(current.creator.id)
      const next = revoked ? undefined : afterDelivery(current, now())
      if (next === undefined) reminders.splice(index, 1)
      else reminders[index] = next
    })
    const reminder = due
    if (reminder === undefined) return
    const channel = deps.chat.channel(channelId)
    if (channel === undefined) throw new Error(`channel ${channelId} offline`)
    if (revoked) {
      await channel.send(chatId, `Stopped reminder "${reminder.record.title}": its creator is no longer a super admin.`)
    } else if (reminder.mode === 'message') {
      const text = reminderMessage(reminder)
      const delivered = await channel.send(chatId, text)
      if (delivered.messageId !== undefined) {
        await deps.chatLog.append(reminder.chatKey, {
          ts: new Date(now()).toISOString(), message_id: delivered.messageId, user_id: channel.bot.id, name: channel.bot.name, text: delivered.text ?? text, bot: true,
        })
      }
    } else {
      deps.chat.prompt(reminder.chatKey, {
        text: agentPrompt(reminder),
        sender: { id: idIn(channelId, reminder.creator.id) ?? reminder.creator.id, name: reminder.creator.name },
        isGroup: reminder.isGroup,
      })
    }
    log.info(`dsh-chat: ${reminder.chatKey} reminder ${reminder.record.id} -> ${revoked ? 'stopped' : reminder.mode}`)
  }
```

  and `tick` calls `deliver(reminder)` and logs failures as `dsh-chat: ${reminder.chatKey} reminder ... failed`.

- [ ] **Step 6: Implement `tools.ts`.** Copy today's file; `deps.telegram` becomes `deps.chat: Pick<ChatRouter, 'chatOf' | 'turnOf' | 'superAdmins'>`; `inChat` resolves:

```ts
    const key = exec.agent === undefined ? undefined : deps.chat.chatOf(String(exec.agent.id))
    const turn = key === undefined ? undefined : deps.chat.turnOf(key)
    if (key === undefined || turn === undefined) throw new ReminderError('no_chat', 'reminders can only be managed from a chat turn')
    const userKey = chatKey(splitKey(key).channel, turn.sender.id)
    return JSON.stringify(await body({ key, isGroup: turn.isGroup, userKey, sender: turn.sender }))
```

  with `body(chat: { key: ChatKey; isGroup: boolean; userKey: string; sender: ChatSender })`. `find` matches `r.chatKey === key`; per-chat filters use `chatKey`; `assertCanManage` and the agent-mode check use `userKey` against `deps.chat.superAdmins`; `commit(deps, splitKey(key).channel, change)` calls `deps.book.update(channel, change)`; a created reminder is `{ chatKey: key, isGroup, creator: { id: userKey, name: displayName(sender) }, mode, record }`.

- [ ] **Step 7: Implement `index.ts`.** Copy today's plugin; `name = 'dsh-chat-schedule'`; error prefix `dsh-chat:`; `ctx.inject(['chat', 'chatData', 'chatLog', 'tools'], ...)`; `new ReminderBook(ctx.chatData.dataDir)` with `book.load()`; `startScheduler({ book, chat: ctx.chat, chatLog: ctx.chatLog, log })`; `createScheduleTools({ chat: ctx.chat, book, timeZone, maxPerChat, changed })`; dispose stops the scheduler and closes the book; log line `dsh-chat: reminders on (...)`.

- [ ] **Step 8: Run** `pnpm --filter dsh-chat exec vitest run tests/schedule`, `pnpm --filter dsh-chat run typecheck`, `pnpm --filter dsh-chat run build`. Expected: PASS.

- [ ] **Step 9: Commit** `feat(chat): add dsh-chat/schedule with one reminder file per channel`.

---

### Task 4: Telegram on the shared plugins

**Files:**
- Modify: `packages/dsh-telegram/cordis.patch.yml`, `profile/telegram/cordis.patch.yml`, `packages/dsh-telegram/src/index.ts`, `packages/dsh-telegram/package.json`
- Delete: `packages/dsh-telegram/src/idle/`, `src/schedule/`, `src/service.ts`, `tests/idle/`, `tests/schedule/`
- Test: `packages/dsh-telegram/tests/profile.spec.ts`

- [ ] **Step 1: Failing profile tests.** In `tests/profile.spec.ts`, `telegramIdle(list)` reads row `chat-idle`; the env case expects `evalJs(config.chatKeys, { TELEGRAM_IDLE_CHATS: '-1001234567890, 42,' })` to equal `['telegram:-1001234567890', 'telegram:42']` and `[]` for no env; the "mounts the idle plugin" case expects row `chat-idle` named `dsh-chat/idle` and row `chat-schedule` named `dsh-chat/schedule`, and no row named `dsh-telegram/idle` or `dsh-telegram/schedule`; keep the persona and timing cases on `chat-idle`. Any burst-schema case imports `Config` from `dsh-chat/idle`. Run `pnpm --filter dsh-telegram exec vitest run tests/profile.spec.ts`. Expected: FAIL.

- [ ] **Step 2: Patches.** In `packages/dsh-telegram/cordis.patch.yml` replace the `telegram-idle` and `telegram-schedule` rows with:

```yaml
    - id: chat-idle
      name: dsh-chat/idle
      config:
        enabled: !!js process.env.TELEGRAM_IDLE_ENABLED === 'true'
        chatKeys: !!js (process.env.TELEGRAM_IDLE_CHATS ?? '').split(',').map(s => s.trim()).filter(s => /^-?[1-9]\d*$/.test(s)).map(s => 'telegram:' + s)
        idleMinutes: 10
        minNewMessages: 5
        chance: 1
        maxPerBurst: 4
        slotGapMinutes: 10
        maxPerDay: 24

    - id: chat-schedule
      name: dsh-chat/schedule
      config:
        timeZone: Asia/Ho_Chi_Minh
        maxPerChat: 20
```

  and update the header comment (idle engagement now comes from dsh-chat). In `profile/telegram/cordis.patch.yml` rename the restated `telegram-idle` row to `chat-idle`, its comment accordingly, and its `chatIds` line to the `chatKeys` line above.

- [ ] **Step 3: Remove the Telegram copies.** `git rm -r packages/dsh-telegram/src/idle packages/dsh-telegram/src/schedule packages/dsh-telegram/src/service.ts packages/dsh-telegram/tests/idle packages/dsh-telegram/tests/schedule`. In `src/index.ts`: drop the `TelegramService` export and type, `telegramIds`, the `service` field of `Started` and of `start`'s result, `ctx.provide('telegram', ...)` with its `revoke`, and the two `chat/message`/`chat/turn` bridges; `inject` loses `chatData` and `chatLog` if nothing else uses them. In `package.json` drop the `./idle` and `./schedule` exports and `@deepseek-ai/dsh-schedule`.

- [ ] **Step 4: Run** `pnpm --filter dsh-chat run build`, `pnpm --filter dsh-telegram exec vitest run`, `pnpm --filter dsh-telegram run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `refactor(telegram): use dsh-chat/idle and dsh-chat/schedule`.

---

### Task 5: Zalo gets idle, schedule and stickers

**Files:**
- Modify: `packages/dsh-zalo/cordis.patch.yml`, `profile/zalo/cordis.patch.yml`, `docker-compose.yml`
- Test: `packages/dsh-zalo/tests/profile.spec.ts`

- [ ] **Step 1: Failing profile tests.** Add to `tests/profile.spec.ts`:

```ts
  it('mounts shared idle and reminders for Zalo, idle off unless asked', async () => {
    const bundle = await rows('../cordis.patch.yml')
    expect(row(bundle, 'chat-idle').name).toBe('dsh-chat/idle')
    expect(row(bundle, 'chat-schedule').name).toBe('dsh-chat/schedule')
    for (const path of PATHS) {
      const idle = resolve(row(await rows(path), 'chat-idle').config, { ZALO_IDLE_ENABLED: 'true', ZALO_IDLE_CHATS: 'g1, g2,' })
      expect(idle).toMatchObject({ enabled: true, chatKeys: ['zalo:g1', 'zalo:g2'] })
      expect(resolve(row(await rows(path), 'chat-idle').config, {})).toMatchObject({ enabled: false, chatKeys: [] })
    }
  })

  it('gives idle the profile persona', async () => {
    const profile = await rows('../../../profile/zalo/cordis.patch.yml')
    expect(row(profile, 'chat-idle').config!.persona).toBe(profile.find(r => r.id === 'system-prompt')!.config!.personaPrefix)
  })

  it('maps the reaction emoji to the Khu Vuon Tren May 1 stickers', async () => {
    for (const path of PATHS) {
      const stickers = resolve(row(await rows(path), 'zalo').config, env).stickers
      expect(stickers['\u{1F44D}']).toBe('e4f2231c1f59f607af48')
      expect(stickers['\u{2764}']).toBe('ec2022ce1e8bf7d5ae9a')
      expect(Object.keys(stickers)).toHaveLength(9)
    }
  })
```

  Run `pnpm --filter dsh-zalo exec vitest run tests/profile.spec.ts`. Expected: FAIL.

- [ ] **Step 2: Patches.** In `packages/dsh-zalo/cordis.patch.yml` add `stickers` to the `zalo` row and append the two rows:

```yaml
        # Reactions become stickers from the pack "Khu Vuon Tren May 1" (stickers.zaloapp.com, cid c65678bc44f9ada7f4e8).
        stickers:
          "\U0001F44D": e4f2231c1f59f607af48
          "\u2764": ec2022ce1e8bf7d5ae9a
          "\U0001F601": 071adff4e3b10aef53a0
          "\U0001F923": f80822e61ea3f7fdaeb2
          "\U0001F914": b6e67d08414da813f15c
          "\U0001F648": 1c97c779fb3c12624b2d
          "\U0001F60E": 181fd9f1e5b40cea55a5
          "\U0001F929": d33017de2b9bc2c59b8a
          "\U0001F917": 94c3402d7c689536cc79

    - id: chat-idle
      name: dsh-chat/idle
      config:
        enabled: !!js process.env.ZALO_IDLE_ENABLED === 'true'
        chatKeys: !!js (process.env.ZALO_IDLE_CHATS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => 'zalo:' + s)
        idleMinutes: 10
        minNewMessages: 5
        chance: 1
        maxPerBurst: 4
        slotGapMinutes: 10
        maxPerDay: 24

    - id: chat-schedule
      name: dsh-chat/schedule
      config:
        timeZone: Asia/Ho_Chi_Minh
        maxPerChat: 20
```

  In `profile/zalo/cordis.patch.yml`: anchor the persona (`personaPrefix: &persona >-`) with the same comment as the Telegram profile, add the same `stickers` block to the restated `zalo` row (patches replace a row's config wholesale), and restate `chat-idle` with the bundle's values plus `persona: *persona`. In `docker-compose.yml` add to `dsh-zalo.environment`:

```yaml
      ZALO_IDLE_ENABLED: ${ZALO_IDLE_ENABLED:-false}
      ZALO_IDLE_CHATS: ${ZALO_IDLE_CHATS:-}
```

- [ ] **Step 3: Run** `pnpm --filter dsh-zalo exec vitest run`, then `pnpm typecheck` and `pnpm test` from the root. Expected: PASS.

- [ ] **Step 4: Commit** `feat(zalo): turn on shared idle and reminders, with sticker reactions`.
