# dsh-telegram Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Telegram agent a capped persistent memory per chat plus a super-admin-only global memory, injected once per session and editable through three native tools.

**Architecture:** A `MemoryStore` keeps one small JSON file per scope under `<dataDir>/memory/` and enforces caps. Three tools (`memory_save`, `memory_recall`, `memory_forget`) are registered per chat agent next to the existing Telegram tools; authorization for global writes is checked in the tool from the sender that `ChatAgents` records before each turn. `handleMessage` prepends the chat and global memory to the first user message of every session.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `@deepseek-ai/dsh-tools` `defineTool`, Schemastery config, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-telegram-memory-design.md`

## Global Constraints

- Everything in the repo is English: code, comments, tests, commit messages. The Vietnamese text lives only in `profile/telegram/cordis.patch.yml`, which is already a Vietnamese persona.
- No Unicode emoji in code or data.
- Prompt cache: nothing dynamic enters the system prompt; the memory block is part of a user message only.
- Caps default to chat 50 entries, global 50 entries, 200 characters per entry; nothing is evicted or truncated silently.
- Global memory writes require the turn's sender to be in `superAdmins` **and** the chat to be private; both checks live in tool code, never in the prompt.
- Scope ids in tool output and injected text render as `[#id] text`.
- Match the surrounding style: 2-space indent, no semicolons, single quotes, `readonly` config fields, doc comments in the existing terse voice.
- All commands run from `packages/dsh-telegram` unless a step says otherwise; commits run from the repo root.

---

## File structure

| File | Responsibility |
|---|---|
| Create `packages/dsh-telegram/src/memory.ts` | `MemoryStore` (JSON file per scope, caps, atomic writes), `formatMemoryEntry`, `renderMemoryBlock` |
| Modify `packages/dsh-telegram/src/config.ts` | `superAdmins`, `memory` limits |
| Modify `packages/dsh-telegram/src/sessions.ts` | `TurnContext` per chat, once-per-session injection bookkeeping |
| Modify `packages/dsh-telegram/src/tools.ts` | Three memory tools, `ToolDeps` additions, registration |
| Modify `packages/dsh-telegram/src/bot.ts` | Set the turn context, prepend the memory block once per session |
| Modify `packages/dsh-telegram/src/index.ts` | Construct the store, wire deps |
| Modify `packages/dsh-telegram/cordis.patch.yml`, `profile/telegram/cordis.patch.yml` | `superAdmins` row field, persona sentences |
| Modify `.env.example`, `README.md` | Document `TELEGRAM_SUPER_ADMINS` and the memory feature |
| Tests | `tests/memory.spec.ts` (new), `tests/config.spec.ts`, `tests/sessions.spec.ts`, `tests/tools.spec.ts`, `tests/bot.spec.ts` |

---

### Task 1: MemoryStore

**Files:**
- Create: `packages/dsh-telegram/src/memory.ts`
- Test: `packages/dsh-telegram/tests/memory.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type MemoryScope = { kind: 'chat'; chatId: number } | { kind: 'global' }`
  - `interface MemoryEntry { id: number; text: string; ts: string }`
  - `interface MemoryLimits { readonly maxEntries: number; readonly maxGlobalEntries: number; readonly maxEntryChars: number }`
  - `class MemoryStore { constructor(dir: string, limits: MemoryLimits); list(scope): Promise<MemoryEntry[]>; save(scope, text, replaceId?): Promise<MemoryEntry>; forget(scope, id): Promise<void> }`
  - `formatMemoryEntry(entry: MemoryEntry): string` → `[#id] text`
  - `renderMemoryBlock(chat: MemoryEntry[], global: MemoryEntry[]): string` → `''` when both are empty

- [ ] **Step 1: Write the failing tests**

Create `packages/dsh-telegram/tests/memory.spec.ts`:

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, formatMemoryEntry, renderMemoryBlock } from '../src/memory.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const limits = { maxEntries: 3, maxGlobalEntries: 2, maxEntryChars: 20 }
const chat = { kind: 'chat', chatId: 5 } as const
const global = { kind: 'global' } as const

describe('MemoryStore', () => {
  it('lists an empty scope when no file exists', async () => {
    const store = new MemoryStore(join(dir, 'missing'), limits)
    expect(await store.list(chat)).toEqual([])
    expect(await store.list(global)).toEqual([])
  })

  it('saves, replaces and forgets entries; ids never repeat', async () => {
    const store = new MemoryStore(dir, limits)
    const a = await store.save(chat, ' coffee ')
    const b = await store.save(chat, 'tea')
    expect([a.id, b.id]).toEqual([1, 2])
    expect(a.text).toBe('coffee')
    const replaced = await store.save(chat, 'black coffee', 1)
    expect(replaced).toMatchObject({ id: 1, text: 'black coffee' })
    await store.forget(chat, 2)
    const c = await store.save(chat, 'milk')
    expect(c.id).toBe(3)
    expect((await store.list(chat)).map(e => e.text)).toEqual(['black coffee', 'milk'])
  })

  it('rejects empty and over-long text', async () => {
    const store = new MemoryStore(dir, limits)
    await expect(store.save(chat, '   ')).rejects.toThrow(/empty/)
    await expect(store.save(chat, 'x'.repeat(21))).rejects.toThrow(/21 characters, the limit is 20/)
    expect(await store.list(chat)).toEqual([])
  })

  it('rejects unknown ids for replace and forget', async () => {
    const store = new MemoryStore(dir, limits)
    await expect(store.save(chat, 'x', 9)).rejects.toThrow(/no memory entry #9/)
    await expect(store.forget(chat, 9)).rejects.toThrow(/no memory entry #9/)
  })

  it('enforces the chat cap and the global cap, listing existing entries; replace still works when full', async () => {
    const store = new MemoryStore(dir, limits)
    for (const text of ['a', 'b', 'c']) await store.save(chat, text)
    await expect(store.save(chat, 'd')).rejects.toThrow(/full \(3\/3\)[\s\S]*\[#1\] a\n\[#2\] b\n\[#3\] c/)
    await expect(store.save(chat, 'd', 2)).resolves.toMatchObject({ id: 2, text: 'd' })
    await store.save(global, 'g1')
    await store.save(global, 'g2')
    await expect(store.save(global, 'g3')).rejects.toThrow(/full \(2\/2\)/)
  })

  it('keeps chat scopes independent of each other and of global', async () => {
    const store = new MemoryStore(dir, limits)
    await store.save(chat, 'five')
    await store.save({ kind: 'chat', chatId: 6 }, 'six')
    await store.save(global, 'everyone')
    expect((await store.list(chat)).map(e => e.text)).toEqual(['five'])
    expect((await store.list({ kind: 'chat', chatId: 6 })).map(e => e.text)).toEqual(['six'])
    expect((await store.list(global)).map(e => e.text)).toEqual(['everyone'])
  })

  it('writes one JSON file per scope atomically, leaving no temp file', async () => {
    const store = new MemoryStore(dir, limits)
    await store.save(chat, 'x')
    await store.save(global, 'y')
    expect((await readdir(dir)).sort()).toEqual(['5.json', 'global.json'])
    expect(JSON.parse(await readFile(join(dir, '5.json'), 'utf8'))).toEqual({
      nextId: 2,
      entries: [{ id: 1, text: 'x', ts: expect.any(String) }],
    })
  })
})

describe('formatMemoryEntry / renderMemoryBlock', () => {
  const e = (id: number, text: string) => ({ id, text, ts: 't' })

  it('formats one entry as [#id] text', () => {
    expect(formatMemoryEntry(e(4, 'likes tea'))).toBe('[#4] likes tea')
  })

  it('renders only the non-empty scopes and nothing when both are empty', () => {
    expect(renderMemoryBlock([], [])).toBe('')
    expect(renderMemoryBlock([e(1, 'a')], [])).toBe('[Memory of this conversation]\n- [#1] a')
    expect(renderMemoryBlock([], [e(2, 'b')])).toBe('[Global memory]\n- [#2] b')
    expect(renderMemoryBlock([e(1, 'a'), e(3, 'c')], [e(2, 'b')]))
      .toBe('[Memory of this conversation]\n- [#1] a\n- [#3] c\n\n[Global memory]\n- [#2] b')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/memory.spec.ts`
Expected: FAIL — cannot resolve `../src/memory.ts`.

- [ ] **Step 3: Implement `src/memory.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `chat` is the memory of one conversation (a private chat or a group); `global` is shared by every chat. */
export type MemoryScope = { kind: 'chat'; chatId: number } | { kind: 'global' }

export interface MemoryEntry { id: number; text: string; ts: string }

/** Caps enforced by the store; see the memory design spec. */
export interface MemoryLimits {
  readonly maxEntries: number
  readonly maxGlobalEntries: number
  readonly maxEntryChars: number
}

interface MemoryFile { nextId: number; entries: MemoryEntry[] }

export function formatMemoryEntry(entry: MemoryEntry): string {
  return `[#${entry.id}] ${entry.text}`
}

/** One small JSON file per scope under `dir`, rewritten atomically on every change; nothing is cached. */
export class MemoryStore {
  constructor(private readonly dir: string, private readonly limits: MemoryLimits) {}

  private file(scope: MemoryScope): string {
    return join(this.dir, scope.kind === 'global' ? 'global.json' : `${scope.chatId}.json`)
  }

  private cap(scope: MemoryScope): number {
    return scope.kind === 'global' ? this.limits.maxGlobalEntries : this.limits.maxEntries
  }

  private async read(scope: MemoryScope): Promise<MemoryFile> {
    try {
      return JSON.parse(await readFile(this.file(scope), 'utf8')) as MemoryFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nextId: 1, entries: [] }
      throw error
    }
  }

  private async write(scope: MemoryScope, data: MemoryFile): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.file(scope)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, target)
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return (await this.read(scope)).entries
  }

  /** Append one entry, or overwrite `replaceId`; errors carry a message written for the model. */
  async save(scope: MemoryScope, text: string, replaceId?: number): Promise<MemoryEntry> {
    const trimmed = text.trim()
    if (trimmed === '') throw new Error('memory text is empty')
    if (trimmed.length > this.limits.maxEntryChars) {
      throw new Error(`entry is ${trimmed.length} characters, the limit is ${this.limits.maxEntryChars}; shorten it`)
    }
    const data = await this.read(scope)
    const ts = new Date().toISOString()
    if (replaceId !== undefined) {
      const existing = data.entries.find(e => e.id === replaceId)
      if (existing === undefined) throw new Error(`no memory entry #${replaceId}`)
      existing.text = trimmed
      existing.ts = ts
      await this.write(scope, data)
      return existing
    }
    const cap = this.cap(scope)
    if (data.entries.length >= cap) {
      throw new Error(`memory is full (${cap}/${cap}); replace or forget an entry first:\n${data.entries.map(formatMemoryEntry).join('\n')}`)
    }
    const entry: MemoryEntry = { id: data.nextId, text: trimmed, ts }
    data.nextId += 1
    data.entries.push(entry)
    await this.write(scope, data)
    return entry
  }

  async forget(scope: MemoryScope, id: number): Promise<void> {
    const data = await this.read(scope)
    const index = data.entries.findIndex(e => e.id === id)
    if (index === -1) throw new Error(`no memory entry #${id}`)
    data.entries.splice(index, 1)
    await this.write(scope, data)
  }
}

/** The block prepended to the first user turn of a session; empty when both scopes are empty. */
export function renderMemoryBlock(chat: MemoryEntry[], global: MemoryEntry[]): string {
  const sections: string[] = []
  if (chat.length > 0) sections.push(`[Memory of this conversation]\n${chat.map(e => `- ${formatMemoryEntry(e)}`).join('\n')}`)
  if (global.length > 0) sections.push(`[Global memory]\n${global.map(e => `- ${formatMemoryEntry(e)}`).join('\n')}`)
  return sections.join('\n\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/memory.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add packages/dsh-telegram/src/memory.ts packages/dsh-telegram/tests/memory.spec.ts
git commit -m "feat(telegram): add MemoryStore with per-scope JSON files and caps"
```

---

### Task 2: Configuration

**Files:**
- Modify: `packages/dsh-telegram/src/config.ts`
- Modify: `packages/dsh-telegram/cordis.patch.yml`
- Modify: `profile/telegram/cordis.patch.yml`
- Modify: `.env.example`
- Test: `packages/dsh-telegram/tests/config.spec.ts`

**Interfaces:**
- Consumes: `MemoryLimits` from `src/memory.ts` (Task 1).
- Produces: `Config.superAdmins: number[]` (default `[]`), `Config.memory: MemoryLimits` (defaults 50 / 50 / 200).

- [ ] **Step 1: Write the failing tests**

Append to the `describe('Config', ...)` block in `tests/config.spec.ts`:

```ts
  it('defaults superAdmins to nobody and memory caps to 50/50/200', () => {
    const config = Config(minimal)
    expect(config.superAdmins).toEqual([])
    expect(config.memory).toEqual({ maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  })

  it('accepts super admin ids and partial memory overrides', () => {
    const config = Config({ ...minimal, superAdmins: [42, 7], memory: { maxEntries: 10 } })
    expect(config.superAdmins).toEqual([42, 7])
    expect(config.memory).toEqual({ maxEntries: 10, maxGlobalEntries: 50, maxEntryChars: 200 })
  })

  it('rejects memory caps below one', () => {
    expect(() => Config({ ...minimal, memory: { maxEntryChars: 0 } })).toThrow()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/config.spec.ts`
Expected: FAIL — `config.superAdmins` is `undefined`.

- [ ] **Step 3: Extend `src/config.ts`**

Add the import at the top:

```ts
import type { MemoryLimits } from './memory.ts'
```

Add two fields to the `Config` interface after `status`:

```ts
  /** Telegram user ids allowed to add, replace, or forget global memory entries. */
  readonly superAdmins: number[]
  readonly memory: MemoryLimits
```

Add to the `z.object({...})` after the `status` entry:

```ts
  superAdmins: z.array(z.number()).default([]),
  memory: z.object({
    maxEntries: z.number().min(1).default(50),
    maxGlobalEntries: z.number().min(1).default(50),
    maxEntryChars: z.number().min(1).default(200),
  }).default({ maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire the environment variable into both patch files**

In `packages/dsh-telegram/cordis.patch.yml`, inside the `telegram` row's `config`, after the `model` line add:

```yaml
        superAdmins: !!js (process.env.TELEGRAM_SUPER_ADMINS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
```

In `profile/telegram/cordis.patch.yml`, inside the `telegram` row's `config`, after the `model` line add the same line with the profile's indentation:

```yaml
    superAdmins: !!js (process.env.TELEGRAM_SUPER_ADMINS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
```

In `.env.example`, after the `TELEGRAM_ALLOW_FROM=` line add:

```
# Comma-separated Telegram user ids (not usernames) allowed to edit the global memory.
TELEGRAM_SUPER_ADMINS=
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add packages/dsh-telegram/src/config.ts packages/dsh-telegram/tests/config.spec.ts packages/dsh-telegram/cordis.patch.yml profile/telegram/cordis.patch.yml .env.example
git commit -m "feat(telegram): add superAdmins and memory cap configuration"
```

---

### Task 3: Turn context and once-per-session bookkeeping in `ChatAgents`

**Files:**
- Modify: `packages/dsh-telegram/src/sessions.ts`
- Test: `packages/dsh-telegram/tests/sessions.spec.ts`

**Interfaces:**
- Consumes: `TelegramUser` from `src/inbound.ts` (existing).
- Produces on `ChatAgents`:
  - `interface TurnContext { sender: TelegramUser; isGroup: boolean }` (exported from `sessions.ts`)
  - `setTurn(chatId: number, turn: TurnContext): void`
  - `turnOf(chatId: number): TurnContext | undefined`
  - `memoryInjected(chatId: number, sessionId: string): boolean`
  - `markMemoryInjected(chatId: number, sessionId: string): void`
  - `reset(chatId)` also forgets both records for the chat.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('ChatAgents', ...)` block in `tests/sessions.spec.ts`:

```ts
  it('records the running turn per chat', async () => {
    const { agents } = await build()
    const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
    expect(agents.turnOf(1)).toBeUndefined()
    agents.setTurn(1, { sender: ann, isGroup: false })
    agents.setTurn(2, { sender: ann, isGroup: true })
    expect(agents.turnOf(1)).toEqual({ sender: ann, isGroup: false })
    expect(agents.turnOf(2)).toEqual({ sender: ann, isGroup: true })
  })

  it('tracks memory injection per chat and session', async () => {
    const { agents } = await build()
    expect(agents.memoryInjected(1, 's1')).toBe(false)
    agents.markMemoryInjected(1, 's1')
    expect(agents.memoryInjected(1, 's1')).toBe(true)
    expect(agents.memoryInjected(1, 's2')).toBe(false)
    expect(agents.memoryInjected(2, 's1')).toBe(false)
  })

  it('reset forgets the turn and injection records', async () => {
    const { agents } = await build()
    await agents.resolve(1)
    agents.setTurn(1, { sender: { id: 7, is_bot: false, first_name: 'Ann' }, isGroup: false })
    agents.markMemoryInjected(1, 's1')
    await agents.reset(1)
    expect(agents.turnOf(1)).toBeUndefined()
    expect(agents.memoryInjected(1, 's1')).toBe(false)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/sessions.spec.ts`
Expected: FAIL — `agents.turnOf is not a function`.

- [ ] **Step 3: Extend `src/sessions.ts`**

Add the import:

```ts
import type { TelegramUser } from './inbound.ts'
```

Add after the `ResolvedAgent` interface:

```ts
/** Who started the turn running in a chat, and whether that chat is a group. */
export interface TurnContext { sender: TelegramUser; isGroup: boolean }
```

Inside the `ChatAgents` class, after the `handles` field:

```ts
  private readonly turns = new Map<number, TurnContext>()
  /** Session id that already received the memory block, per chat. */
  private readonly injected = new Map<number, string>()
```

After `markTurn`:

```ts
  setTurn(chatId: number, turn: TurnContext): void {
    this.turns.set(chatId, turn)
  }

  turnOf(chatId: number): TurnContext | undefined {
    return this.turns.get(chatId)
  }

  memoryInjected(chatId: number, sessionId: string): boolean {
    return this.injected.get(chatId) === sessionId
  }

  markMemoryInjected(chatId: number, sessionId: string): void {
    this.injected.set(chatId, sessionId)
  }
```

In `reset`, after `this.handles.delete(chatId)`:

```ts
    this.turns.delete(chatId)
    this.injected.delete(chatId)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/sessions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck`
Expected: no errors.

```bash
git add packages/dsh-telegram/src/sessions.ts packages/dsh-telegram/tests/sessions.spec.ts
git commit -m "feat(telegram): track the running turn and memory injection per chat"
```

---

### Task 4: Memory tools

**Files:**
- Modify: `packages/dsh-telegram/src/tools.ts`
- Test: `packages/dsh-telegram/tests/tools.spec.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `MemoryScope`, `formatMemoryEntry` (Task 1); `TurnContext` (Task 3).
- Produces:
  - `ToolDeps` gains `memory: MemoryStore`, `superAdmins: readonly number[]`, `currentTurn: () => TurnContext | undefined`.
  - `createMemorySaveTool(deps)`, `createMemoryRecallTool(deps)`, `createMemoryForgetTool(deps)`: `ToolDefinition`.
  - `registerChatTools` registers five tools in this order: `telegram_send_file`, `telegram_chat_history`, `memory_save`, `memory_recall`, `memory_forget`.

- [ ] **Step 1: Write the failing tests**

In `tests/tools.spec.ts`, replace the imports and the `deps()` helper with:

```ts
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { MemoryStore } from '../src/memory.ts'
import type { TurnContext } from '../src/sessions.ts'
import {
  createChatHistoryTool,
  createMemoryForgetTool,
  createMemoryRecallTool,
  createMemorySaveTool,
  createSendFileTool,
  registerChatTools,
} from '../src/tools.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
let turn: TurnContext | undefined
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'tools-'))); api = new FakeTelegramApi(); turn = undefined })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

const admin = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const member = { id: 9, is_bot: false, first_name: 'Bob' }

function deps() {
  return {
    api,
    chatLog: new ChatLog(join(dir, 'log')),
    chatId: 5,
    workspaceDir: dir,
    maxUploadBytes: 100,
    memory: new MemoryStore(join(dir, 'memory'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
    superAdmins: [7],
    currentTurn: () => turn,
  }
}
```

Change the `registerChatTools` expectation to the five names:

```ts
    expect(registered).toEqual(['telegram_send_file', 'telegram_chat_history', 'memory_save', 'memory_recall', 'memory_forget'])
```

Append these describe blocks:

```ts
describe('memory_save / memory_recall / memory_forget', () => {
  it('saves to the chat scope by default and recalls both scopes with headings', async () => {
    const d = deps()
    turn = { sender: admin, isGroup: false }
    const save = createMemorySaveTool(d)
    expect(save.name).toBe('memory_save')
    expect(await save.execute({ text: 'likes tea' }, exec)).toBe('Saved [#1] likes tea')
    expect(await save.execute({ text: 'stand-up 9:00', scope: 'global' }, exec)).toBe('Saved [#1] stand-up 9:00')
    expect(await save.execute({ text: 'likes black tea', replace_id: 1 }, exec)).toBe('Replaced [#1] likes black tea')
    expect((await d.memory.list({ kind: 'chat', chatId: 5 })).map(e => e.text)).toEqual(['likes black tea'])

    const recall = createMemoryRecallTool(d)
    expect(recall.name).toBe('memory_recall')
    expect(await recall.execute({}, exec)).toBe('Chat memory:\n[#1] likes black tea\n\nGlobal memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'chat' }, exec)).toBe('Chat memory:\n[#1] likes black tea')
    expect(await recall.execute({ scope: 'global', query: 'STAND' }, exec)).toBe('Global memory:\n[#1] stand-up 9:00')
    expect(await recall.execute({ scope: 'all', query: 'zzz' }, exec)).toBe('Chat memory:\n(none)\n\nGlobal memory:\n(none)')
  })

  it('forgets by scope and id', async () => {
    const d = deps()
    turn = { sender: admin, isGroup: false }
    await createMemorySaveTool(d).execute({ text: 'a' }, exec)
    const forget = createMemoryForgetTool(d)
    expect(forget.name).toBe('memory_forget')
    expect(await forget.execute({ scope: 'chat', id: 1 }, exec)).toBe('Forgot [#1]')
    expect(await d.memory.list({ kind: 'chat', chatId: 5 })).toEqual([])
    await expect(forget.execute({ scope: 'chat', id: 1 }, exec)).rejects.toThrow(/no memory entry #1/)
  })

  it('lets only a super admin in a private chat edit global memory', async () => {
    const d = deps()
    const save = createMemorySaveTool(d)
    const forget = createMemoryForgetTool(d)

    turn = { sender: member, isGroup: false }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/only super admins/)
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow(/only super admins/)
    expect(await save.execute({ text: 'mine' }, exec)).toBe('Saved [#1] mine')

    turn = { sender: admin, isGroup: true }
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/private chat/)
    await expect(forget.execute({ scope: 'global', id: 1 }, exec)).rejects.toThrow(/private chat/)

    turn = undefined
    await expect(save.execute({ text: 'x', scope: 'global' }, exec)).rejects.toThrow(/only super admins/)

    turn = { sender: admin, isGroup: false }
    expect(await save.execute({ text: 'x', scope: 'global' }, exec)).toBe('Saved [#1] x')
    expect(await forget.execute({ scope: 'global', id: 1 }, exec)).toBe('Forgot [#1]')
    expect(await d.memory.list({ kind: 'global' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/tools.spec.ts`
Expected: FAIL — `createMemorySaveTool` is not exported.

- [ ] **Step 3: Implement the tools in `src/tools.ts`**

Add imports:

```ts
import { formatMemoryEntry, type MemoryScope, type MemoryStore } from './memory.ts'
import type { TurnContext } from './sessions.ts'
```

Extend `ToolDeps`:

```ts
export interface ToolDeps {
  api: TelegramApi
  chatLog: ChatLog
  chatId: number
  workspaceDir: string
  maxUploadBytes: number
  memory: MemoryStore
  superAdmins: readonly number[]
  /** The turn running in this chat; tools use it to authorise global writes. */
  currentTurn: () => TurnContext | undefined
}
```

Add after `createChatHistoryTool`:

```ts
const WRITE_SCOPES = ['chat', 'global'] as const
const RECALL_SCOPES = ['chat', 'global', 'all'] as const

function scopeOf(deps: ToolDeps, name: 'chat' | 'global'): MemoryScope {
  return name === 'global' ? { kind: 'global' } : { kind: 'chat', chatId: deps.chatId }
}

/** Global memory is public to every chat: only a super admin may edit it, and only from a private chat, where no stranger's text is in context. */
function assertGlobalWrite(deps: ToolDeps): void {
  const turn = deps.currentTurn()
  if (turn?.isGroup) throw new Error('global memory can only be edited from a private chat with the bot')
  if (turn === undefined || !deps.superAdmins.includes(turn.sender.id)) throw new Error('only super admins can edit global memory')
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
} as const

export function createMemorySaveTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_save',
    description: 'Store one short fact in persistent memory. Scope "chat" (default) is the memory of this conversation; "global" is shared with every chat and can only be edited by a super admin from a private chat. Pass replace_id to update an existing entry instead of adding a new one.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact to remember, one short sentence' },
      scope: { type: 'string', enum: WRITE_SCOPES, description: 'chat (default) or global' },
      replace_id: { type: 'integer', description: 'Id of an existing entry to overwrite' },
    },
    output: textOutput,
    async execute(args) {
      const scope = args.scope ?? 'chat'
      if (scope === 'global') assertGlobalWrite(deps)
      const entry = await deps.memory.save(scopeOf(deps, scope), args.text, args.replace_id)
      return `${args.replace_id === undefined ? 'Saved' : 'Replaced'} ${formatMemoryEntry(entry)}`
    },
  })
}

export function createMemoryRecallTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_recall',
    description: 'List persistent memory entries, oldest first. Scope "all" (default) returns both the memory of this conversation and the global memory.',
    parameters: {
      scope: { type: 'string', enum: RECALL_SCOPES, description: 'chat, global, or all (default)' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the entry text' },
    },
    output: textOutput,
    async execute(args) {
      const scope = args.scope ?? 'all'
      const needle = args.query?.toLowerCase()
      const section = async (label: string, target: MemoryScope): Promise<string> => {
        const entries = (await deps.memory.list(target)).filter(e => needle === undefined || e.text.toLowerCase().includes(needle))
        return `${label}:\n${entries.length === 0 ? '(none)' : entries.map(formatMemoryEntry).join('\n')}`
      }
      const parts: string[] = []
      if (scope !== 'global') parts.push(await section('Chat memory', scopeOf(deps, 'chat')))
      if (scope !== 'chat') parts.push(await section('Global memory', scopeOf(deps, 'global')))
      return parts.join('\n\n')
    },
  })
}

export function createMemoryForgetTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description: 'Delete one persistent memory entry by id. Global entries can only be deleted by a super admin from a private chat.',
    parameters: {
      scope: { type: 'string', enum: WRITE_SCOPES, required: true, description: 'chat or global' },
      id: { type: 'integer', required: true, description: 'Entry id as shown in [#id]' },
    },
    output: textOutput,
    async execute(args) {
      if (args.scope === 'global') assertGlobalWrite(deps)
      await deps.memory.forget(scopeOf(deps, args.scope), args.id)
      return `Forgot [#${args.id}]`
    },
  })
}
```

If `textOutput` does not satisfy `defineTool`'s output type, inline the object literal `{ schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }` in each tool exactly as the two existing tools do.

Update `registerChatTools`:

```ts
/** Register the chat-scoped tools on an agent context; disposal unwinds them. */
export function registerChatTools(agentCtx: ToolHost, deps: ToolDeps): void {
  agentCtx.effect(() => agentCtx.tools.register(createSendFileTool(deps)), 'dsh-telegram: telegram_send_file')
  agentCtx.effect(() => agentCtx.tools.register(createChatHistoryTool(deps)), 'dsh-telegram: telegram_chat_history')
  agentCtx.effect(() => agentCtx.tools.register(createMemorySaveTool(deps)), 'dsh-telegram: memory_save')
  agentCtx.effect(() => agentCtx.tools.register(createMemoryRecallTool(deps)), 'dsh-telegram: memory_recall')
  agentCtx.effect(() => agentCtx.tools.register(createMemoryForgetTool(deps)), 'dsh-telegram: memory_forget')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/tools.spec.ts`
Expected: PASS. `pnpm run typecheck` will report `index.ts` missing the new `ToolDeps` fields; that is fixed in Task 6. Confirm the only typecheck errors are in `src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/tools.ts packages/dsh-telegram/tests/tools.spec.ts
git commit -m "feat(telegram): add memory_save, memory_recall and memory_forget tools"
```

---

### Task 5: Turn context and memory injection in `handleMessage`

**Files:**
- Modify: `packages/dsh-telegram/src/bot.ts`
- Test: `packages/dsh-telegram/tests/bot.spec.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `renderMemoryBlock` (Task 1); `ChatAgents.setTurn`, `memoryInjected`, `markMemoryInjected` (Task 3); `resolved.agent.id` as the session id.
- Produces: `BotDeps.memory: MemoryStore`.

- [ ] **Step 1: Write the failing tests**

In `tests/bot.spec.ts`, add the import:

```ts
import { MemoryStore } from '../src/memory.ts'
```

Change the `agents` type declaration and fake so it carries the three new methods:

```ts
  let agents: {
    resolve: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>
    markTurn: ReturnType<typeof vi.fn>; lastTurnMessageId: ReturnType<typeof vi.fn>; workspaceFor: ReturnType<typeof vi.fn>
    setTurn: ReturnType<typeof vi.fn>; memoryInjected: ReturnType<typeof vi.fn>; markMemoryInjected: ReturnType<typeof vi.fn>
  }
```

```ts
    agents = {
      resolve: vi.fn(async () => ({ agent, resumed: false })),
      reset: vi.fn(async () => {}), stop: vi.fn(() => true), markTurn: vi.fn(async () => {}),
      lastTurnMessageId: vi.fn(() => 0), workspaceFor: vi.fn(() => join(dir, 'ws', '5')),
      setTurn: vi.fn(), memoryInjected: vi.fn(() => false), markMemoryInjected: vi.fn(),
    }
```

Add `memory` to `deps` (after `chatLog`):

```ts
      memory: new MemoryStore(join(dir, 'memory'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
```

Append inside `describe('handleMessage', ...)`:

```ts
  it('records the turn context before the turn is submitted', async () => {
    agents.setTurn.mockImplementation(() => { expect(followups).toHaveLength(0) })
    await handleMessage(msg({ text: 'hello' }), deps)
    expect(agents.setTurn).toHaveBeenCalledWith(5, { sender: ann, isGroup: false })
    await handleMessage(msg({ text: '@dshbot hi', entities: mention }, 'supergroup', 11), deps)
    expect(agents.setTurn).toHaveBeenLastCalledWith(5, { sender: ann, isGroup: true })
  })

  it('prepends chat and global memory once per session', async () => {
    await deps.memory.save({ kind: 'chat', chatId: 5 }, 'likes tea')
    await deps.memory.save({ kind: 'global' }, 'stand-up 9:00')
    await handleMessage(msg({ text: 'hello' }), deps)
    const first = (followups[0] as { content: Array<{ text?: string }> }).content[0]!.text
    expect(first).toBe('[Memory of this conversation]\n- [#1] likes tea\n\n[Global memory]\n- [#1] stand-up 9:00\n\nhello')
    expect(agents.markMemoryInjected).toHaveBeenCalledWith(5, 's1')

    agents.memoryInjected.mockReturnValue(true)
    await handleMessage(msg({ text: 'again' }, 'private', 11), deps)
    expect((followups[1] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('again')
  })

  it('puts the memory block before the recent group block', async () => {
    await deps.memory.save({ kind: 'chat', chatId: 5 }, 'group rule')
    await deps.chatLog.append(5, { ts: 't', message_id: 8, user_id: 9, name: 'Bob', text: 'earlier note' })
    await handleMessage(msg({ text: '@dshbot see', entities: mention }, 'supergroup'), deps)
    expect((followups[0] as { content: Array<{ text?: string }> }).content[0]!.text)
      .toBe('[Memory of this conversation]\n- [#1] group rule\n\nRecent group messages:\n- id:9 (Bob): earlier note\n\n@ann (Ann): see')
  })

  it('marks the session even when both scopes are empty', async () => {
    await handleMessage(msg({ text: 'hello' }), deps)
    expect((followups[0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('hello')
    expect(agents.markMemoryInjected).toHaveBeenCalledWith(5, 's1')
  })

  it('runs the turn without memory and does not mark the session when reading fails', async () => {
    const warnings: string[] = []
    deps.log = { info: () => {}, warn: (m) => { warnings.push(m) }, error: () => {} }
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'memory', '5.json'), '{not json', 'utf8')
    await handleMessage(msg({ text: 'hello' }), deps)
    expect((followups[0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe('hello')
    expect(agents.markMemoryInjected).not.toHaveBeenCalled()
    expect(warnings[0]).toMatch(/reading memory for chat 5 failed/)
  })
```

Extend the `node:fs/promises` import at the top of the file:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/bot.spec.ts`
Expected: FAIL — `setTurn` never called; memory block missing.

- [ ] **Step 3: Implement in `src/bot.ts`**

Add the import:

```ts
import { renderMemoryBlock, type MemoryStore } from './memory.ts'
```

Add `memory: MemoryStore` to `BotDeps` after `chatLog`:

```ts
  chatLog: ChatLog
  memory: MemoryStore
```

Add after `recentBlock`:

```ts
/** Chat plus global memory for the first turn of a session; undefined when reading failed, so the turn runs without it and the session stays unmarked. */
async function memoryBlock(deps: BotDeps, chatId: number): Promise<string | undefined> {
  try {
    const [chat, global] = await Promise.all([deps.memory.list({ kind: 'chat', chatId }), deps.memory.list({ kind: 'global' })])
    return renderMemoryBlock(chat, global)
  } catch (error) {
    deps.log.warn(`dsh-telegram: reading memory for chat ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
```

In `handleMessage`, replace the section from `let text = inbound.text` through `await deps.agents.markTurn(chatId, message.message_id)` with:

```ts
  deps.agents.setTurn(chatId, { sender: inbound.sender, isGroup: inbound.isGroup })

  let text = inbound.text
  if (inbound.isGroup) {
    const recent = await deps.chatLog.recent(chatId, deps.agents.lastTurnMessageId(chatId), message.message_id, deps.config.recentMessagesLimit)
    if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
  }
  // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
  const sessionId = resolved.agent.id
  const memory = deps.agents.memoryInjected(chatId, sessionId) ? '' : await memoryBlock(deps, chatId)
  if (memory !== undefined && memory !== '') text = `${memory}\n\n${text}`
  await deps.agents.markTurn(chatId, message.message_id)
```

Then, immediately before `const result = await runTurn({`, add:

```ts
  if (memoryText !== undefined) deps.agents.markMemoryInjected(chatId, sessionId)
```

Note `memoryText` is `''` when the session was already injected, so `markMemoryInjected` is called again harmlessly with the same session id; it is skipped only when the read failed (`undefined`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/bot.spec.ts`
Expected: PASS, including the pre-existing `runs a turn` and `injects recent group messages` tests (their scopes are empty, so the text is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/bot.ts packages/dsh-telegram/tests/bot.spec.ts
git commit -m "feat(telegram): inject memory once per session and record the turn sender"
```

---

### Task 6: Wiring, persona, docs, full verification

**Files:**
- Modify: `packages/dsh-telegram/src/index.ts`
- Modify: `packages/dsh-telegram/cordis.patch.yml`
- Modify: `profile/telegram/cordis.patch.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `MemoryStore` (Task 1), `Config.memory` / `Config.superAdmins` (Task 2), `ChatAgents.turnOf` (Task 3), `ToolDeps` fields (Task 4), `BotDeps.memory` (Task 5).
- Produces: a building, fully tested plugin.

- [ ] **Step 1: Wire the store in `src/index.ts`**

Add the import:

```ts
import { MemoryStore } from './memory.ts'
```

In `start`, after the `chatLog` line:

```ts
  const memory = new MemoryStore(join(config.dataDir, 'memory'), config.memory)
```

Replace the `setup` callback:

```ts
    setup: (agentCtx, _agent, chatId) => {
      registerChatTools(agentCtx, {
        api, chatLog, chatId, workspaceDir: agents.workspaceFor(chatId), maxUploadBytes,
        memory, superAdmins: config.superAdmins, currentTurn: () => agents.turnOf(chatId),
      })
    },
```

Add `memory,` to the `createDispatcher({...})` call after `chatLog,`.

- [ ] **Step 2: Typecheck, build, and run the whole suite**

Run: `pnpm run typecheck && pnpm run build && pnpm test`
Expected: no type errors, `lib/memory.js` emitted, all spec files pass.

- [ ] **Step 3: Extend the persona in both patch files**

In `packages/dsh-telegram/cordis.patch.yml`, extend `personaSuffix` of the `system-prompt` row so it reads:

```yaml
    personaSuffix: >-
      Your working directory is {{cwd}}. Replies are rendered by Telegram; prefer concise markdown.
      Files you want the user to receive must be sent with the telegram_send_file tool.
      You have a persistent memory for this conversation: when the user shares a preference,
      a habit, a fact about themselves, or asks you to remember something, store one short fact
      with memory_save, and pass replace_id when it updates an earlier fact instead of adding a new one.
      Call memory_recall when the user asks about earlier conversations or when memory shown earlier
      may have been dropped from context. Global memory is shared with every chat: read it freely,
      write to it only when the user explicitly asks for something to be remembered globally.
```

In `profile/telegram/cordis.patch.yml`, extend `personaSuffix` so it reads:

```yaml
    personaSuffix: >-
      Thư mục làm việc của bạn là {{cwd}}. Câu trả lời được hiển thị trên Telegram,
      nên hãy viết markdown ngắn gọn. Muốn gửi file cho người dùng thì phải dùng tool
      telegram_send_file. Bạn có bộ nhớ lâu dài cho cuộc trò chuyện này: khi người dùng
      kể sở thích, thói quen, thông tin về bản thân hoặc nhờ bạn nhớ điều gì, hãy lưu một
      fact ngắn bằng memory_save, và dùng replace_id khi đó là cập nhật của một fact cũ thay
      vì thêm mục mới. Gọi memory_recall khi người dùng hỏi về những lần trò chuyện trước
      hoặc khi phần memory đã hiện trước đó có thể không còn trong ngữ cảnh. Memory chung
      (global) dùng chung cho mọi chat: đọc thoải mái, chỉ ghi khi người dùng nói rõ là
      muốn nhớ chung cho mọi nơi.
```

- [ ] **Step 4: Document the feature in `README.md`**

Add after the `## Commands` section:

```markdown
## Memory

The agent keeps a small persistent memory per chat (a private chat remembers that user; a group remembers that group) and one global memory shared by every chat. Entries are short facts stored as JSON under `./data/memory/` (`<chat_id>.json`, `global.json`), so they survive `/reset` and container recreation and can be edited by hand. The agent uses `memory_save`, `memory_recall`, and `memory_forget`; the memory of the chat and the global memory are shown to the agent once at the start of each conversation.

Caps default to 50 entries per chat, 50 global entries, and 200 characters per entry (`memory.maxEntries`, `memory.maxGlobalEntries`, `memory.maxEntryChars` on the `telegram` row). When a scope is full the agent must replace or forget an entry before saving another. Only the user ids in `TELEGRAM_SUPER_ADMINS` can add, replace, or forget global entries, and only from a private chat with the bot.
```

Also extend the Setup step 3 sentence to mention the new variable:

```markdown
3. `cp .env.example .env` and fill in `DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOW_FROM` (comma-separated Telegram user ids or usernames). `TELEGRAM_SUPER_ADMINS` (comma-separated user ids) lists who may edit the global memory.
```

- [ ] **Step 5: Run the suite once more**

Run from `packages/dsh-telegram`: `pnpm run typecheck && pnpm test`
Expected: no type errors, all tests pass. The YAML files carry `!!js` tags that only the dsh loader understands, so they are verified by the container start in Step 7, not by a parser here.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-telegram/src/index.ts packages/dsh-telegram/cordis.patch.yml profile/telegram/cordis.patch.yml README.md
git commit -m "feat(telegram): wire persistent memory tools, persona guidance and docs"
```

- [ ] **Step 7: Smoke test in Docker (manual, optional but recommended)**

From the repo root: `docker compose -f docker-compose.dev.yml up -d --build`, then in a private chat with the bot:

1. `Remember that my validation drink is lapsang-1234.` — expect a `memory_save` call and a confirmation.
2. `/reset`, then `What is my validation drink?` — the first message of the new session carries the memory block, so the answer should name it without a tool call.
3. As a non-super-admin user: `Remember globally: stand-up at 9.` — expect the "only super admins" refusal relayed.
4. Check `./data/memory/<your_id>.json` exists and contains the entry.

---

## Self-review

- **Spec coverage:** storage and caps → Task 1; config and env → Task 2; sender of the current turn → Tasks 3 and 5; three tools with in-code authorization → Task 4; injection once per session, ordering with the recent group block, failed-read behaviour → Task 5; wiring, persona sentences, README, `.env.example` → Tasks 2 and 6; out-of-scope items untouched.
- **Placeholders:** none; every code step carries the code.
- **Type consistency:** `TurnContext { sender, isGroup }` is defined in Task 3 and consumed by Tasks 4 and 5 with the same shape; `ToolDeps.currentTurn: () => TurnContext | undefined` matches `agents.turnOf(chatId)` in Task 6; `memoryInjected` / `markMemoryInjected` names match between Tasks 3 and 5; `MemoryLimits` keys match between Tasks 1 and 2; tool names in `registerChatTools` match the test expectation in Task 4.
