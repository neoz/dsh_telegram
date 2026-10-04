# dsh-telegram: idle engagement as its own plugin

Date: 2026-10-04
Status: approved design, pending implementation plan

## Goal

Move idle engagement (see `2026-10-02-telegram-idle-engagement-design.md`) out
of the `telegram` plugin into a separate Cordis plugin, `dsh-telegram/idle`, so
that:

1. Idle is configured and toggled on its own row (`telegram-idle`); changing it
   no longer means restating the whole `telegram` row.
2. The core bot knows nothing about idle. It exposes a `telegram` service and a
   `telegram/turn` event that idle, and later extension plugins, build on.

Idle behaviour does not change: `shouldEngage`, the prompt, output validation,
caps and log lines stay as they are.

## Decisions

| Topic | Decision |
|---|---|
| Packaging | Same npm package, new sub-export `dsh-telegram/idle`, like `dsh-telegram/logger`. No new package. |
| Coupling | The core provides a `telegram` service and emits `telegram/turn`; the idle plugin injects `telegram` and `llm`. |
| Lifecycle | The core provides `telegram` only once the bot is running and revokes it on stop. Cordis starts the idle plugin when both services are provided and disposes it on revoke. |
| Toggle | `enabled` stays a config field of the idle plugin, so `TELEGRAM_IDLE_ENABLED` keeps its meaning. The row's `disabled` is not used. |
| Environment | `TELEGRAM_IDLE_ENABLED` and `TELEGRAM_IDLE_CHATS` unchanged. |

## Service: `src/service.ts`

Types and module augmentation only:

```ts
export interface TelegramService {
  api: TelegramApi
  chatLog: ChatLog
  queue: { enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }
  bot: { id: number; username: string }
  selection: { provider: string; model: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context { telegram: TelegramService }
  interface Events { 'telegram/turn'(chatId: number): void }
}
```

`queue` is the dispatcher; `selection` is the bot's `provider` and `model`.

## Core: `src/index.ts`

- `start()` returns the service value (`{ api, chatLog, queue: dispatcher, bot, selection }`)
  in `Started.service`.
- Once `start()` has resolved and the plugin is not stopping, the bot runner
  effect calls `revoke = ctx.provide('telegram', started.service)`. A start
  that resolves after stop provides nothing.
- On stop the effect calls `revoke()` before polling stops, so dependants are
  disposed while the bot is still usable.
- The dispatcher's `noteTurn` is wired to `chatId => ctx.emit('telegram/turn', chatId)`.
  `src/bot.ts` does not change.
- Everything idle is removed: the `startIdle` import, `Started.idle`,
  `idle?.stop()`, and `'llm'` in `inject` (only idle used `ctx.llm`), along
  with the `@deepseek-ai/dsh-llm` type import if nothing else needs it.

## Idle plugin: `src/idle-plugin.ts`

```ts
export const name = 'dsh-telegram-idle'
export const inject = ['telegram', 'llm']
export interface IdleConfig { /* unchanged fields, moved from config.ts */ }
export const Config: z<IdleConfig>
export function apply(ctx: Context, config: IdleConfig): void
```

`apply`:

1. Rejects an invalid `timezone` (`Intl.DateTimeFormat`), with the existing
   message `dsh-telegram: idle.timezone must be an IANA time zone, got ...`.
2. Starts the scheduler with `startIdle({ config, provider, model, llm: ctx.llm, api, chatLog, queue, botId, botUsername, log })`,
   taking the values from `ctx.telegram`.
3. Subscribes `ctx.on('telegram/turn', handle.noteTurn)`.
4. Registers `handle.stop` through `ctx.effect`, so a bot reload or stop aborts
   pending idle tasks and clears the timer.

The logger is `ctx.logger('dsh-telegram')`, so log lines keep their
`dsh-telegram:` prefix. `src/idle.ts` (pure logic and `startIdle`) is unchanged.

## Configuration

`src/config.ts` drops the `idle` field from the core `Config` and the timezone
check from `assertConfig`. `IdleConfig`, `DEFAULT_IDLE` and the schema move to
`src/idle-plugin.ts` with the same fields and defaults; `src/idle.ts` imports
`IdleConfig` from there.

Bundle `packages/dsh-telegram/cordis.patch.yml`: the `idle` block leaves the
`telegram` row and a new row joins `insert`:

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

Profile `profile/telegram/cordis.patch.yml`: the `idle` block leaves the
`telegram` row; a `telegram-idle` patch row restates the block above with
`persona: *persona`. The comment that the alias only resolves inside this file
stays.

`packages/dsh-telegram/package.json` gains the export
`"./idle": { "types": "./lib/idle-plugin.d.ts", "default": "./lib/idle-plugin.js" }`.

Unchanged: `docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`,
`docker/Dockerfile`, `docker/entrypoint.sh`, `src/bot.ts`, `src/idle.ts` logic.

The earlier idle design gets a note at the top pointing to this spec for
wiring and configuration.

## Cordis behaviour this relies on

Checked with a probe against `@deepseek-ai/cordis` 4.0.4 while planning:

- `inject` waits for a name to be provided, not for a value: after
  `ctx.provide('telegram')` with no value, a dependant starts at once with
  `ctx.telegram === undefined`. So the core must not provide the name before
  the bot is running, and `ctx.set` is not used.
- `ctx.provide(name, value)` called asynchronously from inside an effect starts
  waiting dependants; calling the returned function disposes them.

`tests/idle-plugin.spec.ts` pins the second point.

## Testing (vitest)

- `tests/idle-plugin.spec.ts`, with a real Cordis `Context` and fake services:
  - providing `telegram` and `llm` starts the plugin (one `idle engagement on`
    log line when `enabled`);
  - `ctx.emit('telegram/turn', chatId)` records the turn (the next tick does
    not engage that chat);
  - revoking `telegram` stops the scheduler (timer cleared, pending task
    aborted);
  - an invalid `timezone` is rejected.
- `tests/config.spec.ts`: the four idle tests (defaults, partial overrides,
  chance above 1, unknown timezone) move to the idle plugin schema; the core
  `Config` no longer has `idle`.
- `tests/profile.spec.ts`: reads the `telegram-idle` row instead of
  `telegram.config.idle`; asserts the `telegram` row in both patches has no
  `idle`.
- `tests/idle.spec.ts`: only its `IdleConfig` import and the `base` config
  change to the idle plugin schema. `tests/bot.spec.ts`: unchanged.

## Out of scope

- Any change to idle behaviour.
- A separate npm package.
- Other extension plugins on top of the `telegram` service.
- A runtime switch such as `/idle on|off`.
