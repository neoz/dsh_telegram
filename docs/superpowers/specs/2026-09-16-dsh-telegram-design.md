# dsh-telegram: Telegram channel plugin for DeepSeek Harness

Date: 2026-09-16
Status: approved design, pending implementation plan

## Goal

Run a DeepSeek Harness (`dsh`) agent behind a Telegram bot, in one Docker Compose
service, with the Telegram user experience of einoclaw's Telegram channel
(`D:\working\go\einoclawprj\einoclaw\internal\channels\telegram\telegram.go`):
placeholder editing, tool status, collapsed long replies, `.md` attachment for
very long replies, reply quoting, inbound media, outbound files, `/reset` and
`/stop`.

## Decisions already made

| Topic | Decision |
|---|---|
| Integration | In-process Cordis plugin (`dsh-telegram`) loaded through a custom `dsh` profile. Not the SDK bridge: the SDK server cannot resume persisted sessions and has no cancel. |
| dsh source | npm `@deepseek-ai/dsh@0.1.5-rc.1`, pinned in the Dockerfile. |
| Users | The owner plus a few allowlisted people, in DMs and groups. |
| Workspace | One sub-directory per chat: `/workspace/<chat_id>/`. |
| Permissions | `DSH_PERMISSION_MODE=danger-full-access`; the container is the sandbox. No approval prompts in v1. |
| History across restarts | Required. `chat_id -> sessionId` map persisted on a volume; `ctx.agents.resume()` on first message after restart. |
| Group context | Every group message the bot sees is written to a per-chat JSONL log. New messages since the last turn are injected into the next prompt; a `telegram_chat_history` tool reads older ones. |
| Telegram client | grammY with `auto-retry` and long polling. |

## Repository layout

```
dsh/
  packages/dsh-telegram/
    package.json              # name "dsh-telegram", ESM, main lib/index.js
    tsconfig.json
    src/
      index.ts                # name, inject, Config schema, apply
      bot.ts                  # grammY bot: polling, allowlist, group gating, inbound parsing
      sessions.ts             # chat_id <-> sessionId map, create/resume/reset/stop
      turn.ts                 # one agent turn: followup, observe events, placeholder, deliver
      render.ts               # markdown -> Telegram HTML, cleanCut, renderMessage, collapse, captionPrefix, repairHTMLTags
      media.ts                # inbound downloads, outbound photo/document, path validation
      chatlog.ts              # per-chat JSONL log, recent-window query, history query
      tools.ts                # telegram_send_file, telegram_chat_history (agent-scoped)
    tests/                    # vitest
  profile/telegram/
    package.json              # dsh.profile { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" }, dependency on dsh-telegram
    cordis.patch.yml
  docker/Dockerfile
  docker-compose.yml
  .env.example
  README.md
```

The plugin depends on `@deepseek-ai/cordis` (peer), `@deepseek-ai/dsh-agent`,
`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-attachment`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`, `grammy`, `@grammyjs/auto-retry`, `@grammyjs/runner`.
Exact package names are verified against the installed 0.1.5-rc.1 during
implementation; the design assumes the APIs listed under "dsh APIs used".

## Plugin configuration

`Config` is a Schemastery object; every field is either required or has a
default. Secrets arrive through `!!js process.env.*` in `cordis.patch.yml`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `botToken` | string, required | — | Telegram bot token |
| `allowFrom` | string[], required, non-empty | — | user ids or usernames allowed to trigger the agent |
| `workspaceRoot` | string, required | — | absolute; per-chat cwd is `<workspaceRoot>/<chat_id>` |
| `dataDir` | string, required | — | absolute; holds `telegram-sessions.json` and `chatlog/<chat_id>.jsonl` |
| `provider` | string | `deepseek-official` | model route |
| `model` | string, required | — | e.g. `deepseek-v4-flash` |
| `reasoningEffort` | string, optional | — | adapter-owned effort id |
| `messageSize` | number 1000..3400 | 1024 | visible bytes before the collapse wrapper |
| `recentMessagesLimit` | number >= 0 | 30 | max injected group messages per turn |
| `statusEditIntervalMs` | number >= 0 | 1000 | minimum spacing between placeholder edits |
| `turnTimeoutMs` | number > 0 | 900000 | soft cap per turn before `cancel()` |
| `retry.maxAttempts` | number >= 1 | 4 | Bot API retry attempts |
| `retry.startDelayMs` | number | 500 | first backoff |
| `retry.maxDelayMs` | number | 8000 | backoff ceiling and `retry_after` ceiling |
| `retry.maxUploadMb` | number | 20 | outbound file size ceiling |

Misconfiguration fails at load (Schema `required`, absolute-path checks in
`apply`).

## Inbound flow (`bot.ts`)

1. Only `message` updates from a human `from` are handled; edited messages,
   channel posts and bot senders are ignored.
2. The message is appended to the chat log first (see Chat log), regardless
   of allowlist or gating, so group context is complete.
3. Gating:
   - DM: sender must be in `allowFrom`; otherwise ignore silently.
   - Group: sender must be in `allowFrom` **and** the message must @mention the
     bot (text or caption entities) or reply to a bot message; otherwise it is
     log-only.
4. `/reset` and `/stop` are handled before any agent work (see Sessions).
5. Content assembly, producing `ContentBlock[]` for one `user/message`:
   - Text: `message.text` / `message.caption`. In groups the bot mention is
     stripped and the text is prefixed with a sender label
     `@username (First Name): ` (or `id:<id> (First Name): ` without username).
   - Reply context: if the message replies to another message, its text (or
     caption) is prepended as a blockquote `> <sender>: <text>`. A photo in the
     replied-to message from a non-bot sender is downloaded as well.
   - Photos (highest resolution) are downloaded and admitted through the
     attachment service (`admitEncodedImages`) into `ImageBlock`s so the model
     sees them.
   - Documents, voice (`.ogg`), audio (`.mp3`) are saved under
     `<cwd>/inbox/<original or generated filename>` and referenced in the text
     as `[file: <path>]`, `[voice: <path>]`, `[audio: <path>]`.
   - Stickers become `[sticker: <emoji>]`; an otherwise empty message becomes
     `[empty message]`.
   - Group context injection: messages from the chat log with
     `message_id > lastTurnMessageId`, excluding the triggering message, at most
     `recentMessagesLimit` newest, rendered as a leading block
     `Recent group messages:\n- <sender>: <text>` in the same text block. This
     keeps model-visible input inside the logged `user/message`.
6. The bot reacts to the message with an acknowledgement emoji, then hands the
   assembled content and the message id to `turn.ts`.

Telegram privacy mode must be disabled (BotFather `/setprivacy`) or the bot must
be a group admin; otherwise group messages that do not mention the bot never
arrive. The README states this.

## Sessions (`sessions.ts`)

- Key: Telegram `chat_id`. Map file: `<dataDir>/telegram-sessions.json`
  (`{ [chat_id]: { sessionId, lastTurnMessageId } }`), written atomically
  (temp file + rename) after every change.
- Resolving an agent for a chat:
  1. `ctx.agents.get(sessionId)` live -> use it.
  2. Map has a `sessionId` -> `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`.
     If resume fails, log the error, drop the map entry, notify the chat with
     one line, and fall through to create.
  3. Otherwise mkdir `<workspaceRoot>/<chat_id>`, `ctx.agents.create({ sessionId: <new id>, meta: { cwd }, agentOptions, setup })`, store the map entry.
- `agentOptions` = `{ provider, model, reasoningEffort? }` from config.
- `setup(agentCtx, agent)` registers the two agent-scoped tools (see Tools) bound
  to that chat id.
- Agents stay live between turns; they are disposed on `/reset` and when the
  plugin unloads (a single `ctx.effect` disposer walks the live handles).
- `/reset`: dispose the live handle if any, delete the map entry, reply
  "Started a new conversation." The old session log stays on disk.
- `/stop`: if the agent is running, `handle.agent.cancel(new Error('stopped by user'))`
  and reply "Stopped."; otherwise reply "Nothing is running."
- A message arriving while the agent is busy is submitted with `followup()`;
  the dsh inbox queues it. No debouncing.

## Turn flow (`turn.ts`)

One turn owns one Telegram message and runs until the agent reports idle.

1. Send `typing` chat action and a placeholder `Thinking...` as a reply to the
   triggering message (`reply_parameters`, `allow_sending_without_reply`).
   The placeholder is a reply from birth because an edit cannot change the
   reply target.
2. Subscribe to the agent's session events; submit the content with
   `handle.agent.followup({ content, source: { kind: 'user' } })`.
3. On each `tool/call`: edit the placeholder to `<tool>: <argument summary>`
   (summary <= 60 chars, single line). Skip when the text is unchanged
   (Telegram answers 400 for identical edits); enforce `statusEditIntervalMs`
   between edits, coalescing to the latest status.
4. On `agent/status` idle (or `handle.agent.whenIdle()`): take the last
   `assistant/message` of this turn, concatenate its text blocks, and deliver
   (see Delivery). Record `lastTurnMessageId` for the chat.
5. On `agent/error`: edit the placeholder to a one-line warning and end the
   turn.
6. `turnTimeoutMs` elapsed: `cancel()`, edit the placeholder to a timeout
   notice, end the turn.
7. The delivered reply is appended to the chat log as a bot message.

## Delivery (`render.ts`, ported from einoclaw)

Given the reply markdown:

1. `html = markdownToTelegramHTML(markdown)`: code blocks and inline code are
   extracted first and re-inserted verbatim as `<pre><code>` / `<code>`;
   bold, italic, strikethrough, links, headings (rendered bold) and blockquotes
   are converted; everything else is HTML-escaped; `repairHTMLTags` closes
   any tag left open.
2. `text = renderMessage(html, messageSize)`:
   - `len(html) <= messageSize * 1.2` -> `html` unchanged.
   - otherwise `cut = cleanCut(html, messageSize)` (backs up to a rune
     boundary, then to the nearest `\n\n`, `\n`, `. `, or space, accepting only
     a break past `messageSize / 2`); `head = repairHTMLTags(html[:cut])`,
     `tail = html[cut:]`; result is `head + "\n" + collapse(tail)` where
     `collapse` wraps in `<blockquote expandable>` unless the tail already
     contains a blockquote, in which case `<tg-spoiler>`.
3. If `len(text) > 4096`: delete the placeholder, write the original markdown
   (UTF-8 BOM prefix) to `<cwd>/outbox/response-<timestamp>.md`, and send it
   as a document replying to the triggering message with caption
   `captionPrefix(html, 1024)` (clean cut, tags repaired, suffix noting the
   attachment). If the upload fails, send a plain-text "The reply could not be
   delivered." notice and log the error; never send a truncated reply.
4. Otherwise edit the placeholder into `text` (HTML parse mode). If the edit
   fails, delete the placeholder and send `text` fresh. A send that Telegram
   rejects for markup is retried without the collapse wrapper, then as plain
   text.

Lengths are measured in UTF-8 bytes as in einoclaw, which is stricter than
Telegram's UTF-16 limit and therefore safe.

## Tools (`tools.ts`), registered per agent in `setup`

- `telegram_send_file({ path, caption? })`: resolves `path` against the chat
  cwd, rejects anything outside it (realpath check) or above
  `retry.maxUploadMb`; image extensions go through `sendPhoto`, everything
  else through `sendDocument`; returns `Sent <basename>` or the error text.
- `telegram_chat_history({ limit?, before_message_id?, query? })`: reads the
  chat's own JSONL backwards; `limit` <= 100 (default 50); `query` is a
  case-insensitive substring filter; returns lines
  `[<iso time>] <sender>: <text>` oldest first.

Tool schemas are defined with the dsh tool DSL from `docs/user/develop/basic/tool.md`.

## Chat log (`chatlog.ts`)

Append-only JSONL at `<dataDir>/chatlog/<chat_id>.jsonl`, one object per line:
`{ ts, message_id, user_id, username, name, text, reply_to?, media?: string[], bot?: true }`.
Bot replies are logged with `bot: true` and the sent message id. Reads load the
whole file and scan from the tail; files are small at this scale (revisit if a
chat log exceeds tens of MB).

## Media (`media.ts`)

- Inbound: `getFile` + download via the Bot API file URL into
  `<cwd>/inbox/`; filenames are sanitized (basename only, no path separators,
  collision suffix). Photos are read into memory for attachment admission and
  not kept on disk.
- Outbound: see `telegram_send_file`; uploads are buffered in memory so a retry
  never re-sends a drained stream (`maxUploadMb` bounds this).

## Profile and Docker

`profile/telegram/package.json`:

```json
{
  "name": "dsh-profile-telegram",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"], "patchReload": "startup" } },
  "dependencies": { "dsh-telegram": "file:../../packages/dsh-telegram" }
}
```

`profile/telegram/cordis.patch.yml`:

```yaml
- id: system-prompt
  config:
    personaPrefix: You are a helpful assistant reachable through Telegram, powered by the {{model}} model.
    personaSuffix: Your working directory is {{cwd}}. Replies are rendered by Telegram; prefer concise markdown.
- id: session-title-llm
  disabled: true
- insert:
    - id: telegram
      name: dsh-telegram
      config:
        botToken: !!js process.env.TELEGRAM_BOT_TOKEN
        allowFrom: !!js (process.env.TELEGRAM_ALLOW_FROM ?? '').split(',').map(s => s.trim()).filter(Boolean)
        workspaceRoot: /workspace
        dataDir: /data
        model: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
```

`docker/Dockerfile` (multi-stage):

1. `builder` (`node:22-slim`): copy `packages/dsh-telegram`, `npm ci`, `npm run build`.
2. `runtime` (`node:22-slim`): install `git` and `ripgrep`; `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`;
   `DSH_HOME=/dsh-home`; copy the built plugin and `profile/telegram` to
   `$DSH_HOME/profiles/telegram`, `npm install --omit=dev` there; create a
   non-root `dsh` user owning `/dsh-home`, `/workspace`, `/data`;
   `CMD ["dsh", "--profile", "telegram"]`.

`docker-compose.yml`: one service `dsh-telegram`, `build: { context: ., dockerfile: docker/Dockerfile }`,
`env_file: .env`, `environment: DSH_PERMISSION_MODE=danger-full-access`,
volumes `./workspace:/workspace`, `./data:/data`, named volume `dsh-home:/dsh-home`,
`restart: unless-stopped`.

`.env.example`: `DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOW_FROM`, `DSH_MODEL`.

## Error handling

- Missing or invalid config fails plugin load loudly.
- Polling errors are logged and the runner reconnects; a throwing update
  handler never stops the bot.
- Every Bot API call goes through `auto-retry` (429 honours `retry_after` up to
  `retry.maxDelayMs`; network errors and 5xx back off exponentially from
  `retry.startDelayMs`; other 4xx fail immediately). Final failures are logged
  with `chat_id`.
- Resume failure falls back to a new session and tells the user.
- Agent errors and turn timeouts are surfaced on the placeholder.

## dsh APIs used

- `ctx.agents.create / resume / get` and `AgentHandle` (`agent.followup`, `agent.cancel`, `agent.whenIdle`, `dispose`).
- Session events: `tool/call`, `assistant/message`, `agent/status`, `agent/error`.
- Attachment admission: `admitEncodedImages(ctx.attachments, [...])` -> `ImageBlock`.
- Tool registration through `agentCtx.tools.register(...)` inside `setup`.
- `ctx.effect()` for the bot runner lifecycle and live-agent disposal.

Names are verified against the pinned npm version at the start of
implementation; any drift is recorded in the implementation plan.

## Testing

Vitest, no network, no API key:

- `render.spec.ts`: cases ported from `telegram_test.go` — markdown conversion,
  code block preservation, `cleanCut` boundaries, 1.2x threshold, collapse vs
  spoiler, `captionPrefix`, `repairHTMLTags`, document threshold at 4096.
- `turn.spec.ts`: fake Bot API recorder + fake agent emitting events; asserts
  the placeholder -> status -> answer sequence, identical-status skip, edit
  failure fallback, document path, undelivered notice, error and timeout.
- `sessions.spec.ts`: create / resume / reset / stop against a fake `agents`
  registry and a temp map file; resume failure fallback.
- `chatlog.spec.ts`: append, recent window excluding the trigger, history tool
  filters.
- `media.spec.ts`: path escape rejection, size ceiling, photo vs document routing,
  filename sanitization.
- Manual smoke: `docker compose up`, send text, photo, document, long prompt,
  `/stop`, `/reset`, restart the container and confirm history continues.

## Out of scope (v1)

- Approval prompts over Telegram (inline Allow/Deny), user-question routing.
- Observe-only agent reactions to non-targeted group messages.
- Webhook mode, multiple bots, per-user agent presets.
- Cleanup of `inbox/` and `outbox/` files; the workspace volume is the owner's.
