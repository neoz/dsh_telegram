import z from '@deepseek-ai/schemastery'
import type { MemoryLimits } from './memory.ts'

/** Bot API retry and upload limits. */
export interface RetryConfig {
  readonly maxAttempts: number
  readonly startDelayMs: number
  readonly maxDelayMs: number
  readonly maxUploadMb: number
}

/** Placeholder texts shown while a turn runs; tools map onto a group, never their arguments. */
export interface StatusLabels {
  readonly thinking: string
  readonly web: string
  readonly read: string
  readonly write: string
  readonly command: string
  readonly send: string
  readonly other: string
}

/** Plugin configuration; see the design spec for field semantics. */
export interface Config {
  readonly botToken: string
  readonly allowFrom: string[]
  readonly workspaceRoot: string
  readonly dataDir: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly messageSize: number
  readonly recentMessagesLimit: number
  readonly statusEditIntervalMs: number
  readonly turnTimeoutMs: number
  /** How long getUpdates keeps retrying after failures before the bot gives up. */
  readonly pollRetryMs: number
  /** Inbox and outbox files untouched for this many days are deleted. */
  readonly fileRetentionDays: number
  readonly retry: RetryConfig
  readonly status: StatusLabels
  /** Telegram user ids allowed to add, replace, or forget global memory entries. */
  readonly superAdmins: number[]
  readonly memory: MemoryLimits
}

const DEFAULT_STATUS: StatusLabels = {
  thinking: 'Thinking...',
  web: 'Searching the web...',
  read: 'Reading files...',
  write: 'Editing files...',
  command: 'Running a command...',
  send: 'Sending a file...',
  other: 'Working...',
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
  pollRetryMs: z.number().min(1).default(86_400_000),
  fileRetentionDays: z.number().min(1).default(365),
  retry: z.object({
    maxAttempts: z.number().min(1).default(4),
    startDelayMs: z.number().min(0).default(500),
    maxDelayMs: z.number().min(0).default(8000),
    maxUploadMb: z.number().min(1).default(20),
  }).default({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000, maxUploadMb: 20 }),
  status: z.object({
    thinking: z.string().default(DEFAULT_STATUS.thinking),
    web: z.string().default(DEFAULT_STATUS.web),
    read: z.string().default(DEFAULT_STATUS.read),
    write: z.string().default(DEFAULT_STATUS.write),
    command: z.string().default(DEFAULT_STATUS.command),
    send: z.string().default(DEFAULT_STATUS.send),
    other: z.string().default(DEFAULT_STATUS.other),
  }).default(DEFAULT_STATUS),
  superAdmins: z.array(z.number()).default([]),
  memory: z.object({
    maxEntries: z.number().min(1).default(50),
    maxGlobalEntries: z.number().min(1).default(50),
    maxEntryChars: z.number().min(1).default(200),
  }).default({ maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertConfig(config: Config): void {
  if (config.allowFrom.length === 0) throw new Error('dsh-telegram: allowFrom must list at least one user id or username')
  for (const key of ['workspaceRoot', 'dataDir'] as const) {
    if (!config[key].startsWith('/') && !/^[A-Za-z]:[\/]/.test(config[key])) {
      throw new Error(`dsh-telegram: ${key} must be an absolute path`)
    }
  }
}
