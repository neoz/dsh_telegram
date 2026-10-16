# dsh-chat Plan 1: store plugins and data migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the channel-agnostic stores of `dsh-telegram` and `dsh-zalo` into a new `dsh-chat` package of small Cordis plugins, keyed by `chatKey`, with a one-time migration to the per-channel data layout; both adapters run on them.

**Architecture:** `dsh-chat/migrate` migrates the old layout and provides `chatData` (paths). `dsh-chat/log`, `dsh-chat/memory` and `dsh-chat/sessions` provide `chatLog`, `chatMemory` and `chatAgents`; `dsh-chat/history` and `dsh-chat/retention` add a tool and a sweep. Adapters inject these services instead of building their own stores and convert their native ids to `chatKey` at the boundary. The router, `ChatChannel`, and moving idle/schedule are later plans (spec rollout steps 3-5).

**Tech Stack:** TypeScript 6 (nodenext, `.ts` imports), Cordis 4, Schemastery, Vitest 4, pnpm 10 workspace, Node >= 22.19, Docker.

**Spec:** `docs/superpowers/specs/2026-10-16-dsh-chat-plugin-core-design.md` (rollout steps 1 and 2, plus the packaging needed to deploy them).

## Global Constraints

- `chatKey = "<channel>:<id>"`, a string; channels are `telegram` and `zalo`.
- Chat log ids are strings: `message_id`, `user_id`, `reply_to`.
- New layout: `/data/memory/global.json`, `/data/sessions.json` (keyed by `chatKey`), `/data/<channel>/chatlog/<id>.jsonl`, `/data/<channel>/memory/<id>.json`, `/data/<channel>/idle-decisions.jsonl`, `/data/<channel>/schedule.json`, `/data/.migrated-v1`, `/workspace/<channel>/<id>/{inbox,outbox}`.
- File names use `pathSafe(id)`; it returns safe ids unchanged.
- Prompt cache: the rendered `<memory>` block, chat-log lines (`formatEntry`) and `<group_messages>` block stay byte-identical to today's output.
- Every repository text is English; no emoji in code; no new `.md` files beyond this plan.
- Every plugin follows the existing pattern: `export const name`, `export const inject`, `export const Config` (Schemastery), `export function apply(ctx, config)`, services provided with `ctx.effect(() => ctx.provide(...), label)`.
- Run commands from the repo root `D:\working\nodejs\dsh` unless a step says otherwise.

## Review Focus

1. Two Telegram messages in the same second as the last handled message: both must appear in the next group context (position-based `recent`; test in Task 2).
2. The process dies half-way through the migration: the next start completes it without losing or duplicating files (test in Task 7).
3. A migrated Telegram chat log with numeric ids: the trigger is still excluded from `<group_messages>` (ids rewritten to strings; test in Task 7).
4. A Zalo id with unsafe characters: its files keep the same names as before the move (`pathSafe` identical to the old Zalo one; test in Task 1).
5. `chat_history` with an unknown `before_message_id`: returns the newest entries instead of nothing (test in Task 5).

---

## File Structure

```
pnpm-workspace.yaml, package.json, .npmrc, pnpm-lock.yaml   (root, new)
packages/dsh-chat/
  package.json, tsconfig.json, vitest.config.ts, cordis.patch.yml
  src/index.ts            type and helper re-exports for adapters
  src/keys.ts             ChatKey, chatKey, splitKey, idIn, pathSafe, keyPath
  src/json-file.ts        moved from dsh-telegram (atomic writes, SerialQueue)
  src/migrate/{index.ts,migrate.ts}
  src/log/{index.ts,chatlog.ts}
  src/memory/{index.ts,store.ts,tools.ts}
  src/sessions/{index.ts,agents.ts,session-map.ts}
  src/history/index.ts
  src/retention/{index.ts,sweep.ts}
  tests/... one spec per src file
packages/dsh-telegram, packages/dsh-zalo   (stores deleted, wiring changed)
docker/Dockerfile, docker/zalo.Dockerfile, profile/*/  (packaging)
```

---

### Task 1: Workspace and `dsh-chat` skeleton

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.npmrc` (root)
- Create: `packages/dsh-chat/{package.json,tsconfig.json,vitest.config.ts,cordis.patch.yml,.gitignore}`
- Create: `packages/dsh-chat/src/keys.ts`, `packages/dsh-chat/src/json-file.ts`, `packages/dsh-chat/src/index.ts`
- Delete: `packages/dsh-telegram/pnpm-lock.yaml`, `packages/dsh-zalo/pnpm-lock.yaml`, `packages/dsh-telegram/.npmrc`, `packages/dsh-zalo/.npmrc`
- Test: `packages/dsh-chat/tests/keys.spec.ts`

**Interfaces:**
- Produces: `type ChatKey = string`; `chatKey(channel: string, id: string | number): ChatKey`; `splitKey(key): { channel: string; id: string }`; `idIn(channel, key): string | undefined`; `pathSafe(id: string): string`; `keyPath(root, key, sub, ext?): string`; `writeFileAtomic`, `writeJsonAtomic`, `SerialQueue` (same as `dsh-telegram/src/json-file.ts`).

- [ ] **Step 1: Root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`package.json`:
```json
{
  "name": "dsh-workspace",
  "private": true,
  "packageManager": "pnpm@10.14.0",
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test"
  }
}
```

`.npmrc` (same content as the per-package files it replaces):
```
auto-install-peers=true
strict-peer-dependencies=false
```

Then: `git rm packages/dsh-telegram/pnpm-lock.yaml packages/dsh-zalo/pnpm-lock.yaml packages/dsh-telegram/.npmrc packages/dsh-zalo/.npmrc`

- [ ] **Step 2: `packages/dsh-chat` package files**

`packages/dsh-chat/package.json`:
```json
{
  "name": "dsh-chat",
  "version": "0.1.0",
  "description": "Channel-agnostic chat core plugins for DeepSeek Harness",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@deepseek-ai/dsh-brand": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2",
    "@types/node": "^22.20.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  },
  "engines": { "node": ">=22.19" },
  "pnpm": { "peerDependencyRules": { "ignoreMissing": ["@deepseek-ai/dsh-*"] } },
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./migrate": { "types": "./lib/migrate/index.d.ts", "default": "./lib/migrate/index.js" },
    "./log": { "types": "./lib/log/index.d.ts", "default": "./lib/log/index.js" },
    "./memory": { "types": "./lib/memory/index.d.ts", "default": "./lib/memory/index.js" },
    "./sessions": { "types": "./lib/sessions/index.d.ts", "default": "./lib/sessions/index.js" },
    "./history": { "types": "./lib/history/index.d.ts", "default": "./lib/history/index.js" },
    "./retention": { "types": "./lib/retention/index.d.ts", "default": "./lib/retention/index.js" },
    "./package.json": "./package.json"
  }
}
```

`packages/dsh-chat/tsconfig.json` and `vitest.config.ts`: copy `packages/dsh-telegram/tsconfig.json` and `packages/dsh-telegram/vitest.config.ts` verbatim. `.gitignore`: copy `packages/dsh-telegram/.gitignore`.

`packages/dsh-chat/cordis.patch.yml` (the bundle only makes `dsh-chat/*` resolvable; adapters insert the rows):
```yaml
# dsh-chat bundle layer: no rows of its own; each channel adapter's patch inserts the dsh-chat plugins it uses.
[]
```

- [ ] **Step 3: Move `json-file.ts`**

```bash
git mv packages/dsh-telegram/src/json-file.ts packages/dsh-chat/src/json-file.ts
git rm packages/dsh-zalo/src/json-file.ts
```
`dsh-telegram/src/schedule/store.ts` imports `../json-file.ts`; change that import to `from 'dsh-chat'` (re-exported in Step 5).

- [ ] **Step 4: Write the failing test** `packages/dsh-chat/tests/keys.spec.ts`

```ts
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatKey, idIn, keyPath, pathSafe, splitKey } from '../src/keys.ts'

/** The Zalo implementation before the move; files written by it must keep their names. */
function legacyZaloPathSafe(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

describe('chat keys', () => {
  it('joins channel and id, numbers included', () => {
    expect(chatKey('telegram', -1001234)).toBe('telegram:-1001234')
    expect(chatKey('zalo', 'abc')).toBe('zalo:abc')
  })

  it('splits at the first colon only', () => {
    expect(splitKey('zalo:a:b')).toEqual({ channel: 'zalo', id: 'a:b' })
  })

  it('rejects a key without channel or id', () => {
    expect(() => splitKey('telegram')).toThrow('invalid chat key "telegram"')
    expect(() => splitKey(':1')).toThrow()
    expect(() => splitKey('telegram:')).toThrow()
  })

  it('returns the id only for the matching channel', () => {
    expect(idIn('telegram', 'telegram:42')).toBe('42')
    expect(idIn('telegram', 'zalo:42')).toBeUndefined()
  })

  it('keeps safe ids and matches the legacy Zalo names for unsafe ones', () => {
    for (const id of ['-1001234', 'abc_DEF-9', 'a/b', '../x', 'a b']) expect(pathSafe(id)).toBe(legacyZaloPathSafe(id))
  })

  it('builds per-channel paths', () => {
    expect(keyPath('/data', 'telegram:-5', 'chatlog', '.jsonl')).toBe(join('/data', 'telegram', 'chatlog', '-5.jsonl'))
    expect(keyPath('/ws', 'zalo:a/b', '')).toBe(join('/ws', 'zalo', legacyZaloPathSafe('a/b')))
  })
})
```

- [ ] **Step 5: Install and run to verify failure**

Run: `pnpm install && pnpm --filter dsh-chat test`
Expected: FAIL, cannot resolve `../src/keys.ts`.

- [ ] **Step 6: Implement `packages/dsh-chat/src/keys.ts`**

```ts
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** `<channel>:<id>`, e.g. `telegram:-1001234` or `zalo:abc`; every core store is keyed by it. */
export type ChatKey = string

export function chatKey(channel: string, id: string | number): ChatKey {
  return `${channel}:${id}`
}

export function splitKey(key: ChatKey): { channel: string; id: string } {
  const at = key.indexOf(':')
  if (at <= 0 || at === key.length - 1) throw new Error(`invalid chat key "${key}"`)
  return { channel: key.slice(0, at), id: key.slice(at + 1) }
}

/** The id part of `key` when it belongs to `channel`, else undefined. */
export function idIn(channel: string, key: ChatKey): string | undefined {
  return key.startsWith(`${channel}:`) ? key.slice(channel.length + 1) : undefined
}

/** A file-name-safe form of an id; safe ids stay unchanged, so files written before the move keep their names. */
export function pathSafe(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

/** `<root>/<channel>/<sub>/<pathSafe(id)><ext>`; an empty `sub` puts the file right under the channel. */
export function keyPath(root: string, key: ChatKey, sub: string, ext = ''): string {
  const { channel, id } = splitKey(key)
  return join(root, channel, sub, `${pathSafe(id)}${ext}`)
}
```

`packages/dsh-chat/src/index.ts` (grows in later tasks):
```ts
export { chatKey, idIn, keyPath, pathSafe, splitKey, type ChatKey } from './keys.ts'
export { SerialQueue, writeFileAtomic, writeJsonAtomic } from './json-file.ts'
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 8: Wire the adapters to the workspace package**

In both `packages/dsh-telegram/package.json` and `packages/dsh-zalo/package.json` add `"dsh-chat": "workspace:*"` to `peerDependencies` and to `devDependencies`. Run `pnpm install`; then `pnpm -r test`.
Expected: dsh-chat passes; dsh-telegram passes (schedule store now imports from `dsh-chat`); dsh-zalo passes (its `json-file.ts` users still compile only if they import it; if `tsc`/vitest reports `../json-file.ts` missing in `dsh-zalo/src/{chatlog,memory,session-map}.ts`, change those imports to `from 'dsh-chat'` for now; those files are deleted in Task 9).

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json .npmrc pnpm-lock.yaml packages/
git commit -m "build: add a pnpm workspace and the dsh-chat package with chat keys"
```

---

### Task 2: Chat log store and `dsh-chat/log`

**Files:**
- Create: `packages/dsh-chat/src/log/chatlog.ts`, `packages/dsh-chat/src/log/index.ts`
- Modify: `packages/dsh-chat/src/index.ts`
- Test: `packages/dsh-chat/tests/log/chatlog.spec.ts`, `packages/dsh-chat/tests/log/plugin.spec.ts`

**Interfaces:**
- Consumes: `keyPath`, `ChatKey` (Task 1); `ctx.chatData` (Task 7 declares it; until then tests provide it directly).
- Produces: `interface ChatLogEntry { ts: string; message_id: string; user_id: string; username?: string; name: string; text: string; reply_to?: string; media?: string[]; bot?: true; handled?: true }`; `oneLine`, `senderLabel`, `formatEntry`; `class ChatLog(dataDir, onAppend?, maxEntries?)` with `append(key, entry)`, `readAll(key)`, `recent(key, afterMessageId: string, excludeMessageId: string, limit)`, `history(key, { limit, beforeMessageId?: string, query?: string })`; service `ctx.chatLog`; event `'chat/message'(key: ChatKey, entry: ChatLogEntry)`; `forwardAppends`.

- [ ] **Step 1: Write the failing store test** `packages/dsh-chat/tests/log/chatlog.spec.ts`

Start from `packages/dsh-telegram/tests/chatlog.spec.ts` (`git mv` it here, then delete `packages/dsh-zalo/tests/chatlog.spec.ts`), and apply: every chat id becomes a key (`42` -> `'telegram:42'`), every `message_id`/`user_id`/`reply_to` literal becomes a string, the store is built as `new ChatLog(dir, ...)` where files land at `join(dir, 'telegram', 'chatlog', '42.jsonl')`, `recent(...)`'s second argument is the last handled message id as a string (`''` for none), `history`'s `beforeMessageId` is a string. Then add:

```ts
describe('byte-identical rendering', () => {
  it('formats lines exactly as before the move', () => {
    expect(formatEntry({ ts: '2026-10-16T01:02:03.000Z', message_id: '7', user_id: '42', username: 'neo', name: 'Neo\nX', text: 'hi\nthere', media: ['/w/a.jpg'] }))
      .toBe('[2026-10-16T01:02:03.000Z] @neo (Neo X): hi there [media: /w/a.jpg]')
    expect(formatEntry({ ts: 't', message_id: 'm', user_id: 'u1', name: '', text: 'x' })).toBe('[t] id:u1: x')
    expect(formatEntry({ ts: 't', message_id: '', user_id: '1', name: 'bot', text: 'ok', bot: true })).toBe('[t] assistant: ok')
  })
})

describe('position-based context', () => {
  const at = '2026-10-16T01:02:03.000Z'
  const entry = (id: string, extra: Partial<ChatLogEntry> = {}): ChatLogEntry => ({ ts: at, message_id: id, user_id: '1', name: 'a', text: id, ...extra })

  it('keeps messages logged in the same second right after the last turn', async () => {
    const log = new ChatLog(dir)
    for (const e of [entry('1', { handled: true }), entry('2'), entry('3'), entry('4', { handled: true })]) await log.append('telegram:9', e)
    expect((await log.recent('telegram:9', '1', '4', 30)).map(e => e.message_id)).toEqual(['2', '3'])
  })

  it('returns everything when the last turn id is unknown or empty', async () => {
    const log = new ChatLog(dir)
    for (const id of ['1', '2', '3']) await log.append('zalo:g', entry(id))
    expect((await log.recent('zalo:g', '', '3', 30)).map(e => e.message_id)).toEqual(['1', '2'])
    expect((await log.recent('zalo:g', 'gone', '3', 30)).map(e => e.message_id)).toEqual(['1', '2'])
  })

  it('ignores a bot reply whose id matches the marker', async () => {
    const log = new ChatLog(dir)
    for (const e of [entry('5'), entry('6'), entry('5', { bot: true })]) await log.append('telegram:9', e)
    expect((await log.recent('telegram:9', '5', 'x', 30)).map(e => e.text)).toEqual(['6', '5'])
  })

  it('pages history by position and ignores an unknown cursor', async () => {
    const log = new ChatLog(dir)
    for (const id of ['1', '2', '3', '4']) await log.append('telegram:9', entry(id))
    expect((await log.history('telegram:9', { limit: 10, beforeMessageId: '3' })).map(e => e.message_id)).toEqual(['1', '2'])
    expect((await log.history('telegram:9', { limit: 2, beforeMessageId: 'nope' })).map(e => e.message_id)).toEqual(['3', '4'])
  })

  it('keeps channels apart', async () => {
    const log = new ChatLog(dir)
    await log.append('telegram:1', entry('a'))
    await log.append('zalo:1', entry('b'))
    expect((await log.readAll('telegram:1')).map(e => e.message_id)).toEqual(['a'])
    expect((await log.readAll('zalo:1')).map(e => e.message_id)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- log/chatlog`
Expected: FAIL, cannot resolve `../../src/log/chatlog.ts`.

- [ ] **Step 3: Implement `packages/dsh-chat/src/log/chatlog.ts`**

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SerialQueue, writeFileAtomic } from '../json-file.ts'
import { keyPath, type ChatKey } from '../keys.ts'

/** One observed chat message; bot replies carry `bot: true`, messages that got a turn carry `handled: true`. */
export interface ChatLogEntry {
  ts: string
  message_id: string
  user_id: string
  username?: string
  name: string
  text: string
  reply_to?: string
  media?: string[]
  bot?: true
  handled?: true
}

/** Folds line breaks so text rendered as one line of a block cannot forge another line (e.g. a fake sender). */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

export function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'username' | 'name' | 'bot'>): string {
  if (entry.bot) return 'assistant'
  const base = entry.username === undefined ? `id:${oneLine(entry.user_id)}` : `@${oneLine(entry.username)}`
  return entry.name === '' ? base : `${base} (${oneLine(entry.name)})`
}

export function formatEntry(entry: ChatLogEntry): string {
  const media = entry.media === undefined ? '' : ` [media: ${entry.media.join(', ')}]`
  return `[${entry.ts}] ${senderLabel(entry)}: ${oneLine(entry.text)}${media}`
}

/** Index of the last human entry with this id, or -1; ids are opaque, so the log's order is the only order. */
function lastHumanIndex(entries: readonly ChatLogEntry[], messageId: string): number {
  if (messageId === '') return -1
  return entries.findLastIndex(e => e.bot !== true && e.message_id === messageId)
}

/** A log is trimmed back to `maxEntries` only once it grows this much past it, so trims stay rare. */
const TRIM_SLACK = 1.2

/**
 * Append-only per-chat JSONL log at `<dataDir>/<channel>/chatlog/<id>.jsonl`; `onAppend` hears every line once it is written.
 * Readers parse the whole file, so it is trimmed to the newest `maxEntries` to keep each read bounded.
 */
export class ChatLog {
  /** Lines per chat file, counted from disk on the first append after start. */
  private readonly counts = new Map<ChatKey, number>()
  private readonly writes = new SerialQueue()

  constructor(
    private readonly dataDir: string,
    private readonly onAppend?: (key: ChatKey, entry: ChatLogEntry) => void,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  private file(key: ChatKey): string {
    return keyPath(this.dataDir, key, 'chatlog', '.jsonl')
  }

  async append(key: ChatKey, entry: ChatLogEntry): Promise<void> {
    await this.writes.run(async () => {
      const file = this.file(key)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      const count = this.counts.get(key) ?? (await this.readAll(key)).length - 1
      this.counts.set(key, count + 1)
      if (count + 1 > this.maxEntries * TRIM_SLACK) await this.trim(key)
    })
    this.onAppend?.(key, entry)
  }

  private async trim(key: ChatKey): Promise<void> {
    const kept = (await this.readAll(key)).slice(-this.maxEntries)
    await writeFileAtomic(this.file(key), kept.map(e => `${JSON.stringify(e)}\n`).join(''))
    this.counts.set(key, kept.length)
  }

  async readAll(key: ChatKey): Promise<ChatLogEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ChatLogEntry)
  }

  /** Entries after the last turn's message (all when it is absent or trimmed away), minus the trigger, keeping the newest `limit`. */
  async recent(key: ChatKey, afterMessageId: string, excludeMessageId: string, limit: number): Promise<ChatLogEntry[]> {
    if (limit === 0) return []
    const entries = await this.readAll(key)
    return entries.slice(lastHumanIndex(entries, afterMessageId) + 1).filter(e => e.message_id !== excludeMessageId).slice(-limit)
  }

  /** Newest `limit` entries (oldest first) before `beforeMessageId` (ignored when unknown), optionally containing `query`. */
  async history(key: ChatKey, options: { limit: number; beforeMessageId?: string; query?: string }): Promise<ChatLogEntry[]> {
    const all = await this.readAll(key)
    const end = options.beforeMessageId === undefined ? -1 : lastHumanIndex(all, options.beforeMessageId)
    const needle = options.query?.toLowerCase()
    return (end === -1 ? all : all.slice(0, end))
      .filter(e => needle === undefined || e.text.toLowerCase().includes(needle))
      .slice(-options.limit)
  }
}
```

Note `senderLabel` now wraps `user_id` in `oneLine` (Zalo did, Telegram's ids were numbers); output is identical for every id without a line break.

- [ ] **Step 4: Run store tests**

Run: `pnpm --filter dsh-chat test -- log/chatlog`
Expected: PASS.

- [ ] **Step 5: Write the failing plugin test** `packages/dsh-chat/tests/log/plugin.spec.ts`

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as logPlugin from '../../src/log/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-log-plugin-'))
  root = new Context()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/log', () => {
  it('waits for chatData, then provides chatLog and emits chat/message', async () => {
    root.plugin(logPlugin, logPlugin.Config({}))
    expect(root.get('chatLog')).toBeUndefined()
    root.provide('chatData', { dataDir: dir, workspaceRoot: join(dir, 'ws') })
    await vi.waitFor(() => expect(root.get('chatLog')).toBeDefined())
    const heard: string[] = []
    root.on('chat/message', key => { heard.push(key) })
    await root.get('chatLog')!.append('zalo:1', { ts: 't', message_id: '1', user_id: 'u', name: 'n', text: 'x' })
    expect(heard).toEqual(['zalo:1'])
  })

  it('only warns when a chat/message listener throws', async () => {
    root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
    root.plugin(logPlugin, logPlugin.Config({}))
    await vi.waitFor(() => expect(root.get('chatLog')).toBeDefined())
    root.on('chat/message', () => { throw new Error('boom') })
    await expect(root.get('chatLog')!.append('zalo:1', { ts: 't', message_id: '1', user_id: 'u', name: 'n', text: 'x' })).resolves.toBeUndefined()
  })

  it('defaults maxEntries to 15000', () => {
    expect(logPlugin.Config({})).toEqual({ maxEntries: 15_000 })
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- log/plugin`
Expected: FAIL, cannot resolve `../../src/log/index.ts`.

- [ ] **Step 7: Implement `packages/dsh-chat/src/log/index.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatKey } from '../keys.ts'
import type {} from '../migrate/index.ts'
import { ChatLog, type ChatLogEntry } from './chatlog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatLog: ChatLog
  }
  interface Events {
    /** A line was appended to a chat's log (human or bot), after it was written. */
    'chat/message'(key: ChatKey, entry: ChatLogEntry): void
  }
}

export interface LogConfig {
  /** Each chat log keeps its newest entries up to this many; older ones are dropped. */
  readonly maxEntries: number
}

export const Config: z<LogConfig> = z.object({
  maxEntries: z.number().min(1).default(15_000),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-log'
export const inject = ['chatData']

/** Chat-log listener that forwards lines as an event; Cordis does not isolate listeners, so a throw only warns. */
export function forwardAppends(emit: (key: ChatKey, entry: ChatLogEntry) => void, warn: (msg: string) => void): (key: ChatKey, entry: ChatLogEntry) => void {
  return (key, entry) => {
    try {
      emit(key, entry)
    } catch (error) {
      warn(`dsh-chat: a chat/message listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function apply(ctx: Context, config: LogConfig): void {
  const logger = ctx.logger('dsh-chat')
  const log = new ChatLog(ctx.chatData.dataDir, forwardAppends((key, entry) => ctx.emit('chat/message', key, entry), msg => logger.warn(msg)), config.maxEntries)
  ctx.effect(() => ctx.provide('chatLog', log), 'dsh-chat: chatLog')
}
```

`src/log/index.ts` imports `../migrate/index.ts` for the `chatData` declaration, which Task 7 writes. To keep this task green, create `packages/dsh-chat/src/migrate/index.ts` now with only the declaration (Task 7 completes the file):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    chatData: ChatData
  }
}

/** Paths every chat plugin shares; provided once the data layout is current. */
export interface ChatData {
  readonly dataDir: string
  readonly workspaceRoot: string
}
```

Append to `packages/dsh-chat/src/index.ts`:
```ts
export { ChatLog, formatEntry, oneLine, senderLabel, type ChatLogEntry } from './log/chatlog.ts'
export type { ChatData } from './migrate/index.ts'
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dsh-chat packages/dsh-telegram/tests packages/dsh-zalo/tests
git commit -m "feat(chat): add the chat log store and the dsh-chat/log plugin"
```

---

### Task 3: Memory store, tools and `dsh-chat/memory`

**Files:**
- Create: `packages/dsh-chat/src/memory/{store.ts,tools.ts,index.ts}`
- Modify: `packages/dsh-chat/src/index.ts`
- Test: `packages/dsh-chat/tests/memory/{store.spec.ts,tools.spec.ts,plugin.spec.ts}`

**Interfaces:**
- Consumes: `keyPath`, `ChatKey`, `SerialQueue`, `writeJsonAtomic`, `oneLine`; `TurnContext` and `ctx.chatAgents` plus event `'chat/agent'` from Task 4 (this task declares the minimal types it reads; see Step 7).
- Produces: `type MemoryScope = { kind: 'chat'; key: ChatKey } | { kind: 'global' }`; `MemoryEntry`, `MemoryLimits`, `formatMemoryEntry`, `class MemoryStore(dataDir, limits)` with `list`, `save`, `forget`; `renderMemoryBlock(chat, global)`; `registerMemoryTools(agentCtx, { memory, key, currentTurn })`; service `ctx.chatMemory`.

- [ ] **Step 1: Port the store and tool specs**

```bash
git mv packages/dsh-telegram/tests/memory.spec.ts packages/dsh-chat/tests/memory/store.spec.ts
git rm packages/dsh-zalo/tests/memory.spec.ts
```
In `store.spec.ts`: import from `../../src/memory/store.ts`; scopes become `{ kind: 'chat', key: 'telegram:42' }`; the store is `new MemoryStore(dir, limits)` and chat files land at `join(dir, 'telegram', 'memory', '42.json')`, global at `join(dir, 'memory', 'global.json')`. Add:

```ts
describe('byte-identical rendering', () => {
  it('renders the memory block exactly as before the move', () => {
    const e = (id: number, text: string) => ({ id, text, ts: 't' })
    expect(renderMemoryBlock([e(1, 'likes tea'), e(2, 'two\nlines')], [e(3, 'team is DSH')]))
      .toBe('<memory>\n[Memory of this conversation]\n- [#1] likes tea\n- [#2] two lines\n\n[Global memory]\n- [#3] team is DSH\n</memory>')
    expect(renderMemoryBlock([], [])).toBe('')
  })

  it('shares one global file across channels', async () => {
    const store = new MemoryStore(dir, { maxEntries: 5, maxGlobalEntries: 5, maxEntryChars: 200 })
    await store.save({ kind: 'global' }, 'shared')
    await store.save({ kind: 'chat', key: 'zalo:a' }, 'z only')
    expect((await store.list({ kind: 'global' })).map(e => e.text)).toEqual(['shared'])
    expect(await store.list({ kind: 'chat', key: 'telegram:a' })).toEqual([])
  })
})
```

Move the memory-tool cases out of `packages/dsh-telegram/tests/tools.spec.ts` (every `describe`/`it` that calls `memory_save`, `memory_recall` or `memory_forget`) into a new `packages/dsh-chat/tests/memory/tools.spec.ts`, and delete the matching cases from `packages/dsh-zalo/tests/tools.spec.ts`. In the moved cases, deps become `{ memory, key: 'telegram:42', currentTurn: () => turn }` and a turn is `{ sender: { id: '7', name: 'Neo' }, isGroup: false, isSuperAdmin: true }` (non-admin: `isSuperAdmin: false`). Ensure these three cases exist:

```ts
it('rejects a global write from a group even for a super admin', async () => {
  const tools = createMemoryTools({ memory, key: 'telegram:-5', currentTurn: () => ({ sender: { id: '7', name: 'n' }, isGroup: true, isSuperAdmin: true }) })
  await expect(run(tools.save, { text: 'x', scope: 'global' })).rejects.toThrow('global memory can only be edited from a private chat with the bot')
})
it('rejects a global write from a non-admin', async () => {
  const tools = createMemoryTools({ memory, key: 'zalo:a', currentTurn: () => ({ sender: { id: 'a', name: 'n' }, isGroup: false, isSuperAdmin: false }) })
  await expect(run(tools.save, { text: 'x', scope: 'global' })).rejects.toThrow('only super admins can edit global memory')
})
it('rejects a global write when no turn is running', async () => {
  const tools = createMemoryTools({ memory, key: 'zalo:a', currentTurn: () => undefined })
  await expect(run(tools.forget, { scope: 'global', id: 1 })).rejects.toThrow('only super admins can edit global memory')
})
```
`run(tool, args)` is the helper the existing `tools.spec.ts` uses to execute a `ToolDefinition`; move it along with the cases.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- memory`
Expected: FAIL, cannot resolve `../../src/memory/store.ts`.

- [ ] **Step 3: Implement `packages/dsh-chat/src/memory/store.ts`**

Copy `packages/dsh-telegram/src/memory.ts` and change only:
```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SerialQueue, writeJsonAtomic } from '../json-file.ts'
import { keyPath, type ChatKey } from '../keys.ts'
import { oneLine } from '../log/chatlog.ts'

/** `chat` is the memory of one conversation (a private chat or a group); `global` is shared by every chat of every channel. */
export type MemoryScope = { kind: 'chat'; key: ChatKey } | { kind: 'global' }
```
and the constructor and `file()`:
```ts
  constructor(private readonly dataDir: string, private readonly limits: MemoryLimits) {}

  private file(scope: MemoryScope): string {
    return scope.kind === 'global' ? join(this.dataDir, 'memory', 'global.json') : keyPath(this.dataDir, scope.key, 'memory', '.json')
  }
```
Everything else (`MemoryEntry`, `MemoryLimits`, `formatMemoryEntry`, `list`, `save`, `forget`, `renderMemoryBlock`) stays byte-for-byte as in the Telegram file.

- [ ] **Step 4: Implement `packages/dsh-chat/src/memory/tools.ts`**

Copy `createMemorySaveTool`, `createMemoryRecallTool`, `createMemoryForgetTool`, `WRITE_SCOPES`, `RECALL_SCOPES` verbatim from `packages/dsh-telegram/src/tools.ts` (descriptions unchanged), with this header and helpers:

```ts
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ChatKey } from '../keys.ts'
import type { TurnContext } from '../sessions/agents.ts'
import { formatMemoryEntry, type MemoryScope, type MemoryStore } from './store.ts'

export interface MemoryToolDeps {
  memory: MemoryStore
  key: ChatKey
  /** The turn running in this chat; tools use it to authorise global writes. */
  currentTurn: () => TurnContext | undefined
}

function scopeOf(deps: MemoryToolDeps, name: 'chat' | 'global'): MemoryScope {
  return name === 'global' ? { kind: 'global' } : { kind: 'chat', key: deps.key }
}

/** Global memory is public to every chat: only a super admin may edit it, and only from a private chat, where no stranger's text is in context. */
function assertGlobalWrite(deps: MemoryToolDeps): void {
  const turn = deps.currentTurn()
  if (turn?.isGroup) throw new Error('global memory can only be edited from a private chat with the bot')
  if (turn === undefined || !turn.isSuperAdmin) throw new Error('only super admins can edit global memory')
}
```
Rename the `deps` parameter type in the three tool factories to `MemoryToolDeps`, then add:

```ts
export function createMemoryTools(deps: MemoryToolDeps): { save: ToolDefinition; recall: ToolDefinition; forget: ToolDefinition } {
  return { save: createMemorySaveTool(deps), recall: createMemoryRecallTool(deps), forget: createMemoryForgetTool(deps) }
}

interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void }
  effect(fn: () => () => void, label?: string): void
}

/** Registers the memory tools on one chat's agent context; disposal unwinds them. */
export function registerMemoryTools(agentCtx: ToolHost, deps: MemoryToolDeps): void {
  for (const tool of Object.values(createMemoryTools(deps))) {
    agentCtx.effect(() => agentCtx.tools.register(tool), `dsh-chat: ${tool.name}`)
  }
}
```

- [ ] **Step 5: Run store and tool tests**

`tools.ts` imports `TurnContext` from `../sessions/agents.ts`, which Task 4 writes. Create that file now with only the types (Task 4 completes it):

```ts
/** Who sent the running turn, in channel-neutral form. */
export interface ChatSender { id: string; name: string; username?: string }

/** Who started the turn running in a chat, whether that chat is a group, and whether the sender is a super admin there. */
export interface TurnContext { sender: ChatSender; isGroup: boolean; isSuperAdmin: boolean }
```

Run: `pnpm --filter dsh-chat test -- memory/store memory/tools`
Expected: PASS.

- [ ] **Step 6: Write the failing plugin test** `packages/dsh-chat/tests/memory/plugin.spec.ts`

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as memoryPlugin from '../../src/memory/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-memory-plugin-'))
  root = new Context()
  root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
  root.provide('chatAgents', { turnOf: () => undefined } as never)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/memory', () => {
  it('provides chatMemory and registers the memory tools on every chat agent', async () => {
    root.plugin(memoryPlugin, memoryPlugin.Config({}))
    await vi.waitFor(() => expect(root.get('chatMemory')).toBeDefined())
    const registered: string[] = []
    const agentCtx = { tools: { register: (t: { name: string }) => { registered.push(t.name); return () => {} } }, effect: (fn: () => () => void) => { fn() } }
    root.emit('chat/agent', agentCtx as never, 'zalo:a')
    expect(registered).toEqual(['memory_save', 'memory_recall', 'memory_forget'])
  })

  it('fills the limits defaults', () => {
    expect(memoryPlugin.Config({})).toEqual({ maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  })
})
```

- [ ] **Step 7: Implement `packages/dsh-chat/src/memory/index.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../migrate/index.ts'
import type {} from '../sessions/index.ts'
import { MemoryStore, type MemoryLimits } from './store.ts'
import { registerMemoryTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatMemory: MemoryStore
  }
}

export const Config: z<MemoryLimits> = z.object({
  maxEntries: z.number().min(1).default(50),
  maxGlobalEntries: z.number().min(1).default(50),
  maxEntryChars: z.number().min(1).default(200),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-memory'
export const inject = ['chatData', 'chatAgents']

export function apply(ctx: Context, config: MemoryLimits): void {
  const memory = new MemoryStore(ctx.chatData.dataDir, config)
  ctx.on('chat/agent', (agentCtx, key) => {
    registerMemoryTools(agentCtx, { memory, key, currentTurn: () => ctx.chatAgents.turnOf(key) })
  })
  ctx.effect(() => ctx.provide('chatMemory', memory), 'dsh-chat: chatMemory')
}
```

This imports `../sessions/index.ts` for the `chatAgents` service and `chat/agent` event declarations. Create it now with only the declarations (Task 4 completes the file):

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ChatKey } from '../keys.ts'
import type { TurnContext } from './agents.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAgents: { turnOf(key: ChatKey): TurnContext | undefined }
  }
  interface Events {
    /** A chat's agent was created or resumed; plugins register that chat's tools on `agentCtx`. */
    'chat/agent'(agentCtx: Context, key: ChatKey): void
  }
}
```

Append to `packages/dsh-chat/src/index.ts`:
```ts
export { formatMemoryEntry, MemoryStore, renderMemoryBlock, type MemoryEntry, type MemoryLimits, type MemoryScope } from './memory/store.ts'
export type { ChatSender, TurnContext } from './sessions/agents.ts'
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/
git commit -m "feat(chat): add the memory store, memory tools and the dsh-chat/memory plugin"
```

---

### Task 4: Session map, `ChatAgents` and `dsh-chat/sessions`

**Files:**
- Create: `packages/dsh-chat/src/sessions/session-map.ts`
- Modify: `packages/dsh-chat/src/sessions/agents.ts`, `packages/dsh-chat/src/sessions/index.ts` (stubs from Task 3), `packages/dsh-chat/src/index.ts`
- Test: `packages/dsh-chat/tests/sessions/{session-map.spec.ts,agents.spec.ts,plugin.spec.ts}`

**Interfaces:**
- Consumes: `ChatKey`, `splitKey`, `pathSafe`, `SerialQueue`, `writeJsonAtomic`, `ctx.chatData`, `ctx.agents`.
- Produces: `interface ChatSessionRecord { sessionId: string; lastTurnMessageId: string; memoryInjected?: true }`; `class SessionMap(file)` keyed by `ChatKey`; `class ChatAgents` with `selection`, `workspaceFor(key)`, `lastTurnMessageId(key): string`, `markTurn(key, messageId: string)`, `setTurn(key, turn)`, `turnOf(key)`, `chatOf(agentId): ChatKey | undefined`, `memoryInjected(key, sessionId)`, `markMemoryInjected(key, sessionId)`, `resolve(key): Promise<ResolvedAgent>`, `reset(key)`, `stop(key): boolean`, `disposeAll()`; `ModelRoute`; service `ctx.chatAgents: ChatAgents`; event `'chat/agent'(agentCtx, key)`.

- [ ] **Step 1: Port the specs**

```bash
git mv packages/dsh-telegram/tests/session-map.spec.ts packages/dsh-chat/tests/sessions/session-map.spec.ts
git mv packages/dsh-telegram/tests/sessions.spec.ts packages/dsh-chat/tests/sessions/agents.spec.ts
git rm packages/dsh-zalo/tests/session-map.spec.ts packages/dsh-zalo/tests/sessions.spec.ts
```
Apply: imports from `../../src/sessions/session-map.ts` / `../../src/sessions/agents.ts`; numeric chat ids become keys (`42` -> `'telegram:42'`); `lastTurnMessageId` values become strings (`0` -> `''`); `setup` callbacks receive `(agentCtx, agent, key)`; created session ids match `/^telegram-42-/`; `workspaceFor('telegram:42')` is `join(root, 'telegram', '42')`; log messages start with `dsh-chat:`; turn contexts use the `TurnContext` shape from Task 3. Add:

```ts
it('names zalo sessions and workspaces with the path-safe id', async () => {
  const agents = makeAgents()           // the spec's existing factory
  expect(agents.workspaceFor('zalo:a/b')).toBe(join(workspaceRoot, 'zalo', pathSafe('a/b')))
  await agents.resolve('zalo:a/b')
  expect(created[0]!.sessionId).toMatch(new RegExp(`^zalo-${pathSafe('a/b')}-`))
})

it('returns the chat key of a live agent', async () => {
  const agents = makeAgents()
  const { agent } = await agents.resolve('telegram:-5')
  expect(agents.chatOf(String(agent.id))).toBe('telegram:-5')
})
```
Adjust `makeAgents`/`created` to the names the ported spec uses.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- sessions`
Expected: FAIL, cannot resolve `../../src/sessions/session-map.ts`.

- [ ] **Step 3: Implement `packages/dsh-chat/src/sessions/session-map.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { SerialQueue, writeJsonAtomic } from '../json-file.ts'
import type { ChatKey } from '../keys.ts'

export interface ChatSessionRecord {
  sessionId: string
  /** Id of the last message that got a turn; '' before the first. Group context starts after it. */
  lastTurnMessageId: string
  /** Set once the memory block is in this session's history; a resumed session must not get it again. */
  memoryInjected?: true
}

/** `chatKey -> session` map persisted as one JSON file for every channel, rewritten atomically. */
export class SessionMap {
  private records = new Map<ChatKey, ChatSessionRecord>()
  private readonly writes = new SerialQueue()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.records = new Map(Object.entries(JSON.parse(raw) as Record<ChatKey, ChatSessionRecord>))
  }

  get(key: ChatKey): ChatSessionRecord | undefined {
    return this.records.get(key)
  }

  async set(key: ChatKey, record: ChatSessionRecord): Promise<void> {
    this.records.set(key, record)
    await this.flush()
  }

  async delete(key: ChatKey): Promise<void> {
    this.records.delete(key)
    await this.flush()
  }

  /** Chats flush concurrently; each queued write snapshots the map when it runs, so the last one holds every change. */
  private flush(): Promise<void> {
    return this.writes.run(() => writeJsonAtomic(this.file, Object.fromEntries(this.records)))
  }
}
```

- [ ] **Step 4: Implement `packages/dsh-chat/src/sessions/agents.ts`**

Replace the Task 3 stub with `packages/dsh-telegram/src/sessions.ts` copied and changed as follows (keep the two interfaces from the stub at the top, after the imports):

- imports: drop `TelegramUser`; add `import { pathSafe, splitKey, type ChatKey } from '../keys.ts'` and `import type { SessionMap } from './session-map.ts'`.
- `ChatAgentsOptions.setup: (agentCtx: Context, agent: Agent, key: ChatKey) => void`.
- delete the old `TurnContext` interface (the stub's `ChatSender`/`TurnContext` replace it).
- every `chatId: number` parameter becomes `key: ChatKey`; both `Map<number, ...>` become `Map<ChatKey, ...>`; `chatOf` returns `ChatKey | undefined`.
- add, after the constructor:
```ts
  /** Model route every chat agent uses; idle engagement calls the same model. */
  get selection(): ModelRoute {
    return this.options.selection
  }

  workspaceFor(key: ChatKey): string {
    const { channel, id } = splitKey(key)
    return join(this.options.workspaceRoot, channel, pathSafe(id))
  }

  lastTurnMessageId(key: ChatKey): string {
    return this.options.map.get(key)?.lastTurnMessageId ?? ''
  }

  async markTurn(key: ChatKey, lastTurnMessageId: string): Promise<void> {
    const record = this.options.map.get(key)
    if (record === undefined) return
    await this.options.map.set(key, { ...record, lastTurnMessageId })
  }
```
- in `create`:
```ts
    const { channel, id } = splitKey(key)
    const sessionId = `${channel}-${pathSafe(id)}-${randomUUID()}`
    ...
    await this.options.map.set(key, { sessionId, lastTurnMessageId: '' })
```
- log prefixes `dsh-telegram:` become `dsh-chat:`; `chat ${chatId}` becomes `chat ${key}`.
- class doc comment: `/** One live or persisted dsh agent per chat key, across channels. */`

- [ ] **Step 5: Run store tests**

Run: `pnpm --filter dsh-chat test -- sessions/session-map sessions/agents`
Expected: PASS.

- [ ] **Step 6: Write the failing plugin test** `packages/dsh-chat/tests/sessions/plugin.spec.ts`

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sessionsPlugin from '../../src/sessions/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-sessions-plugin-'))
  root = new Context()
  root.provide('chatData', { dataDir: dir, workspaceRoot: join(dir, 'ws') })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/sessions', () => {
  it('waits for agents, loads sessions.json, then provides chatAgents with the model route', async () => {
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({ 'zalo:a': { sessionId: 's1', lastTurnMessageId: 'm9' } }))
    root.plugin(sessionsPlugin, sessionsPlugin.Config({ model: 'deepseek-flash' }))
    expect(root.get('chatAgents')).toBeUndefined()
    root.provide('agents', { get: () => undefined, create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } } as never)
    await vi.waitFor(() => expect(root.get('chatAgents')).toBeDefined())
    expect(root.get('chatAgents')!.lastTurnMessageId('zalo:a')).toBe('m9')
    expect(root.get('chatAgents')!.selection).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('requires a model', () => {
    expect(() => sessionsPlugin.Config({})).toThrow()
  })
})
```

- [ ] **Step 7: Implement `packages/dsh-chat/src/sessions/index.ts`**

Replace the Task 3 stub:

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { ChatKey } from '../keys.ts'
import type {} from '../migrate/index.ts'
import { ChatAgents, type ModelRoute } from './agents.ts'
import { SessionMap } from './session-map.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAgents: ChatAgents
  }
  interface Events {
    /** A chat's agent was created or resumed; plugins register that chat's tools on `agentCtx`. */
    'chat/agent'(agentCtx: Context, key: ChatKey): void
  }
}

export const Config: z<ModelRoute> = z.object({
  provider: z.string().default('deepseek-official'),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-sessions'
export const inject = ['chatData', 'agents']

export function apply(ctx: Context, config: ModelRoute): void {
  const logger = ctx.logger('dsh-chat')
  const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) }
  ctx.effect(() => {
    const map = new SessionMap(join(ctx.chatData.dataDir, 'sessions.json'))
    const agents = new ChatAgents({
      agents: ctx.agents,
      map,
      workspaceRoot: ctx.chatData.workspaceRoot,
      selection: config,
      setup: (agentCtx, _agent, key) => ctx.emit('chat/agent', agentCtx, key),
      log,
    })
    let stopped = false
    let revoke: (() => void) | undefined
    map.load().then(() => {
      if (!stopped) revoke = ctx.provide('chatAgents', agents)
    }, (error: unknown) => {
      logger.error(`dsh-chat: loading sessions.json failed: ${error instanceof Error ? error.message : String(error)}; chat agents stay stopped`)
    })
    return () => {
      stopped = true
      revoke?.()
      void agents.disposeAll()
    }
  }, 'dsh-chat: chatAgents')
}
```

`Config({ model })` yields `{ provider, model }` without `reasoningEffort` when unset; if Schemastery emits `reasoningEffort: undefined`, change the test's `toEqual` (it ignores undefined properties) only if it fails, never the plugin.

Append to `packages/dsh-chat/src/index.ts`:
```ts
export { ChatAgents, type AgentRegistryLike, type ModelRoute, type ResolvedAgent } from './sessions/agents.ts'
export { SessionMap, type ChatSessionRecord } from './sessions/session-map.ts'
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/
git commit -m "feat(chat): add ChatAgents keyed by chat key and the dsh-chat/sessions plugin"
```

---

### Task 5: `dsh-chat/history`

**Files:**
- Create: `packages/dsh-chat/src/history/index.ts`
- Test: `packages/dsh-chat/tests/history.spec.ts`

**Interfaces:**
- Consumes: `ctx.chatLog`, `formatEntry`, event `'chat/agent'`.
- Produces: tool `chat_history` with parameters `limit?: integer`, `before_message_id?: string`, `query?: string`; `createChatHistoryTool({ chatLog, key })`.

- [ ] **Step 1: Write the failing test** `packages/dsh-chat/tests/history.spec.ts`

Move the `telegram_chat_history` cases from `packages/dsh-telegram/tests/tools.spec.ts` here (and delete the `zalo_chat_history` cases from `packages/dsh-zalo/tests/tools.spec.ts`), switched to `createChatHistoryTool({ chatLog, key: 'telegram:42' })`, string ids and `before_message_id: '<id>'`. Add:

```ts
it('returns the newest entries when before_message_id is unknown', async () => {
  for (const id of ['1', '2', '3']) await chatLog.append('telegram:42', { ts: `t${id}`, message_id: id, user_id: 'u', name: 'n', text: id })
  const out = await run(createChatHistoryTool({ chatLog, key: 'telegram:42' }), { limit: 2, before_message_id: 'missing' })
  expect(out).toBe('<chat_history>\n[t2] id:u (n): 2\n[t3] id:u (n): 3\n</chat_history>')
})

it('registers chat_history on every chat agent once chatLog is up', async () => {
  const root = new Context()
  root.provide('chatLog', chatLog)
  root.plugin(historyPlugin)
  const registered: string[] = []
  const agentCtx = { tools: { register: (t: { name: string }) => { registered.push(t.name); return () => {} } }, effect: (fn: () => () => void) => { fn() } }
  await vi.waitFor(() => {
    registered.length = 0
    root.emit('chat/agent', agentCtx as never, 'zalo:a')
    expect(registered).toEqual(['chat_history'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- history`
Expected: FAIL, cannot resolve `../src/history/index.ts`.

- [ ] **Step 3: Implement `packages/dsh-chat/src/history/index.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ChatKey } from '../keys.ts'
import { formatEntry, type ChatLog } from '../log/chatlog.ts'
import type {} from '../log/index.ts'
import type {} from '../sessions/index.ts'

const HISTORY_LIMIT_MAX = 100
const HISTORY_LIMIT_DEFAULT = 50

export function createChatHistoryTool(deps: { chatLog: ChatLog; key: ChatKey }): ToolDefinition {
  return defineTool({
    name: 'chat_history',
    description: 'Read earlier messages of the current chat, including messages from people the assistant did not reply to. Returns oldest first.',
    parameters: {
      limit: { type: 'integer', description: `Number of messages to return (default ${HISTORY_LIMIT_DEFAULT}, max ${HISTORY_LIMIT_MAX})` },
      before_message_id: { type: 'string', description: 'Only messages logged before the message with this id' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the message text' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, args.limit ?? HISTORY_LIMIT_DEFAULT))
      const entries = await deps.chatLog.history(deps.key, {
        limit,
        ...(args.before_message_id === undefined ? {} : { beforeMessageId: args.before_message_id }),
        ...(args.query === undefined ? {} : { query: args.query }),
      })
      return entries.length === 0 ? '(no messages)' : `<chat_history>\n${entries.map(formatEntry).join('\n')}\n</chat_history>`
    },
  })
}

/** Cordis plugin name. */
export const name = 'dsh-chat-history'
export const inject = ['chatLog']

export function apply(ctx: Context): void {
  ctx.on('chat/agent', (agentCtx, key) => {
    const tool = createChatHistoryTool({ chatLog: ctx.chatLog, key })
    agentCtx.effect(() => agentCtx.tools.register(tool), 'dsh-chat: chat_history')
  })
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/
git commit -m "feat(chat): add the channel-neutral chat_history tool as dsh-chat/history"
```

---

### Task 6: `dsh-chat/retention`

**Files:**
- Create: `packages/dsh-chat/src/retention/sweep.ts`, `packages/dsh-chat/src/retention/index.ts`
- Delete: `packages/dsh-telegram/src/retention.ts`, `packages/dsh-zalo/src/retention.ts` (in Tasks 8/9 when their importers go)
- Test: `packages/dsh-chat/tests/retention.spec.ts`

**Interfaces:**
- Consumes: `ctx.chatData.workspaceRoot`.
- Produces: `sweepOldFiles(workspaceRoot, maxAgeMs, now?)` walking `<root>/<channel>/<id>/{inbox,outbox}`; plugin config `{ fileRetentionDays: number }` (default 90).

- [ ] **Step 1: Port and extend the test**

`git mv packages/dsh-telegram/tests/retention.spec.ts packages/dsh-chat/tests/retention.spec.ts`. Change its import to `../src/retention/sweep.ts` and every chat directory from `<root>/<id>` to `<root>/telegram/<id>`. Add:

```ts
it('sweeps every channel and leaves files outside inbox and outbox alone', async () => {
  const old = Date.now() - 10 * DAY
  for (const path of ['telegram/1/inbox/a.jpg', 'zalo/x/outbox/b.txt', 'zalo/x/notes.md']) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), 'x')
    await utimes(join(root, path), old / 1000, old / 1000)
  }
  await sweepOldFiles(root, 5 * DAY)
  expect(existsSync(join(root, 'telegram/1/inbox/a.jpg'))).toBe(false)
  expect(existsSync(join(root, 'zalo/x/outbox/b.txt'))).toBe(false)
  expect(existsSync(join(root, 'zalo/x/notes.md'))).toBe(true)
})
```
(Import `existsSync` from `node:fs`, `dirname` from `node:path`, `mkdir`, `writeFile`, `utimes` from `node:fs/promises`; `DAY = 86_400_000`; reuse the spec's `root` temp dir.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- retention`
Expected: FAIL, cannot resolve `../src/retention/sweep.ts`.

- [ ] **Step 3: Implement**

`packages/dsh-chat/src/retention/sweep.ts`: copy `packages/dsh-telegram/src/retention.ts` and replace `sweepOldFiles` with:

```ts
/** Deletes files older than `maxAgeMs` from every chat's `inbox/` and `outbox/` (`<root>/<channel>/<id>/`), then the folders they leave empty. */
export async function sweepOldFiles(workspaceRoot: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  for (const channel of await entriesOf(workspaceRoot)) {
    if (!channel.isDirectory()) continue
    for (const chat of await entriesOf(join(workspaceRoot, channel.name))) {
      if (!chat.isDirectory()) continue
      for (const box of ['inbox', 'outbox']) await sweepDir(join(workspaceRoot, channel.name, chat.name, box), now - maxAgeMs, false)
    }
  }
}
```

`packages/dsh-chat/src/retention/index.ts`:
```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../migrate/index.ts'
import { sweepOldFiles } from './sweep.ts'

export interface RetentionConfig {
  /** Inbox and outbox files untouched for this many days are deleted. */
  readonly fileRetentionDays: number
}

export const Config: z<RetentionConfig> = z.object({
  fileRetentionDays: z.number().min(1).default(90),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-retention'
export const inject = ['chatData']

const DAY_MS = 86_400_000

/** Sweeps old inbox and outbox files now and then once a day. */
export function apply(ctx: Context, config: RetentionConfig): void {
  const logger = ctx.logger('dsh-chat')
  ctx.effect(() => {
    const sweep = () => {
      sweepOldFiles(ctx.chatData.workspaceRoot, config.fileRetentionDays * DAY_MS).catch((error: unknown) => {
        logger.warn(`dsh-chat: file retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    sweep()
    const timer = setInterval(sweep, DAY_MS).unref()
    return () => clearInterval(timer)
  }, 'dsh-chat: file retention')
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/
git commit -m "feat(chat): sweep per-channel inbox and outbox files as dsh-chat/retention"
```

---

### Task 7: `dsh-chat/migrate`

**Files:**
- Create: `packages/dsh-chat/src/migrate/migrate.ts`
- Modify: `packages/dsh-chat/src/migrate/index.ts` (stub from Task 2)
- Test: `packages/dsh-chat/tests/migrate/{migrate.spec.ts,plugin.spec.ts}`

**Interfaces:**
- Produces: `MARKER = '.migrated-v1'`; `migrate({ dataDir, workspaceRoot, legacyChannel? }): Promise<'current' | 'migrated'>`; plugin config `{ dataDir: string; workspaceRoot: string; legacyChannel?: string }`; service `ctx.chatData: ChatData`.

- [ ] **Step 1: Write the failing test** `packages/dsh-chat/tests/migrate/migrate.spec.ts`

```ts
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MARKER, migrate } from '../../src/migrate/migrate.ts'

let data: string
let ws: string
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'chat-migrate-'))
  data = join(base, 'data')
  ws = join(base, 'workspace')
})
afterEach(async () => { await rm(dirname(data), { recursive: true, force: true }) })

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function legacyTelegram(): Promise<void> {
  await put(join(data, 'chatlog', '-100.jsonl'), `${JSON.stringify({ ts: 't', message_id: 5, user_id: 7, name: 'n', text: 'x', reply_to: 4 })}\n`)
  await put(join(data, 'memory', '-100.json'), '{"nextId":2,"entries":[{"id":1,"text":"a","ts":"t"}]}')
  await put(join(data, 'memory', 'global.json'), '{"nextId":1,"entries":[]}')
  await put(join(data, 'telegram-sessions.json'), '{"-100":{"sessionId":"s","lastTurnMessageId":5}}')
  await put(join(data, 'idle-decisions.jsonl'), '{}\n')
  await put(join(data, 'schedule.json'), '[]')
  await put(join(ws, '-100', 'inbox', 'a.jpg'), 'img')
}

describe('migrate', () => {
  it('moves a Telegram volume to the per-channel layout and stringifies log ids', async () => {
    await legacyTelegram()
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('migrated')
    const line = JSON.parse((await readFile(join(data, 'telegram', 'chatlog', '-100.jsonl'), 'utf8')).trim())
    expect(line).toEqual({ ts: 't', message_id: '5', user_id: '7', name: 'n', text: 'x', reply_to: '4' })
    expect(existsSync(join(data, 'telegram', 'memory', '-100.json'))).toBe(true)
    expect(existsSync(join(data, 'memory', 'global.json'))).toBe(true)
    expect(existsSync(join(data, 'telegram', 'idle-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(data, 'telegram', 'schedule.json'))).toBe(true)
    expect(existsSync(join(data, 'telegram-sessions.json'))).toBe(false)
    expect(existsSync(join(ws, 'telegram', '-100', 'inbox', 'a.jpg'))).toBe(true)
    expect(existsSync(join(ws, '-100'))).toBe(false)
    expect(existsSync(join(data, MARKER))).toBe(true)
  })

  it('moves a Zalo volume without touching its string ids', async () => {
    const line = `${JSON.stringify({ ts: 't', message_id: 'm1', user_id: 'u1', name: 'n', text: 'x' })}\n`
    await put(join(data, 'chatlog', 'abc.jsonl'), line)
    await put(join(data, 'zalo-sessions.json'), '{}')
    await put(join(ws, 'abc', 'inbox', 'p.png'), 'img')
    await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'zalo' })
    expect(await readFile(join(data, 'zalo', 'chatlog', 'abc.jsonl'), 'utf8')).toBe(line)
    expect(existsSync(join(ws, 'zalo', 'abc', 'inbox', 'p.png'))).toBe(true)
    expect(existsSync(join(data, 'zalo-sessions.json'))).toBe(false)
  })

  it('does nothing once the marker exists', async () => {
    await legacyTelegram()
    await put(join(data, MARKER), 'done')
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('current')
    expect(existsSync(join(data, 'chatlog', '-100.jsonl'))).toBe(true)
  })

  it('only writes the marker when there is no legacy channel', async () => {
    expect(await migrate({ dataDir: data, workspaceRoot: ws })).toBe('migrated')
    expect(existsSync(join(data, MARKER))).toBe(true)
  })

  it('completes on a rerun after failing half-way, without a marker in between', async () => {
    await legacyTelegram()
    const fs = await import('node:fs/promises')
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => { await fs.copyFile(from, to); throw new Error('disk gone') })
    await expect(migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).rejects.toThrow('disk gone')
    expect(existsSync(join(data, MARKER))).toBe(false)
    spy.mockRestore()
    expect(await migrate({ dataDir: data, workspaceRoot: ws, legacyChannel: 'telegram' })).toBe('migrated')
    expect((await readFile(join(data, 'telegram', 'chatlog', '-100.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(existsSync(join(ws, 'telegram', '-100', 'inbox', 'a.jpg'))).toBe(true)
  })
})
```

The half-way case relies on `migrate.ts` calling `rename` through the module namespace (`import * as fs from 'node:fs/promises'`); if `vi.spyOn` cannot patch the ESM namespace, replace the spy with `vi.mock('node:fs/promises', ...)` that wraps the real module and fails the first `rename` once, keeping the same assertions.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter dsh-chat test -- migrate/migrate`
Expected: FAIL, cannot resolve `../../src/migrate/migrate.ts`.

- [ ] **Step 3: Implement `packages/dsh-chat/src/migrate/migrate.ts`**

```ts
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../json-file.ts'

export const MARKER = '.migrated-v1'

export interface MigrateOptions {
  readonly dataDir: string
  readonly workspaceRoot: string
  /** Channel whose pre-dsh-chat files live directly in `dataDir` and `workspaceRoot`; absent for a fresh or multi-channel volume. */
  readonly legacyChannel?: string
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(() => true, () => false)
}

async function names(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Renames `from` to `to` unless `to` is already there (an earlier run got that far); then the source is a leftover copy. */
async function move(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return
  if (await exists(to)) {
    await fs.rm(from, { recursive: true, force: true })
    return
  }
  await fs.mkdir(join(to, '..'), { recursive: true })
  await fs.rename(from, to)
}

/** Telegram logged numeric ids; the core compares ids as strings. */
async function stringifyLogIds(dir: string): Promise<void> {
  for (const name of await names(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(line => line !== '')
    let changed = false
    const out = lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      for (const field of ['message_id', 'user_id', 'reply_to']) {
        if (typeof entry[field] === 'number') {
          entry[field] = String(entry[field])
          changed = true
        }
      }
      return JSON.stringify(entry)
    })
    if (changed) await writeFileAtomic(file, out.map(line => `${line}\n`).join(''))
  }
}

/**
 * Moves one channel's legacy files into `<dataDir>/<channel>/` and `<workspaceRoot>/<channel>/`, then writes the marker.
 * Every step is safe to repeat, so a run that failed half-way completes on the next start; without the marker no chat plugin starts.
 */
export async function migrate(options: MigrateOptions): Promise<'current' | 'migrated'> {
  const { dataDir, workspaceRoot, legacyChannel: channel } = options
  if (await exists(join(dataDir, MARKER))) return 'current'
  if (channel !== undefined) {
    const target = join(dataDir, channel)
    for (const name of await names(join(dataDir, 'chatlog'))) await move(join(dataDir, 'chatlog', name), join(target, 'chatlog', name))
    if (channel === 'telegram') await stringifyLogIds(join(target, 'chatlog'))
    for (const name of await names(join(dataDir, 'memory'))) {
      if (name !== 'global.json') await move(join(dataDir, 'memory', name), join(target, 'memory', name))
    }
    for (const name of ['idle-decisions.jsonl', 'schedule.json']) await move(join(dataDir, name), join(target, name))
    // Stored sessions keep their old cwd, so every chat starts a new session; memory and chat log carry the continuity.
    await fs.rm(join(dataDir, `${channel}-sessions.json`), { force: true })
    for (const name of await names(workspaceRoot)) {
      if (name === channel) continue
      const from = join(workspaceRoot, name)
      if ((await fs.stat(from)).isDirectory()) await move(from, join(workspaceRoot, channel, name))
    }
  }
  await writeFileAtomic(join(dataDir, MARKER), `${new Date().toISOString()}\n`)
  return 'migrated'
}
```

The workspace loop skips any entry named like a channel only for the current one; a Telegram volume holds no `zalo` folder and vice versa, so no other name needs skipping.

- [ ] **Step 4: Run migrate tests**

Run: `pnpm --filter dsh-chat test -- migrate/migrate`
Expected: PASS.

- [ ] **Step 5: Write the failing plugin test** `packages/dsh-chat/tests/migrate/plugin.spec.ts`

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as migratePlugin from '../../src/migrate/index.ts'

let dir: string
let root: Context
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-migrate-plugin-'))
  root = new Context()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('dsh-chat/migrate', () => {
  it('provides chatData after migrating', async () => {
    root.plugin(migratePlugin, migratePlugin.Config({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w'), legacyChannel: 'zalo' }))
    await vi.waitFor(() => expect(root.get('chatData')).toEqual({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w') }))
  })

  it('withholds chatData when the migration fails', async () => {
    await writeFile(join(dir, 'd'), 'a file where the data dir should be')
    root.plugin(migratePlugin, migratePlugin.Config({ dataDir: join(dir, 'd'), workspaceRoot: join(dir, 'w') }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(root.get('chatData')).toBeUndefined()
  })

  it('rejects relative paths and odd channel names at load', () => {
    expect(() => root.plugin(migratePlugin, migratePlugin.Config({ dataDir: 'data', workspaceRoot: '/w' }))).toThrow('dsh-chat: dataDir must be an absolute path')
    expect(() => root.plugin(migratePlugin, migratePlugin.Config({ dataDir: '/d', workspaceRoot: '/w', legacyChannel: '../x' }))).toThrow('dsh-chat: legacyChannel must be lowercase letters')
  })
})
```

If `root.plugin` reports the `apply` error through the fiber state instead of throwing, assert the way `packages/dsh-telegram/tests/schedule/plugin.spec.ts` does for its invalid-config case (`FAILED` state), keeping the messages.

- [ ] **Step 6: Implement `packages/dsh-chat/src/migrate/index.ts`**

Replace the Task 2 stub (keep its `declare module` and `ChatData`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { migrate, type MigrateOptions } from './migrate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatData: ChatData
  }
}

/** Paths every chat plugin shares; provided once the data layout is current. */
export interface ChatData {
  readonly dataDir: string
  readonly workspaceRoot: string
}

export const Config: z<MigrateOptions> = z.object({
  dataDir: z.string().required(),
  workspaceRoot: z.string().required(),
  legacyChannel: z.string(),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-migrate'

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertConfig(config: MigrateOptions): void {
  for (const key of ['workspaceRoot', 'dataDir'] as const) {
    if (!config[key].startsWith('/') && !/^[A-Za-z]:[\\/]/.test(config[key])) throw new Error(`dsh-chat: ${key} must be an absolute path`)
  }
  if (config.legacyChannel !== undefined && !/^[a-z]+$/.test(config.legacyChannel)) throw new Error('dsh-chat: legacyChannel must be lowercase letters')
}

export function apply(ctx: Context, config: MigrateOptions): void {
  assertConfig(config)
  const logger = ctx.logger('dsh-chat')
  ctx.effect(() => {
    let stopped = false
    let revoke: (() => void) | undefined
    migrate(config).then((result) => {
      if (result === 'migrated') logger.info(`dsh-chat: data layout migrated${config.legacyChannel === undefined ? '' : ` from the ${config.legacyChannel} layout`}`)
      if (!stopped) revoke = ctx.provide('chatData', { dataDir: config.dataDir, workspaceRoot: config.workspaceRoot })
    }, (error: unknown) => {
      logger.error(`dsh-chat: data migration failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}; chat plugins stay stopped until it succeeds on a restart`)
    })
    return () => {
      stopped = true
      revoke?.()
    }
  }, 'dsh-chat: data layout')
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter dsh-chat test && pnpm --filter dsh-chat typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-chat
git commit -m "feat(chat): migrate a channel volume to the per-channel layout before the chat plugins start"
```

---

### Task 8: `dsh-telegram` on the core plugins

**Files:**
- Delete: `packages/dsh-telegram/src/{chatlog,memory,session-map,sessions,retention}.ts`
- Modify: `packages/dsh-telegram/src/{config,index,bot,inbound,tools,service}.ts`, `src/idle/{burst,engage,scheduler,index}.ts`, `src/schedule/{delivery,tools,index}.ts`
- Modify tests: `packages/dsh-telegram/tests/**` (fixtures only)

**Interfaces:**
- Consumes: from `dsh-chat`: `chatKey`, `idIn`, `ChatLog`, `ChatLogEntry`, `oneLine`, `senderLabel`, `renderMemoryBlock`, `MemoryStore`, `ChatAgents`, `TurnContext`; services `chatData`, `chatLog`, `chatMemory`, `chatAgents`; events `chat/message`, `chat/agent`.
- Produces: unchanged `TelegramService` shape and `telegram/turn`, `telegram/message` events (numeric chat ids), so idle and schedule keep their contracts; `TelegramService.chatLog` is the core `ChatLog` (keyed by `ChatKey`).

Rule for every edit: Telegram APIs keep numeric ids; anything that touches a core store converts with `const key = chatKey('telegram', chatId)` and `String(...)` for message and user ids. Back from a store: `Number(id)`.

- [ ] **Step 1: Delete the stores and their imports' targets**

```bash
git rm packages/dsh-telegram/src/chatlog.ts packages/dsh-telegram/src/memory.ts packages/dsh-telegram/src/session-map.ts packages/dsh-telegram/src/sessions.ts packages/dsh-telegram/src/retention.ts
```
Replace every import of those modules with the same names from `'dsh-chat'` (`TurnContext` too).

- [ ] **Step 2: Config**

In `src/config.ts` delete the fields and schema entries `workspaceRoot`, `dataDir`, `provider`, `model`, `reasoningEffort`, `fileRetentionDays`, `chatLogMaxEntries`, `memory`, the `MemoryLimits` import, and the path loop in `assertConfig` (`dsh-chat/migrate` checks paths now). Update `tests/config.spec.ts` expectations to the remaining fields.

- [ ] **Step 3: `src/index.ts`**

- `export const inject = ['attachments', 'loader', 'chatData', 'chatLog', 'chatMemory', 'chatAgents']`
- In `start`: delete the `ChatLog`, `MemoryStore`, `SessionMap`, `ChatAgents` construction; use `const chatLog = ctx.chatLog`, `const memory = ctx.chatMemory`, `const agents = ctx.chatAgents`.
- `Started` becomes `{ polling: Polling; service: TelegramService }`; stop paths call only `polling.stop()` (agents belong to `dsh-chat/sessions`).
- Delete `startRetention`, `DAY_MS`, the retention effect and `forwardAppends` (moved to `dsh-chat/log`); in `tests/index.spec.ts` delete the `forwardAppends` cases.
- In `apply`, register the per-chat Telegram tool and the legacy event bridge:

```ts
  let current: { api: TelegramApi; maxUploadBytes: number } | undefined
  ctx.on('chat/agent', (agentCtx, key) => {
    const id = idIn('telegram', key)
    if (id === undefined || current === undefined) return
    const chatId = Number(id)
    const tool = createSendFileTool({ api: current.api, chatId, workspaceDir: ctx.chatAgents.workspaceFor(key), maxUploadBytes: current.maxUploadBytes })
    agentCtx.effect(() => agentCtx.tools.register(tool), 'dsh-telegram: telegram_send_file')
  })
  // Idle engagement listens to telegram/message with numeric chat ids until it moves to dsh-chat.
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/message', Number(id), entry)
  })
```
Set `current = { api, maxUploadBytes }` where `start` resolves (next to `started = result`) and `current = undefined` in the stop path. Return `api` and `maxUploadBytes` from `start` for this (add them to `Started`).
- The `service` object:

```ts
      dataDir: join(ctx.chatData.dataDir, 'telegram'),
      selection: ctx.chatAgents.selection,
      chatOf: (agentId) => {
        const key = agents.chatOf(agentId)
        const id = key === undefined ? undefined : idIn('telegram', key)
        return id === undefined ? undefined : Number(id)
      },
      turnOf: chatId => telegramTurn(agents.turnOf(chatKey('telegram', chatId))),
```
with, in `src/service.ts`, `TelegramService.turnOf` returning `TelegramTurn | undefined` where

```ts
/** The running turn in Telegram terms, for the schedule tools. */
export interface TelegramTurn { sender: TelegramUser; isGroup: boolean }

export function telegramTurn(turn: TurnContext | undefined): TelegramTurn | undefined {
  if (turn === undefined) return undefined
  const { id, name, username } = turn.sender
  return { isGroup: turn.isGroup, sender: { id: Number(id), is_bot: false, first_name: name, ...(username === undefined ? {} : { username }) } }
}
```
Change `TelegramService.selection` to `{ readonly provider: string; readonly model: string }` sourced as above (it already is).

- [ ] **Step 4: `src/tools.ts`**

Keep only `createSendFileTool`; `ToolDeps` becomes `{ api: TelegramApi; chatId: number; workspaceDir: string; maxUploadBytes: number }`. Delete `createChatHistoryTool`, the memory tools, `registerChatTools`, and their imports. In `tests/tools.spec.ts` keep only the `telegram_send_file` cases (memory and history cases moved in Tasks 3 and 5).

- [ ] **Step 5: `src/inbound.ts` and `src/bot.ts`**

`logEntryFor` and the `logEntry` built in `parseInbound`: `message_id: String(message.message_id)`, `user_id: String(sender.id)`, `reply_to: String(...)` when present.

`bot.ts`:
- `BotDeps.memory: MemoryStore`, `agents: ChatAgents`, `chatLog: ChatLog` (types from `dsh-chat`).
- `memoryBlock(deps, chatId)` lists `{ kind: 'chat', key: chatKey('telegram', chatId) }`.
- In `runChatTurn`, `const key = chatKey('telegram', chatId)` and use `key` for every `deps.agents.*` and `deps.chatLog.*` call. The turn:
```ts
  deps.agents.setTurn(key, {
    sender: { id: String(input.sender.id), name: input.sender.first_name, ...(input.sender.username === undefined ? {} : { username: input.sender.username }) },
    isGroup: input.isGroup,
    isSuperAdmin: deps.config.superAdmins.includes(input.sender.id),
  })
```
- Group context and marker:
```ts
    const recent = await deps.chatLog.recent(key, deps.agents.lastTurnMessageId(key), String(messageId), deps.config.recentMessagesLimit)
  ...
  if (messageId !== undefined) await deps.agents.markTurn(key, String(messageId))
```
- `const sessionId = String(resolved.agent.id)`.
- Bot reply entry: `message_id: result.sentMessageId === undefined ? '' : String(result.sentMessageId)`, `user_id: String(deps.botId)`, `reply_to: String(messageId)` when defined.
- `handleMessage`: `deps.agents.workspaceFor(chatKey('telegram', chatId))`, `deps.chatLog.append(chatKey('telegram', chatId), ...)`, `deps.agents.reset(key)`, `deps.agents.stop(key)`.
- Remove the `config.model`/`provider` uses if any remain (selection comes from `dsh-chat/sessions`).

- [ ] **Step 6: Idle and schedule**

- `idle/burst.ts`, `idle/engage.ts`: `Set<number>` of message ids becomes `Set<string>`; in `parseDecision`, compare `e.message_id === String(messageId)` and reject non-number/non-string `message_id` as today; `IdleAction.messageId` becomes `string`. `idleTranscript` output is unchanged for numeric-string ids.
- `idle/scheduler.ts`: `chatLog.append(chatKey('telegram', chatId), { ..., message_id: String(sent.messageId), user_id: String(deps.botId), reply_to: action.messageId })`, `chatLog.readAll(chatKey('telegram', chatId))`; Telegram API calls take `Number(action.messageId)`; `state.reacted` and the photo `messageId` follow the types tsc reports (store strings, convert with `Number` only at API calls). The decision record's `messageId` becomes `string`.
- `idle/index.ts`: unchanged apart from types (`dataDir`, `selection` still come from `ctx.telegram`).
- `schedule/delivery.ts`: `telegram.chatLog.append(chatKey('telegram', chatId), { ts, message_id: String(sent.messageId), user_id: String(telegram.bot.id), name: telegram.bot.username, text, bot: true })`.
- `schedule/tools.ts`: `turnOf` now returns `TelegramTurn`; replace the `TurnContext` import with `TelegramTurn` from `../service.ts`.

- [ ] **Step 7: Typecheck and test**

Run: `pnpm --filter dsh-telegram typecheck`
Expected: no errors. Each remaining error is a number/string id at a store boundary; fix it by the rule above, never by widening a core type.

Run: `pnpm --filter dsh-telegram test`
Expected: PASS after fixture updates: test fixtures that build `ChatLog`, `MemoryStore` or `ChatAgents` import them from `dsh-chat` and pass keys and string ids; fixtures that build a `Config` drop the deleted fields; `tests/schedule/plugin.spec.ts`'s `service()` drops nothing (shape unchanged) but builds `new ChatLog(join(dir, 'log'))`. Add to `tests/bot.spec.ts`:

```ts
it('keys the chat as telegram:<id>, marks the turn with a string id and gives context by position', async () => {
  agents.lastTurnMessageId.mockReturnValue('8')
  await deps.chatLog.append('telegram:5', { ts: 't', message_id: '8', user_id: '7', name: 'Ann', text: 'last turn', handled: true })
  await deps.chatLog.append('telegram:5', { ts: 't', message_id: '9', user_id: '9', name: 'Bob', text: 'same second' })
  await handleMessage(msg({ text: '@dshbot see', entities: mention }, 'supergroup'), deps)
  const content = (followups[0] as { content: Array<{ text?: string }> }).content
  expect(content[0]!.text).toBe('<group_messages>\n- id:9 (Bob): same second\n</group_messages>\n\n@ann (Ann): see')
  expect(agents.markTurn).toHaveBeenCalledWith('telegram:5', '10')
  expect(agents.setTurn).toHaveBeenCalledWith('telegram:5', { sender: { id: '7', name: 'Ann', username: 'ann' }, isGroup: true, isSuperAdmin: true })
})
```
In the `handleMessage` harness, `agents.lastTurnMessageId` defaults to `vi.fn(() => '')` and `chatLog` becomes `new ChatLog(dir)`; existing expectations of `setTurn(5, { sender: ann, isGroup })` become `setTurn('telegram:5', { sender: { id: '7', name: 'Ann', username: 'ann' }, isGroup, isSuperAdmin: true })`.

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-telegram
git commit -m "refactor(telegram): run on the dsh-chat store plugins and chat keys"
```

---

### Task 9: `dsh-zalo` on the core plugins

**Files:**
- Delete: `packages/dsh-zalo/src/{chatlog,memory,session-map,sessions,retention,tools}.ts`, `packages/dsh-zalo/tests/tools.spec.ts`
- Modify: `packages/dsh-zalo/src/{config,index,bot,inbound,service,media}.ts`
- Modify tests: `packages/dsh-zalo/tests/**` (fixtures only)

**Interfaces:**
- Consumes: as Task 8.
- Produces: `ZaloService` unchanged in shape; `zalo/turn` and `zalo/message` events with string chat ids.

- [ ] **Step 1: Delete stores and tools**

```bash
git rm packages/dsh-zalo/src/chatlog.ts packages/dsh-zalo/src/memory.ts packages/dsh-zalo/src/session-map.ts packages/dsh-zalo/src/sessions.ts packages/dsh-zalo/src/retention.ts packages/dsh-zalo/src/tools.ts packages/dsh-zalo/tests/tools.spec.ts
```
(Zalo's only per-chat tools were history and memory, now in `dsh-chat`.) Replace imports of those modules with `'dsh-chat'`. In `src/media.ts`, delete `pathSafe` and import it from `'dsh-chat'` where `inbound.ts` uses it.

- [ ] **Step 2: Config**

Same deletions as Task 8 Step 2 (`workspaceRoot`, `dataDir`, `provider`, `model`, `reasoningEffort`, `fileRetentionDays`, `chatLogMaxEntries`, `memory`, the path loop). Update `tests/config.spec.ts`.

- [ ] **Step 3: `src/index.ts`**

- `export const inject = ['attachments', 'loader', 'chatData', 'chatLog', 'chatMemory', 'chatAgents']`
- Use `ctx.chatLog`, `ctx.chatMemory`, `ctx.chatAgents`; delete store construction, `registerChatTools`, `startRetention`, `DAY_MS`, `forwardAppends` (and its cases in `tests/index.spec.ts`).
- `Started` becomes `{ poller: Poller; dispatcher: Dispatcher; service: ZaloService }`; stop paths call `dispatcher.close()` and `poller.stop()` only.
- Event bridge in `apply`:
```ts
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('zalo', key)
    if (id !== undefined) ctx.emit('zalo/message', id, entry)
  })
```
- Service: `dataDir: join(ctx.chatData.dataDir, 'zalo')`, `chatOf: (agentId) => { const key = agents.chatOf(agentId); return key === undefined ? undefined : idIn('zalo', key) }`.

- [ ] **Step 4: `src/bot.ts`**

- `const key = chatKey('zalo', chatId)` in `handleMessage`; use it for every `deps.agents.*`, `deps.chatLog.*` call and the memory scope `{ kind: 'chat', key }`.
- Turn:
```ts
  deps.agents.setTurn(key, {
    sender: { id: inbound.sender.id, name: inbound.sender.display_name ?? '' },
    isGroup: inbound.isGroup,
    isSuperAdmin: deps.config.superAdmins.includes(inbound.sender.id),
  })
```
(Use the field names `ZaloUser` actually has; `display_name` is what `handleMessage` already logs.)
- Group context and marker switch from timestamps to message ids:
```ts
    const recent = await deps.chatLog.recent(key, deps.agents.lastTurnMessageId(key), inbound.messageId, deps.config.recentMessagesLimit)
  ...
  await deps.agents.markTurn(key, inbound.messageId)
```
- The `/reset` path in the dispatcher (`deps.agents.stop(update.message.chat.id)`) uses `chatKey('zalo', update.message.chat.id)`.

- [ ] **Step 5: Typecheck and test**

Run: `pnpm --filter dsh-zalo typecheck && pnpm --filter dsh-zalo test`
Expected: PASS after fixture updates (store fixtures from `dsh-chat`, keys `'zalo:<id>'`, `Config` without deleted fields; `bot.spec.ts` expectations on `lastTurnAt` become `lastTurnMessageId` with the trigger's message id).

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-zalo
git commit -m "refactor(zalo): run on the dsh-chat store plugins and chat keys"
```

---

### Task 10: Patches, profiles and images

**Files:**
- Modify: `packages/dsh-telegram/cordis.patch.yml`, `packages/dsh-zalo/cordis.patch.yml`, `profile/telegram/{cordis.patch.yml,package.json}`, `profile/zalo/{cordis.patch.yml,package.json}`
- Modify: `docker/Dockerfile`, `docker/zalo.Dockerfile`
- Test: `packages/dsh-telegram/tests/profile.spec.ts`, `packages/dsh-zalo/tests/profile.spec.ts`

**Interfaces:**
- Consumes: plugin names `dsh-chat/migrate`, `dsh-chat/log`, `dsh-chat/memory`, `dsh-chat/sessions`, `dsh-chat/history`, `dsh-chat/retention` and their configs from Tasks 2-7.

- [ ] **Step 1: Write the failing wiring tests**

Append to `packages/dsh-telegram/tests/profile.spec.ts` (the zalo spec gets the same block with `zalo` / `ZALO` / `DSH_ZALO_*` names and `legacyChannel: 'zalo'`):

```ts
describe('dsh-chat rows', () => {
  const ids = ['chat-migrate', 'chat-log', 'chat-memory', 'chat-sessions', 'chat-history', 'chat-retention']

  it('inserts every dsh-chat plugin before the bot row', async () => {
    const list = await rows('../cordis.patch.yml')
    const inserted = list.flatMap(r => r.insert ?? []).map(r => r.id)
    for (const id of ids) expect(inserted.indexOf(id)).toBeGreaterThanOrEqual(0)
    expect(inserted.indexOf('chat-migrate')).toBeLessThan(inserted.indexOf('telegram'))
    expect(row(list, 'chat-log').name).toBe('dsh-chat/log')
  })

  it('maps the old env vars to the migrate and sessions rows', async () => {
    const list = await rows('../cordis.patch.yml')
    const migrateRow = row(list, 'chat-migrate').config!
    expect(evalJs(migrateRow.dataDir, { DSH_TELEGRAM_DATA: '/x' })).toBe('/x')
    expect(evalJs(migrateRow.workspaceRoot, {})).toBe('/workspace')
    expect(migrateRow.legacyChannel).toBe('telegram')
    expect(evalJs(row(list, 'chat-sessions').config!.model, {})).toBe('deepseek-flash')
  })

  it('keeps paths and model off the bot row', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = row(await rows(path), 'telegram').config!
      for (const key of ['dataDir', 'workspaceRoot', 'model']) expect(config).not.toHaveProperty(key)
    }
  })

  it('lists dsh-chat as a profile bundle before the adapter', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../profile/telegram/package.json', import.meta.url), 'utf8'))
    const bundles: string[] = pkg.dsh.profile.bundles
    expect(bundles.indexOf('dsh-chat')).toBeLessThan(bundles.indexOf('dsh-telegram'))
  })
})
```
If `packages/dsh-zalo/tests/profile.spec.ts` lacks the `rows`/`row`/`evalJs` helpers, copy them from the Telegram spec.

Run: `pnpm -r test -- profile`
Expected: FAIL (rows missing).

- [ ] **Step 2: Bundle patches**

In `packages/dsh-telegram/cordis.patch.yml`, inside `insert:` right after the `telegram-logger` row, add:

```yaml
    - id: chat-migrate
      name: dsh-chat/migrate
      config:
        dataDir: !!js process.env.DSH_TELEGRAM_DATA ?? '/data'
        workspaceRoot: !!js process.env.DSH_TELEGRAM_WORKSPACE ?? '/workspace'
        legacyChannel: telegram

    - id: chat-log
      name: dsh-chat/log

    - id: chat-memory
      name: dsh-chat/memory

    - id: chat-sessions
      name: dsh-chat/sessions
      config:
        model: !!js process.env.DSH_MODEL ?? 'deepseek-flash'

    - id: chat-history
      name: dsh-chat/history

    - id: chat-retention
      name: dsh-chat/retention
```
and delete `workspaceRoot`, `dataDir`, `model` from the `telegram` row. In the persona suffix, replace nothing (the memory wording is unchanged; the tool list now includes `chat_history` instead of `telegram_chat_history`, which the persona does not name).

Do the same in `packages/dsh-zalo/cordis.patch.yml` with `DSH_ZALO_DATA`, `DSH_ZALO_WORKSPACE`, `legacyChannel: zalo`, and delete those keys from the `zalo` row.

- [ ] **Step 3: Profiles**

`profile/telegram/package.json` bundles: `["@deepseek-ai/dsh-base", "dsh-chat", "dsh-telegram", "dsh-web-search-searxng"]`; same for `profile/zalo/package.json` with `dsh-zalo`.

In `profile/telegram/cordis.patch.yml` and `profile/zalo/cordis.patch.yml`, read the file and delete `workspaceRoot`, `dataDir`, `model`, `provider`, `reasoningEffort`, `fileRetentionDays`, `chatLogMaxEntries` and `memory` wherever the bot row (`id: telegram` / `id: zalo`) restates them; if the profile overrides `model`, move that override to a `chat-sessions` row with the same value. Leave the persona untouched.

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 4: Dockerfiles**

Replace the builder stage of `docker/Dockerfile` with:

```dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /build
RUN corepack enable pnpm && corepack prepare pnpm@10.14.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/dsh-chat/package.json packages/dsh-chat/
COPY packages/dsh-telegram/package.json packages/dsh-telegram/
COPY packages/dsh-zalo/package.json packages/dsh-zalo/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
# Production copies without peers: dsh packages and dsh-chat resolve from the profile at runtime.
RUN pnpm --filter dsh-chat --filter dsh-telegram run build \
 && pnpm --filter dsh-chat deploy --legacy --prod --config.auto-install-peers=false /out/dsh-chat \
 && pnpm --filter dsh-telegram deploy --legacy --prod --config.auto-install-peers=false /out/dsh-telegram
```
and the copy lines of the runtime stage with:
```dockerfile
COPY --from=builder /out/dsh-chat /opt/dsh-telegram/profile/node_modules/dsh-chat
COPY --from=builder /out/dsh-telegram /opt/dsh-telegram/profile/node_modules/dsh-telegram
```
(Delete the three old `COPY --from=builder /build/...` lines.) Do the same in `docker/zalo.Dockerfile` with `dsh-zalo` and `/opt/dsh-zalo/...`.

- [ ] **Step 5: Verify the images**

Run: `docker build -f docker/Dockerfile -t dsh-telegram:plan1 . && docker run --rm --entrypoint sh dsh-telegram:plan1 -c "ls /opt/dsh-telegram/profile/node_modules/dsh-chat/lib/migrate /opt/dsh-telegram/profile/node_modules/dsh-telegram/lib && test ! -e /opt/dsh-telegram/profile/node_modules/dsh-telegram/node_modules/dsh-chat"`
Expected: both `lib` listings print; no nested `dsh-chat` under the adapter.

Run the same for `docker/zalo.Dockerfile` (`dsh-zalo:plan1`, `/opt/dsh-zalo/...`).

Then start each image against a copy of a real volume (or the legacy fixture layout from Task 7) with its usual env and `DSH_LOG_LEVEL=3`:
Expected log lines, in order: `dsh-chat: data layout migrated from the telegram layout` (zalo: `from the zalo layout`), then the adapter's `polling as ...`. Send one private message: the bot answers, and `/data/telegram/chatlog/<id>.jsonl` gains two lines with string ids.

If `pnpm deploy --legacy` is rejected by pnpm 10.14, use `pnpm --filter <pkg> deploy --prod ...` with `inject-workspace-packages=true` added to the root `.npmrc`, and rerun Step 5.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-telegram packages/dsh-zalo profile docker
git commit -m "build: insert the dsh-chat plugins in both bundles and ship dsh-chat as a sibling bundle"
```

---

## Out of this plan (next plans)

- Plan 2: `chat` router, `ChatChannel` / `TurnSink`, shared gate/queue/turn, adapters reduced to transport (spec rollout step 3).
- Plan 3: idle and schedule moved into `dsh-chat`, events renamed (step 4).
- Plan 4: sample two-channel profile (step 5 remainder).
