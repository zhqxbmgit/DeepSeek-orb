/**
 * Background task status model.
 *
 * The real state (running / completed / stopped / ended) is counted separately from
 * `unread`, which only says the result has not been looked at yet. The panel's task line
 * and the collapsed ball's badge are both rendered from this one model, so a stopped task
 * can never be described as "done" just because it is unread.
 */

/**
 * Count bookmarks by their real state, keeping unread as a separate view flag.
 * @param {unknown} items - the host's `agents` payload.
 * @returns {{ running: number, completed: number, stopped: number, ended: number,
 *   unreadRunning: number, unreadCompleted: number, unreadStopped: number, unreadEnded: number }}
 */
export function countAgentStates(items) {
  const counts = {
    running: 0,
    completed: 0,
    stopped: 0,
    ended: 0,
    unreadRunning: 0,
    unreadCompleted: 0,
    unreadStopped: 0,
    unreadEnded: 0,
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    const unread = item.unread === true
    if (item.state === 'running') {
      counts.running += 1
      if (unread) counts.unreadRunning += 1
    } else if (item.state === 'completed') {
      counts.completed += 1
      if (unread) counts.unreadCompleted += 1
    } else if (item.state === 'stopped') {
      counts.stopped += 1
      if (unread) counts.unreadStopped += 1
    } else if (item.state === 'ended') {
      counts.ended += 1
      if (unread) counts.unreadEnded += 1
    }
  }
  return counts
}

/**
 * Describe this chat plus background work for the task line and the ball badge.
 * @param {{ running: boolean, elapsed?: string, items?: unknown,
 *   labels: { taskIdle: string, taskRunning: string,
 *     taskBackgroundRunning: (count: number) => string,
 *     taskBackgroundDone: (count: number) => string,
 *     taskBackgroundStopped: (count: number) => string,
 *     badgeRunning: string, badgeDone: string, badgeStopped: string } }} input
 * @returns {{ text: string, state: 'running'|'background'|'done'|'stopped'|'idle',
 *   badge: { kind: 'running'|'done'|'stopped', count: number, title: string } | null,
 *   counts: ReturnType<typeof countAgentStates> }}
 */
export function describeTaskStatus({ running, elapsed = '', items = [], labels }) {
  const counts = countAgentStates(items)
  const unreadStopped = counts.unreadStopped + counts.unreadEnded
  const parts = []
  if (running) parts.push(elapsed === '' ? labels.taskRunning : `${labels.taskRunning} ${elapsed}`)
  else parts.push(labels.taskIdle)
  // Each real state keeps its own wording. A running task is never folded into a
  // finished count, and a stopped task is never folded into the completed count.
  if (counts.running > 0) parts.push(labels.taskBackgroundRunning(counts.running))
  if (counts.unreadCompleted > 0) parts.push(labels.taskBackgroundDone(counts.unreadCompleted))
  if (unreadStopped > 0) parts.push(labels.taskBackgroundStopped(unreadStopped))

  let state = 'idle'
  if (running) state = 'running'
  else if (counts.running > 0) state = 'background'
  else if (unreadStopped > 0) state = 'stopped'
  else if (counts.unreadCompleted > 0) state = 'done'

  let badge = null
  if (running || counts.running > 0) {
    badge = { kind: 'running', count: counts.running, title: labels.badgeRunning }
  } else if (unreadStopped > 0) {
    // One badge cannot draw two colours: a stopped result wins the badge and the count
    // includes every unviewed finished task, while the task line spells each state out.
    badge = { kind: 'stopped', count: unreadStopped + counts.unreadCompleted, title: labels.badgeStopped }
  } else if (counts.unreadCompleted > 0) {
    badge = { kind: 'done', count: counts.unreadCompleted, title: labels.badgeDone }
  }

  return { text: parts.join(' · '), state, badge, counts }
}
