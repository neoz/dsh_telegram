import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { InboundImage } from '../router/channel.ts'

const run = promisify(execFile)
const TIMEOUT_MS = 60_000
/**
 * The clip is untrusted: a playlist or concat file could make ffmpeg fetch URLs or read local files,
 * so only plain files and real video containers are opened.
 */
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,gif,avi']

export interface FrameOptions {
  /** Stills taken per video. */
  readonly frames: number
  /** Wider stills are scaled down to this width. */
  readonly maxWidth: number
}

/** Container duration in seconds, 0 when ffprobe cannot tell. */
async function durationOf(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', ...INPUT_GUARD, '-show_entries', 'format=duration', '-of', 'csv=p=0', `file:${path}`], { timeout: TIMEOUT_MS })
  const seconds = Number.parseFloat(stdout)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

/** Up to `frames` JPEG stills spread evenly over the video, in playback order. */
export async function extractFrames(path: string, options: FrameOptions): Promise<InboundImage[]> {
  const duration = await durationOf(path)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-frames-'))
  try {
    // One still per equal slice of the clip; an unknown duration falls back to one per second.
    const rate = duration > 0 ? `${options.frames}/${duration}` : '1'
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', ...INPUT_GUARD, '-i', `file:${path}`,
      '-vf', `fps=${rate},scale=w='min(${options.maxWidth},iw)':h=-2`,
      '-frames:v', String(options.frames), '-q:v', '4', join(dir, '%02d.jpg'),
    ], { timeout: TIMEOUT_MS })
    const names = (await readdir(dir)).sort()
    return await Promise.all(names.map(async name => ({ data: await readFile(join(dir, name)), mediaType: 'image/jpeg' as const })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
