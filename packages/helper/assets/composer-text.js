/**
 * Draft + clipboard text merging for the paste button.
 *
 * Paste never sends. It appends to whatever is already in the composer, with a visible
 * separator, and truncates at the same limit the composer enforces so the result can
 * always be sent.
 */

/** Blank line between the existing draft and pasted text. */
export const PASTE_SEPARATOR = '\n\n'

/**
 * Merge clipboard text into the current draft.
 * @param {string} draft - what the composer holds now.
 * @param {string} clip - plain text read from the clipboard.
 * @param {number} limit - the composer's character limit.
 * @returns {{ text: string, inserted: boolean, truncated: boolean, appended: boolean }}
 *   the merged text and what happened to it.
 */
export function mergePastedText(draft, clip, limit) {
  const base = typeof draft === 'string' ? draft : ''
  const incoming = typeof clip === 'string' ? clip : ''
  if (incoming === '') return { text: base, inserted: false, truncated: false, appended: base !== '' }
  const separator = base === '' || base.endsWith('\n') ? '' : PASTE_SEPARATOR
  const room = limit - base.length - separator.length
  if (room <= 0) return { text: base, inserted: false, truncated: incoming !== '', appended: base !== '' }
  const kept = incoming.length > room ? incoming.slice(0, room) : incoming
  return {
    text: `${base}${separator}${kept}`,
    inserted: kept !== '',
    truncated: kept.length < incoming.length,
    appended: base !== '',
  }
}
