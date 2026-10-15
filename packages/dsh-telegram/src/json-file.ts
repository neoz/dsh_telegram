import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Write `data` as JSON through a sibling temp file, so readers never see a half-written file; callers serialise writes to one file. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/** Runs tasks one at a time in call order; a failed task does not stop the ones queued after it. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }
}
