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
    if (!config[key].startsWith('/') && !/^[A-Za-z]:[\/]/.test(config[key])) {
      throw new Error(`dsh-telegram: ${key} must be an absolute path`)
    }
  }
}
