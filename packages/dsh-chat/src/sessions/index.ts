import type { Context } from '@deepseek-ai/cordis'
import type { ChatKey } from '../keys.ts'
import type { TurnContext } from './agents.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAgents: { turnOf(key: ChatKey): TurnContext | undefined }
  }
  interface Events {
    /** A chat's agent was created or resumed; plugins register that chat's tools on `agentCtx`. */
    'chat/agent'(agentCtx: Context, key: ChatKey): void
  }
}
