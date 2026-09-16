# dsh-telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Telegram bot that drives a DeepSeek Harness agent per chat, running as one Docker Compose service, with einoclaw-style reply UX (placeholder edits, collapsed long replies, `.md` attachment, reply quoting, inbound media, `/reset`, `/stop`).

**Architecture:** `dsh-telegram` is an out-of-tree Cordis plugin bundle loaded by a custom `dsh` profile (`dsh --profile telegram`). It owns a grammY long-polling bot, maps each `chat_id` to a persisted dsh session (create/resume through `ctx.agents`), observes session events to update a Telegram placeholder, and renders the final assistant message with rules ported from einoclaw's Go channel. Telegram I/O goes through a narrow `TelegramApi` interface so every module is unit-tested with fakes.

**Tech Stack:** TypeScript 6 (ESM, NodeNext), `@deepseek-ai/dsh@0.1.5-rc.1` packages (`dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-tools`, `dsh-attachment`, `dsh-brand`, `schemastery`), grammY 1.46 + `@grammyjs/auto-retry` + `@grammyjs/runner`, vitest 4, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-16-dsh-telegram-design.md`

## Global Constraints

- dsh version is pinned to `0.1.5-rc.1` everywhere (`peerDependencies`, `devDependencies`, Dockerfile `ARG DSH_VERSION`).
- Everything in the repo is English: code, comments, file names, commit messages. No emoji in string literals except the single acknowledgement reaction, which is declared once as `ACK_REACTION` in `src/bot.ts` (Telegram requires a real emoji there).
- Lengths for Telegram limits are measured in UTF-8 bytes (`Buffer.byteLength`), matching einoclaw: `messageSize` 1000..3400 default 1024, collapse threshold `messageSize * 1.2`, message ceiling 4096, caption ceiling 1024.
- No hardcoded tunables in the plugin: anything a deployment may change is a `Config` field with a Schemastery default.
- All dsh packages that carry a `Context` merge or a service (`@deepseek-ai/cordis`, `dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-tools`, `dsh-attachment`, `cordis-plugin-loader`) are `peerDependencies`; only `grammy`, `@grammyjs/*`, `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-brand` are `dependencies`.
- Tests never touch the network or need `DEEPSEEK_API_KEY`/`TELEGRAM_BOT_TOKEN`.
- The dsh API facts below were verified against the `dsh-v0.1.5-rc.1` tag of `D:\working\nodejs\deepseek-harness`:
  - `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model, reasoningEffort? }, setup })` and `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` return `AgentHandle { agent, dispose() }`; `ctx.agents.get(id)` returns a live `Agent | undefined`.
  - `Agent` has `id`, `session`, `status: 'idle' | 'running'`, `ctx`, `followup(message)`, `cancel(cause, options?)`, `whenIdle()`. `session.seq` is the next seq, `session.eventAt(SessionSeq(n))` reads one event, `session.header.cwd` is the persisted cwd.
  - Session events used: `'turn/start'`, `'turn/end' { reason }`, `'tool/call' { name, arguments }`, `'assistant/message' { message: { content: ContentBlock[] } }`. Subscribe on the plugin ctx with `ctx.on('session/event', (session, event) => ...)` and `ctx.on('agent/status', ({ agent, status }) => ...)`.
  - `createUserMessage({ content, source: { kind: 'user' } })` from `@deepseek-ai/dsh-llm`; `installModelSelection(agentCtx, { current, assembled: undefined })` from `@deepseek-ai/dsh-agent`; `brandString<SessionId>(...)` from `@deepseek-ai/dsh-brand`; `SessionSeq(n)` from `@deepseek-ai/dsh-session`.
  - Images: `ctx.attachments.saveImages([{ data: base64, mediaType: 'image/jpeg', name? }])` returns `ImageAttachmentRef[]`; a user content block is `{ type: 'image', attachment: ref }`.
  - Tools: `defineTool({ name, description, parameters, output: { schema, render }, execute(args, exec) })` from `@deepseek-ai/dsh-tools`; `agentCtx.tools.register(tool)` returns a disposer and scopes the tool to that agent.
  - Approval is disabled by `DSH_PERMISSION_MODE=danger-full-access`; the base bundle stores sessions under `$DSH_HOME/sessions`.

## File structure

```
packages/dsh-telegram/
  package.json                 bundle manifest (dsh.bundle.patch), deps, scripts
  tsconfig.json                NodeNext ESM, strict, rewriteRelativeImportExtensions
  vitest.config.ts
  cordis.patch.yml             bundle layer: persona override + insert row `telegram`
  src/config.ts                Config interface + Schemastery schema
  src/index.ts                 plugin entry: name/inject/Config/apply; wires modules
  src/telegram-api.ts          TelegramApi interface + grammY adapter + TelegramApiError
  src/render.ts                pure text functions ported from einoclaw
  src/chatlog.ts               ChatLog: per-chat JSONL append/read/recent
  src/session-map.ts           SessionMap: chat_id -> { sessionId, lastTurnMessageId } JSON file
  src/sessions.ts              ChatAgents: resolve (get/resume/create), reset, stop
  src/media.ts                 sanitizeFilename, resolveInsideWorkspace, outbound kind, downloadToFile
  src/inbound.ts               parseInbound: Telegram message -> InboundMessage
  src/turn.ts                  runTurn: placeholder -> status -> deliver
  src/tools.ts                 telegram_send_file, telegram_chat_history
  src/bot.ts                   grammY wiring: gating, commands, dispatch, runner
  tests/helpers/fake-api.ts    FakeTelegramApi recorder
  tests/*.spec.ts
profile/telegram/package.json  profile manifest
profile/telegram/cordis.patch.yml
docker/Dockerfile
docker/entrypoint.sh
docker-compose.yml
.env.example
README.md
```

---

### Task 1: Package scaffold and Config schema

**Files:**
- Create: `packages/dsh-telegram/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config.ts`, `src/index.ts`
- Test: `packages/dsh-telegram/tests/config.spec.ts`

**Interfaces:**
- Produces: `Config` (interface + schema) in `src/config.ts`; every later task imports `type Config` from it.

- [ ] **Step 1: Create the package manifest and tooling**

`packages/dsh-telegram/package.json`:

```json
{
  "name": "dsh-telegram",
  "version": "0.1.0",
  "description": "Telegram channel bundle for DeepSeek Harness",
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
    "@deepseek-ai/dsh-brand": "0.1.5-rc.1",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@grammyjs/auto-retry": "^2.0.2",
    "@grammyjs/runner": "^2.0.3",
    "grammy": "^1.46.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/cordis-plugin-loader": "^1.0.3",
    "@deepseek-ai/dsh-agent": "0.1.5-rc.1",
    "@deepseek-ai/dsh-attachment": "0.1.5-rc.1",
    "@deepseek-ai/dsh-llm": "0.1.5-rc.1",
    "@deepseek-ai/dsh-session": "0.1.5-rc.1",
    "@deepseek-ai/dsh-tools": "0.1.5-rc.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/cordis-plugin-loader": "^1.0.3",
    "@deepseek-ai/dsh-agent": "0.1.5-rc.1",
    "@deepseek-ai/dsh-attachment": "0.1.5-rc.1",
    "@deepseek-ai/dsh-llm": "0.1.5-rc.1",
    "@deepseek-ai/dsh-session": "0.1.5-rc.1",
    "@deepseek-ai/dsh-tools": "0.1.5-rc.1",
    "@types/node": "^22.20.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  },
  "engines": { "node": ">=22.19" }
}
```

`packages/dsh-telegram/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2024"],
    "types": ["node"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "lib",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/dsh-telegram/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
```

`packages/dsh-telegram/.gitignore`:

```
node_modules/
lib/
```

- [ ] **Step 2: Write the failing config test**

`packages/dsh-telegram/tests/config.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

const minimal = {
  botToken: '123:abc',
  allowFrom: ['42'],
  workspaceRoot: '/workspace',
  dataDir: '/data',
  model: 'deepseek-v4-flash',
}

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(minimal)
    expect(config.provider).toBe('deepseek-official')
    expect(config.messageSize).toBe(1024)
    expect(config.recentMessagesLimit).toBe(30)
    expect(config.statusEditIntervalMs).toBe(1000)
    expect(config.turnTimeoutMs).toBe(900_000)
    expect(config.retry).toEqual({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000, maxUploadMb: 20 })
  })

  it('rejects a missing bot token', () => {
    expect(() => Config({ ...minimal, botToken: undefined })).toThrow()
  })

  it('rejects an empty allow list', () => {
    expect(() => Config({ ...minimal, allowFrom: [] })).toThrow()
  })

  it('clamps messageSize to its range', () => {
    expect(() => Config({ ...minimal, messageSize: 500 })).toThrow()
    expect(() => Config({ ...minimal, messageSize: 5000 })).toThrow()
  })
})
```

- [ ] **Step 3: Install and run the test to verify it fails**

Run (from `packages/dsh-telegram`): `npm install && npx vitest run tests/config.spec.ts`
Expected: FAIL — cannot find module `../src/config.ts`.

- [ ] **Step 4: Write `src/config.ts`**

```ts
import z from '@deepseek-ai/schemastery'

/** Bot API retry and upload limits. */
export interface RetryConfig {
  readonly maxAttempts: number
  readonly startDelayMs: number
  readonly maxDelayMs: number
  readonly maxUploadMb: number
}

/** Plugin configuration; see the design spec for field semantics. */
export interface Config {
  readonly botToken: string
  readonly allowFrom: readonly string[]
  readonly workspaceRoot: string
  readonly dataDir: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly messageSize: number
  readonly recentMessagesLimit: number
  readonly statusEditIntervalMs: number
  readonly turnTimeoutMs: number
  readonly retry: RetryConfig
}

export const Config: z<Config> = z.object({
  botToken: z.string().required(),
  allowFrom: z.array(z.string()).required(),
  workspaceRoot: z.string().required(),
  dataDir: z.string().required(),
  provider: z.string().default('deepseek-official'),
  model: z.string().required(),
  reasoningEffort: z.string(),
  messageSize: z.number().min(1000).max(3400).default(1024),
  recentMessagesLimit: z.number().min(0).default(30),
  statusEditIntervalMs: z.number().min(0).default(1000),
  turnTimeoutMs: z.number().min(1).default(900_000),
  retry: z.object({
    maxAttempts: z.number().min(1).default(4),
    startDelayMs: z.number().min(0).default(500),
    maxDelayMs: z.number().min(0).default(8000),
    maxUploadMb: z.number().min(1).default(20),
  }).default({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000, maxUploadMb: 20 }),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertConfig(config: Config): void {
  if (config.allowFrom.length === 0) throw new Error('dsh-telegram: allowFrom must list at least one user id or username')
  for (const key of ['workspaceRoot', 'dataDir'] as const) {
    if (!config[key].startsWith('/') && !/^[A-Za-z]:[\\/]/.test(config[key])) {
      throw new Error(`dsh-telegram: ${key} must be an absolute path`)
    }
  }
}
```

Note: if Schemastery's `z.array(...).required()` accepts `[]`, the empty-list test is satisfied by `assertConfig`; update the test to call `assertConfig(Config({...}))` for that case.

- [ ] **Step 5: Write the minimal `src/index.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { assertConfig, Config } from './config.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** Services required before the bot starts. */
export const inject = ['agents', 'tools', 'attachments', 'loader']

export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  ctx.logger.info('dsh-telegram loaded')
}
```

- [ ] **Step 6: Run tests, typecheck, build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS; `lib/index.js` exists.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-telegram
git commit -m "feat(telegram): scaffold plugin package with Config schema"
```

---

### Task 2: Profile, Docker image, and boot smoke test

This task validates the deployment layout before any real code: the stub plugin must load inside `dsh --profile telegram` in the container and resolve a dsh peer import.

**Files:**
- Create: `packages/dsh-telegram/cordis.patch.yml`, `profile/telegram/package.json`, `profile/telegram/cordis.patch.yml`, `docker/Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`, `.env.example`, `.dockerignore`, `.gitignore`
- Modify: `packages/dsh-telegram/src/index.ts` (add one peer value import for the smoke)

- [ ] **Step 1: Bundle patch**

`packages/dsh-telegram/cordis.patch.yml`:

```yaml
# dsh-telegram bundle layer: persona for a chat assistant and the bot row.
- id: system-prompt
  config:
    personaPrefix: >-
      You are a helpful assistant reachable through Telegram, powered by the {{model}} model.
    personaSuffix: >-
      Your working directory is {{cwd}}. Replies are rendered by Telegram; prefer concise markdown.
      Files you want the user to receive must be sent with the telegram_send_file tool.

- id: session-title-llm
  disabled: true

- insert:
    - id: telegram
      name: dsh-telegram
      config:
        botToken: !!js process.env.TELEGRAM_BOT_TOKEN
        allowFrom: !!js (process.env.TELEGRAM_ALLOW_FROM ?? '').split(',').map(s => s.trim()).filter(Boolean)
        workspaceRoot: !!js process.env.DSH_TELEGRAM_WORKSPACE ?? '/workspace'
        dataDir: !!js process.env.DSH_TELEGRAM_DATA ?? '/data'
        model: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
```

- [ ] **Step 2: Profile manifest**

`profile/telegram/package.json`:

```json
{
  "name": "dsh-profile-telegram",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-telegram"],
      "patchReload": "startup"
    }
  }
}
```

`profile/telegram/cordis.patch.yml`:

```yaml
# Deployment overrides go here; the dsh-telegram bundle carries the defaults.
[]
```

- [ ] **Step 3: Dockerfile and entrypoint**

`docker/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY packages/dsh-telegram/package.json packages/dsh-telegram/package-lock.json ./
RUN npm ci
COPY packages/dsh-telegram/ ./
RUN npm run build \
 && rm -rf node_modules \
 && npm install --omit=dev --omit=peer --ignore-scripts

FROM node:22-bookworm-slim
ARG DSH_VERSION=0.1.5-rc.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @deepseek-ai/dsh@${DSH_VERSION}
ENV DSH_HOME=/dsh-home
# The profile template lives outside the volume so image rebuilds refresh it.
COPY profile/telegram/ /opt/dsh-telegram/profile/
COPY --from=builder /build/package.json /build/cordis.patch.yml /opt/dsh-telegram/profile/node_modules/dsh-telegram/
COPY --from=builder /build/lib /opt/dsh-telegram/profile/node_modules/dsh-telegram/lib
COPY --from=builder /build/node_modules /opt/dsh-telegram/profile/node_modules/dsh-telegram/node_modules
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /dsh-home /workspace /data \
 && chown -R node:node /dsh-home /workspace /data /opt/dsh-telegram
USER node
WORKDIR /workspace
ENTRYPOINT ["entrypoint.sh"]
CMD ["dsh", "--profile", "telegram"]
```

`docker/entrypoint.sh`:

```sh
#!/bin/sh
# Refresh the profile from the image on every start; sessions stay in the volume.
set -eu
mkdir -p "$DSH_HOME/profiles"
rm -rf "$DSH_HOME/profiles/telegram"
cp -R /opt/dsh-telegram/profile "$DSH_HOME/profiles/telegram"
exec "$@"
```

`.dockerignore`:

```
**/node_modules
**/lib
workspace
data
.env
docs
```

`.gitignore` (repo root):

```
node_modules/
lib/
.env
workspace/
data/
```

- [ ] **Step 4: Compose and env example**

`docker-compose.yml`:

```yaml
services:
  dsh-telegram:
    build:
      context: .
      dockerfile: docker/Dockerfile
    env_file: .env
    environment:
      DSH_PERMISSION_MODE: danger-full-access
    volumes:
      - ./workspace:/workspace
      - ./data:/data
      - dsh-home:/dsh-home
    restart: unless-stopped

volumes:
  dsh-home:
```

`.env.example`:

```
DEEPSEEK_API_KEY=
TELEGRAM_BOT_TOKEN=
# Comma-separated Telegram user ids or usernames allowed to talk to the agent.
TELEGRAM_ALLOW_FROM=
DSH_MODEL=deepseek-v4-flash
```

- [ ] **Step 5: Add a peer value import to the stub so the smoke proves module resolution**

In `packages/dsh-telegram/src/index.ts` replace the `apply` body:

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// ...
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const probe = createUserMessage({ content: [{ type: 'text', text: 'probe' }], source: { kind: 'user' } })
  ctx.logger.info(`dsh-telegram loaded (allowFrom=${config.allowFrom.length}, probe=${probe.role})`)
}
```

- [ ] **Step 6: Build and boot the smoke**

Run (repo root): `cp .env.example .env`, fill `DEEPSEEK_API_KEY` and `TELEGRAM_BOT_TOKEN` with real values and `TELEGRAM_ALLOW_FROM` with your user id, then:

```
cd packages/dsh-telegram && npm install && cd ../..   # produces package-lock.json
docker compose build
docker compose run --rm dsh-telegram dsh --profile telegram --dump-config | grep -A3 'id: telegram'
docker compose up
```

Expected: the dump shows the inserted `telegram` row from layer `dsh-telegram`; `up` logs `dsh-telegram loaded (allowFrom=1, probe=user)` and the process stays running.

If the boot fails with `Cannot find package '@deepseek-ai/dsh-llm'`, the installation fallback `$DSH_HOME/profiles/node_modules` is not reachable from the plugin path. Fallback: add `RUN corepack enable pnpm` to the runtime stage, replace the three `COPY --from=builder` lines by `COPY --from=builder /build/dsh-telegram-0.1.0.tgz /opt/dsh-telegram/` (after `npm pack` in the builder), and in `entrypoint.sh` run `dsh plugin --profile telegram add /opt/dsh-telegram/dsh-telegram-0.1.0.tgz` before `exec`. Record which path worked in the README.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-telegram/cordis.patch.yml packages/dsh-telegram/package-lock.json packages/dsh-telegram/src/index.ts profile docker docker-compose.yml .env.example .dockerignore .gitignore
git commit -m "feat(telegram): profile bundle, Docker image and compose service"
```

---

### Task 3: Rendering functions ported from einoclaw

**Files:**
- Create: `packages/dsh-telegram/src/render.ts`
- Test: `packages/dsh-telegram/tests/render.spec.ts`

**Interfaces:**
- Produces:
  - `byteLength(text: string): number`
  - `escapeHTML(text: string): string`
  - `markdownToTelegramHTML(markdown: string): string`
  - `repairHTMLTags(html: string): string`
  - `cleanCut(text: string, budgetBytes: number): number` — returns a **string index**
  - `renderMessage(html: string, openBytes: number): string`
  - `collapse(chunk: string): string`, `stripCollapse(part: string): string`
  - `captionPrefix(html: string, maxBytes: number): string`
  - `summarizeToolCall(name: string, argumentsJson: string, maxChars: number): string`
  - constants `TELEGRAM_MAX_MESSAGE_BYTES = 4096`, `CAPTION_MAX_BYTES = 1024`, `CAPTION_SUFFIX`, `UNDELIVERED_NOTICE`, `THINKING_TEXT = 'Thinking...'`, `UTF8_BOM = '\uFEFF'`, `SPLIT_THRESHOLD_RATIO = 1.2`

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/render.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CAPTION_SUFFIX,
  byteLength,
  captionPrefix,
  cleanCut,
  collapse,
  escapeHTML,
  markdownToTelegramHTML,
  renderMessage,
  repairHTMLTags,
  stripCollapse,
  summarizeToolCall,
} from '../src/render.ts'

describe('escapeHTML', () => {
  it.each([
    ['no special chars', 'no special chars'],
    ['a & b', 'a &amp; b'],
    ['a < b', 'a &lt; b'],
    ['<a>&b</a>', '&lt;a&gt;&amp;b&lt;/a&gt;'],
    ['', ''],
  ])('%j', (input, want) => {
    expect(escapeHTML(input)).toBe(want)
  })
})

describe('markdownToTelegramHTML', () => {
  it.each([
    ['', ''],
    ['hello world', 'hello world'],
    ['**bold text**', '<b>bold text</b>'],
    ['some _italic_ text', 'some <i>italic</i> text'],
    ['~~strike~~', '<s>strike</s>'],
    ['use `fmt.Println`', 'use <code>fmt.Println</code>'],
    ['[Go](https://go.dev)', '<a href="https://go.dev">Go</a>'],
    ['```go\nfmt.Println("hello")\n```', '<pre><code>fmt.Println("hello")\n</code></pre>'],
    ['a < b & c > d', 'a &lt; b &amp; c &gt; d'],
    ["```\n<script>alert('xss')</script>\n```", "<pre><code>&lt;script&gt;alert('xss')&lt;/script&gt;\n</code></pre>"],
    ['- item one\n- item two', '\u2022 item one\n\u2022 item two'],
    ['* item one\n* item two', '\u2022 item one\n\u2022 item two'],
    ['## Section Title', 'Section Title'],
    ['__bold text__', '<b>bold text</b>'],
    ['> quoted', 'quoted'],
  ])('%j', (input, want) => {
    expect(markdownToTelegramHTML(input)).toBe(want)
  })

  it('escapes inline code content', () => {
    expect(markdownToTelegramHTML('run `echo <hello>`')).toContain('<code>echo &lt;hello&gt;</code>')
  })
})

describe('repairHTMLTags', () => {
  it.each([
    ['plain text', 'plain text'],
    ['<b>bold</b>', '<b>bold</b>'],
    ['<b>bold', '<b>bold</b>'],
    ['<b>bold <i>italic', '<b>bold <i>italic</i></b>'],
    ['<pre><code>fn()', '<pre><code>fn()</code></pre>'],
    ['<b>ok</b> <i>ok</i>', '<b>ok</b> <i>ok</i>'],
  ])('%j', (input, want) => {
    expect(repairHTMLTags(input)).toBe(want)
  })
})

describe('cleanCut', () => {
  it('returns the full length when under budget', () => {
    expect(cleanCut('short', 100)).toBe(5)
  })
  it('prefers a paragraph break past the halfway mark', () => {
    const text = 'a'.repeat(600) + '\n\n' + 'b'.repeat(600)
    expect(cleanCut(text, 1000)).toBe(600)
  })
  it('never splits a multi-byte character', () => {
    const text = 'ắ'.repeat(700) // 3 bytes each, no spaces
    const cut = cleanCut(text, 1000)
    expect(byteLength(text.slice(0, cut))).toBeLessThanOrEqual(1000)
    expect(text.slice(0, cut)).toBe('ắ'.repeat(cut))
  })
  it('does not treat a version number as a sentence end', () => {
    const text = 'x'.repeat(590) + ' v6.2.0.0 ' + 'y'.repeat(600)
    const cut = cleanCut(text, 1000)
    expect(text.slice(cut, cut + 1)).toBe(' ')
  })
})

describe('renderMessage', () => {
  it('returns content below the threshold untouched', () => {
    const html = 'a'.repeat(1100)
    expect(renderMessage(html, 1000)).toBe(html)
  })
  it('opens the head and collapses the tail', () => {
    const head = 'alpha beta gamma delta '.repeat(44)
    const tail = 'tail content here '.repeat(100)
    const got = renderMessage(head + '\n\n' + tail, 1024)
    expect(got).toContain('<blockquote expandable>')
    expect(got.startsWith(head.slice(0, 200))).toBe(true)
  })
  it('preserves all content', () => {
    const html = 'mot dong van ban\n'.repeat(200)
    const got = renderMessage(html, 1024).replaceAll('<blockquote expandable>', '').replaceAll('</blockquote>', '')
    expect(byteLength(got)).toBeGreaterThanOrEqual(byteLength(html))
  })
  it('head never ends mid-word', () => {
    const html = 'Day la mot cau tieng Viet khong dau de kiem tra. '.repeat(100)
    const got = renderMessage(html, 1024)
    const idx = got.indexOf('<blockquote expandable>')
    const head = got.slice(0, idx).replace(/[ \n]+$/, '')
    const next = html.slice(head.length, head.length + 1)
    expect([' ', '\n', '.', '']).toContain(next)
  })
  it('uses a spoiler when the tail already has a blockquote', () => {
    const html = '<blockquote>quoted line</blockquote>\n'.repeat(100)
    const got = renderMessage(html, 1024)
    expect(got).toContain('<tg-spoiler>')
    expect(got).not.toContain('<blockquote expandable>')
  })
})

describe('collapse / stripCollapse', () => {
  it('wraps in an expandable blockquote', () => {
    expect(collapse('body')).toBe('<blockquote expandable>body</blockquote>')
  })
  it.each([
    ['<b>head</b>\n<blockquote expandable>body</blockquote>', '<b>head</b>\nbody'],
    ['<b>head</b>\n<tg-spoiler>body</tg-spoiler>', '<b>head</b>\nbody'],
    ['<b>head</b>\nbody', '<b>head</b>\nbody'],
    ['<tg-spoiler><blockquote>inner</blockquote></tg-spoiler>', '<blockquote>inner</blockquote>'],
  ])('strips %j', (input, want) => {
    expect(stripCollapse(input)).toBe(want)
  })
})

describe('captionPrefix', () => {
  it('returns short html unchanged', () => {
    expect(captionPrefix('<b>hi</b>', 1024)).toBe('<b>hi</b>')
  })
  it('bounds the result by bytes and ends with the notice', () => {
    const html = 'word '.repeat(500)
    const got = captionPrefix(html, 1024)
    expect(byteLength(got)).toBeLessThanOrEqual(1024)
    expect(got.endsWith(CAPTION_SUFFIX)).toBe(true)
  })
  it('closes tags cut in half', () => {
    const html = '<b>' + 'word '.repeat(500) + '</b>'
    const body = captionPrefix(html, 1024).slice(0, -CAPTION_SUFFIX.length)
    expect(body.endsWith('</b>')).toBe(true)
  })
})

describe('summarizeToolCall', () => {
  it('shows the first string argument on one line', () => {
    expect(summarizeToolCall('bash', '{"command":"ls -la\\n/tmp"}', 60)).toBe('bash: ls -la /tmp')
  })
  it('falls back to the tool name on bad json', () => {
    expect(summarizeToolCall('read', '{oops', 60)).toBe('read')
  })
  it('truncates to maxChars', () => {
    const got = summarizeToolCall('bash', JSON.stringify({ command: 'x'.repeat(200) }), 20)
    expect(got.length).toBeLessThanOrEqual(20)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/render.spec.ts`
Expected: FAIL — cannot find module `../src/render.ts`.

- [ ] **Step 3: Write `src/render.ts`**

```ts
/** Telegram rendering rules ported from einoclaw's Go channel; all lengths are UTF-8 bytes. */

export const TELEGRAM_MAX_MESSAGE_BYTES = 4096
export const CAPTION_MAX_BYTES = 1024
export const SPLIT_THRESHOLD_RATIO = 1.2
export const THINKING_TEXT = 'Thinking...'
export const UTF8_BOM = '\uFEFF'
export const CAPTION_SUFFIX = '\n\n<i>Please read the attached .md file.</i>'
export const UNDELIVERED_NOTICE = 'The reply was too long for one message, and sending it as a file failed too.'

const reHeading = /^#{1,6}\s+(.+)$/gm
const reBlockquote = /^>\s*(.*)$/gm
const reBold = /\*\*(.+?)\*\*/g
const reBoldUnderscore = /__([^<]+?)__/g
const reItalic = /_([^_<>]+)_/g
const reStrike = /~~(.+?)~~/g
const reLink = /\[([^\]]+)\]\(([^)]+)\)/g
const reBullet = /^[-*]\s+/gm
const reCodeBlock = /```\w*\n?([\s\S]*?)```/g
const reInlineCode = /`([^`]+)`/g
const reOpenTag = /<(b|i|s|u|code|pre|a)\b[^>]*>/g
const reCloseTag = /<\/(b|i|s|u|code|pre|a)>/g

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function escapeHTML(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function extract(text: string, re: RegExp, tag: string): { text: string; codes: string[] } {
  const codes: string[] = []
  const replaced = text.replace(re, (_match, code: string) => {
    codes.push(code)
    return `\u0000${tag}${codes.length - 1}\u0000`
  })
  return { text: replaced, codes }
}

export function markdownToTelegramHTML(markdown: string): string {
  if (markdown === '') return ''
  const blocks = extract(markdown, reCodeBlock, 'CB')
  const inline = extract(blocks.text, reInlineCode, 'IC')
  let text = inline.text
  text = text.replace(reHeading, '$1')
  text = text.replace(reBlockquote, '$1')
  text = escapeHTML(text)
  text = text.replace(reBold, '<b>$1</b>')
  text = text.replace(reBoldUnderscore, '<b>$1</b>')
  text = text.replace(reItalic, '<i>$1</i>')
  text = text.replace(reStrike, '<s>$1</s>')
  text = text.replace(reLink, '<a href="$2">$1</a>')
  text = text.replace(reBullet, '\u2022 ')
  inline.codes.forEach((code, i) => {
    text = text.replaceAll(`\u0000IC${i}\u0000`, `<code>${escapeHTML(code)}</code>`)
  })
  blocks.codes.forEach((code, i) => {
    text = text.replaceAll(`\u0000CB${i}\u0000`, `<pre><code>${escapeHTML(code)}</code></pre>`)
  })
  return text
}

/** Close every tag left open, innermost first. */
export function repairHTMLTags(html: string): string {
  const stack: string[] = []
  const tokens = [...html.matchAll(reOpenTag)].map(m => ({ index: m.index, tag: m[1] as string, open: true }))
    .concat([...html.matchAll(reCloseTag)].map(m => ({ index: m.index, tag: m[1] as string, open: false })))
    .sort((a, b) => a.index - b.index)
  for (const token of tokens) {
    if (token.open) {
      stack.push(token.tag)
      continue
    }
    const at = stack.lastIndexOf(token.tag)
    if (at >= 0) stack.splice(at, 1)
  }
  return html + stack.reverse().map(tag => `</${tag}>`).join('')
}

/** String index whose UTF-8 prefix fits in `budgetBytes` without splitting a code point. */
function indexAtByteBudget(text: string, budgetBytes: number): number {
  let bytes = 0
  let index = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > budgetBytes) break
    bytes += size
    index += char.length
  }
  return index
}

/**
 * Split offset that never lands mid-character or mid-word: backs up from the
 * byte budget to the nearest paragraph, line, sentence (". ") or space break,
 * accepting only a break past the halfway mark.
 */
export function cleanCut(text: string, budgetBytes: number): number {
  if (byteLength(text) <= budgetBytes) return text.length
  const cut = indexAtByteBudget(text, budgetBytes)
  const head = text.slice(0, cut)
  const half = budgetBytes / 2
  const pastHalf = (index: number): boolean => index > 0 && byteLength(text.slice(0, index)) > half
  const paragraph = head.lastIndexOf('\n\n')
  if (pastHalf(paragraph)) return paragraph
  const line = head.lastIndexOf('\n')
  if (pastHalf(line)) return line
  const sentence = head.lastIndexOf('. ')
  if (pastHalf(sentence)) return sentence + 1
  const space = head.lastIndexOf(' ')
  if (pastHalf(space)) return space
  return cut
}

export function collapse(chunk: string): string {
  if (chunk.includes('<blockquote')) return `<tg-spoiler>${chunk}</tg-spoiler>`
  return `<blockquote expandable>${chunk}</blockquote>`
}

export function stripCollapse(part: string): string {
  for (const [open, close] of [['<blockquote expandable>', '</blockquote>'], ['<tg-spoiler>', '</tg-spoiler>']]) {
    const i = part.indexOf(open as string)
    if (i >= 0 && part.endsWith(close as string)) {
      return part.slice(0, i) + part.slice(i + (open as string).length, part.length - (close as string).length)
    }
  }
  return part
}

/** One Telegram message: the first `openBytes` visible, the rest folded behind "Show more". */
export function renderMessage(html: string, openBytes: number): string {
  if (byteLength(html) <= openBytes * SPLIT_THRESHOLD_RATIO) return html
  const cut = cleanCut(html, openBytes)
  const head = repairHTMLTags(html.slice(0, cut).replace(/[ \n]+$/, ''))
  const tail = html.slice(cut).replace(/^\n+/, '')
  return `${head}\n${collapse(tail)}`
}

export function captionPrefix(html: string, maxBytes: number): string {
  if (byteLength(html) <= maxBytes) return html
  const cut = cleanCut(html, maxBytes - byteLength(CAPTION_SUFFIX))
  return repairHTMLTags(html.slice(0, cut).replace(/[ \n]+$/, '')) + CAPTION_SUFFIX
}

/** `name: <first string argument>` on one line, bounded to `maxChars`. */
export function summarizeToolCall(name: string, argumentsJson: string, maxChars: number): string {
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed !== null && typeof parsed === 'object') {
      const first = Object.values(parsed as Record<string, unknown>).find(value => typeof value === 'string' && value !== '')
      if (typeof first === 'string') detail = first.replace(/\s+/g, ' ').trim()
    }
  } catch {
    // Malformed model arguments: the tool name alone is still a useful status.
  }
  const label = detail === '' ? name : `${name}: ${detail}`
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}\u2026` : label
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/render.spec.ts`
Expected: PASS. If the `head never ends mid-word` case fails because the cut trims a trailing `.`, adjust the test's `next` computation to compare against `html.slice(head.length)`'s first character after trimming, not the implementation.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/render.ts packages/dsh-telegram/tests/render.spec.ts
git commit -m "feat(telegram): port Telegram rendering rules from einoclaw"
```

---

### Task 4: Chat log

**Files:**
- Create: `packages/dsh-telegram/src/chatlog.ts`
- Test: `packages/dsh-telegram/tests/chatlog.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ChatLogEntry { ts: string; message_id: number; user_id: number; username?: string; name: string; text: string; reply_to?: number; media?: string[]; bot?: true }
  class ChatLog {
    constructor(dir: string)
    append(chatId: number, entry: ChatLogEntry): Promise<void>
    readAll(chatId: number): Promise<ChatLogEntry[]>
    recent(chatId: number, afterMessageId: number, excludeMessageId: number, limit: number): Promise<ChatLogEntry[]>
    history(chatId: number, options: { limit: number; beforeMessageId?: number; query?: string }): Promise<ChatLogEntry[]>
  }
  function formatEntry(entry: ChatLogEntry): string   // "[<ts>] <sender>: <text>"
  function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'username' | 'name' | 'bot'>): string
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/chatlog.spec.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog, formatEntry, senderLabel, type ChatLogEntry } from '../src/chatlog.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'chatlog-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function entry(id: number, text: string, extra: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return { ts: `2026-09-16T00:00:${String(id).padStart(2, '0')}Z`, message_id: id, user_id: 7, name: 'Ann', text, ...extra }
}

describe('ChatLog', () => {
  it('appends one JSON line per entry', async () => {
    const log = new ChatLog(dir)
    await log.append(5, entry(1, 'hi'))
    await log.append(5, entry(2, 'there'))
    const raw = await readFile(join(dir, '5.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    expect(await log.readAll(5)).toHaveLength(2)
  })

  it('reads an empty log for an unknown chat', async () => {
    expect(await new ChatLog(dir).readAll(99)).toEqual([])
  })

  it('recent returns messages after the anchor, excluding the trigger, newest-limited', async () => {
    const log = new ChatLog(dir)
    for (let i = 1; i <= 6; i++) await log.append(1, entry(i, `m${i}`))
    const got = await log.recent(1, 2, 6, 2)
    expect(got.map(e => e.message_id)).toEqual([4, 5])
  })

  it('history reads backwards with limit, before and query filters', async () => {
    const log = new ChatLog(dir)
    for (let i = 1; i <= 10; i++) await log.append(1, entry(i, i % 2 ? `odd ${i}` : `even ${i}`))
    expect((await log.history(1, { limit: 3 })).map(e => e.message_id)).toEqual([8, 9, 10])
    expect((await log.history(1, { limit: 3, beforeMessageId: 5 })).map(e => e.message_id)).toEqual([2, 3, 4])
    expect((await log.history(1, { limit: 2, query: 'ODD' })).map(e => e.message_id)).toEqual([7, 9])
  })
})

describe('labels', () => {
  it('prefers username, falls back to id, marks the bot', () => {
    expect(senderLabel({ user_id: 7, username: 'ann', name: 'Ann' })).toBe('@ann (Ann)')
    expect(senderLabel({ user_id: 7, name: 'Ann' })).toBe('id:7 (Ann)')
    expect(senderLabel({ user_id: 1, name: 'Bot', bot: true })).toBe('assistant')
  })
  it('formats one line', () => {
    expect(formatEntry(entry(3, 'hello', { username: 'ann' }))).toBe('[2026-09-16T00:00:03Z] @ann (Ann): hello')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chatlog.spec.ts`
Expected: FAIL — cannot find module `../src/chatlog.ts`.

- [ ] **Step 3: Write `src/chatlog.ts`**

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One observed Telegram message; bot replies carry `bot: true`. */
export interface ChatLogEntry {
  ts: string
  message_id: number
  user_id: number
  username?: string
  name: string
  text: string
  reply_to?: number
  media?: string[]
  bot?: true
}

export function senderLabel(entry: Pick<ChatLogEntry, 'user_id' | 'username' | 'name' | 'bot'>): string {
  if (entry.bot) return 'assistant'
  const base = entry.username === undefined ? `id:${entry.user_id}` : `@${entry.username}`
  return entry.name === '' ? base : `${base} (${entry.name})`
}

export function formatEntry(entry: ChatLogEntry): string {
  return `[${entry.ts}] ${senderLabel(entry)}: ${entry.text}`
}

/** Append-only per-chat JSONL log under `dir`. */
export class ChatLog {
  constructor(private readonly dir: string) {}

  private file(chatId: number): string {
    return join(this.dir, `${chatId}.jsonl`)
  }

  async append(chatId: number, entry: ChatLogEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.file(chatId), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async readAll(chatId: number): Promise<ChatLogEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file(chatId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ChatLogEntry)
  }

  /** Messages with id > afterMessageId, minus the trigger, keeping the newest `limit`. */
  async recent(chatId: number, afterMessageId: number, excludeMessageId: number, limit: number): Promise<ChatLogEntry[]> {
    if (limit === 0) return []
    const entries = (await this.readAll(chatId))
      .filter(e => e.message_id > afterMessageId && e.message_id !== excludeMessageId)
    return entries.slice(-limit)
  }

  /** Newest `limit` entries (oldest first) before `beforeMessageId`, optionally containing `query`. */
  async history(chatId: number, options: { limit: number; beforeMessageId?: number; query?: string }): Promise<ChatLogEntry[]> {
    const needle = options.query?.toLowerCase()
    const entries = (await this.readAll(chatId)).filter(e =>
      (options.beforeMessageId === undefined || e.message_id < options.beforeMessageId)
      && (needle === undefined || e.text.toLowerCase().includes(needle)))
    return entries.slice(-options.limit)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chatlog.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/chatlog.ts packages/dsh-telegram/tests/chatlog.spec.ts
git commit -m "feat(telegram): per-chat JSONL chat log"
```

---

### Task 5: Session map

**Files:**
- Create: `packages/dsh-telegram/src/session-map.ts`
- Test: `packages/dsh-telegram/tests/session-map.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ChatSessionRecord { sessionId: string; lastTurnMessageId: number }
  class SessionMap {
    constructor(file: string)
    load(): Promise<void>                       // reads the file once; missing file = empty map
    get(chatId: number): ChatSessionRecord | undefined
    set(chatId: number, record: ChatSessionRecord): Promise<void>   // atomic write (tmp + rename)
    delete(chatId: number): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/session-map.spec.ts`:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionMap } from '../src/session-map.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sessmap-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('SessionMap', () => {
  it('starts empty when the file is missing', async () => {
    const map = new SessionMap(join(dir, 'map.json'))
    await map.load()
    expect(map.get(1)).toBeUndefined()
  })

  it('persists set and delete across instances', async () => {
    const file = join(dir, 'map.json')
    const a = new SessionMap(file)
    await a.load()
    await a.set(1, { sessionId: 's1', lastTurnMessageId: 10 })
    await a.set(2, { sessionId: 's2', lastTurnMessageId: 0 })
    await a.delete(2)
    const b = new SessionMap(file)
    await b.load()
    expect(b.get(1)).toEqual({ sessionId: 's1', lastTurnMessageId: 10 })
    expect(b.get(2)).toBeUndefined()
    expect(await readdir(dir)).toEqual(['map.json'])
  })

  it('creates the parent directory', async () => {
    const map = new SessionMap(join(dir, 'nested', 'map.json'))
    await map.load()
    await map.set(1, { sessionId: 's1', lastTurnMessageId: 0 })
    expect(map.get(1)?.sessionId).toBe('s1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-map.spec.ts`
Expected: FAIL — cannot find module `../src/session-map.ts`.

- [ ] **Step 3: Write `src/session-map.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ChatSessionRecord {
  sessionId: string
  lastTurnMessageId: number
}

/** `chat_id -> session` map persisted as one JSON file, rewritten atomically. */
export class SessionMap {
  private records = new Map<number, ChatSessionRecord>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as Record<string, ChatSessionRecord>
    this.records = new Map(Object.entries(parsed).map(([chatId, record]) => [Number(chatId), record]))
  }

  get(chatId: number): ChatSessionRecord | undefined {
    return this.records.get(chatId)
  }

  async set(chatId: number, record: ChatSessionRecord): Promise<void> {
    this.records.set(chatId, record)
    await this.flush()
  }

  async delete(chatId: number): Promise<void> {
    this.records.delete(chatId)
    await this.flush()
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/session-map.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/session-map.ts packages/dsh-telegram/tests/session-map.spec.ts
git commit -m "feat(telegram): persisted chat to session map"
```

---

### Task 6: TelegramApi interface, fake, and media helpers

**Files:**
- Create: `packages/dsh-telegram/src/telegram-api.ts`, `packages/dsh-telegram/src/media.ts`, `packages/dsh-telegram/tests/helpers/fake-api.ts`
- Test: `packages/dsh-telegram/tests/media.spec.ts`, `packages/dsh-telegram/tests/fake-api.spec.ts`

**Interfaces:**
- Produces `src/telegram-api.ts`:
  ```ts
  interface ReplyTarget { messageId: number }
  interface SendTextOptions { parseMode?: 'HTML'; replyTo?: ReplyTarget }
  interface SendFileOptions { caption?: string; parseMode?: 'HTML'; replyTo?: ReplyTarget; filename?: string }
  interface TelegramApi {
    sendMessage(chatId: number, text: string, options?: SendTextOptions): Promise<{ messageId: number }>
    editMessageText(chatId: number, messageId: number, text: string, options?: { parseMode?: 'HTML' }): Promise<void>
    deleteMessage(chatId: number, messageId: number): Promise<void>
    sendChatAction(chatId: number, action: 'typing'): Promise<void>
    setReaction(chatId: number, messageId: number, emoji: string): Promise<void>
    sendDocument(chatId: number, data: Buffer, options: SendFileOptions & { filename: string }): Promise<{ messageId: number }>
    sendPhoto(chatId: number, data: Buffer, options?: SendFileOptions): Promise<{ messageId: number }>
    downloadFile(fileId: string): Promise<{ data: Buffer; filePath: string }>
  }
  class TelegramApiError extends Error { constructor(message: string, readonly status?: number) }
  function createGrammyApi(bot: Bot, token: string): TelegramApi
  ```
- Produces `src/media.ts`:
  ```ts
  function sanitizeFilename(name: string | undefined, fallbackExt: string): string
  function resolveInsideWorkspace(workspaceDir: string, requested: string): Promise<string>  // realpath; throws outside
  function outboundKind(path: string): 'photo' | 'document'
  function uniquePath(dir: string, filename: string): Promise<string>  // adds -1, -2 suffix on collision
  ```
- Produces `tests/helpers/fake-api.ts`: `class FakeTelegramApi implements TelegramApi` recording `calls: Array<{ method: string; args: unknown[] }>`, with `failNext(method, error)` and `files: Map<string, Buffer>` for downloads; `sendMessage`/`sendDocument`/`sendPhoto` return incrementing message ids starting at 100.

- [ ] **Step 1: Write the API module**

`packages/dsh-telegram/src/telegram-api.ts`:

```ts
import { GrammyError, HttpError, InputFile, type Bot } from 'grammy'

export interface ReplyTarget { readonly messageId: number }
export interface SendTextOptions { readonly parseMode?: 'HTML'; readonly replyTo?: ReplyTarget }
export interface SendFileOptions {
  readonly caption?: string
  readonly parseMode?: 'HTML'
  readonly replyTo?: ReplyTarget
  readonly filename?: string
}

/** The Bot API surface the plugin needs; tests substitute a recorder. */
export interface TelegramApi {
  sendMessage(chatId: number, text: string, options?: SendTextOptions): Promise<{ messageId: number }>
  editMessageText(chatId: number, messageId: number, text: string, options?: { parseMode?: 'HTML' }): Promise<void>
  deleteMessage(chatId: number, messageId: number): Promise<void>
  sendChatAction(chatId: number, action: 'typing'): Promise<void>
  setReaction(chatId: number, messageId: number, emoji: string): Promise<void>
  sendDocument(chatId: number, data: Buffer, options: SendFileOptions & { filename: string }): Promise<{ messageId: number }>
  sendPhoto(chatId: number, data: Buffer, options?: SendFileOptions): Promise<{ messageId: number }>
  downloadFile(fileId: string): Promise<{ data: Buffer; filePath: string }>
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

function replyParameters(target: ReplyTarget | undefined) {
  return target === undefined ? {} : { reply_parameters: { message_id: target.messageId, allow_sending_without_reply: true } }
}

async function wrap<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof GrammyError) throw new TelegramApiError(error.description, error.error_code)
    if (error instanceof HttpError) throw new TelegramApiError(error.message)
    throw error
  }
}

export function createGrammyApi(bot: Bot, token: string): TelegramApi {
  const api = bot.api
  return {
    sendMessage: (chatId, text, options = {}) => wrap(async () => {
      const sent = await api.sendMessage(chatId, text, {
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
        link_preview_options: { is_disabled: true },
      })
      return { messageId: sent.message_id }
    }),
    editMessageText: (chatId, messageId, text, options = {}) => wrap(async () => {
      await api.editMessageText(chatId, messageId, text, {
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        link_preview_options: { is_disabled: true },
      })
    }),
    deleteMessage: (chatId, messageId) => wrap(async () => { await api.deleteMessage(chatId, messageId) }),
    sendChatAction: (chatId, action) => wrap(async () => { await api.sendChatAction(chatId, action) }),
    setReaction: (chatId, messageId, emoji) => wrap(async () => {
      await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as never }])
    }),
    sendDocument: (chatId, data, options) => wrap(async () => {
      const sent = await api.sendDocument(chatId, new InputFile(data, options.filename), {
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
      })
      return { messageId: sent.message_id }
    }),
    sendPhoto: (chatId, data, options = {}) => wrap(async () => {
      const sent = await api.sendPhoto(chatId, new InputFile(data, options.filename), {
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
      })
      return { messageId: sent.message_id }
    }),
    downloadFile: fileId => wrap(async () => {
      const file = await api.getFile(fileId)
      if (file.file_path === undefined) throw new TelegramApiError(`file ${fileId} has no file_path`)
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
      if (!response.ok) throw new TelegramApiError(`download failed: ${response.status}`, response.status)
      return { data: Buffer.from(await response.arrayBuffer()), filePath: file.file_path }
    }),
  }
}
```

- [ ] **Step 2: Write the fake**

`packages/dsh-telegram/tests/helpers/fake-api.ts`:

```ts
import type { SendFileOptions, SendTextOptions, TelegramApi } from '../../src/telegram-api.ts'

export interface RecordedCall { method: string; args: unknown[] }

export class FakeTelegramApi implements TelegramApi {
  calls: RecordedCall[] = []
  files = new Map<string, { data: Buffer; filePath: string }>()
  private nextId = 100
  private failures = new Map<string, Error[]>()

  failNext(method: string, error: Error): void {
    const queue = this.failures.get(method) ?? []
    queue.push(error)
    this.failures.set(method, queue)
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter(c => c.method === method)
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
    const queue = this.failures.get(method)
    const error = queue?.shift()
    if (error !== undefined) throw error
  }

  async sendMessage(chatId: number, text: string, options?: SendTextOptions) {
    this.record('sendMessage', [chatId, text, options])
    return { messageId: this.nextId++ }
  }
  async editMessageText(chatId: number, messageId: number, text: string, options?: { parseMode?: 'HTML' }) {
    this.record('editMessageText', [chatId, messageId, text, options])
  }
  async deleteMessage(chatId: number, messageId: number) {
    this.record('deleteMessage', [chatId, messageId])
  }
  async sendChatAction(chatId: number, action: 'typing') {
    this.record('sendChatAction', [chatId, action])
  }
  async setReaction(chatId: number, messageId: number, emoji: string) {
    this.record('setReaction', [chatId, messageId, emoji])
  }
  async sendDocument(chatId: number, data: Buffer, options: SendFileOptions & { filename: string }) {
    this.record('sendDocument', [chatId, data, options])
    return { messageId: this.nextId++ }
  }
  async sendPhoto(chatId: number, data: Buffer, options?: SendFileOptions) {
    this.record('sendPhoto', [chatId, data, options])
    return { messageId: this.nextId++ }
  }
  async downloadFile(fileId: string) {
    this.record('downloadFile', [fileId])
    const file = this.files.get(fileId)
    if (file === undefined) throw new Error(`no fake file ${fileId}`)
    return file
  }
}
```

`packages/dsh-telegram/tests/fake-api.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FakeTelegramApi } from './helpers/fake-api.ts'

describe('FakeTelegramApi', () => {
  it('records calls, mints ids and replays queued failures', async () => {
    const api = new FakeTelegramApi()
    expect((await api.sendMessage(1, 'a')).messageId).toBe(100)
    expect((await api.sendMessage(1, 'b')).messageId).toBe(101)
    api.failNext('editMessageText', new Error('boom'))
    await expect(api.editMessageText(1, 100, 'x')).rejects.toThrow('boom')
    await api.editMessageText(1, 100, 'y')
    expect(api.callsTo('editMessageText')).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Write the failing media tests**

`packages/dsh-telegram/tests/media.spec.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { outboundKind, resolveInsideWorkspace, sanitizeFilename, uniquePath } from '../src/media.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'media-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('sanitizeFilename', () => {
  it('keeps a plain name', () => expect(sanitizeFilename('report.pdf', '.bin')).toBe('report.pdf'))
  it('strips directories and odd characters', () => {
    expect(sanitizeFilename('../../etc/passwd', '.bin')).toBe('passwd')
    expect(sanitizeFilename('a b:c*d?.txt', '.bin')).toBe('a_b_c_d_.txt')
  })
  it('generates a name with the fallback extension', () => {
    expect(sanitizeFilename(undefined, '.ogg')).toMatch(/^file-\d+\.ogg$/)
    expect(sanitizeFilename('', '.ogg')).toMatch(/^file-\d+\.ogg$/)
  })
})

describe('resolveInsideWorkspace', () => {
  it('resolves a relative path inside the workspace', async () => {
    await writeFile(join(dir, 'out.txt'), 'x')
    expect(await resolveInsideWorkspace(dir, 'out.txt')).toBe(join(dir, 'out.txt'))
  })
  it('rejects escapes and missing files', async () => {
    await expect(resolveInsideWorkspace(dir, '../outside.txt')).rejects.toThrow(/outside/)
    await expect(resolveInsideWorkspace(dir, 'missing.txt')).rejects.toThrow()
  })
})

describe('outboundKind', () => {
  it.each([['a.png', 'photo'], ['b.JPG', 'photo'], ['c.webp', 'photo'], ['d.pdf', 'document'], ['e', 'document']])(
    '%s -> %s', (path, kind) => expect(outboundKind(path)).toBe(kind))
})

describe('uniquePath', () => {
  it('adds a numeric suffix on collision', async () => {
    await mkdir(join(dir, 'inbox'))
    await writeFile(join(dir, 'inbox', 'a.txt'), '')
    await writeFile(join(dir, 'inbox', 'a-1.txt'), '')
    expect(await uniquePath(join(dir, 'inbox'), 'a.txt')).toBe(join(dir, 'inbox', 'a-2.txt'))
    expect(await uniquePath(join(dir, 'inbox'), 'b.txt')).toBe(join(dir, 'inbox', 'b.txt'))
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/media.spec.ts tests/fake-api.spec.ts`
Expected: `fake-api` PASS, `media` FAIL — cannot find module `../src/media.ts`.

- [ ] **Step 5: Write `src/media.ts`**

```ts
import { access, realpath } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

const PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Basename only, unsafe characters replaced, generated name when empty. */
export function sanitizeFilename(name: string | undefined, fallbackExt: string): string {
  const base = basename((name ?? '').replaceAll('\\', '/')).replace(/[^A-Za-z0-9._-]/g, '_')
  if (base === '' || base === '.' || base === '..') return `file-${Date.now()}${fallbackExt}`
  return base
}

/** Real path of `requested` inside `workspaceDir`; throws when missing or outside. */
export async function resolveInsideWorkspace(workspaceDir: string, requested: string): Promise<string> {
  const root = await realpath(workspaceDir)
  const target = await realpath(resolve(root, requested))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path is outside the chat workspace: ${requested}`)
  }
  return target
}

export function outboundKind(path: string): 'photo' | 'document' {
  return PHOTO_EXTENSIONS.has(extname(path).toLowerCase()) ? 'photo' : 'document'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** `dir/filename`, or `dir/name-N.ext` for the first free N. */
export async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let n = 1; await exists(candidate); n++) candidate = join(dir, `${stem}-${n}${ext}`)
  return candidate
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/media.spec.ts tests/fake-api.spec.ts && npm run typecheck`
Expected: PASS. (The `resolveInsideWorkspace` test compares against `join(dir, ...)`; on macOS `tmpdir()` may be a symlink — if so compare with `await realpath(join(dir, 'out.txt'))`.)

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-telegram/src/telegram-api.ts packages/dsh-telegram/src/media.ts packages/dsh-telegram/tests
git commit -m "feat(telegram): TelegramApi seam, grammY adapter, media helpers"
```

---

### Task 7: Inbound message parsing

**Files:**
- Create: `packages/dsh-telegram/src/inbound.ts`
- Test: `packages/dsh-telegram/tests/inbound.spec.ts`

**Interfaces:**
- Consumes: `TelegramApi.downloadFile`, `sanitizeFilename`, `uniquePath` (Task 6), `ChatLogEntry` (Task 4).
- Produces:
  ```ts
  /** The subset of grammY's Message the parser reads (structural, so tests build literals). */
  interface TelegramUser { id: number; is_bot: boolean; username?: string; first_name: string }
  interface TelegramMessage {
    message_id: number; date: number; chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
    from?: TelegramUser; text?: string; caption?: string
    entities?: Array<{ type: string; offset: number; length: number }>
    caption_entities?: Array<{ type: string; offset: number; length: number }>
    photo?: Array<{ file_id: string; width: number; height: number }>
    document?: { file_id: string; file_name?: string; mime_type?: string }
    voice?: { file_id: string }; audio?: { file_id: string; file_name?: string }
    sticker?: { emoji?: string }
    reply_to_message?: TelegramMessage
  }
  interface InboundMessage {
    chatId: number; messageId: number; isGroup: boolean; sender: TelegramUser
    text: string                       // final text block (labels, quote, media notes; no recent-context yet)
    images: Array<{ data: Buffer; mediaType: 'image/jpeg' }>
    savedFiles: string[]               // absolute paths written under inboxDir
    logEntry: ChatLogEntry             // what to append to the chat log
  }
  function hasBotMention(text: string | undefined, entities: TelegramMessage['entities'], botUsername: string): boolean
  function stripBotMention(text: string, botUsername: string): string
  function displayName(user: TelegramUser): string      // "@name (First)" or "id:N (First)"
  function logEntryFor(message: TelegramMessage, savedFiles?: string[]): ChatLogEntry
  function parseInbound(message: TelegramMessage, options: { api: TelegramApi; inboxDir: string; botId: number; botUsername: string }): Promise<InboundMessage>
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/inbound.spec.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { displayName, hasBotMention, parseInbound, stripBotMention, type TelegramMessage } from '../src/inbound.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inbound-'))
  api = new FakeTelegramApi()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const options = () => ({ api, inboxDir: join(dir, 'inbox'), botId: 1, botUsername: 'dshbot' })

function msg(extra: Partial<TelegramMessage>, type: TelegramMessage['chat']['type'] = 'private'): TelegramMessage {
  return { message_id: 10, date: 1_700_000_000, chat: { id: 5, type }, from: ann, ...extra }
}

describe('mentions and names', () => {
  it('detects a mention entity for the bot only', () => {
    const entities = [{ type: 'mention', offset: 0, length: 7 }]
    expect(hasBotMention('@dshbot hi', entities, 'dshbot')).toBe(true)
    expect(hasBotMention('@other hi', [{ type: 'mention', offset: 0, length: 6 }], 'dshbot')).toBe(false)
    expect(hasBotMention(undefined, undefined, 'dshbot')).toBe(false)
  })
  it('strips the mention and trims', () => {
    expect(stripBotMention('@dshbot  hello', 'dshbot')).toBe('hello')
  })
  it('labels users', () => {
    expect(displayName(ann)).toBe('@ann (Ann)')
    expect(displayName({ id: 9, is_bot: false, first_name: 'Bob' })).toBe('id:9 (Bob)')
  })
})

describe('parseInbound', () => {
  it('passes DM text through unchanged and logs it', async () => {
    const got = await parseInbound(msg({ text: 'hello' }), options())
    expect(got.text).toBe('hello')
    expect(got.isGroup).toBe(false)
    expect(got.logEntry).toMatchObject({ message_id: 10, user_id: 7, username: 'ann', name: 'Ann', text: 'hello' })
  })

  it('prefixes the sender label and strips the mention in groups', async () => {
    const got = await parseInbound(msg({ text: '@dshbot do it', entities: [{ type: 'mention', offset: 0, length: 7 }] }, 'supergroup'), options())
    expect(got.text).toBe('@ann (Ann): do it')
  })

  it('downloads the largest photo as an image block', async () => {
    api.files.set('big', { data: Buffer.from('jpegbytes'), filePath: 'photos/1.jpg' })
    const got = await parseInbound(msg({ caption: 'look', photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 9, height: 9 }] }), options())
    expect(got.images).toEqual([{ data: Buffer.from('jpegbytes'), mediaType: 'image/jpeg' }])
    expect(got.text).toBe('look')
    expect(api.callsTo('downloadFile')[0]?.args).toEqual(['big'])
  })

  it('saves documents, voice and audio into the inbox and annotates the text', async () => {
    api.files.set('doc', { data: Buffer.from('pdf'), filePath: 'documents/x.pdf' })
    api.files.set('v', { data: Buffer.from('ogg'), filePath: 'voice/1.oga' })
    const got = await parseInbound(msg({ text: 'see', document: { file_id: 'doc', file_name: 'report.pdf' }, voice: { file_id: 'v' } }), options())
    const doc = join(dir, 'inbox', 'report.pdf')
    expect(await readFile(doc, 'utf8')).toBe('pdf')
    expect(got.savedFiles).toHaveLength(2)
    expect(got.text).toBe(`see\n[file: ${doc}]\n[voice: ${got.savedFiles[1]}]`)
    expect(got.savedFiles[1]).toMatch(/\.ogg$/)
    expect(got.logEntry.media).toEqual(got.savedFiles)
  })

  it('annotates stickers and empty messages', async () => {
    expect((await parseInbound(msg({ sticker: { emoji: ':)' } }), options())).text).toBe('[sticker: :)]')
    expect((await parseInbound(msg({}), options())).text).toBe('[empty message]')
  })

  it('prepends quoted reply context and downloads a quoted user photo but not a bot one', async () => {
    api.files.set('q', { data: Buffer.from('img'), filePath: 'photos/q.jpg' })
    const quoted: TelegramMessage = { message_id: 3, date: 1, chat: { id: 5, type: 'private' }, from: { id: 9, is_bot: false, first_name: 'Bob' }, text: 'first line\nsecond', photo: [{ file_id: 'q', width: 1, height: 1 }] }
    const got = await parseInbound(msg({ text: 'reply', reply_to_message: quoted }), options())
    expect(got.text).toBe('> id:9 (Bob): first line\n> second\n\nreply')
    expect(got.images).toHaveLength(1)
    expect(got.logEntry.reply_to).toBe(3)

    const botQuoted: TelegramMessage = { ...quoted, from: { id: 1, is_bot: true, first_name: 'dsh' } }
    const got2 = await parseInbound(msg({ text: 'again', reply_to_message: botQuoted }), options())
    expect(got2.images).toHaveLength(0)
    expect(got2.text.startsWith('> assistant: first line')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inbound.spec.ts`
Expected: FAIL — cannot find module `../src/inbound.ts`.

- [ ] **Step 3: Write `src/inbound.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ChatLogEntry } from './chatlog.ts'
import { sanitizeFilename, uniquePath } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface TelegramUser { id: number; is_bot: boolean; username?: string; first_name: string }
interface Entity { type: string; offset: number; length: number }
export interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  from?: TelegramUser
  text?: string
  caption?: string
  entities?: Entity[]
  caption_entities?: Entity[]
  photo?: Array<{ file_id: string; width: number; height: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string }
  voice?: { file_id: string }
  audio?: { file_id: string; file_name?: string }
  sticker?: { emoji?: string }
  reply_to_message?: TelegramMessage
}

export interface InboundImage { data: Buffer; mediaType: 'image/jpeg' }

export interface InboundMessage {
  chatId: number
  messageId: number
  isGroup: boolean
  sender: TelegramUser
  text: string
  images: InboundImage[]
  savedFiles: string[]
  logEntry: ChatLogEntry
}

export interface ParseOptions { api: TelegramApi; inboxDir: string; botId: number; botUsername: string }

export function hasBotMention(text: string | undefined, entities: Entity[] | undefined, botUsername: string): boolean {
  if (text === undefined || entities === undefined) return false
  const wanted = `@${botUsername}`.toLowerCase()
  return entities.some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === wanted)
}

export function stripBotMention(text: string, botUsername: string): string {
  return text.replaceAll(new RegExp(`@${botUsername}`, 'gi'), '').replace(/\s+/g, ' ').trim()
}

export function displayName(user: TelegramUser): string {
  if (user.is_bot) return 'assistant'
  const base = user.username === undefined ? `id:${user.id}` : `@${user.username}`
  return user.first_name === '' ? base : `${base} (${user.first_name})`
}

function largestPhoto(photo: TelegramMessage['photo']): string | undefined {
  if (photo === undefined || photo.length === 0) return undefined
  return photo.reduce((best, p) => (p.width * p.height > best.width * best.height ? p : best)).file_id
}

async function saveInbox(api: TelegramApi, inboxDir: string, fileId: string, preferredName: string | undefined, fallbackExt: string): Promise<string> {
  const { data, filePath } = await api.downloadFile(fileId)
  const ext = fallbackExt === '' ? extname(filePath) : fallbackExt
  await mkdir(inboxDir, { recursive: true })
  const target = await uniquePath(inboxDir, sanitizeFilename(preferredName, ext))
  await writeFile(target, data)
  return target
}

function quote(label: string, text: string): string {
  return text.split('\n').map(line => `> ${label}: ${line}`.replace(`${label}: `, m => m)).join('\n')
}

export async function parseInbound(message: TelegramMessage, options: ParseOptions): Promise<InboundMessage> {
  const sender = message.from
  if (sender === undefined) throw new Error('message without sender')
  const isGroup = message.chat.type !== 'private'
  const images: InboundImage[] = []
  const savedFiles: string[] = []
  const parts: string[] = []

  let body = [message.text, message.caption].filter((t): t is string => t !== undefined && t !== '').join('\n')
  if (isGroup) body = stripBotMention(body, options.botUsername)
  if (body !== '') parts.push(body)

  const photoId = largestPhoto(message.photo)
  if (photoId !== undefined) {
    const { data } = await options.api.downloadFile(photoId)
    images.push({ data, mediaType: 'image/jpeg' })
  }
  if (message.document !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.document.file_id, message.document.file_name, '')
    savedFiles.push(path)
    parts.push(`[file: ${path}]`)
  }
  if (message.voice !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.voice.file_id, undefined, '.ogg')
    savedFiles.push(path)
    parts.push(`[voice: ${path}]`)
  }
  if (message.audio !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.audio.file_id, message.audio.file_name, '.mp3')
    savedFiles.push(path)
    parts.push(`[audio: ${path}]`)
  }
  if (message.sticker !== undefined) {
    parts.push(message.sticker.emoji === undefined ? '[sticker]' : `[sticker: ${message.sticker.emoji}]`)
  }

  let text = parts.join('\n')
  if (text === '') text = '[empty message]'
  if (isGroup) text = `${displayName(sender)}: ${text}`

  const quoted = message.reply_to_message
  if (quoted?.from !== undefined) {
    let quotedText = quoted.text ?? quoted.caption ?? ''
    const quotedPhoto = quoted.from.id === options.botId ? undefined : largestPhoto(quoted.photo)
    if (quotedPhoto !== undefined) {
      const { data } = await options.api.downloadFile(quotedPhoto)
      images.push({ data, mediaType: 'image/jpeg' })
      quotedText = quotedText === '' ? '[image]' : `${quotedText}\n[image]`
    }
    const label = quoted.from.id === options.botId ? 'assistant' : displayName(quoted.from)
    const lines = quotedText.split('\n')
    const block = lines.map((line, i) => (i === 0 ? `> ${label}: ${line}` : `> ${line}`)).join('\n')
    text = `${block}\n\n${text}`
  }

  return { chatId: message.chat.id, messageId: message.message_id, isGroup, sender, text, images, savedFiles, logEntry: logEntryFor(message, savedFiles) }
}

/** Chat-log record for any observed message; `savedFiles` lists inbox paths when media was downloaded. */
export function logEntryFor(message: TelegramMessage, savedFiles: string[] = []): ChatLogEntry {
  const sender = message.from
  if (sender === undefined) throw new Error('message without sender')
  const text = [message.text, message.caption].filter((t): t is string => t !== undefined && t !== '').join('\n')
  return {
    ts: new Date(message.date * 1000).toISOString(),
    message_id: message.message_id,
    user_id: sender.id,
    ...(sender.username === undefined ? {} : { username: sender.username }),
    name: sender.first_name,
    text: text !== '' ? text : message.sticker !== undefined ? '[sticker]' : message.photo !== undefined ? '[photo]' : '',
    ...(message.reply_to_message === undefined ? {} : { reply_to: message.reply_to_message.message_id }),
    ...(savedFiles.length === 0 ? {} : { media: savedFiles }),
  }
}
```

Remove the unused `quote` helper before committing (it is superseded by the inline `block` construction). `logEntryFor` is also exported for log-only group messages (Task 11); add to `tests/inbound.spec.ts`:

```ts
it('logEntryFor records a photo-only message', async () => {
  const { logEntryFor } = await import('../src/inbound.ts')
  expect(logEntryFor(msg({ photo: [{ file_id: 'p', width: 1, height: 1 }] })).text).toBe('[photo]')
})
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/inbound.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/inbound.ts packages/dsh-telegram/tests/inbound.spec.ts
git commit -m "feat(telegram): parse inbound Telegram messages into agent input"
```

---

### Task 8: Chat agents (create / resume / reset / stop)

**Files:**
- Create: `packages/dsh-telegram/src/sessions.ts`
- Test: `packages/dsh-telegram/tests/sessions.spec.ts`

**Interfaces:**
- Consumes: `SessionMap` (Task 5), `Config` (Task 1).
- Produces:
  ```ts
  /** The slice of ctx.agents this module uses; the real AgentRegistry satisfies it structurally. */
  interface AgentRegistryLike {
    get(id: SessionId): Agent | undefined
    create(options: CreateAgentOptions): Promise<AgentHandle>
    resume(options: ResumeAgentOptions): Promise<AgentHandle>
  }
  interface ChatAgentsOptions {
    agents: AgentRegistryLike
    map: SessionMap
    workspaceRoot: string
    selection: { provider: string; model: string; reasoningEffort?: string }
    setup: (agentCtx: Context, agent: Agent, chatId: number) => void   // tool registration hook (Task 10)
    log: { info(msg: string): void; warn(msg: string): void }
  }
  class ChatAgents {
    constructor(options: ChatAgentsOptions)
    workspaceFor(chatId: number): string                       // <workspaceRoot>/<chatId>
    resolve(chatId: number): Promise<{ agent: Agent; resumed: boolean; resumeFailed?: string }>
    reset(chatId: number): Promise<void>
    stop(chatId: number): boolean                              // true when a running agent was cancelled
    markTurn(chatId: number, lastTurnMessageId: number): Promise<void>
    lastTurnMessageId(chatId: number): number
    disposeAll(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/sessions.spec.ts`:

```ts
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMap } from '../src/session-map.ts'
import { ChatAgents, type AgentRegistryLike } from '../src/sessions.ts'

interface FakeAgent { id: string; status: 'idle' | 'running'; cancel: ReturnType<typeof vi.fn>; session: { header: { cwd: string } } }

function fakeRegistry() {
  const live = new Map<string, FakeAgent>()
  const disposed: string[] = []
  const registry = {
    created: [] as unknown[],
    resumed: [] as unknown[],
    failResume: false,
    get: (id: string) => live.get(id),
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string }; setup?: (ctx: unknown, agent: unknown) => void }) => {
      const agent: FakeAgent = { id: options.sessionId, status: 'idle', cancel: vi.fn(), session: { header: { cwd: options.meta?.cwd ?? '' } } }
      options.setup?.({}, agent)
      live.set(agent.id, agent)
      registry.created.push(options)
      return { agent, dispose: async () => { live.delete(agent.id); disposed.push(agent.id) } }
    }),
    resume: vi.fn(async (options: { resumeSessionId: string; setup?: (ctx: unknown, agent: unknown) => void }) => {
      if (registry.failResume) throw new Error('corrupt log')
      const agent: FakeAgent = { id: options.resumeSessionId, status: 'idle', cancel: vi.fn(), session: { header: { cwd: '/w/1' } } }
      options.setup?.({}, agent)
      live.set(agent.id, agent)
      registry.resumed.push(options)
      return { agent, dispose: async () => { live.delete(agent.id); disposed.push(agent.id) } }
    }),
  }
  return { registry: registry as unknown as AgentRegistryLike & typeof registry, live, disposed }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agents-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function build(failResume = false) {
  const { registry, live, disposed } = fakeRegistry()
  registry.failResume = failResume
  const map = new SessionMap(join(dir, 'map.json'))
  await map.load()
  const setup = vi.fn()
  const agents = new ChatAgents({
    agents: registry, map, workspaceRoot: join(dir, 'ws'),
    selection: { provider: 'deepseek-official', model: 'm' }, setup,
    log: { info: () => {}, warn: () => {} },
  })
  return { agents, registry, live, disposed, map, setup }
}

describe('ChatAgents', () => {
  it('creates a session and workspace on first contact and stores the map entry', async () => {
    const { agents, registry, map, setup } = await build()
    const { agent, resumed } = await agents.resolve(1)
    expect(resumed).toBe(false)
    expect(registry.created).toHaveLength(1)
    expect((await stat(join(dir, 'ws', '1'))).isDirectory()).toBe(true)
    expect(map.get(1)?.sessionId).toBe(agent.id)
    expect(setup).toHaveBeenCalledWith({}, agent, 1)
  })

  it('reuses the live agent', async () => {
    const { agents, registry } = await build()
    const first = await agents.resolve(1)
    const second = await agents.resolve(1)
    expect(second.agent).toBe(first.agent)
    expect(registry.created).toHaveLength(1)
  })

  it('resumes from the map when the agent is not live', async () => {
    const { agents, registry, map } = await build()
    await map.set(1, { sessionId: 'old', lastTurnMessageId: 4 })
    const { agent, resumed } = await agents.resolve(1)
    expect(resumed).toBe(true)
    expect(agent.id).toBe('old')
    expect(registry.resumed[0]).toMatchObject({ resumeSessionId: 'old' })
    expect(agents.lastTurnMessageId(1)).toBe(4)
  })

  it('falls back to a fresh session when resume fails', async () => {
    const { agents, registry, map } = await build(true)
    await map.set(1, { sessionId: 'old', lastTurnMessageId: 4 })
    const { agent, resumed, resumeFailed } = await agents.resolve(1)
    expect(resumed).toBe(false)
    expect(resumeFailed).toContain('corrupt log')
    expect(agent.id).not.toBe('old')
    expect(registry.created).toHaveLength(1)
    expect(map.get(1)?.sessionId).toBe(agent.id)
  })

  it('reset disposes the live agent and forgets the chat', async () => {
    const { agents, map, disposed } = await build()
    const { agent } = await agents.resolve(1)
    await agents.reset(1)
    expect(disposed).toEqual([agent.id])
    expect(map.get(1)).toBeUndefined()
  })

  it('stop cancels only a running agent', async () => {
    const { agents, live } = await build()
    const { agent } = await agents.resolve(1)
    expect(agents.stop(1)).toBe(false)
    live.get(agent.id)!.status = 'running'
    expect(agents.stop(1)).toBe(true)
    expect(live.get(agent.id)!.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('markTurn persists the anchor and disposeAll tears down every live agent', async () => {
    const { agents, map, disposed } = await build()
    await agents.resolve(1)
    await agents.resolve(2)
    await agents.markTurn(1, 55)
    expect(map.get(1)?.lastTurnMessageId).toBe(55)
    await agents.disposeAll()
    expect(disposed).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sessions.spec.ts`
Expected: FAIL — cannot find module `../src/sessions.ts`.

- [ ] **Step 3: Write `src/sessions.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionMap } from './session-map.ts'

export interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

export interface ModelRoute { provider: string; model: string; reasoningEffort?: string }

export interface ChatAgentsOptions {
  agents: AgentRegistryLike
  map: SessionMap
  workspaceRoot: string
  selection: ModelRoute
  setup: (agentCtx: Context, agent: Agent, chatId: number) => void
  log: { info(msg: string): void; warn(msg: string): void }
}

export interface ResolvedAgent { agent: Agent; resumed: boolean; resumeFailed?: string }

/** One live or persisted dsh agent per Telegram chat. */
export class ChatAgents {
  private readonly handles = new Map<number, AgentHandle>()

  constructor(private readonly options: ChatAgentsOptions) {}

  workspaceFor(chatId: number): string {
    return join(this.options.workspaceRoot, String(chatId))
  }

  lastTurnMessageId(chatId: number): number {
    return this.options.map.get(chatId)?.lastTurnMessageId ?? 0
  }

  async markTurn(chatId: number, lastTurnMessageId: number): Promise<void> {
    const record = this.options.map.get(chatId)
    if (record === undefined) return
    await this.options.map.set(chatId, { ...record, lastTurnMessageId })
  }

  async resolve(chatId: number): Promise<ResolvedAgent> {
    const record = this.options.map.get(chatId)
    const live = this.handles.get(chatId)
    if (live !== undefined && record !== undefined && this.options.agents.get(brandString<SessionId>(record.sessionId)) !== undefined) {
      return { agent: live.agent, resumed: false }
    }
    if (record !== undefined) {
      try {
        const handle = await this.options.agents.resume({
          resumeSessionId: brandString<SessionId>(record.sessionId),
          agentOptions: this.agentOptions(),
          setup: (agentCtx, agent) => this.compose(agentCtx, agent, chatId),
        })
        this.handles.set(chatId, handle)
        this.options.log.info(`dsh-telegram: resumed session ${record.sessionId} for chat ${chatId}`)
        return { agent: handle.agent, resumed: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.log.warn(`dsh-telegram: resume of ${record.sessionId} failed (${message}); starting fresh`)
        await this.options.map.delete(chatId)
        const created = await this.create(chatId)
        return { ...created, resumeFailed: message }
      }
    }
    return this.create(chatId)
  }

  private async create(chatId: number): Promise<ResolvedAgent> {
    const cwd = this.workspaceFor(chatId)
    await mkdir(cwd, { recursive: true })
    const sessionId = `telegram-${chatId}-${randomUUID()}`
    const handle = await this.options.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd },
      agentOptions: this.agentOptions(),
      setup: (agentCtx, agent) => this.compose(agentCtx, agent, chatId),
    })
    this.handles.set(chatId, handle)
    await this.options.map.set(chatId, { sessionId, lastTurnMessageId: 0 })
    this.options.log.info(`dsh-telegram: created session ${sessionId} for chat ${chatId}`)
    return { agent: handle.agent, resumed: false }
  }

  private agentOptions() {
    const { provider, model, reasoningEffort } = this.options.selection
    return {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) }),
    }
  }

  private compose(agentCtx: Context, agent: Agent, chatId: number): void {
    const { provider, model, reasoningEffort } = this.options.selection
    const selection: ModelSelectionRef = {
      current: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) }) },
      assembled: undefined,
    }
    installModelSelection(agentCtx, selection)
    this.options.setup(agentCtx, agent, chatId)
  }

  async reset(chatId: number): Promise<void> {
    const handle = this.handles.get(chatId)
    this.handles.delete(chatId)
    await this.options.map.delete(chatId)
    if (handle !== undefined) await handle.dispose()
  }

  stop(chatId: number): boolean {
    const handle = this.handles.get(chatId)
    if (handle === undefined || handle.agent.status !== 'running') return false
    handle.agent.cancel({ kind: 'user' })
    return true
  }

  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}
```

Note for the fake registry in tests: `installModelSelection` calls `agentCtx.on(...)`; the test passes `{}` as `agentCtx`, so in the test file stub the module: add at the top `vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }))`. Keep the real import in `src/`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/sessions.spec.ts && npm run typecheck`
Expected: PASS. If `ReasoningEffortId` is exported as a function rather than a type in `@deepseek-ai/dsh-llm`, replace `brandString<ReasoningEffortId>(x)` with `ReasoningEffortId(x)` and import it as a value.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/sessions.ts packages/dsh-telegram/tests/sessions.spec.ts
git commit -m "feat(telegram): chat-scoped agent lifecycle with resume and reset"
```

---

### Task 9: Turn runner (placeholder, status, delivery)

**Files:**
- Create: `packages/dsh-telegram/src/turn.ts`
- Test: `packages/dsh-telegram/tests/turn.spec.ts`

**Interfaces:**
- Consumes: `TelegramApi` (Task 6), render functions and constants (Task 3).
- Produces:
  ```ts
  /** Structural slice of dsh's Agent used by the runner (the real Agent satisfies it). */
  interface TurnAgent {
    readonly id: string
    readonly session: { readonly seq: number; eventAt(seq: SessionSeq): SessionEvent | undefined; readonly header: { readonly cwd?: string } }
    followup(message: UserMessage): void
    whenIdle(): Promise<void>
    cancel(cause: { kind: 'user' }): void
  }
  /** Session event feed abstraction over ctx.on('session/event'). */
  type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void
  interface TurnOptions {
    api: TelegramApi; agent: TurnAgent; feed: SessionEventFeed
    chatId: number; replyToMessageId: number; content: ContentBlock[]
    outboxDir: string; messageSize: number; statusEditIntervalMs: number; turnTimeoutMs: number
    log: { warn(msg: string): void; error(msg: string): void }
    now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout
  }
  type TurnOutcome = 'edited' | 'sent' | 'document' | 'undelivered' | 'error' | 'timeout' | 'empty'
  interface TurnResult { outcome: TurnOutcome; text: string; sentMessageId?: number }
  function summarizeTurn(session: TurnAgent['session'], firstSeq: number): { text: string; error?: string }
  function runTurn(options: TurnOptions): Promise<TurnResult>
  const STATUS_MAX_CHARS = 60
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/turn.spec.ts`:

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THINKING_TEXT, UNDELIVERED_NOTICE, UTF8_BOM } from '../src/render.ts'
import { TelegramApiError } from '../src/telegram-api.ts'
import { runTurn, type SessionEventFeed, type TurnAgent, type TurnOptions } from '../src/turn.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

type AnyEvent = { type: string; data: unknown }

/** Fake agent: `script` runs when followup is called and may emit events. */
function fakeAgent(script: (emit: (event: AnyEvent) => void) => Promise<void> | void) {
  const events: AnyEvent[] = []
  const listeners = new Set<(sessionId: string, event: AnyEvent) => void>()
  let running: Promise<void> = Promise.resolve()
  const emit = (event: AnyEvent) => {
    events.push(event)
    for (const l of listeners) l('s1', event)
  }
  const agent: TurnAgent = {
    id: 's1',
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never, header: { cwd: '/w' } },
    followup: () => { running = Promise.resolve().then(() => script(emit)) },
    whenIdle: () => running,
    cancel: () => { emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }) },
  }
  const feed: SessionEventFeed = listener => {
    listeners.add(listener as never)
    return () => listeners.delete(listener as never)
  }
  return { agent, feed, events }
}

const reply = (text: string): AnyEvent => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const toolCall = (name: string, args: object): AnyEvent => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name, arguments: JSON.stringify(args) } })
const turnStart: AnyEvent = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = (reason: object): AnyEvent => ({ type: 'turn/end', data: { turn: 1, reason } })

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'turn-')); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function options(agentParts: ReturnType<typeof fakeAgent>, extra: Partial<TurnOptions> = {}): TurnOptions {
  return {
    api, agent: agentParts.agent, feed: agentParts.feed, chatId: 5, replyToMessageId: 10,
    content: [{ type: 'text', text: 'hi' }], outboxDir: join(dir, 'outbox'),
    messageSize: 1024, statusEditIntervalMs: 0, turnTimeoutMs: 10_000,
    log: { warn: () => {}, error: () => {} }, ...extra,
  }
}

describe('runTurn', () => {
  it('sends a reply placeholder, then edits it into the rendered answer', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(reply('**done**')); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('edited')
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    const [chatId, text, opts] = api.callsTo('sendMessage')[0]!.args as [number, string, { replyTo?: { messageId: number } }]
    expect([chatId, text, opts.replyTo]).toEqual([5, THINKING_TEXT, { messageId: 10 }])
    const edit = api.callsTo('editMessageText').at(-1)!.args
    expect(edit).toEqual([5, 100, '<b>done</b>', { parseMode: 'HTML' }])
    expect(result.sentMessageId).toBe(100)
  })

  it('edits the placeholder with tool status and skips identical statuses', async () => {
    // Status edits are throttled through a timer, so give each one a tick to flush.
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    const a = fakeAgent(async emit => {
      emit(turnStart)
      emit(toolCall('bash', { command: 'ls' }))
      await tick()
      emit(toolCall('bash', { command: 'ls' }))
      await tick()
      emit(toolCall('read', { path: '/w/a.txt' }))
      await tick()
      emit(reply('ok'))
      emit(turnEnd({ kind: 'completed' }))
    })
    await runTurn(options(a))
    const statuses = api.callsTo('editMessageText').map(c => c.args[2])
    expect(statuses).toEqual(['bash: ls', 'read: /w/a.txt', 'ok'])
  })

  it('sends fresh when the placeholder edit fails', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(reply('answer')); emit(turnEnd({ kind: 'completed' })) })
    api.failNext('editMessageText', new TelegramApiError('message to edit not found', 400))
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('sent')
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe('answer')
  })

  it('retries a rejected send without the collapse wrapper, then as plain text', async () => {
    const long = 'word '.repeat(400)
    const a = fakeAgent(emit => { emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' })) })
    api.failNext('editMessageText', new TelegramApiError("can't parse entities", 400))
    api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
    api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('sent')
    const sends = api.callsTo('sendMessage').slice(1)
    expect(sends).toHaveLength(3)
    expect(sends[0]!.args[1]).toContain('<blockquote expandable>')
    expect(sends[1]!.args[1]).not.toContain('<blockquote expandable>')
    expect(sends[2]!.args[2]).toEqual({ replyTo: { messageId: 10 } })
  })

  it('sends a markdown document when the rendered message exceeds 4096 bytes', async () => {
    const long = 'line of text that is long enough\n'.repeat(200)
    const a = fakeAgent(emit => { emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('document')
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    const [, data, opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption: string; replyTo: object }]
    expect(data.toString('utf8')).toBe(UTF8_BOM + long)
    expect(opts.filename).toMatch(/^response-\d+\.md$/)
    expect(Buffer.byteLength(opts.caption)).toBeLessThanOrEqual(1024)
    expect(opts.replyTo).toEqual({ messageId: 10 })
    expect(await readdir(join(dir, 'outbox'))).toHaveLength(1)
  })

  it('reports undelivered when the document upload fails, without a truncated fallback', async () => {
    const long = 'x'.repeat(5000)
    const a = fakeAgent(emit => { emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' })) })
    api.failNext('sendDocument', new TelegramApiError('too big', 413))
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('undelivered')
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe(UNDELIVERED_NOTICE)
    expect(api.callsTo('sendMessage')).toHaveLength(2)
  })

  it('shows a warning when the turn ends in error', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(turnEnd({ kind: 'error', error: { code: 'LLM_AUTH', message: 'bad key' } })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('error')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe('Error: LLM_AUTH: bad key')
  })

  it('cancels and reports a timeout', async () => {
    let release!: () => void
    const a = fakeAgent(emit => { emit(turnStart); return new Promise<void>(resolve => { release = resolve }) })
    const result = await runTurn(options(a, { turnTimeoutMs: 5 }))
    release()
    expect(result.outcome).toBe('timeout')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toMatch(/timed out/)
  })

  it('reports empty when the agent produced no text', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('empty')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe('(no reply)')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/turn.spec.ts`
Expected: FAIL — cannot find module `../src/turn.ts`.

- [ ] **Step 3: Write `src/turn.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CAPTION_MAX_BYTES,
  TELEGRAM_MAX_MESSAGE_BYTES,
  THINKING_TEXT,
  UNDELIVERED_NOTICE,
  UTF8_BOM,
  byteLength,
  captionPrefix,
  markdownToTelegramHTML,
  renderMessage,
  stripCollapse,
  summarizeToolCall,
} from './render.ts'
import type { TelegramApi } from './telegram-api.ts'

export const STATUS_MAX_CHARS = 60

export interface TurnAgent {
  readonly id: string
  readonly session: {
    readonly seq: number
    eventAt(seq: SessionSeq): SessionEvent | undefined
    readonly header: { readonly cwd?: string }
  }
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'user' }): void
}

export type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void

export interface TurnOptions {
  api: TelegramApi
  agent: TurnAgent
  feed: SessionEventFeed
  chatId: number
  replyToMessageId: number
  content: ContentBlock[]
  outboxDir: string
  messageSize: number
  statusEditIntervalMs: number
  turnTimeoutMs: number
  log: { warn(msg: string): void; error(msg: string): void }
  now?: () => number
}

export type TurnOutcome = 'edited' | 'sent' | 'document' | 'undelivered' | 'error' | 'timeout' | 'empty'

export interface TurnResult {
  outcome: TurnOutcome
  text: string
  sentMessageId?: number
}

/** Last assistant text and any error reason inside the turn(s) since `firstSeq`. */
export function summarizeTurn(session: TurnAgent['session'], firstSeq: number): { text: string; error?: string } {
  let started = false
  let text = ''
  let error: string | undefined
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      const reason = event.data.reason as { kind: 'error'; error: { code: string; message: string } }
      error = `${reason.error.code}: ${reason.error.message}`
    }
  }
  return error === undefined ? { text } : { text, error }
}

/** Throttled placeholder editor that never repeats the visible text. */
class Placeholder {
  private shown = THINKING_TEXT
  private pending: string | undefined
  private timer: NodeJS.Timeout | undefined
  private lastEdit = 0
  private chain = Promise.resolve()

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    readonly messageId: number,
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  status(text: string): void {
    if (text === this.shown || text === this.pending) return
    this.pending = text
    const wait = Math.max(0, this.lastEdit + this.intervalMs - this.now())
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, wait)
  }

  private flush(): Promise<void> {
    const text = this.pending
    this.pending = undefined
    if (text === undefined || text === this.shown) return this.chain
    this.chain = this.chain.then(async () => {
      try {
        await this.api.editMessageText(this.chatId, this.messageId, text)
        this.shown = text
        this.lastEdit = this.now()
      } catch {
        // A failed status edit leaves the old text on screen; the next status retries.
      }
    })
    return this.chain
  }

  /** Stop status edits and wait for in-flight ones. */
  async settle(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    await this.chain
  }

  async replace(text: string, parseMode?: 'HTML'): Promise<boolean> {
    await this.settle()
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, parseMode === undefined ? {} : { parseMode })
      return true
    } catch {
      return false
    }
  }

  async drop(): Promise<void> {
    await this.settle()
    try {
      await this.api.deleteMessage(this.chatId, this.messageId)
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

async function sendPart(api: TelegramApi, chatId: number, part: string, replyToMessageId: number, log: TurnOptions['log']): Promise<number> {
  const replyTo = { messageId: replyToMessageId }
  try {
    return (await api.sendMessage(chatId, part, { parseMode: 'HTML', replyTo })).messageId
  } catch (error) {
    log.warn(`dsh-telegram: HTML send rejected (${String(error)})`)
  }
  const stripped = stripCollapse(part)
  if (stripped !== part) {
    try {
      return (await api.sendMessage(chatId, stripped, { parseMode: 'HTML', replyTo })).messageId
    } catch (error) {
      log.warn(`dsh-telegram: send without collapse rejected (${String(error)})`)
    }
  }
  return (await api.sendMessage(chatId, part, { replyTo })).messageId
}

async function sendMarkdownDocument(options: TurnOptions, markdown: string, html: string): Promise<number> {
  await mkdir(options.outboxDir, { recursive: true })
  const filename = `response-${Date.now()}.md`
  const data = Buffer.from(UTF8_BOM + markdown, 'utf8')
  await writeFile(join(options.outboxDir, filename), data)
  const sent = await options.api.sendDocument(options.chatId, data, {
    filename,
    caption: captionPrefix(html, CAPTION_MAX_BYTES),
    parseMode: 'HTML',
    replyTo: { messageId: options.replyToMessageId },
  })
  return sent.messageId
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { api, agent, chatId, log } = options
  const now = options.now ?? Date.now
  await api.sendChatAction(chatId, 'typing')
  const placeholderId = (await api.sendMessage(chatId, THINKING_TEXT, { replyTo: { messageId: options.replyToMessageId } })).messageId
  const placeholder = new Placeholder(api, chatId, placeholderId, options.statusEditIntervalMs, now)

  const firstSeq = agent.session.seq
  const unsubscribe = options.feed((sessionId, event) => {
    if (sessionId !== agent.id || event.type !== 'tool/call') return
    placeholder.status(summarizeToolCall(event.data.name, event.data.arguments, STATUS_MAX_CHARS))
  })

  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  try {
    agent.followup(createUserMessage({ content: options.content, source: { kind: 'user' } }))
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => { timedOut = true; agent.cancel({ kind: 'user' }); resolve() }, options.turnTimeoutMs)
    })
    await Promise.race([agent.whenIdle(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }

  const summary = summarizeTurn(agent.session, firstSeq)
  if (timedOut) {
    await placeholder.replace(`The reply timed out after ${Math.round(options.turnTimeoutMs / 1000)}s and was stopped.`)
    return { outcome: 'timeout', text: summary.text, sentMessageId: placeholderId }
  }
  if (summary.error !== undefined) {
    await placeholder.replace(`Error: ${summary.error}`)
    return { outcome: 'error', text: summary.text, sentMessageId: placeholderId }
  }
  if (summary.text === '') {
    await placeholder.replace('(no reply)')
    return { outcome: 'empty', text: '', sentMessageId: placeholderId }
  }

  const html = markdownToTelegramHTML(summary.text)
  const rendered = renderMessage(html, options.messageSize)

  if (byteLength(rendered) > TELEGRAM_MAX_MESSAGE_BYTES) {
    await placeholder.drop()
    try {
      const sentMessageId = await sendMarkdownDocument(options, summary.text, html)
      return { outcome: 'document', text: summary.text, sentMessageId }
    } catch (error) {
      log.error(`dsh-telegram: markdown document send failed (${String(error)})`)
      await api.sendMessage(chatId, UNDELIVERED_NOTICE, { replyTo: { messageId: options.replyToMessageId } })
      return { outcome: 'undelivered', text: summary.text }
    }
  }

  if (await placeholder.replace(rendered, 'HTML')) {
    return { outcome: 'edited', text: summary.text, sentMessageId: placeholderId }
  }
  await placeholder.drop()
  const sentMessageId = await sendPart(api, chatId, rendered, options.replyToMessageId, log)
  return { outcome: 'sent', text: summary.text, sentMessageId }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/turn.spec.ts && npm run typecheck`
Expected: PASS. Typing notes: the fake's `eventAt` returns loosely typed events, hence the `as never` casts in the test; keep `src/turn.ts` strictly typed against `SessionEvent`. If `event.data.reason` on `'turn/end'` is not narrowable by `kind`, keep the explicit cast shown above.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/turn.ts packages/dsh-telegram/tests/turn.spec.ts
git commit -m "feat(telegram): turn runner with placeholder status and delivery rules"
```

---

### Task 10: Agent tools

**Files:**
- Create: `packages/dsh-telegram/src/tools.ts`
- Test: `packages/dsh-telegram/tests/tools.spec.ts`

**Interfaces:**
- Consumes: `TelegramApi`, `resolveInsideWorkspace`, `outboundKind` (Task 6), `ChatLog`, `formatEntry` (Task 4).
- Produces:
  ```ts
  interface ToolDeps { api: TelegramApi; chatLog: ChatLog; chatId: number; workspaceDir: string; maxUploadBytes: number }
  function createSendFileTool(deps: ToolDeps): ToolDefinition     // name 'telegram_send_file'
  function createChatHistoryTool(deps: ToolDeps): ToolDefinition  // name 'telegram_chat_history'
  function registerChatTools(agentCtx: { tools: { register(tool: ToolDefinition): () => void }; effect(fn: () => () => void, label?: string): void }, deps: ToolDeps): void
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/tools.spec.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { createChatHistoryTool, createSendFileTool, registerChatTools } from '../src/tools.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tools-')); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

function deps() {
  return { api, chatLog: new ChatLog(join(dir, 'log')), chatId: 5, workspaceDir: dir, maxUploadBytes: 100 }
}

describe('telegram_send_file', () => {
  it('sends an image as a photo and other files as documents', async () => {
    await writeFile(join(dir, 'pic.png'), 'png')
    await writeFile(join(dir, 'notes.txt'), 'txt')
    const tool = createSendFileTool(deps())
    expect(tool.name).toBe('telegram_send_file')
    expect(await tool.execute({ path: 'pic.png' }, exec)).toBe('Sent pic.png')
    expect(await tool.execute({ path: join(dir, 'notes.txt'), caption: 'here' }, exec)).toBe('Sent notes.txt')
    expect(api.callsTo('sendPhoto')).toHaveLength(1)
    const [, , opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption?: string }]
    expect(opts).toMatchObject({ filename: 'notes.txt', caption: 'here' })
  })

  it('refuses paths outside the workspace and oversized files', async () => {
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(200))
    const tool = createSendFileTool(deps())
    await expect(tool.execute({ path: '../secret' }, exec)).rejects.toThrow(/outside/)
    await expect(tool.execute({ path: 'big.bin' }, exec)).rejects.toThrow(/exceeds/)
  })
})

describe('telegram_chat_history', () => {
  it('returns formatted lines oldest first, honouring limit, before and query', async () => {
    const d = deps()
    for (let i = 1; i <= 5; i++) {
      await d.chatLog.append(5, { ts: `t${i}`, message_id: i, user_id: 1, username: 'u', name: 'U', text: i % 2 ? `odd${i}` : `even${i}` })
    }
    const tool = createChatHistoryTool(d)
    expect(tool.name).toBe('telegram_chat_history')
    expect(await tool.execute({ limit: 2 }, exec)).toBe('[t4] @u (U): even4\n[t5] @u (U): odd5')
    expect(await tool.execute({ limit: 10, before_message_id: 3, query: 'odd' }, exec)).toBe('[t1] @u (U): odd1')
    expect(await tool.execute({ limit: 10, query: 'zzz' }, exec)).toBe('(no messages)')
  })
})

describe('registerChatTools', () => {
  it('registers both tools through ctx.effect', () => {
    const registered: string[] = []
    const ctx = {
      tools: { register: (tool: { name: string }) => { registered.push(tool.name); return () => {} } },
      effect: (fn: () => () => void) => { fn() },
    }
    registerChatTools(ctx, deps())
    expect(registered).toEqual(['telegram_send_file', 'telegram_chat_history'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools.spec.ts`
Expected: FAIL — cannot find module `../src/tools.ts`.

- [ ] **Step 3: Write `src/tools.ts`**

```ts
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatEntry, type ChatLog } from './chatlog.ts'
import { outboundKind, resolveInsideWorkspace } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface ToolDeps {
  api: TelegramApi
  chatLog: ChatLog
  chatId: number
  workspaceDir: string
  maxUploadBytes: number
}

const HISTORY_LIMIT_MAX = 100
const HISTORY_LIMIT_DEFAULT = 50

export function createSendFileTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'telegram_send_file',
    description: 'Send a file from the chat workspace to the current Telegram chat. Images are sent as photos, everything else as documents.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path, relative to the workspace or absolute inside it' },
      caption: { type: 'string', description: 'Optional caption shown with the file' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const path = await resolveInsideWorkspace(deps.workspaceDir, args.path)
      const size = (await stat(path)).size
      if (size > deps.maxUploadBytes) {
        throw new Error(`file size ${size} bytes exceeds the upload limit of ${deps.maxUploadBytes} bytes`)
      }
      const data = await readFile(path)
      const filename = basename(path)
      const options = { filename, ...(args.caption === undefined ? {} : { caption: args.caption }) }
      if (outboundKind(path) === 'photo') await deps.api.sendPhoto(deps.chatId, data, options)
      else await deps.api.sendDocument(deps.chatId, data, options)
      return `Sent ${filename}`
    },
  })
}

export function createChatHistoryTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'telegram_chat_history',
    description: 'Read earlier messages of the current Telegram chat, including messages from people the assistant did not reply to. Returns oldest first.',
    parameters: {
      limit: { type: 'integer', description: `Number of messages to return (default ${HISTORY_LIMIT_DEFAULT}, max ${HISTORY_LIMIT_MAX})` },
      before_message_id: { type: 'integer', description: 'Only messages with a smaller Telegram message id' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the message text' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, args.limit ?? HISTORY_LIMIT_DEFAULT))
      const entries = await deps.chatLog.history(deps.chatId, {
        limit,
        ...(args.before_message_id === undefined ? {} : { beforeMessageId: args.before_message_id }),
        ...(args.query === undefined ? {} : { query: args.query }),
      })
      return entries.length === 0 ? '(no messages)' : entries.map(formatEntry).join('\n')
    },
  })
}

interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void }
  effect(fn: () => () => void, label?: string): void
}

/** Register both chat-scoped tools on an agent context; disposal unwinds them. */
export function registerChatTools(agentCtx: ToolHost, deps: ToolDeps): void {
  agentCtx.effect(() => agentCtx.tools.register(createSendFileTool(deps)), 'dsh-telegram: telegram_send_file')
  agentCtx.effect(() => agentCtx.tools.register(createChatHistoryTool(deps)), 'dsh-telegram: telegram_chat_history')
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/tools.spec.ts && npm run typecheck`
Expected: PASS. If `defineTool`'s parameter DSL rejects `type: 'integer'`, use `type: 'number'` for both integer parameters and `Math.floor` the values in `execute`.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-telegram/src/tools.ts packages/dsh-telegram/tests/tools.spec.ts
git commit -m "feat(telegram): telegram_send_file and telegram_chat_history tools"
```

---

### Task 11: Bot wiring and plugin entry

**Files:**
- Create: `packages/dsh-telegram/src/bot.ts`
- Modify: `packages/dsh-telegram/src/index.ts` (replace the Task 2 stub)
- Test: `packages/dsh-telegram/tests/bot.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces `src/bot.ts`:
  ```ts
  const ACK_REACTION: string
  type GateVerdict = 'ignore' | 'log-only' | 'handle'
  function isAllowed(user: TelegramUser, allowFrom: readonly string[]): boolean
  function gate(message: TelegramMessage, options: { allowFrom: readonly string[]; botId: number; botUsername: string }): GateVerdict
  function commandOf(text: string | undefined, botUsername: string): 'reset' | 'stop' | undefined
  interface ImageStore { saveImages(images: Array<{ data: string; mediaType: 'image/jpeg' }>): Promise<Array<{ attachmentId: unknown }>> }
  interface BotDeps {
    api: TelegramApi; config: Config; chatLog: ChatLog; agents: ChatAgents; feed: SessionEventFeed
    attachments: ImageStore; botId: number; botUsername: string
    log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
  }
  function handleMessage(message: TelegramMessage, deps: BotDeps): Promise<void>
  function createDispatcher(deps: BotDeps): (message: TelegramMessage) => void   // per-chat serial queue, errors logged
  ```

- [ ] **Step 1: Write the failing tests**

`packages/dsh-telegram/tests/bot.spec.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandOf, createDispatcher, gate, handleMessage, isAllowed, type BotDeps } from '../src/bot.ts'
import { ChatLog } from '../src/chatlog.ts'
import { Config } from '../src/config.ts'
import type { TelegramMessage } from '../src/inbound.ts'
import { THINKING_TEXT } from '../src/render.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }))

const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const bob = { id: 9, is_bot: false, first_name: 'Bob' }
const mention = [{ type: 'mention', offset: 0, length: 7 }]
function msg(extra: Partial<TelegramMessage>, type: TelegramMessage['chat']['type'] = 'private', id = 10): TelegramMessage {
  return { message_id: id, date: 1_700_000_000, chat: { id: 5, type }, from: ann, ...extra }
}

describe('isAllowed / gate / commandOf', () => {
  it('matches ids and usernames case-insensitively', () => {
    expect(isAllowed(ann, ['7'])).toBe(true)
    expect(isAllowed(ann, ['ANN'])).toBe(true)
    expect(isAllowed(ann, ['@ann'])).toBe(true)
    expect(isAllowed(bob, ['ann'])).toBe(false)
  })
  const g = { allowFrom: ['ann'], botId: 1, botUsername: 'dshbot' }
  it('DM: allowed handles, others ignore', () => {
    expect(gate(msg({ text: 'x' }), g)).toBe('handle')
    expect(gate(msg({ text: 'x', from: bob }), g)).toBe('ignore')
  })
  it('group: requires allowlist and mention or reply-to-bot; otherwise log-only', () => {
    expect(gate(msg({ text: 'hello' }, 'supergroup'), g)).toBe('log-only')
    expect(gate(msg({ text: '@dshbot hi', entities: mention }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ caption: '@dshbot hi', caption_entities: mention }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ text: 'yes', reply_to_message: { ...msg({ text: 'q' }), from: { id: 1, is_bot: true, first_name: 'dsh' } } }, 'supergroup'), g)).toBe('handle')
    expect(gate(msg({ text: '@dshbot hi', entities: mention, from: bob }, 'supergroup'), g)).toBe('log-only')
    expect(gate({ ...msg({ text: 'x' }), from: undefined }, g)).toBe('ignore')
  })
  it('recognises commands with and without the bot suffix', () => {
    expect(commandOf('/reset', 'dshbot')).toBe('reset')
    expect(commandOf('/stop@dshbot', 'dshbot')).toBe('stop')
    expect(commandOf('/stop@other', 'dshbot')).toBeUndefined()
    expect(commandOf('reset please', 'dshbot')).toBeUndefined()
  })
})

describe('handleMessage', () => {
  let dir: string
  let api: FakeTelegramApi
  let deps: BotDeps
  let agents: { resolve: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; markTurn: ReturnType<typeof vi.fn>; lastTurnMessageId: ReturnType<typeof vi.fn>; workspaceFor: ReturnType<typeof vi.fn> }
  let followups: unknown[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bot-'))
    api = new FakeTelegramApi()
    followups = []
    const agent = {
      id: 's1', status: 'idle',
      session: { seq: 0, eventAt: () => undefined, header: { cwd: join(dir, 'ws', '5') } },
      followup: (m: unknown) => { followups.push(m) }, whenIdle: async () => {}, cancel: () => {},
    }
    agents = {
      resolve: vi.fn(async () => ({ agent, resumed: false })),
      reset: vi.fn(async () => {}), stop: vi.fn(() => true), markTurn: vi.fn(async () => {}),
      lastTurnMessageId: vi.fn(() => 0), workspaceFor: vi.fn(() => join(dir, 'ws', '5')),
    }
    deps = {
      api, config: Config({ botToken: 't', allowFrom: ['ann'], workspaceRoot: join(dir, 'ws'), dataDir: dir, model: 'm' }),
      chatLog: new ChatLog(join(dir, 'log')), agents: agents as never, feed: () => () => {},
      attachments: { saveImages: vi.fn(async (images: unknown[]) => images.map((_, i) => ({ attachmentId: `att${i}` }))) },
      botId: 1, botUsername: 'dshbot', log: { info: () => {}, warn: () => {}, error: () => {} },
    }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('ignores strangers in DMs without logging', async () => {
    await handleMessage(msg({ text: 'hi', from: bob }), deps)
    expect(api.calls).toHaveLength(0)
    expect(await deps.chatLog.readAll(5)).toEqual([])
  })

  it('logs untargeted group messages without running a turn', async () => {
    await handleMessage(msg({ text: 'chatter', from: bob }, 'supergroup'), deps)
    expect(api.calls).toHaveLength(0)
    expect((await deps.chatLog.readAll(5))[0]).toMatchObject({ user_id: 9, text: 'chatter' })
    expect(agents.resolve).not.toHaveBeenCalled()
  })

  it('handles /reset and /stop without touching the agent turn', async () => {
    await handleMessage(msg({ text: '/reset' }), deps)
    expect(agents.reset).toHaveBeenCalledWith(5)
    expect(api.callsTo('sendMessage')[0]!.args[1]).toBe('Started a new conversation.')
    await handleMessage(msg({ text: '/stop@dshbot' }), deps)
    expect(agents.stop).toHaveBeenCalledWith(5)
    expect(api.callsTo('sendMessage')[1]!.args[1]).toBe('Stopped.')
  })

  it('runs a turn: reacts, marks the turn, submits text, logs the reply', async () => {
    await handleMessage(msg({ text: 'hello' }), deps)
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, expect.any(String)])
    expect(agents.markTurn).toHaveBeenCalledWith(5, 10)
    expect(followups).toHaveLength(1)
    expect((followups[0] as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'hello' }])
    expect(api.callsTo('sendMessage')[0]!.args[1]).toBe(THINKING_TEXT)
    const log = await deps.chatLog.readAll(5)
    expect(log[0]).toMatchObject({ user_id: 7, text: 'hello' })
  })

  it('injects recent group messages and image blocks', async () => {
    await deps.chatLog.append(5, { ts: 't', message_id: 8, user_id: 9, name: 'Bob', text: 'earlier note' })
    api.files.set('big', { data: Buffer.from('jpg'), filePath: 'p.jpg' })
    await handleMessage(msg({ caption: '@dshbot see', caption_entities: mention, photo: [{ file_id: 'big', width: 2, height: 2 }] }, 'supergroup'), deps)
    const content = (followups[0] as { content: Array<{ type: string; text?: string }> }).content
    expect(content[0]!.text).toBe('Recent group messages:\n- id:9 (Bob): earlier note\n\n@ann (Ann): see')
    expect(content[1]).toEqual({ type: 'image', attachment: { attachmentId: 'att0' } })
  })

  it('tells the chat when a resume failed', async () => {
    agents.resolve.mockResolvedValueOnce({ agent: (await agents.resolve()).agent, resumed: false, resumeFailed: 'corrupt' })
    await handleMessage(msg({ text: 'hi' }), deps)
    expect(api.callsTo('sendMessage')[0]!.args[1]).toMatch(/could not be restored/)
  })

  it('dispatcher serialises turns per chat and survives handler errors', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    agents.resolve
      .mockImplementationOnce(async () => { order.push('a-start'); await new Promise<void>(r => { releaseFirst = r }); order.push('a-end'); throw new Error('boom') })
      .mockImplementationOnce(async () => { order.push('b-start'); throw new Error('boom') })
    const dispatch = createDispatcher(deps)
    dispatch(msg({ text: 'one' }, 'private', 11))
    dispatch(msg({ text: 'two' }, 'private', 12))
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual(['a-start'])
    releaseFirst()
    await new Promise(r => setTimeout(r, 5))
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bot.spec.ts`
Expected: FAIL — cannot find module `../src/bot.ts`.

- [ ] **Step 3: Write `src/bot.ts`**

```ts
import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { senderLabel, type ChatLog, type ChatLogEntry } from './chatlog.ts'
import type { Config } from './config.ts'
import { hasBotMention, logEntryFor, parseInbound, type TelegramMessage, type TelegramUser } from './inbound.ts'
import type { ChatAgents } from './sessions.ts'
import type { TelegramApi } from './telegram-api.ts'
import { runTurn, type SessionEventFeed } from './turn.ts'

/** Reaction placed on every message the agent will answer. */
export const ACK_REACTION = '\u{1F47E}'

export type GateVerdict = 'ignore' | 'log-only' | 'handle'

export interface ImageStore {
  saveImages(images: Array<{ data: string; mediaType: 'image/jpeg' }>): Promise<ReadonlyArray<{ attachmentId: unknown }>>
}

export interface BotDeps {
  api: TelegramApi
  config: Config
  chatLog: ChatLog
  agents: ChatAgents
  feed: SessionEventFeed
  attachments: ImageStore
  botId: number
  botUsername: string
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

export function isAllowed(user: TelegramUser, allowFrom: readonly string[]): boolean {
  const username = user.username?.toLowerCase()
  return allowFrom.some((entry) => {
    const normalized = entry.trim().replace(/^@/, '').toLowerCase()
    return normalized === String(user.id) || (username !== undefined && normalized === username)
  })
}

export function gate(message: TelegramMessage, options: { allowFrom: readonly string[]; botId: number; botUsername: string }): GateVerdict {
  const sender = message.from
  if (sender === undefined || sender.is_bot) return 'ignore'
  const allowed = isAllowed(sender, options.allowFrom)
  if (message.chat.type === 'private') return allowed ? 'handle' : 'ignore'
  const targeted = hasBotMention(message.text, message.entities, options.botUsername)
    || hasBotMention(message.caption, message.caption_entities, options.botUsername)
    || message.reply_to_message?.from?.id === options.botId
  return allowed && targeted ? 'handle' : 'log-only'
}

export function commandOf(text: string | undefined, botUsername: string): 'reset' | 'stop' | undefined {
  const match = /^\/(reset|stop)(?:@(\w+))?\s*$/.exec(text ?? '')
  if (match === null) return undefined
  if (match[2] !== undefined && match[2].toLowerCase() !== botUsername.toLowerCase()) return undefined
  return match[1] as 'reset' | 'stop'
}

function recentBlock(entries: ChatLogEntry[]): string {
  return `Recent group messages:\n${entries.map(e => `- ${senderLabel(e)}: ${e.text}`).join('\n')}`
}

export async function handleMessage(message: TelegramMessage, deps: BotDeps): Promise<void> {
  const verdict = gate(message, { allowFrom: deps.config.allowFrom, botId: deps.botId, botUsername: deps.botUsername })
  if (verdict === 'ignore') return
  const chatId = message.chat.id
  if (verdict === 'log-only') {
    await deps.chatLog.append(chatId, logEntryFor(message))
    return
  }

  const command = commandOf(message.text, deps.botUsername)
  if (command === 'reset') {
    await deps.agents.reset(chatId)
    await deps.api.sendMessage(chatId, 'Started a new conversation.')
    return
  }
  if (command === 'stop') {
    const stopped = deps.agents.stop(chatId)
    await deps.api.sendMessage(chatId, stopped ? 'Stopped.' : 'Nothing is running.')
    return
  }

  const workspaceDir = deps.agents.workspaceFor(chatId)
  const inbound = await parseInbound(message, {
    api: deps.api, inboxDir: join(workspaceDir, 'inbox'), botId: deps.botId, botUsername: deps.botUsername,
  })
  await deps.chatLog.append(chatId, inbound.logEntry)
  await deps.api.setReaction(chatId, message.message_id, ACK_REACTION)

  const resolved = await deps.agents.resolve(chatId)
  if (resolved.resumeFailed !== undefined) {
    await deps.api.sendMessage(chatId, 'The previous conversation could not be restored; starting a new one.')
  }

  let text = inbound.text
  if (inbound.isGroup) {
    const recent = await deps.chatLog.recent(chatId, deps.agents.lastTurnMessageId(chatId), message.message_id, deps.config.recentMessagesLimit)
    if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
  }
  await deps.agents.markTurn(chatId, message.message_id)

  const content: ContentBlock[] = [{ type: 'text', text }]
  if (inbound.images.length > 0) {
    const refs = await deps.attachments.saveImages(inbound.images.map(i => ({ data: i.data.toString('base64'), mediaType: i.mediaType })))
    for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
  }

  const result = await runTurn({
    api: deps.api,
    agent: resolved.agent,
    feed: deps.feed,
    chatId,
    replyToMessageId: message.message_id,
    content,
    outboxDir: join(workspaceDir, 'outbox'),
    messageSize: deps.config.messageSize,
    statusEditIntervalMs: deps.config.statusEditIntervalMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    log: deps.log,
  })

  if (result.text !== '') {
    await deps.chatLog.append(chatId, {
      ts: new Date().toISOString(),
      message_id: result.sentMessageId ?? 0,
      user_id: deps.botId,
      name: deps.botUsername,
      text: result.text,
      bot: true,
    })
  }
  deps.log.info(`dsh-telegram: chat ${chatId} message ${message.message_id} -> ${result.outcome}`)
}

/** Serialises message handling per chat; a failing handler is logged and never blocks the next one. */
export function createDispatcher(deps: BotDeps): (message: TelegramMessage) => void {
  const chains = new Map<number, Promise<void>>()
  return (message) => {
    const chatId = message.chat.id
    const previous = chains.get(chatId) ?? Promise.resolve()
    const next = previous
      .then(() => handleMessage(message, deps))
      .catch((error: unknown) => {
        deps.log.error(`dsh-telegram: message ${message.message_id} in chat ${chatId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      })
      .finally(() => {
        if (chains.get(chatId) === next) chains.delete(chatId)
      })
    chains.set(chatId, next)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bot.spec.ts && npm run typecheck`
Expected: PASS. The `ImageStore` interface is structural so `ctx.attachments` (an `AttachmentStore`) satisfies it; the `as never` cast on the ref is only because `ImageStore` widens `attachmentId` for tests.

- [ ] **Step 5: Replace `src/index.ts` with the real entry**

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { autoRetry } from '@grammyjs/auto-retry'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { Bot } from 'grammy'
import { createDispatcher } from './bot.ts'
import { ChatLog } from './chatlog.ts'
import { assertConfig, Config } from './config.ts'
import { SessionMap } from './session-map.ts'
import { ChatAgents } from './sessions.ts'
import { createGrammyApi } from './telegram-api.ts'
import { registerChatTools } from './tools.ts'
import type { SessionEventFeed } from './turn.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** Services required before the bot starts. */
export const inject = ['agents', 'tools', 'attachments', 'loader']

interface Started { runner: RunnerHandle; agents: ChatAgents }

async function start(ctx: Context, config: Config): Promise<Started> {
  // Wait for the complete application so agent-scoped tools and adapters are composed.
  await ctx.get('loader')?.await()

  const bot = new Bot(config.botToken)
  bot.api.config.use(autoRetry({
    maxRetryAttempts: config.retry.maxAttempts,
    maxDelaySeconds: config.retry.maxDelayMs / 1000,
  }))
  await bot.init()
  const api = createGrammyApi(bot, config.botToken)

  const chatLog = new ChatLog(join(config.dataDir, 'chatlog'))
  const map = new SessionMap(join(config.dataDir, 'telegram-sessions.json'))
  await map.load()

  const feed: SessionEventFeed = listener => ctx.on('session/event', (session, event) => listener(String(session.id), event))
  const maxUploadBytes = config.retry.maxUploadMb * 1024 * 1024
  const agents: ChatAgents = new ChatAgents({
    agents: ctx.agents,
    map,
    workspaceRoot: config.workspaceRoot,
    selection: { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) },
    setup: (agentCtx, _agent, chatId) => {
      registerChatTools(agentCtx, { api, chatLog, chatId, workspaceDir: agents.workspaceFor(chatId), maxUploadBytes })
    },
    log: ctx.logger,
  })

  const dispatch = createDispatcher({
    api, config, chatLog, agents, feed,
    attachments: ctx.attachments,
    botId: bot.botInfo.id,
    botUsername: bot.botInfo.username,
    log: ctx.logger,
  })
  bot.on('message', (update) => { dispatch(update.message) })
  bot.catch((error) => { ctx.logger.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const runner = run(bot)
  ctx.logger.info(`dsh-telegram: polling as @${bot.botInfo.username}`)
  return { runner, agents }
}

export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  let started: Started | undefined
  let stopped = false
  ctx.effect(() => {
    void start(ctx, config).then((result) => {
      if (stopped) {
        void result.runner.stop()
        void result.agents.disposeAll()
        return
      }
      started = result
    }).catch((error: unknown) => {
      ctx.logger.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
    return () => {
      stopped = true
      if (started === undefined) return
      const { runner, agents } = started
      started = undefined
      void runner.stop().then(() => agents.disposeAll())
    }
  }, 'dsh-telegram: bot runner')
}
```

`ctx.logger` provides `info/warn/error`; if its type lacks one of them, wrap it in a small adapter object with the three methods. `update.message` from grammY is structurally compatible with `TelegramMessage`; if TypeScript rejects `chat.type` (grammY includes `'channel'` chats on `message`), cast with `dispatch(update.message as TelegramMessage)`.

- [ ] **Step 6: Run the whole suite, typecheck and build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS, `lib/` regenerated.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-telegram/src/bot.ts packages/dsh-telegram/src/index.ts packages/dsh-telegram/tests/bot.spec.ts
git commit -m "feat(telegram): bot gating, per-chat dispatch and plugin entry"
```

---

### Task 12: End-to-end smoke in Docker and README

**Files:**
- Create: `README.md`
- Modify: `docker/Dockerfile` only if the Task 2 smoke required the pnpm fallback (keep whichever layout worked).

- [ ] **Step 1: Rebuild and boot**

Run (repo root): `docker compose build && docker compose up`
Expected: log line `dsh-telegram: polling as @<bot>`; no stack traces.

- [ ] **Step 2: Manual checklist (record results in the commit message)**

In a DM from an allowlisted account:
1. Send `hello` — reaction appears, `Thinking...` placeholder is a reply to your message and is edited into the answer.
2. Ask for something that runs tools (`list the files in your working directory`) — placeholder shows `bash: ...` / `ls ...` statuses before the answer.
3. Ask for a ~2000-character answer — the visible part is followed by an expandable "Show more" block.
4. Ask for a ~6000-character answer — a `response-<ts>.md` document arrives with a caption; `./workspace/<chat_id>/outbox/` holds the file.
5. Send a photo with the caption `what is in this picture?` — the answer describes the image.
6. Send a text document — `./workspace/<chat_id>/inbox/` holds it and the agent can read it when asked.
7. Ask `send me the file you just read as an attachment` — the file comes back through `telegram_send_file`.
8. Send `/stop` while a long answer is running — the placeholder reports the stop.
9. `docker compose restart` and ask `what did we talk about?` — the previous conversation is remembered.
10. `/reset` then ask the same — the agent no longer remembers.

In a group with the bot (privacy mode disabled):
11. Have another member post two messages, then @mention the bot asking what they said — the answer reflects them (injected context).
12. Ask the bot to search older group messages for a word — `telegram_chat_history` is used.

- [ ] **Step 3: Write `README.md`**

```markdown
# dsh-telegram

A Telegram front end for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one dsh agent per chat, running as a single Docker Compose service.

## Setup

1. Create a bot with @BotFather and copy the token.
2. For group use, run `/setprivacy` in @BotFather and choose **Disable** (or make the bot a group admin) so it sees every group message; the agent uses them as context.
3. `cp .env.example .env` and fill in `DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOW_FROM` (comma-separated Telegram user ids or usernames).
4. `docker compose up -d --build`

Chats get their own working directory under `./workspace/<chat_id>/` (`inbox/` for files you send, `outbox/` for long replies saved as `.md`). Conversation state lives in the `dsh-home` volume; the chat-to-session map and chat logs live in `./data/`.

## Commands

- `/reset` starts a new conversation for the chat.
- `/stop` cancels the running reply.

## Behaviour

- In groups the bot answers only allowlisted users who @mention it or reply to it; other messages are logged and offered to the agent as context.
- Replies longer than the configured `messageSize` fold the remainder behind "Show more"; replies that do not fit one Telegram message are sent as a `.md` file.
- The agent can send files from the chat workspace with `telegram_send_file` and read earlier chat messages with `telegram_chat_history`.
- The container runs dsh with `DSH_PERMISSION_MODE=danger-full-access`; the container is the sandbox.

## Configuration

Plugin options are set in `packages/dsh-telegram/cordis.patch.yml` and can be overridden per deployment in `profile/telegram/cordis.patch.yml`. See `packages/dsh-telegram/src/config.ts` for every field and default.

## Development

```sh
cd packages/dsh-telegram
npm install
npm test
npm run build
```
```

- [ ] **Step 4: Commit**

```bash
git add README.md docker docker-compose.yml
git commit -m "docs: README and verified Docker smoke checklist"
```

---

## Self-review notes

- Spec coverage: config table (Task 1), bundle/profile/Docker (Tasks 2, 12), inbound rules incl. mention/reply/media/sticker/quote/labels (Task 7), gating and log-only (Task 11), chat log + recent injection + history tool (Tasks 4, 10, 11), session map + create/resume/reset/stop + workspace per chat (Tasks 5, 8), placeholder/status/collapse/document/undelivered/error/timeout (Tasks 3, 9), `telegram_send_file` with path and size checks (Task 10), auto-retry (Task 11 entry), README privacy-mode note (Task 12).
- Deviation from the spec recorded here: the profile is hand-written and the plugin is copied into the profile's `node_modules` in the image instead of `dsh plugin add`; Task 2 has the pnpm fallback if module resolution through `$DSH_HOME/profiles/node_modules` does not work.
- Markdown blockquotes are stripped (not converted to `<blockquote>`) exactly as einoclaw does; the spec's "blockquotes are converted" is superseded by the ported tests.
