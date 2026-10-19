import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countAgentStates, describeTaskStatus } from '../assets/background-status.js'

const labels = {
  taskIdle: '本对话空闲',
  taskRunning: '本对话运行中',
  taskBackgroundRunning: (count) => `后台 ${count} 个任务运行中`,
  taskBackgroundDone: (count) => `后台 ${count} 个任务已完成`,
  taskBackgroundStopped: (count) => `后台 ${count} 个任务已停止`,
  badgeRunning: '运行中',
  badgeDone: '有未查看的完成结果',
  badgeStopped: '有未查看的后台任务（含已停止）',
}

function status(items, running = false) {
  return describeTaskStatus({ running, elapsed: '0:12', items, labels })
}

describe('background task state model', () => {
  it('counts a stopped, unread task as stopped rather than completed', () => {
    const counts = countAgentStates([{ state: 'stopped', unread: true }])
    assert.equal(counts.stopped, 1)
    assert.equal(counts.completed, 0)
    assert.equal(counts.unreadStopped, 1)

    const model = status([{ state: 'stopped', unread: true }])
    assert.match(model.text, /已停止/)
    assert.doesNotMatch(model.text, /已完成/)
    assert.equal(model.state, 'stopped')
    assert.equal(model.badge?.kind, 'stopped')
  })

  it('counts a completed, unread task as completed', () => {
    const model = status([{ state: 'completed', unread: true }])
    assert.match(model.text, /后台 1 个任务已完成/)
    assert.doesNotMatch(model.text, /已停止/)
    assert.equal(model.state, 'done')
    assert.equal(model.badge?.kind, 'done')
    assert.equal(model.badge?.count, 1)
  })

  it('reports a running task without any finished wording', () => {
    const model = status([{ state: 'running', unread: false }])
    assert.match(model.text, /后台 1 个任务运行中/)
    assert.doesNotMatch(model.text, /已完成|已停止/)
    assert.equal(model.state, 'background')
    assert.equal(model.badge?.kind, 'running')
    assert.equal(model.badge?.count, 1)
  })

  it('keeps running, completed and stopped tasks apart at the same time', () => {
    const model = status([
      { state: 'running', unread: false },
      { state: 'completed', unread: true },
      { state: 'stopped', unread: true },
    ])
    assert.match(model.text, /后台 1 个任务运行中/)
    assert.match(model.text, /后台 1 个任务已完成/)
    assert.match(model.text, /后台 1 个任务已停止/)
    // Running work is still in progress: the line cannot read as everything finished.
    assert.equal(model.state, 'background')
    assert.equal(model.badge?.kind, 'running')
    assert.equal(model.counts.running, 1)
    assert.equal(model.counts.completed, 1)
    assert.equal(model.counts.stopped, 1)
  })

  it('does not colour a mixed finished state as completed', () => {
    const model = status([
      { state: 'completed', unread: true },
      { state: 'stopped', unread: true },
    ])
    assert.equal(model.state, 'stopped')
    assert.equal(model.badge?.kind, 'stopped')
    assert.equal(model.badge?.count, 2)
    assert.match(model.text, /已完成/)
    assert.match(model.text, /已停止/)
  })

  it('treats an ended task like a stopped one and keeps the current chat state', () => {
    const model = status([{ state: 'ended', unread: true }], true)
    assert.match(model.text, /^本对话运行中 0:12/)
    assert.match(model.text, /已停止/)
    assert.equal(model.state, 'running')
    assert.equal(model.badge?.kind, 'running')
  })

  it('keeps a running current chat running even when background work is stopped', () => {
    const model = status([{ state: 'stopped', unread: true }], true)
    assert.match(model.text, /本对话运行中/)
    assert.match(model.text, /后台 1 个任务已停止/)
    assert.equal(model.state, 'running')
    assert.equal(model.badge?.kind, 'running')
  })

  it('shows nothing about finished background work once it has been viewed', () => {
    const model = status([
      { state: 'completed', unread: false },
      { state: 'stopped', unread: false },
    ])
    assert.equal(model.text, '本对话空闲')
    assert.equal(model.state, 'idle')
    assert.equal(model.badge, null)
  })

  it('ignores unknown states and malformed items', () => {
    const counts = countAgentStates([null, 'x', { state: 'mystery', unread: true }])
    assert.deepEqual(counts, {
      running: 0, completed: 0, stopped: 0, ended: 0,
      unreadRunning: 0, unreadCompleted: 0, unreadStopped: 0, unreadEnded: 0,
    })
  })
})
