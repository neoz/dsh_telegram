/** Zalo rejects a message longer than this many characters. */
export const ZALO_MAX_MESSAGE_CHARS = 2000

const FENCE = '```'
const ZWJ = 0x200d
const VARIATION_SELECTOR = 0xfe0f
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** True when cutting `text` before index `at` would split a surrogate pair or a joined emoji sequence. */
function splitsCluster(text: string, at: number): boolean {
  const next = text.charCodeAt(at)
  return isLowSurrogate(next) || next === ZWJ || next === VARIATION_SELECTOR || text.charCodeAt(at - 1) === ZWJ
}

/** Where to cut `rest` within `max`: a paragraph break, else a line break, else a space, if one sits in the second half; else the hard limit, moved back off any emoji. */
function cutPoint(rest: string, max: number): number {
  const window = rest.slice(0, max)
  for (const separator of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(separator)
    if (at >= max / 2) return at
  }
  let at = max
  while (at > 1 && splitsCluster(rest, at)) at--
  return at
}

const opensFence = (part: string) => part.split(FENCE).length % 2 === 0

/** Splits a reply into messages of at most `maxChars` UTF-16 units, preferring natural breaks; a code block cut in two is closed and reopened. */
export function splitMessage(text: string, maxChars: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > maxChars) {
    let cut = cutPoint(rest, maxChars)
    let part = rest.slice(0, cut).trimEnd()
    let reopen = ''
    if (opensFence(part)) {
      // Leave room for the closing fence on its own line.
      cut = cutPoint(rest, maxChars - FENCE.length - 1)
      part = rest.slice(0, cut).trimEnd()
      if (opensFence(part)) {
        part = `${part}\n${FENCE}`
        reopen = `${FENCE}\n`
      }
    }
    if (part !== '') parts.push(part)
    rest = reopen + rest.slice(cut).trimStart()
  }
  if (rest !== '') parts.push(rest)
  return parts
}
