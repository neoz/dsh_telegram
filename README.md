# dsh-telegram

A Telegram front end for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one dsh agent per chat, running as a single Docker Compose service.

## Setup

1. Create a bot with @BotFather and copy the token.
2. For group use, run `/setprivacy` in @BotFather and choose **Disable** (or make the bot a group admin) so it sees every group message; the agent uses them as context.
3. `cp .env.example .env` and fill in `DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOW_FROM` (comma-separated Telegram user ids or usernames). `TELEGRAM_SUPER_ADMINS` (comma-separated user ids) lists who may edit the global memory.
4. `docker compose up -d` (pulls the release image `ghcr.io/neoz/dsh-telegram:latest`), or `docker compose -f docker-compose.dev.yml up -d --build` to build locally. `.\build-and-push.ps1` builds the release image and pushes it to ghcr.io.

Chats get their own working directory under `./workspace/<chat_id>/` (`inbox/` for files you send, `outbox/` for long replies saved as `.md`). Conversation state lives in the `dsh-home` volume; the chat-to-session map and chat logs live in `./data/`.

## Commands

- `/reset` starts a new conversation for the chat.
- `/stop` cancels the running reply.

## Memory

The agent keeps a small persistent memory per chat (a private chat remembers that user; a group remembers that group) and one global memory shared by every chat. Entries are short facts stored as JSON under `./data/memory/` (`<chat_id>.json`, `global.json`), so they survive `/reset` and container recreation and can be edited by hand. The agent uses `memory_save`, `memory_recall`, and `memory_forget`; the memory of the chat and the global memory are shown to the agent once at the start of each conversation.

Caps default to 50 entries per chat, 50 global entries, and 200 characters per entry (`memory.maxEntries`, `memory.maxGlobalEntries`, `memory.maxEntryChars` on the `telegram` row). When a scope is full the agent must replace or forget an entry before saving another. Only the user ids in `TELEGRAM_SUPER_ADMINS` can add, replace, or forget global entries, and only from a private chat with the bot.

## Behaviour

- In groups the bot answers only allowlisted users who @mention it or reply to it; other messages are logged and offered to the agent as context.
- Replies longer than the configured `messageSize` fold the remainder behind "Show more"; replies that do not fit one Telegram message are sent as a `.md` file.
- The agent can send files from the chat workspace with `telegram_send_file` and read earlier chat messages with `telegram_chat_history`.
- The container runs dsh with `DSH_PERMISSION_MODE=danger-full-access`; the container is the sandbox.

## Web search

`web_search` runs against a self-hosted [SearXNG](https://docs.searxng.org/) instance (the `searxng` compose service, built from `docker/searxng/`) through the community `dsh-web-search-searxng` bundle, so searches need no API key and cost no model turn. `SEARXNG_SECRET` in `.env` is any random string. Engines, language and safe-search filters can be set on the `web-search-searxng` row in `profile/telegram/cordis.patch.yml`; to switch back to DeepSeek native search, set `searchProvider: deepseek-official` on the `web` row there.

## Configuration

Plugin options are set in `packages/dsh-telegram/cordis.patch.yml` and can be overridden per deployment in `profile/telegram/cordis.patch.yml`. See `packages/dsh-telegram/src/config.ts` for every field and default. `DSH_LOG_LEVEL` (default `2`) controls console log verbosity; `DSH_MODEL` selects the model.

## How it is deployed

The image installs `@deepseek-ai/dsh` globally (version pinned by `ARG DSH_VERSION` in `docker/Dockerfile`) and copies the built plugin into `$DSH_HOME/profiles/telegram/node_modules/dsh-telegram` on every start (`docker/entrypoint.sh`). The plugin declares the dsh packages as peer dependencies; at runtime they resolve from the dsh installation through `$DSH_HOME/profiles/node_modules`, so only grammY and its helpers ship inside the plugin.

## Development

```sh
cd packages/dsh-telegram
pnpm install
pnpm test
pnpm run build
```
