import type { ChatKey } from '../keys.ts'
import type { ChatLogEntry } from '../log/chatlog.ts'
import type { ChatSender } from '../sessions/agents.ts'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface InboundImage { data: Uint8Array; mediaType: ImageMediaType }

/** What reached the chat. `messageId` and `text` are set when a new message was posted. */
export interface Delivered {
  as: 'native' | 'fallback'
  messageId?: string
  text?: string
}

/** How a turn ended, for the channel to render; `text` is empty for `empty`. */
export interface TurnReport {
  kind: 'reply' | 'timeout' | 'error' | 'stopped' | 'empty'
  text: string
  error?: string
  timeoutMs: number
}

/** One turn's view of the chat, opened right before the agent runs. */
export interface TurnSink {
  /** The agent called this tool; Telegram edits its placeholder, Zalo ignores it. */
  status(tool: string): void
  /** Renders the end of the turn; `outcome` is the channel's own word for what it did, for the log line. */
  deliver(report: TurnReport): Promise<{ outcome: string; messageId?: string }>
  /** Always called once, after `deliver` or after a failure. */
  close(): void
}

/** A chat transport; the core states intents and the channel decides how its platform carries them. */
export interface ChatChannel {
  readonly id: string
  /** `name` is written as the chat-log name of the bot's own lines. */
  readonly bot: { id: string; name: string }
  openTurn(chatId: string, origin: { replyTo?: string }): Promise<TurnSink>
  /** Sends a message outside any turn (commands, idle, schedule). */
  send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<Delivered>
  /** Reacts to one message the way this platform can. */
  react(chatId: string, messageId: string, emoji: string): Promise<Delivered>
}

/** What `InboundMessage.load` returns; `text` and `images` are empty in `log` mode. */
export interface LoadedMessage { logEntry: ChatLogEntry; text: string; images: InboundImage[] }

/** One incoming message, normalized by its adapter. Bots and the bot itself never reach the core. */
export interface InboundMessage {
  chatKey: ChatKey
  messageId: string
  sender: ChatSender
  isGroup: boolean
  /** The adapter decides whether the bot was mentioned, replied to or triggered. */
  addressed: boolean
  /** Text with the mention or trigger stripped; commands are read from it. */
  text: string
  /** When the sender sent it, in epoch ms. */
  at: number
  /** Runs inside the chat's queue: downloads media and builds the log line and, in `turn` mode, the agent text. */
  load(mode: 'log' | 'turn'): Promise<LoadedMessage>
}

/** A turn nobody typed (a scheduled reminder): nothing to quote, react to or mark. */
export interface PromptInput { text: string; sender: ChatSender; isGroup: boolean }
