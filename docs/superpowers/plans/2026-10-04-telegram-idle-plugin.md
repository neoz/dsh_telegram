# Telegram Idle Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run idle engagement as its own Cordis plugin (`dsh-telegram/idle`, row `telegram-idle`) on top of a `telegram` service provided by the core bot.

**Architecture:** The core plugin provides a `telegram` service (api, chat log, per-chat queue, bot identity, model selection) only while the bot runs and emits `telegram/turn` when a message gets a turn. The idle plugin injects `telegram` and `llm`, starts the existing `startIdle` scheduler and stops it when Cordis disposes the plugin. Idle logic in `src/idle.ts` does not change.

**Tech Stack:** TypeScript (strict, `nodenext`), `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/schemastery`, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-04-telegram-idle-plugin-design.md`

## Global Constraints

- All commands run from `packages/dsh-telegram` (`pnpm test`, `pnpm run typecheck`, `pnpm run build`).
- Relative imports use the `.ts` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- Everything in the repo is English; no emoji literals (use `\u{...}` escapes).
- Idle behaviour, defaults and log line texts stay exactly as today.
- `TELEGRAM_IDLE_ENABLED` and `TELEGRAM_IDLE_CHATS` keep their meaning; compose files and `.env.example` do not change.
- Cordis: `inject` waits for a name to be provided, not for a value. Never call `ctx.provide('telegram')` before the bot runs, never use `ctx.set` for it.

## Review Focus

- Bot reload (telegram row config change): idle must stop with the old bot and start again on the new one. Pinned in Task 1 ("restarts after a revoke and a new provide").
- Telegram plugin failed to start or is missing: idle stays inert, no crash. Pinned in Task 1 ("stays inert without the telegram service").
- `enabled: false` with the service up: no timer. Pinned in Task 1 ("starts no timer when disabled").
- A deployment profile that still nests `idle` under the `telegram` row would silently lose idle. Pinned in Task 2 ("keeps idle off the telegram row").
- A core start that resolves after stop must not provide the service. `src/index.ts` has no unit tests (needs a live bot); the reviewer checks the `if (stopped)` branch in Task 1 Step 7 by reading.

---

### Task 1: Idle runs as its own plugin on the `telegram` service

**Files:**
- Create: `packages/dsh-telegram/src/service.ts`
- Create: `packages/dsh-telegram/src/idle-plugin.ts`
- Create: `packages/dsh-telegram/tests/idle-plugin.spec.ts`
- Modify: `packages/dsh-telegram/src/config.ts` (drop `IdleConfig`, `DEFAULT_IDLE`, `idle` field and schema, timezone check)
- Modify: `packages/dsh-telegram/src/idle.ts:3` (import `IdleConfig` from `./idle-plugin.ts`)
- Modify: `packages/dsh-telegram/src/index.ts` (provide service, emit event, drop idle)
- Modify: `packages/dsh-telegram/tests/config.spec.ts:73-103` (idle tests leave)
- Modify: `packages/dsh-telegram/tests/idle.spec.ts:7,14-15` (config import and `base`)

**Interfaces:**
- Consumes: `startIdle(deps: IdleDeps): IdleHandle` from `src/idle.ts` (unchanged); `Dispatcher` from `src/bot.ts`; `ChatLog` from `src/chatlog.ts`; `TelegramApi` from `src/telegram-api.ts`.
- Produces:
  - `src/service.ts`: `interface TelegramService { api; chatLog; queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>; bot: { id: number; username: string }; selection: { provider: string; model: string } }`, Cordis augmentation `Context.telegram: TelegramService` and event `'telegram/turn'(chatId: number): void`.
  - `src/idle-plugin.ts`: `interface IdleConfig` (fields unchanged), `const Config: z<IdleConfig>`, `assertIdleConfig(config: IdleConfig): void`, `name = 'dsh-telegram-idle'`, `inject = ['telegram', 'llm']`, `apply(ctx: Context, config: IdleConfig): void`.
  - `src/index.ts`: re-exports `type TelegramService`.

- [ ] **Step 1: Write the failing plugin test**

Create `packages/dsh-telegram/tests/idle-plugin.spec.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import * as idlePlugin from '../src/idle-plugin.ts'
import { assertIdleConfig, Config } from '../src/idle-plugin.ts'
import type { TelegramService } from '../src/service.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

describe('idle Config', () => {
  it('fills idle defaults with idle disabled', () => {
    expect(Config({})).toEqual({
      enabled: false,
      chatIds: [],
      idleMinutes: 60,
      minNewMessages: 5,
      chance: 0.3,
      checkIntervalMinutes: 10,
      maxPerDay: 5,
      quietHours: { from: 23, to: 7 },
      timezone: 'Asia/Ho_Chi_Minh',
      contextMessages: 20,
      persona: '',
    })
  })

  it('accepts partial idle overrides', () => {
    const idle = Config({ enabled: true, chatIds: [-1001234567890], quietHours: { from: 0 } })
    expect(idle.enabled).toBe(true)
    expect(idle.chatIds).toEqual([-1001234567890])
    expect(idle.quietHours).toEqual({ from: 0, to: 7 })
    expect(idle.chance).toBe(0.3)
  })

  it('rejects an idle chance above 1', () => {
    expect(() => Config({ chance: 1.5 })).toThrow()
  })

  it('rejects an unknown idle timezone', () => {
    expect(() => assertIdleConfig(Config({ timezone: 'Mars/Olympus' }))).toThrow(/idle.timezone/)
  })
})

describe('idle plugin', () => {
  const A = -5
  const B = -6
  /** Engages on every tick once a chat has a fresh human message: no quiet hours, chance 1. */
  const config = Config({
    enabled: true, chatIds: [A, B], idleMinutes: 1, minNewMessages: 1, chance: 1,
    checkIntervalMinutes: 1, quietHours: { from: 0, to: 0 },
  })
  let dir: string
  let chatLog: ChatLog
  let queued: Array<{ chatId: number; task: () => Promise<void> }>
  let calls: GenerateOptions[]
  let root: Context
  let baseline: number

  function service(): TelegramService {
    return {
      api: new FakeTelegramApi(),
      chatLog,
      queue: { enqueue: (chatId, task) => { queued.push({ chatId, task }) }, isBusy: () => false },
      bot: { id: 1, username: 'dshbot' },
      selection: { provider: 'p', model: 'm' },
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    dir = await mkdtemp(join(tmpdir(), 'idle-plugin-'))
    chatLog = new ChatLog(join(dir, 'log'))
    const ts = new Date(Date.now() - 30_000).toISOString()
    for (const [chatId, id] of [[A, 10], [B, 20]] as const) {
      await chatLog.append(chatId, { ts, message_id: id, user_id: 7, username: 'ann', name: 'Ann', text: 'hi' })
    }
    queued = []
    calls = []
    root = new Context()
    root.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        yield { type: 'text-delta', index: 0, text: '{"action":"skip"}' }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    })
    baseline = vi.getTimerCount()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('stays inert without the telegram service', async () => {
    root.plugin(idlePlugin, config)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('starts no timer when disabled', async () => {
    root.plugin(idlePlugin, { ...config, enabled: false })
    root.provide('telegram', service())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('starts the scheduler once telegram is provided and skips a chat that just had a turn', async () => {
    root.plugin(idlePlugin, config)
    root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    root.emit('telegram/turn', A)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(queued.map(q => q.chatId)).toContain(B))
    expect(queued.map(q => q.chatId)).toEqual([B])
  })

  it('stops on revoke, so a task queued before it never calls the model', async () => {
    root.plugin(idlePlugin, config)
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(queued).toHaveLength(2))
    revoke()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline))
    for (const { task } of queued) await task()
    expect(calls).toHaveLength(0)
  })

  it('restarts after a revoke and a new provide', async () => {
    root.plugin(idlePlugin, config)
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    revoke()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline))
    root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/idle-plugin.spec.ts`
Expected: FAIL, cannot resolve `../src/idle-plugin.ts`.

- [ ] **Step 3: Create the service types**

Create `packages/dsh-telegram/src/service.ts`:

```ts
import type { Dispatcher } from './bot.ts'
import type { ChatLog } from './chatlog.ts'
import type { TelegramApi } from './telegram-api.ts'

/** The running bot, shared with extension plugins such as `dsh-telegram/idle`; provided only while the bot polls. */
export interface TelegramService {
  readonly api: TelegramApi
  readonly chatLog: ChatLog
  /** Per-chat queue shared with message handling; tasks of one chat never overlap. */
  readonly queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>
  readonly bot: { readonly id: number; readonly username: string }
  readonly selection: { readonly provider: string; readonly model: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    telegram: TelegramService
  }
  interface Events {
    /** A message in this chat passed the gate and is about to get a turn. */
    'telegram/turn'(chatId: number): void
  }
}
```

- [ ] **Step 4: Create the idle plugin with the moved config**

Create `packages/dsh-telegram/src/idle-plugin.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { startIdle } from './idle.ts'
import type {} from './service.ts'

/** Unprompted engagement in active groups; see the idle engagement spec. */
export interface IdleConfig {
  readonly enabled: boolean
  readonly chatIds: number[]
  readonly idleMinutes: number
  readonly minNewMessages: number
  readonly chance: number
  readonly checkIntervalMinutes: number
  readonly maxPerDay: number
  readonly quietHours: { readonly from: number; readonly to: number }
  readonly timezone: string
  readonly contextMessages: number
  readonly persona: string
}

const DEFAULT_IDLE: IdleConfig = {
  enabled: false,
  chatIds: [],
  idleMinutes: 60,
  minNewMessages: 5,
  chance: 0.3,
  checkIntervalMinutes: 10,
  maxPerDay: 5,
  quietHours: { from: 23, to: 7 },
  timezone: 'Asia/Ho_Chi_Minh',
  contextMessages: 20,
  persona: '',
}

export const Config: z<IdleConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_IDLE.enabled),
  chatIds: z.array(z.number()).default([]),
  idleMinutes: z.number().min(1).default(DEFAULT_IDLE.idleMinutes),
  minNewMessages: z.number().min(1).default(DEFAULT_IDLE.minNewMessages),
  chance: z.number().min(0).max(1).default(DEFAULT_IDLE.chance),
  checkIntervalMinutes: z.number().min(1).default(DEFAULT_IDLE.checkIntervalMinutes),
  maxPerDay: z.number().min(1).default(DEFAULT_IDLE.maxPerDay),
  quietHours: z.object({
    from: z.number().min(0).max(23).default(DEFAULT_IDLE.quietHours.from),
    to: z.number().min(0).max(23).default(DEFAULT_IDLE.quietHours.to),
  }).default(DEFAULT_IDLE.quietHours),
  timezone: z.string().default(DEFAULT_IDLE.timezone),
  contextMessages: z.number().min(1).default(DEFAULT_IDLE.contextMessages),
  persona: z.string().default(DEFAULT_IDLE.persona),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertIdleConfig(config: IdleConfig): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone })
  } catch {
    throw new Error(`dsh-telegram: idle.timezone must be an IANA time zone, got ${config.timezone}`)
  }
}

/** Cordis plugin name. */
export const name = 'dsh-telegram-idle'
/** Started by Cordis once the bot provides `telegram`, and disposed when it revokes it. */
export const inject = ['telegram', 'llm']

export function apply(ctx: Context, config: IdleConfig): void {
  assertIdleConfig(config)
  const logger = ctx.logger('dsh-telegram')
  const { api, chatLog, queue, bot, selection } = ctx.telegram
  const handle = startIdle({
    config,
    provider: selection.provider,
    model: selection.model,
    llm: ctx.llm,
    api,
    chatLog,
    queue,
    botId: bot.id,
    botUsername: bot.username,
    log: { info: msg => logger.info(msg), warn: msg => logger.warn(msg) },
  })
  ctx.on('telegram/turn', chatId => handle.noteTurn(chatId))
  ctx.effect(() => () => handle.stop(), 'dsh-telegram: idle scheduler')
}
```

- [ ] **Step 5: Point `idle.ts` at the moved type**

In `packages/dsh-telegram/src/idle.ts` line 3, replace:

```ts
import type { IdleConfig } from './config.ts'
```

with:

```ts
import type { IdleConfig } from './idle-plugin.ts'
```

- [ ] **Step 6: Remove idle from the core config**

In `packages/dsh-telegram/src/config.ts`:
- Delete the `IdleConfig` interface and its doc comment (lines 23-36).
- Delete from `interface Config` the two lines:
  ```ts
    /** Unprompted reactions and replies in active groups. */
    readonly idle: IdleConfig
  ```
- Delete the `DEFAULT_IDLE` constant.
- Delete the `idle: z.object({ ... }).default(DEFAULT_IDLE),` entry from the `Config` schema.
- In `assertConfig`, delete the `try { new Intl.DateTimeFormat(...) } catch { throw ... idle.timezone ... }` block.

- [ ] **Step 7: Provide the service from the core and drop idle**

In `packages/dsh-telegram/src/index.ts`:

Imports — delete these lines:
```ts
import type {} from '@deepseek-ai/dsh-llm'
import { startIdle, type IdleHandle } from './idle.ts'
```
and add, next to the other local type imports:
```ts
import type { TelegramService } from './service.ts'
```

Exports — after `export type { Config as TelegramConfig } from './config.ts'` add:
```ts
export type { TelegramService } from './service.ts'
```

Replace:
```ts
export const inject = ['agents', 'tools', 'attachments', 'loader', 'llm']

interface Started { polling: Polling; agents: ChatAgents; idle: IdleHandle | undefined }
```
with:
```ts
export const inject = ['agents', 'tools', 'attachments', 'loader']

interface Started { polling: Polling; agents: ChatAgents; service: TelegramService }
```

In `start()`, delete `let idle: IdleHandle | undefined`, and in the `createDispatcher({ ... })` call replace:
```ts
    noteTurn: chatId => idle?.noteTurn(chatId),
```
with:
```ts
    noteTurn: chatId => ctx.emit('telegram/turn', chatId),
```

Replace the tail of `start()` from `idle = startIdle({` through `return { polling, agents, idle }` with:
```ts
  return {
    polling,
    agents,
    service: {
      api,
      chatLog,
      queue: dispatcher,
      bot: { id: bot.botInfo.id, username: bot.botInfo.username },
      selection: { provider: config.provider, model: config.model },
    },
  }
```

Replace the bot runner part of `apply` (from `let started: Started | undefined` to the end of that `ctx.effect`) with:
```ts
  let started: Started | undefined
  let revoke: (() => void) | undefined
  let stopped = false
  ctx.effect(() => {
    void start(ctx, config).then((result) => {
      if (stopped) {
        void result.polling.stop().then(() => result.agents.disposeAll())
        return
      }
      started = result
      // Provided only now: Cordis starts dependants as soon as a name is provided, with or without a value.
      revoke = ctx.provide('telegram', result.service)
    }).catch((error: unknown) => {
      log.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
    return () => {
      stopped = true
      if (started === undefined) return
      const { polling, agents } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls.
      revoke?.()
      revoke = undefined
      void polling.stop().then(() => agents.disposeAll())
    }
  }, 'dsh-telegram: bot runner')
```

- [ ] **Step 8: Move the idle config tests out of `config.spec.ts`**

In `packages/dsh-telegram/tests/config.spec.ts`, delete the four tests `'fills idle defaults with idle disabled'`, `'accepts partial idle overrides'`, `'rejects an idle chance above 1'`, `'rejects an unknown idle timezone'` (they now live in `idle-plugin.spec.ts`). In the `'fills defaults'` test, after the `memory` assertion add:

```ts
    expect(config).not.toHaveProperty('idle')
```

- [ ] **Step 9: Point `idle.spec.ts` at the idle plugin schema**

In `packages/dsh-telegram/tests/idle.spec.ts` replace:

```ts
import { Config, type IdleConfig } from '../src/config.ts'
```
with:
```ts
import { Config, type IdleConfig } from '../src/idle-plugin.ts'
```

and replace:
```ts
const minimal = { botToken: 't', allowFrom: ['ann'], workspaceRoot: '/ws', dataDir: '/data', model: 'm' }
const base: IdleConfig = Config({ ...minimal, idle: { enabled: true, chatIds: [-5] } }).idle
```
with:
```ts
const base: IdleConfig = Config({ enabled: true, chatIds: [-5] })
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `pnpm test && pnpm run typecheck`
Expected: all tests PASS (including the 9 in `idle-plugin.spec.ts`), typecheck exits 0.

- [ ] **Step 11: Commit**

```bash
git add packages/dsh-telegram/src/service.ts packages/dsh-telegram/src/idle-plugin.ts packages/dsh-telegram/src/idle.ts packages/dsh-telegram/src/config.ts packages/dsh-telegram/src/index.ts packages/dsh-telegram/tests/idle-plugin.spec.ts packages/dsh-telegram/tests/config.spec.ts packages/dsh-telegram/tests/idle.spec.ts
git commit -m "refactor(telegram): run idle engagement as its own plugin on a telegram service"
```

---

### Task 2: Mount the idle plugin from the bundle and profile

**Files:**
- Modify: `packages/dsh-telegram/cordis.patch.yml` (telegram row loses `idle`; new `telegram-idle` row)
- Modify: `profile/telegram/cordis.patch.yml` (telegram row loses `idle`; new `telegram-idle` patch row)
- Modify: `packages/dsh-telegram/package.json` (`exports["./idle"]`)
- Modify: `packages/dsh-telegram/tests/profile.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-02-telegram-idle-engagement-design.md:4` (pointer note)

**Interfaces:**
- Consumes: plugin module `src/idle-plugin.ts` from Task 1, built to `lib/idle-plugin.js`; its config fields are the `IdleConfig` fields.
- Produces: row id `telegram-idle`, plugin name `dsh-telegram/idle`.

- [ ] **Step 1: Write the failing profile tests**

Replace the helper `telegramIdle` in `packages/dsh-telegram/tests/profile.spec.ts`:

```ts
/** The bundle declares the telegram row under `insert`; the profile restates it at the top level. */
function telegramIdle(list: Row[]): Record<string, any> {
  const row = list.find(r => r.id === 'telegram') ?? list.flatMap(r => r.insert ?? []).find(r => r.id === 'telegram')
  return row!.config!.idle
}
```

with:

```ts
/** The bundle declares its rows under `insert`; the profile restates them at the top level. */
function row(list: Row[], id: string): Row {
  return (list.find(r => r.id === id) ?? list.flatMap(r => r.insert ?? []).find(r => r.id === id))!
}
function telegramIdle(list: Row[]): Record<string, any> {
  return row(list, 'telegram-idle').config!
}
```

and replace `interface Row` with:

```ts
interface Row { id?: string; name?: string; config?: Record<string, any>; insert?: Row[] }
```

Add this test at the end of the `describe('profile patch', ...)` block:

```ts
  it('keeps idle off the telegram row and mounts the idle plugin', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      expect(row(await rows(path), 'telegram').config).not.toHaveProperty('idle')
    }
    expect(row(await rows('../cordis.patch.yml'), 'telegram-idle').name).toBe('dsh-telegram/idle')
  })
```

The three existing tests keep their bodies; they now read the `telegram-idle` row through `telegramIdle`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/profile.spec.ts`
Expected: FAIL, `Cannot read properties of undefined (reading 'config')` (no `telegram-idle` row yet).

- [ ] **Step 3: Move the idle block in the bundle patch**

In `packages/dsh-telegram/cordis.patch.yml`, delete the `idle:` block (6 lines) from the `telegram` row and append to `insert:`, after the `telegram` row and at the same indentation:

```yaml
    - id: telegram-idle
      name: dsh-telegram/idle
      config:
        enabled: !!js process.env.TELEGRAM_IDLE_ENABLED === 'true'
        chatIds: !!js (process.env.TELEGRAM_IDLE_CHATS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n !== 0)
        idleMinutes: 10
        minNewMessages: 5
        chance: 0.5
```

Also change the file's first comment line to:

```yaml
# dsh-telegram bundle layer: console logging, persona for a chat assistant, the bot row and idle engagement.
```

- [ ] **Step 4: Move the idle block in the deployment profile**

In `profile/telegram/cordis.patch.yml`:
- Change the anchor comment above `personaPrefix: &persona >-` to:
  ```yaml
      # Anchored so the telegram-idle row's persona reuses it; the alias only resolves inside this file.
  ```
- Delete the `idle:` block (7 lines, including `persona: *persona`) from the `telegram` row.
- Append at the end of the file:

```yaml

# Patches replace a row's config wholesale, so the bundle's telegram-idle row is restated here with the persona.
- id: telegram-idle
  config:
    enabled: !!js process.env.TELEGRAM_IDLE_ENABLED === 'true'
    chatIds: !!js (process.env.TELEGRAM_IDLE_CHATS ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n !== 0)
    idleMinutes: 10
    minNewMessages: 5
    chance: 0.5
    persona: *persona
```

- [ ] **Step 5: Run the profile tests**

Run: `pnpm vitest run tests/profile.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Export the plugin entry**

In `packages/dsh-telegram/package.json`, inside `"exports"`, after the `"./logger"` entry add:

```json
    "./idle": {
      "types": "./lib/idle-plugin.d.ts",
      "default": "./lib/idle-plugin.js"
    },
```

- [ ] **Step 7: Point the earlier idle design at the new spec**

In `docs/superpowers/specs/2026-10-02-telegram-idle-engagement-design.md`, after line 4 (`Status: ...`) insert:

```markdown

Wiring and configuration have since moved to the `dsh-telegram/idle` plugin;
see `2026-10-04-telegram-idle-plugin-design.md`.
```

- [ ] **Step 8: Full verification**

Run: `pnpm test && pnpm run typecheck && pnpm run build && ls lib/idle-plugin.js lib/service.js`
Expected: all tests PASS, typecheck and build exit 0, both files listed.

- [ ] **Step 9: Commit**

```bash
git add packages/dsh-telegram/cordis.patch.yml profile/telegram/cordis.patch.yml packages/dsh-telegram/package.json packages/dsh-telegram/tests/profile.spec.ts docs/superpowers/specs/2026-10-02-telegram-idle-engagement-design.md
git commit -m "feat(telegram): mount idle engagement as the telegram-idle row"
```
