# dsh-chat: channel-agnostic chat core as Cordis plugins

Date: 2026-10-16
Status: approved design; steps 1, 2 and 5 implemented; Amendment 1 approved

## Goal

Make the chat bots "everything is a plugin". Today `dsh-telegram` and `dsh-zalo`
are each one monolithic Cordis plugin, and `dsh-zalo` is largely a copy of
`dsh-telegram`: `json-file` and `retention` are identical, `memory`,
`session-map`, `chatlog`, `sessions` and `tools` differ only in the `chatId` type
and names. The extension plugins `dsh-telegram/idle` and `dsh-telegram/schedule`
inject the `telegram` service, so Zalo cannot use them.

This design moves the channel-agnostic parts into a new package
`packages/dsh-chat` made of several small Cordis plugins, reduces `dsh-telegram`
and `dsh-zalo` to channel adapters, and lets one process serve several channels.

This supersedes the "Code sharing" decision of
`2026-10-15-dsh-zalo-design.md` (no shared core until a third channel).

## Decisions

| Topic | Decision |
|---|---|
| Granularity | One plugin per concern, all in one npm package `dsh-chat`, exposed as subpath exports (`dsh-chat/memory`, ...). |
| Packaging | Root `pnpm-workspace.yaml`. Adapters declare `dsh-chat` as a peer (`workspace:*`). In images `dsh-chat` is installed as a sibling bundle in `profile/node_modules/dsh-chat`, never nested under an adapter, so each service has exactly one instance. |
| Multi-channel | One process may run several channels. Every key in the core is channel-qualified. |
| Identity | `chatKey = "<channel>:<id>"`, `userKey = "<channel>:<id>"`, both strings. `superAdmins` and `allowFrom` hold `userKey`s. |
| Global memory | One `global.json` shared by every channel in the process; only super admins may write it. |
| Data layout | New per-channel layout under `/data` and `/workspace`, reached by a one-time migration. |
| Agent sessions | The migration drops the old session maps on purpose; each chat starts a new agent session. Continuity comes from memory and chat log, which are kept. |
| Prompt cache | The rendered persona prefix, `<memory>` block and `<chat_history>` block stay byte-identical to the current output. Channel-specific wording lives only in the persona suffix set by each adapter's patch. |
| Events | `telegram/turn`, `telegram/message`, `zalo/*` become `chat/turn(chatKey)` and `chat/message(chatKey, entry)`. |
| Per-chat tools | `dsh-chat/sessions` emits `chat/agent(agentCtx, chatKey)` when it creates or resumes a chat's agent. `memory`, `history` and the router (for `channel.agentTools`) register their tools on `agentCtx` in that listener, replacing today's `registerChatTools` setup callback. |
| Dependency direction | Stores never inject `chat`, so there is no cycle: `migrate` <- `log`, `sessions` <- `memory`, `history` <- router <- `idle`, `schedule`; `retention` needs only `chatData`. The router sets `TurnContext { sender, isGroup, isSuperAdmin }` through `chatAgents.setTurn`, so memory tools read the super-admin flag from `chatAgents.turnOf(chatKey)` instead of from router config. |
| Out of scope | Merging the two existing `global.json` files, new channels, file sending for Zalo. |

## Plugins

| Plugin | Provides | Injects | Responsibility |
|---|---|---|---|
| `dsh-chat/migrate` | `chatData` (`{ dataDir, workspaceRoot }`) | — | One-time layout migration, then provides the shared paths; see below. |
| `dsh-chat/log` | `chatLog` | `chatData` | JSONL chat log per `chatKey`; forwards appends as `chat/message`, a throwing listener only warns. |
| `dsh-chat/memory` | `chatMemory` | `chatData`, `chatAgents` | Memory store, `memory_save` / `memory_recall` / `memory_forget`, the `<memory>` block. |
| `dsh-chat/sessions` | `chatAgents` | `chatData`, `agents` | Session map and `ChatAgents`: create or resume one agent per `chatKey`, per-chat workspace, turn context. |
| `dsh-chat` (router) | `chat` | `chatLog`, `chatMemory`, `chatAgents`, `attachments` | Channel registry, per-`chatKey` queue, shared gate (allowlist, `/reset`, `/stop`, `/help`), turn orchestration, `chat/turn`. |
| `dsh-chat/history` | — | `chatLog`, `chatAgents` | `chat_history` tool (replaces `telegram_chat_history`). |
| `dsh-chat/retention` | — | `chatData` | Daily sweep of `inbox` / `outbox` under `/workspace/<channel>/<id>`. |
| `dsh-chat/idle` | — | `chat`, `chatLog`, `llm`, `attachments` | Moved from `dsh-telegram/idle`. |
| `dsh-chat/schedule` | — | `chat`, `tools` | Moved from `dsh-telegram/schedule`. |

Adapters:

- `dsh-telegram`: grammY client and polling, inbound normalization (mention and
  reply detection), HTML rendering, streaming by editing a draft message,
  `telegram_send_file`.
- `dsh-zalo`: poller with dedupe, inbound normalization (`@<name>` and
  `groupPrefix`), typing indicator, chunked delivery that keeps code fences and
  emoji intact.

Each adapter's `cordis.patch.yml` inserts the `dsh-chat/*` plugins it needs. A
multi-channel profile inserts the core plugins once plus both adapters.

## Channel interface

```ts
interface ChatChannel {
  readonly id: string
  readonly caps: { editMessages: boolean; maxMessageChars: number; sendFiles: boolean }
  readonly bot: { id: string; name: string }
  /** Called by the core before a turn runs; the sink renders that turn. */
  openTurn(chatId: string, origin: { replyTo?: string }): TurnSink
  /** Sends a message outside any turn (schedule, idle, errors). */
  send(chatId: string, text: string): Promise<string | undefined>
  /** Channel-specific tools registered on the chat's agent. */
  agentTools?(chatId: string, turn: () => TurnContext | undefined): ToolDefinition[]
  stop(): Promise<void>
}

interface TurnSink {
  /** Telegram edits the draft message; Zalo sends a typing action. */
  status(text: string): void
  deliver(text: string): Promise<{ outcome: TurnOutcome; messageId?: string }>
  close(): void
}

interface InboundMessage {
  chatKey: string
  messageId?: string
  sender: { userKey: string; name: string }
  isGroup: boolean
  /** The adapter decides whether the bot was mentioned or replied to. */
  addressed: boolean
  /** Text with the mention or trigger stripped. */
  text: string
  images: { data: Uint8Array; mediaType: ImageMediaType }[]
  at: number
}
```

The `chat` service exposes `register(channel)` (returns an unregister function),
`channel(id)`, `inbound(message)`, `enqueue(chatKey, task)`, `isBusy(chatKey)`,
`prompt(chatKey, input)`, `chatOf(agentId)` and `turnOf(chatKey)`.

### Flow

1. The adapter receives an update, normalizes it to `InboundMessage` and calls
   `ctx.chat.inbound(message)`.
2. The core applies the allowlist; a message with `addressed: false` is logged
   only; commands are handled; otherwise the message is logged, queued per
   `chatKey`, the agent is resolved, memory, history and images are assembled,
   and `runTurn` runs (timeout, stop, `summarizeTurn`). Session events drive
   `sink.status`; the final text goes to `sink.deliver`; `sink.close` always runs.
3. Everything channel-specific stays in the adapter: markdown conversion,
   chunking, status labels. The core never sees HTML or emoji.

`TelegramService` and the Zalo service are removed. Idle and schedule use
`ctx.chat.channel(id).send` and `ctx.chat.prompt(chatKey, input)`.

## Data layout and migration

```
/data/
  memory/global.json
  sessions.json                 (keyed by chatKey)
  <channel>/chatlog/<id>.jsonl
  <channel>/memory/<id>.json
  <channel>/idle-decisions.jsonl
  <channel>/schedule.json
  .migrated-v1
/workspace/<channel>/<id>/{inbox,outbox}
```

`dsh-chat/migrate` runs in `apply`; store plugins inject `chatData`, so they
load only after it. Config: `legacyChannel: 'telegram' | 'zalo'`, set by each
adapter's patch, because each image's `/data` volume holds one channel today.

1. If `.migrated-v1` exists, provide `chatData` and stop.
2. `rename` (same volume) `chatlog/*`, `memory/<id>.json`,
   `idle-decisions.jsonl`, `schedule.json` into
   `<legacyChannel>/`. `memory/global.json` stays.
3. Move `/workspace/<id>` to `/workspace/<legacyChannel>/<id>`.
4. Delete the old `<legacyChannel>-sessions.json`: stored agent sessions keep the old `cwd`, so each
   chat starts a new session.
5. Write the marker and provide `chatData`.

Every step skips files already at their destination, so a rerun is safe. On a
failure the plugin logs the error, writes no marker and throws from `apply`, so
the bot never runs on half-migrated data.

Global memory is shared only when channels run in one process on one `/data`.
Two separate images still keep two `global.json` files.

## Error handling

- Startup backoff (`retryStart`) and polling restarts stay in each adapter.
- An adapter calls `chat.register` only after it started; disposing it
  unregisters. Idle or schedule work for an unregistered channel fails with a
  `channel offline` warning.
- A failing `sink.deliver` yields `undelivered` and is logged, as today.

## Testing

- Move the existing specs for chat log, memory, session map, sessions,
  retention, idle and schedule to `packages/dsh-chat/tests`, switched to
  `chatKey`; delete the Zalo duplicates.
- Router specs use a `FakeChannel` that records `status`, `deliver` and `send`:
  gate, commands, per-chat queue, timeout, stop, and two channels side by side
  with no key collision.
- Adapter specs cover inbound normalization, rendering and `TurnSink` (draft
  edits, chunking, code fences, emoji) with the existing fake APIs.
- Migration specs run on temp directories in the old Telegram (numeric ids) and
  Zalo layouts: resulting layout, rerun idempotence, no marker after a mid-way
  failure.
- Prompt-cache snapshot specs compare the rendered persona, `<memory>` and
  `<chat_history>` against the current output byte for byte.
- Wiring specs load each adapter's `cordis.patch.yml` (like `profile.spec.ts`)
  and check that every service is provided in order.

## Rollout

Each step leaves the repository green and deployable.

1. pnpm workspace, `dsh-chat` skeleton, store plugins (`log`, `memory`,
   `sessions`, `retention`) keyed by `chatKey`; both adapters use them.
2. `dsh-chat/migrate` and the new layout.
3. `chat` router, `ChatChannel`, shared gate, queue and turn; adapters reduced
   to transport and rendering.
4. Idle and schedule moved to `dsh-chat`, events renamed; Zalo gains both.
5. Dockerfiles install `dsh-chat` as a sibling bundle, `build-and-push.ps1`
   updated, and a sample two-channel profile added.

## Clarifications from planning

- The `dsh-chat` package is a dsh bundle with an empty patch, so the loader
  resolves `dsh-chat/*` rows; each adapter's patch inserts the rows it needs.
- Chat log ids are strings (`message_id`, `user_id`, `reply_to`). The migration
  rewrites Telegram chat logs, whose ids are numbers, to strings.
- Group context and `chat_history` paging use the position of an entry in the
  log, not its timestamp: Telegram `ts` has one-second precision. The session
  record keeps `lastTurnMessageId: string`; context is every entry after the last
  non-bot entry with that id (all entries when it is absent or trimmed away).
- Until the router exists (rollout step 3), each adapter keeps its own config
  for `superAdmins` and computes `TurnContext.isSuperAdmin` itself.

## Amendment 1: channel intents and idle on Zalo (2026-10-16)

Approved after rollout steps 1, 2 and 5 shipped. It replaces the parts of
"Channel interface" it names and details rollout steps 3 and 4.

### Intents, not capabilities

The core states what it wants; each channel decides how to do it on its
platform. `caps` is removed: chunking and rendering already belong to the
adapter, and file sending is an `agentTools` matter.

```ts
interface ChatChannel {
  readonly id: string
  readonly bot: { id: string; name: string }
  openTurn(chatId: string, origin: { replyTo?: string }): TurnSink
  /** Sends a message outside any turn (schedule, idle, errors). */
  send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<Delivered>
  /** Reacts to one message the way this platform can. */
  react(chatId: string, messageId: string, emoji: string): Promise<Delivered>
  agentTools?(chatId: string, turn: () => TurnContext | undefined): ToolDefinition[]
  stop(): Promise<void>
}

/** What reached the chat. `messageId` and `text` are set when a new message was posted. */
interface Delivered {
  as: 'native' | 'fallback'
  messageId?: string
  text?: string
}
```

| Intent | Telegram | Zalo |
|---|---|---|
| `send` with `replyTo` | reply quoting the message, `native` | plain message, `fallback` |
| `react` | `setReaction`, `native`, no `messageId` | `sendSticker` with `stickers[emoji]`, posted as `[sticker <emoji>]`; an emoji without a sticker is sent as text; both `fallback` |

### Logging what was posted

Whoever calls `send` or `react` appends a bot line to the chat log when
`Delivered.messageId` is set, with `Delivered.text` as the text. A Telegram
reaction posts nothing and is not logged, as today; a Zalo sticker is logged
as `[sticker 👍]`, so the next decision sees that the bot already answered.

### Idle

- `dsh-chat/idle` keeps one decision prompt for every channel, byte-identical
  to the current Telegram prompt (same allowed emoji, same reply format).
- Config `chatIds: number[]` becomes `chatKeys: string[]`. The Telegram patch
  maps `TELEGRAM_IDLE_CHATS` to `telegram:<id>`; the Zalo patch reads
  `ZALO_IDLE_ENABLED` and `ZALO_IDLE_CHATS` into `zalo:<id>`.
- One idle plugin serves every registered channel; decisions are logged to
  `<channel>/idle-decisions.jsonl` and decision events gain `as`.
- Work for a channel that is not registered is skipped with a
  `channel offline` warning.

### Schedule

- `dsh-chat/schedule` stores reminders in `<channel>/schedule.json` with
  `chatId: string` and `creator.id` as a `userKey`.
- Step 2 already shipped its marker, so no new migration: the store normalizes
  on load (a numeric `chatId` becomes its string, a numeric `creator.id` in
  `telegram/schedule.json` becomes `telegram:<id>`) and writes the new form on
  the next save.
- Delivery uses `ctx.chat.channel(id).send` and `ctx.chat.prompt(chatKey, ...)`;
  super-admin checks use the router's `superAdmins` (userKeys).

### Zalo stickers

`dsh-zalo` config gains `stickers: Record<emoji, stickerId>` (default `{}`).
The Zalo patch ships this map, from the pack "Khu Vườn Trên Mây 1"
(`https://stickers.zaloapp.com/oa/detail?cid=c65678bc44f9ada7f4e8`):

| Emoji | Sticker id |
|---|---|
| 👍 | `e4f2231c1f59f607af48` |
| ❤ | `ec2022ce1e8bf7d5ae9a` |
| 😁 | `071adff4e3b10aef53a0` |
| 🤣 | `f80822e61ea3f7fdaeb2` |
| 🤔 | `b6e67d08414da813f15c` |
| 🙈 | `1c97c779fb3c12624b2d` |
| 😎 | `181fd9f1e5b40cea55a5` |
| 🤩 | `d33017de2b9bc2c59b8a` |
| 🤗 | `94c3402d7c689536cc79` |

🔥 👀 🎉 👏 💯 🫡 have no sticker and fall back to text. Emoji keys are
compared without the U+FE0F variation selector, as idle already normalizes.

### Plans

- Plan A (rollout step 3): `chat` router with `ChatChannel` as above,
  shared gate, queue and turn; both adapters reduced to transport and
  rendering; `TelegramService` and the Zalo service removed except what
  `dsh-telegram/idle` and `dsh-telegram/schedule` still need until plan B.
- Plan B (rollout step 4): `dsh-chat/idle` and `dsh-chat/schedule`, events
  `chat/turn` and `chat/message`, Zalo `sendSticker` and the sticker map,
  idle and schedule rows in the Zalo patch and compose env.
