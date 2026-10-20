import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractFrames } from '../src/video/frames.ts'

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'video-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe.skipIf(!hasFfmpeg)('extractFrames', () => {
  it('takes evenly spaced, scaled JPEG stills', async () => {
    const clip = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=1280x720:rate=10', '-pix_fmt', 'yuv420p', clip])
    const frames = await extractFrames(clip, { frames: 4, maxWidth: 320 })
    expect(frames).toHaveLength(4)
    for (const frame of frames) {
      expect(frame.mediaType).toBe('image/jpeg')
      expect([...frame.data.subarray(0, 2)]).toEqual([0xff, 0xd8])
      // JPEG SOF0 stores height then width right after the marker header.
      const sof = Buffer.from(frame.data).indexOf(Buffer.from([0xff, 0xc0]))
      expect(Buffer.from(frame.data).readUInt16BE(sof + 7)).toBe(320)
    }
  })

  it('rejects a file that is not a video', async () => {
    await expect(extractFrames(join(dir, 'missing.mp4'), { frames: 4, maxWidth: 320 })).rejects.toThrow()
  })
})
