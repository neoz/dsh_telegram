import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { InboundImage } from '../router/channel.ts'
import { extractFrames, type FrameOptions } from './frames.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatVideo: ChatVideo
  }
}

/** Turns a downloaded video into stills a vision model can read. */
export interface ChatVideo {
  frames(path: string): Promise<InboundImage[]>
}

export const Config: z<FrameOptions> = z.object({
  frames: z.number().min(1).max(12).default(6),
  maxWidth: z.number().min(128).default(768),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-video'

/** Needs `ffmpeg` and `ffprobe` on PATH. */
export function apply(ctx: Context, config: FrameOptions): void {
  const video: ChatVideo = { frames: path => extractFrames(path, config) }
  ctx.effect(() => ctx.provide('chatVideo', video), 'dsh-chat: chatVideo')
}
