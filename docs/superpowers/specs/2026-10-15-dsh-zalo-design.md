# dsh-zalo: Zalo Bot channel bundle

Date: 2026-10-15
Status: approved design, pending implementation plan

## Goal

Let people chat with a DeepSeek Harness agent through a Zalo Bot, the way
`dsh-telegram` does for Telegram: one agent session per chat, private chats and
groups, persistent per-chat and global memory. The bundle is a new package,
`packages/dsh-zalo`, a Cordis plugin named `dsh-zalo` that provides the `zalo`
service. `dsh-telegram` is not changed.

API reference: https://docs.zaloplatforms.com/docs/BOT/apis/getMe
Base URL: `https://bot-api.zaloplatforms.com/bot<TOKEN>/<method>`, all calls `POST` JSON.

## Decisions

| Topic | Decision |
|---|---|
| Scope (MVP) | Private and group chats; text in and out; inbound photos; sticker/voice/unsupported logged as markers; per-chat and global memory; typing indicator. |
| Out of scope | Idle engagement, reminders, agent-sent files/photos, reactions, quoted replies, live status edits. Zalo has no edit, delete, reaction, reply-to or file-upload API. |
| Code sharing | Standalone package. Channel-agnostic modules are copied from `dsh-telegram` with `chatId: string`; no shared core package until a third channel exists. |
| Updates | Long polling `getUpdates` (`timeout` 30 s). No webhook: the host has no public HTTPS endpoint. |
| Dedupe | `getUpdates` documents no `offset`, so redelivery is possible. Updates whose `message_id` is in an in-memory LRU of the last 1000 ids are dropped. Lost updates across restarts are accepted. |
| Ids | Zalo user and chat ids are strings; every `chatId`, `allowFrom` and `superAdmins` entry is a string. |
| Group trigger | In a `GROUP` chat a message gets a turn only when its text contains `@<account_name>` (case-insensitive) or starts with `groupPrefix` (default `/ask`). The trigger is stripped from the prompt. Other group messages are logged only, as chat history. |
| Access | A message gets a turn only if `from.id` is in `allowFrom`. Group messages from others are still logged. |
| Commands | `/reset`, `/stop`, `/help`, matched like `dsh-telegram`. |
| Progress | `sendChatAction(typing)` at turn start and every 4 s until it ends; failures only warn. |
| Rendering | `sendMessage` with `parse_mode: markdown`. Replies are split into chunks of at most 2000 characters, cut at paragraph or line boundaries, sent in order. A chunk rejected by the API is resent as plain text. |
| Inbound photos | Downloaded from the `photo` URL (retry on network error, 429, 5xx), saved under `workspace/<chat>/inbox/`, passed to the agent as an image. |

## Spike before implementation

Zalo marks groups as Beta and does not document whether a group bot receives
every message or only mentions, nor the exact group payload. The first plan task
adds the bot to a real group, logs raw `getUpdates` payloads (private text,
private photo, group text with and without mention), and records the findings.
If the bot receives only mentions, the `log-only` path simply never fires; if
the payload differs from the documented shape, `inbound.ts` follows the
observed shape.

## Components

```
packages/dsh-zalo/
  cordis.patch.yml   persona, logger, dsh-zalo plugin row, time-context
  src/
    index.ts         apply(): retention timer; retryStart(start) -> provide('zalo')
    config.ts        Schemastery Config + assertConfig
    zalo-api.ts      ZaloApi interface + fetch implementation, ZaloApiError
    poller.ts        getUpdates loop, backoff, message_id dedupe
    inbound.ts       ZaloUpdate -> InboundMessage
    bot.ts           gate, commands, per-chat dispatcher queue
    turn.ts          one agent turn: typing loop, summary, delivery
    render.ts        markdown chunking to 2000 chars
    sessions.ts      ChatAgents (from dsh-telegram, chatId: string)
    tools.ts         zalo_chat_history, memory_save, memory_recall, memory_forget
                     (as dsh-telegram minus telegram_send_file)
    service.ts       ZaloService + Cordis Context/Events augmentation
    chatlog.ts, memory.ts, session-map.ts, json-file.ts, retention.ts,
    media.ts, logger.ts   copied from dsh-telegram, chatId: string
  tests/             vitest, FakeZaloApi helper
profile/zalo/        package.json + cordis.patch.yml, like profile/telegram
```

### ZaloApi

```ts
interface ZaloApi {
  getMe(): Promise<{ id: string; accountName: string }>
  getUpdates(timeoutSec: number): Promise<ZaloUpdate[]>
  sendMessage(chatId: string, text: string, options?: { parseMode?: 'markdown' }): Promise<{ messageId: string }>
  sendChatAction(chatId: string, action: 'typing'): Promise<void>
  downloadUrl(url: string): Promise<Buffer>
}
```

`ok: false` responses throw `ZaloApiError(description, errorCode)`. Calls retry
on network errors, 429 and 5xx with exponential backoff (`retry` config).
`getUpdates` accepts `result` as one update or an array and always returns an
array. A long-poll timeout with no update returns `[]`.

### ZaloUpdate (documented shape)

```json
{
  "event_name": "message.text.received",
  "message": {
    "from": { "id": "…", "display_name": "Ted", "is_bot": false },
    "chat": { "id": "…", "chat_type": "PRIVATE" },
    "message_id": "…", "date": 1750316131602,
    "text": "…", "photo": "https://…", "caption": "…",
    "sticker": "…", "url": "https://…", "voice_url": "https://…"
  }
}
```

`inbound.ts` maps events: `message.text.received` -> text;
`message.image.received` -> image + caption; `message.sticker.received` ->
`[sticker]`; `message.voice.received` -> `[voice]`;
`message.unsupported.received` -> `[unsupported message]`.

### Config

| Field | Default | Notes |
|---|---|---|
| `botToken` | required | `ZALO_BOT_TOKEN` |
| `allowFrom` | required, non-empty | Zalo user ids, `ZALO_ALLOW_FROM` |
| `workspaceRoot`, `dataDir` | required, absolute | `DSH_ZALO_WORKSPACE`, `DSH_ZALO_DATA` |
| `provider`, `model`, `reasoningEffort` | as dsh-telegram | `DSH_MODEL` |
| `groupPrefix` | `/ask` | |
| `messageSize` | 2000 | max chars per chunk, 500..2000 |
| `pollTimeoutSec` | 30 | |
| `typingIntervalMs` | 4000 | |
| `recentMessagesLimit`, `turnTimeoutMs`, `fileRetentionDays`, `chatLogMaxEntries`, `retry`, `memory` | as dsh-telegram | |
| `superAdmins` | `[]` | Zalo user ids allowed to write global memory, `ZALO_SUPER_ADMINS` |

### ZaloService

Provided only after `getMe` succeeds and polling starts; revoked first on stop.

```ts
interface ZaloService {
  readonly api: ZaloApi
  readonly chatLog: ChatLog
  readonly queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>
  readonly bot: { readonly id: string; readonly accountName: string }
  readonly dataDir: string
  chatOf(agentId: string): string | undefined
}
```

Events: `zalo/turn(chatId)`, `zalo/message(chatId, entry)`, matching the
telegram events so idle or schedule plugins can be added later.

## Data flow

1. `poller` calls `getUpdates` in a loop, drops seen `message_id`s, and hands
   each update to `dispatcher.dispatch`.
2. `gate` returns `ignore` (bot sender, or a non-allowed sender in a private
   chat), `log-only` (group message without trigger, or a non-allowed sender in a group),
   or `handle`.
3. Every non-ignored message is appended to the chat log. A `handle` message is
   enqueued on its chat's queue; turns in one chat never overlap.
4. The turn sends `typing` and repeats it every `typingIntervalMs`, runs the
   agent with the memory block and `<chat_history>` (as dsh-telegram), then
   renders, chunks and sends the reply, and logs it.

## Error handling

- Start failure (`getMe`, network): `retryStart` with 5 s .. 5 min backoff; the process stays up.
- Poll failure: exponential backoff up to `retry.maxDelayMs`; the loop never exits until stop.
- Turn timeout, error, or `/stop`: one short notice message to the chat.
- Typing failures: warn only, never drop the reply.
- Send failure of a markdown chunk: retry as plain text once; if that fails, log an error.

## Persistence

Under `dataDir`: `zalo-sessions.json`, `chatlog/`, `memory/`; same formats as
dsh-telegram with string chat ids. Workspaces under `workspaceRoot/<chatId>/`.

## Deployment

A `dsh-zalo` service in `docker-compose.yml` beside `dsh-telegram`, same image
build pattern, `TZ=Asia/Ho_Chi_Minh`, env `ZALO_BOT_TOKEN`, `ZALO_ALLOW_FROM`,
`ZALO_SUPER_ADMINS`, `DSH_ZALO_DATA`, `DSH_ZALO_WORKSPACE`, `DSH_MODEL`.
`.env.example` gains the Zalo variables.

## Testing

Vitest with a `FakeZaloApi` recorder:

- `gate`: private allowed/denied, group with mention, with prefix, without trigger, bot sender.
- `inbound`: each of the five event types; photo download failure falls back to a text marker.
- `render`: chunks never exceed `messageSize`; cuts at paragraph, then line, then hard limit.
- `poller`: dedupe of repeated `message_id`; backoff after errors; stop ends the loop.
- `turn`: typing repeats until done; multi-chunk reply order; plain-text fallback.
- `config`: defaults and `assertConfig` errors.
- `profile`: `cordis.patch.yml` parses and names the expected plugins.
