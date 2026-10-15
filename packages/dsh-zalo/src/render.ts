/** Zalo rejects a message longer than this many characters. */
export const ZALO_MAX_MESSAGE_CHARS = 2000

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/** Where to cut `window`: a paragraph break, else a line break, else a space, if one sits in its second half; else the hard limit. */
function cutPoint(window: string, max: number): number {
  for (const separator of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(separator)
    if (at >= max / 2) return at
  }
  return isHighSurrogate(window.charCodeAt(max - 1)) ? max - 1 : max
}

/** Splits a reply into messages of at most `maxChars` UTF-16 units, preferring natural breaks. */
export function splitMessage(text: string, maxChars: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > maxChars) {
    const cut = cutPoint(rest.slice(0, maxChars), maxChars)
    const part = rest.slice(0, cut).trimEnd()
    if (part !== '') parts.push(part)
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') parts.push(rest)
  return parts
}
