import z from '@deepseek-ai/schemastery'

/** Bot API retry limits. */
export interface RetryConfig {
  readonly maxAttempts: number
  readonly startDelayMs: number
  readonly maxDelayMs: number
}

/** Plugin configuration; see the design spec for field semantics. */
export interface Config {
  readonly botToken: string
  /** Zalo user ids allowed to get a turn. */
  readonly allowFrom: string[]
  /** A group message starting with this word gets a turn, like a mention. */
  readonly groupPrefix: string
  /** Max characters per sent message; Zalo rejects more than 2000. */
  readonly messageSize: number
  readonly pollTimeoutSec: number
  readonly typingIntervalMs: number
  readonly recentMessagesLimit: number
  readonly turnTimeoutMs: number
  /** Inbound photos larger than this are not downloaded. */
  readonly maxDownloadMb: number
  readonly retry: RetryConfig
  /** Zalo user ids allowed to run commands and edit global memory. */
  readonly superAdmins: string[]
}

export const Config: z<Config> = z.object({
  botToken: z.string().required(),
  allowFrom: z.array(z.string()).required(),
  groupPrefix: z.string().default('/ask'),
  messageSize: z.number().min(500).max(2000).default(2000),
  pollTimeoutSec: z.number().min(1).max(60).default(30),
  typingIntervalMs: z.number().min(1000).default(4000),
  recentMessagesLimit: z.number().min(0).default(30),
  turnTimeoutMs: z.number().min(1).default(900_000),
  maxDownloadMb: z.number().min(1).default(20),
  retry: z.object({
    maxAttempts: z.number().min(1).default(4),
    startDelayMs: z.number().min(0).default(500),
    maxDelayMs: z.number().min(0).default(8000),
  }).default({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000 }),
  superAdmins: z.array(z.string()).default([]),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertConfig(config: Config): void {
  if (config.allowFrom.length === 0) throw new Error('dsh-zalo: allowFrom must list at least one Zalo user id')
}
