# dsh-telegram: persistent memory per chat and a global notice board

Date: 2026-09-17
Status: approved design, pending implementation plan

## Goal

Let the agent remember short facts about the person or group it talks to
("likes black coffee, no sugar", "team stand-up Monday 9:00") across
`/reset`, container restarts, and context compaction, without letting one
chat's memory reach another chat. A second, global scope is a public notice
board that every chat can read and only super admins can edit.

## Decisions already made

| Topic | Decision |
|---|---|
| Where memory lives | Inside `dsh-telegram`, as three native tools and a JSON file store under `<dataDir>/memory/`. No Engram or other MCP memory server: they scope by process working directory or by model-supplied names, so they cannot enforce who is speaking. `dsh-telegram` knows the sender of every turn and enforces scope in code. |
| Scopes | `chat` and `global`. `chat` is the memory of the current conversation: in a private chat that is one user (Telegram private chat id equals the user id), in a group it is that group. There is no per-user scope that crosses chats: a group agent is one context shared by everyone in it, so anything that enters it can be repeated to anyone in it. Keeping personal memory inside the private chat is the only isolation that holds without trusting the model. |
| Global scope | Readable from every chat. Every write (add, replace, forget) requires the turn's sender to be a super admin **and** the chat to be private. The admin rule decides who may edit; the private-chat rule keeps group members outside the allowlist from steering an admin's turn through the "Recent group messages" block. |
| Super admins | New config field `superAdmins: number[]` (Telegram user ids only, never usernames), from `TELEGRAM_SUPER_ADMINS`. Default `[]`: nobody can write global. |
| Caps | Per chat 50 entries, global 50 entries, 200 characters per entry. Configurable. A full scope rejects the save and lists the existing entries so the model merges (`replace_id`) or forgets one; nothing is evicted or truncated silently. |
| Recall | Once per session the chat's memory and the global memory are prepended to the user message; afterwards the model uses `memory_recall`. Worst case 20,000 characters (about 6-7k tokens of Vietnamese) once per chat per session; typical entries are far shorter. |
| Search | `memory_recall` filters by case-insensitive substring, like `telegram_chat_history`. No full-text index, no embeddings: a scope holds at most 50 lines. |
| Prompt cache | Tool schemas and persona text are static. The injected memory block is part of a user message, so it only appends to history. Nothing dynamic enters the system prompt. |

## Storage: `src/memory.ts`

```ts
export type MemoryScope = { kind: 'chat'; chatId: number } | { kind: 'global' }
export interface MemoryEntry { id: number; text: string; ts: string }
export interface MemoryLimits { maxEntries: number; maxGlobalEntries: number; maxEntryChars: number }

export class MemoryStore {
  constructor(dir: string, limits: MemoryLimits)
  list(scope: MemoryScope): Promise<MemoryEntry[]>
  save(scope: MemoryScope, text: string, replaceId?: number): Promise<MemoryEntry>
  forget(scope: MemoryScope, id: number): Promise<void>
}
```

- Files: `<dir>/<chatId>.json` and `<dir>/global.json`, content
  `{ "nextId": number, "entries": MemoryEntry[] }`. A missing file is an
  empty scope.
- Every write reads the file, applies the change, writes `<file>.tmp` and
  renames it over the original. Nothing is cached in memory, so a file edited
  by hand on the host is picked up on the next call.
- `save` trims the text, then rejects (throws `Error` with a model-facing
  message) when: the text is empty; the text exceeds `maxEntryChars`
  ("entry is N characters, the limit is 200; shorten it"); `replaceId` names
  no existing entry; or no `replaceId` is given and the scope already holds
  its cap ("memory is full (50/50); replace or forget an entry first:"
  followed by `[#id] text` lines). A replace keeps the entry's id and
  updates `text` and `ts`.
- `forget` rejects an unknown id. Ids are never reused: `nextId` only
  increases.
- Entries are listed oldest first.

## Tools: `src/tools.ts`

`ToolDeps` gains `memory: MemoryStore`, `isGroup: boolean`,
`superAdmins: readonly number[]`, and `currentSender: () => TelegramUser | undefined`.
`registerChatTools` registers the three tools next to the existing two.

| Tool | Parameters | Behaviour |
|---|---|---|
| `memory_save` | `text` (required), `scope` (`chat` \| `global`, default `chat`), `replace_id` (integer) | Saves or replaces one entry. Returns `Saved [#id] text` or `Replaced [#id] text`. |
| `memory_recall` | `scope` (`chat` \| `global` \| `all`, default `all`), `query` (string) | Lists entries, oldest first, as `[#id] text` under a `Chat memory:` / `Global memory:` heading; `query` is a case-insensitive substring filter. Empty scopes render `(none)`. |
| `memory_forget` | `scope` (`chat` \| `global`, required), `id` (integer, required) | Deletes one entry. Returns `Forgot [#id]`. |

Authorization happens inside `execute`, never in the prompt. For
`scope: global` on `memory_save` and `memory_forget`:

1. `deps.isGroup` → throw `global memory can only be edited from a private chat with the bot`.
2. `deps.currentSender()` undefined or its `id` not in `superAdmins` → throw
   `only super admins can edit global memory`.

The tool descriptions state these rules in one sentence each so the model
does not attempt a write it cannot make. The model relays the thrown message
to the user; it never decides authorization itself.

## Sender of the current turn

`ChatAgents` keeps `private readonly senders = new Map<number, TelegramUser>()`
with `setSender(chatId, user)` and `sender(chatId)`. `handleMessage` calls
`setSender` after `resolve()` and before `runTurn`. Turns are serialised per
chat by `createDispatcher`, so the map always names the person whose message
started the running turn. The `setup` callback in `index.ts` passes
`currentSender: () => agents.sender(chatId)` into `ToolDeps`.

## Injection once per session

`ChatAgents` keeps `private readonly injected = new Map<number, string>()`
(chat id → session id that already received the memory block).
`handleMessage`, after `resolve()`:

1. If `injected.get(chatId)` differs from the resolved agent's session id,
   read `memory.list({ kind: 'chat', chatId })` and `memory.list({ kind: 'global' })`.
2. Render the non-empty scopes and prepend them to the turn text:

```
[Memory of this conversation]
- [#3] Likes black coffee, no sugar
- [#7] Learning Japanese, aiming for N3 in December

[Global memory]
- [#1] Team stand-up Monday 9:00

<recent group messages block, if any>

<user text>
```

3. Record `injected.set(chatId, sessionId)` only after the turn was handed to
   the agent, so a failed prep does not mark the session as done.

A new session (`/reset`, failed resume) has a new id and is injected again on
its first turn. The map is process memory: after a restart every chat is
injected once more, which is accepted. If the schedule design's per-turn
timestamp line lands, the memory block goes directly after it; the schedule
spec owns that ordering.

## Prompt

Both `cordis.patch.yml` files extend `personaSuffix` (English in the bundle,
Vietnamese in the profile) with three sentences to this effect:

> You have a persistent memory for this conversation: when the user shares a
> preference, habit, fact about themselves, or asks you to remember
> something, store one short fact with `memory_save`, and use `replace_id`
> when it updates an earlier fact instead of adding a new one. Call
> `memory_recall` when the user asks about earlier conversations or when
> memory shown earlier may have been dropped from context. Global memory is
> shared with every chat: read it freely, write to it only when the user
> explicitly asks for something to be remembered globally.

The system prompt stays static; the persona is not rebuilt per turn.

## Configuration

`src/config.ts`:

```ts
readonly superAdmins: number[]          // z.array(z.number()).default([])
readonly memory: MemoryLimits           // maxEntries 50, maxGlobalEntries 50, maxEntryChars 200; each min 1
```

Both `cordis.patch.yml` files add to the `telegram` row:

```yaml
superAdmins: !!js (process.env.TELEGRAM_SUPER_ADMINS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
```

`.env.example` documents `TELEGRAM_SUPER_ADMINS` (comma-separated user ids).
`README.md` gains a short "Memory" section: the two scopes, where the files
live, the caps, and the super admin rule.

`index.ts` constructs `new MemoryStore(join(config.dataDir, 'memory'), config.memory)`
next to the existing `ChatLog`.

## Error handling

- All rejections above are thrown `Error`s with English messages written for
  the model; the tool pipeline reports them as failed tool calls.
- File system errors other than `ENOENT` on read propagate unchanged.
- A failed memory read during injection is logged with `log.warn` and the
  turn proceeds without the block; the session is not marked as injected.

## Testing (vitest)

- `tests/memory.test.ts`: save/list/replace/forget round trip; ids increase
  monotonically across forgets; chat cap and global cap reject with the
  entry list; over-length and empty text reject; replace on a full scope is
  allowed; unknown `replaceId`/`id` reject; missing file lists empty; the
  file is replaced atomically (no `.tmp` left behind); chat scopes are
  independent of each other and of global.
- `tests/tools.test.ts`: default scopes; recall `query` filtering and
  headings; global write rejected for a non-admin in a private chat, for an
  admin in a group, for a missing sender; accepted for an admin in a private
  chat.
- `tests/bot.test.ts`: the memory block is prepended on the first turn of a
  session and absent on the second; present again after `/reset`; order of
  memory block, recent group block, and user text; `setSender` is called
  before the turn starts; empty scopes produce no block.

## Out of scope

Per-user memory that crosses chats, full-text or semantic search, automatic
promotion of facts to global, time-based forgetting, and Engram or any MCP
memory server. A cross-chat scope, if ever wanted, is a new opt-in scope with
its own authorization rule, not a change to `chat`.
