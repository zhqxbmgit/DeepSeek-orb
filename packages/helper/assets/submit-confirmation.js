/**
 * Links submitted tasks to the Host's own user-message echo.
 *
 * The Host announces every accepted prompt as a `user:<uuid>` block (see
 * `OrbRuntime.onPrompt`). The page never draws a local user bubble; it keeps a small queue
 * of submissions that are still waiting for that echo, including ones whose wait already
 * timed out, so a late echo can still converge the right entry.
 *
 * Entries are matched oldest-first by payload. The order is the send order, which is also
 * the Host's echo order, so two deliberate identical tasks keep their own entries. An echo
 * removes its entry, so it can never confirm a later submission.
 */

/**
 * @typedef {{ id: number, text: string, scope: string, status: 'waiting' | 'timedOut' }} SubmitEntry
 */

/**
 * @returns {{
 *   expect(text: string, scope?: string): number | null,
 *   get(id: number): SubmitEntry | null,
 *   has(id: number): boolean,
 *   expire(id: number): SubmitEntry | null,
 *   observe(block: unknown, scope?: string): SubmitEntry | null,
 *   list(): SubmitEntry[],
 *   remove(id: number): boolean,
 *   clear(): void,
 * }}
 */
export function createSubmitTracker() {
  let nextId = 0
  /** Insertion order is send order; Map preserves it. */
  const entries = new Map()
  const snapshot = (entry) => ({ id: entry.id, text: entry.text, scope: entry.scope, status: entry.status })

  return {
    /**
     * Remember one submitted payload and start waiting for its Host echo.
     * @param {string} text - the exact payload handed to the Host.
     * @param {string} [scope] - the conversation the prompt was sent in; echoes from any
     *   other conversation never confirm it (replayed history included).
     * @returns {number | null} the entry id, or null for an empty payload.
     */
    expect(text, scope = '') {
      if (typeof text !== 'string' || text === '') return null
      nextId += 1
      entries.set(nextId, { id: nextId, text, scope, status: 'waiting' })
      return nextId
    },
    /** One entry by id, or null. */
    get(id) {
      const entry = entries.get(id)
      return entry === undefined ? null : snapshot(entry)
    },
    /** Whether this id is still waiting (late echoes included). */
    has(id) {
      return entries.has(id)
    },
    /**
     * The wait lost its timer. The entry stays in the queue: later echoes still belong to
     * it, and the user can still copy or restore the task.
     * @returns {SubmitEntry | null} the entry that timed out, or null if already confirmed.
     */
    expire(id) {
      const entry = entries.get(id)
      if (entry === undefined) return null
      if (entry.status === 'waiting') entry.status = 'timedOut'
      return snapshot(entry)
    },
    /**
     * One transcript message arrived. The oldest entry with the same payload in the same
     * conversation is confirmed and removed; every other message leaves the queue untouched.
     * @param {unknown} block - the Host block message.
     * @param {string} [scope] - the conversation the block belongs to.
     * @returns {SubmitEntry | null} the confirmed entry, or null.
     */
    observe(block, scope = '') {
      if (block === null || typeof block !== 'object') return null
      if (block.kind !== 'user') return null
      if (typeof block.text !== 'string') return null
      for (const entry of entries.values()) {
        if (entry.scope !== scope) continue
        if (entry.text !== block.text) continue
        entries.delete(entry.id)
        return snapshot(entry)
      }
      return null
    },
    /** Every entry still waiting for a Host echo, in send order. */
    list() {
      return [...entries.values()].map(snapshot)
    },
    /** Drop one entry on explicit user request. */
    remove(id) {
      return entries.delete(id)
    },
    /** Drop every entry (only used by tests and by an explicit reset). */
    clear() {
      entries.clear()
    },
  }
}
