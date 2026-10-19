import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSubmitTracker } from '../assets/submit-confirmation.js'

/** The frame the Host's `block()` publishes for a prompt, as far as the page reads it. */
function hostEcho(text, key = 'user:4c1f') {
  return { type: 'block', key, kind: 'user', text, running: false }
}

describe('Host echo confirmation for submitted tasks', () => {
  it('is confirmed only by the Host user block with the submitted text', () => {
    const tracker = createSubmitTracker()
    const id = tracker.expect('修复登录测试')
    assert.equal(typeof id, 'number')
    assert.equal(tracker.get(id)?.status, 'waiting')
    assert.equal(tracker.observe({ type: 'block', key: 'b:1', kind: 'assistant', text: '修复登录测试' }), null)
    assert.equal(tracker.observe({ type: 'block', key: 'tool:1', kind: 'tool', text: '修复登录测试' }), null)
    assert.equal(tracker.observe({ type: 'block', key: 'user:old', kind: 'user', text: '别的任务' }), null)
    assert.equal(tracker.has(id), true)
    const confirmed = tracker.observe(hostEcho('修复登录测试'))
    assert.equal(confirmed?.id, id)
    assert.equal(tracker.has(id), false)
  })

  it('keeps a timed-out entry so a late echo still converges the same submission', () => {
    const tracker = createSubmitTracker()
    const id = tracker.expect('迟到的任务')
    const expired = tracker.expire(id)
    assert.equal(expired?.status, 'timedOut')
    assert.equal(tracker.has(id), true)
    assert.equal(tracker.list().length, 1)
    const late = tracker.observe(hostEcho('迟到的任务'))
    assert.equal(late?.id, id)
    assert.equal(tracker.list().length, 0)
  })

  it('never confirms an entry with an echo from another conversation', () => {
    const tracker = createSubmitTracker()
    const id = tracker.expect('跨会话任务', 'session-a')
    tracker.expire(id)
    // A replayed user message from another conversation can carry the same text, but it
    // cannot confirm this submission.
    assert.equal(tracker.observe(hostEcho('跨会话任务', 'user:replayed'), 'session-b'), null)
    assert.equal(tracker.has(id), true)
    assert.equal(tracker.observe(hostEcho('跨会话任务', 'user:live'), 'session-a')?.id, id)
  })

  it('assigns two identical sends to their own entries oldest-first', () => {
    const tracker = createSubmitTracker()
    const first = tracker.expect('重复的任务')
    const second = tracker.expect('重复的任务')
    assert.notEqual(first, second)
    assert.equal(tracker.observe(hostEcho('重复的任务', 'user:first'))?.id, first)
    assert.equal(tracker.has(second), true)
    assert.equal(tracker.observe(hostEcho('重复的任务', 'user:second'))?.id, second)
    assert.equal(tracker.list().length, 0)
  })

  it('never lets an echo for A confirm a newer, different B', () => {
    const tracker = createSubmitTracker()
    const a = tracker.expect('任务 A')
    const b = tracker.expect('任务 B')
    assert.equal(tracker.observe(hostEcho('任务 A'))?.id, a)
    assert.equal(tracker.get(b)?.status, 'waiting')
    assert.equal(tracker.observe(hostEcho('任务 B'))?.id, b)
  })

  it('keeps a newer entry untouched when the older timed-out echo arrives late', () => {
    const tracker = createSubmitTracker()
    const a = tracker.expect('旧任务')
    tracker.expire(a)
    const b = tracker.expect('新任务')
    // B's own echo must not confirm A, and A's late echo must not touch B.
    assert.equal(tracker.observe(hostEcho('新任务'))?.id, b)
    assert.equal(tracker.has(a), true)
    assert.equal(tracker.observe(hostEcho('旧任务'))?.id, a)
    assert.equal(tracker.list().length, 0)
  })

  it('removes entries only by their own id or an explicit clear', () => {
    const tracker = createSubmitTracker()
    const a = tracker.expect('任务 A')
    const b = tracker.expect('任务 B')
    assert.equal(tracker.remove(a), true)
    assert.equal(tracker.has(a), false)
    assert.equal(tracker.has(b), true)
    tracker.clear()
    assert.equal(tracker.list().length, 0)
  })

  it('accepts only non-empty payloads it can match later', () => {
    const tracker = createSubmitTracker()
    assert.equal(tracker.expect(''), null)
    assert.equal(tracker.observe(hostEcho('')), null)
    assert.equal(tracker.list().length, 0)
  })
})
