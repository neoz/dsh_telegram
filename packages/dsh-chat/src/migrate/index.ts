import type {} from '@deepseek-ai/cordis'

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
