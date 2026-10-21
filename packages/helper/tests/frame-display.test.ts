import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFrameDisplay,
  type FrameDisplay,
  type FramePlacement,
  type FrameWindow,
} from '../src/frame-display.ts'
import type { OverlayRect } from '../src/overlay-geometry.ts'

const work = { x: 0, y: 0, width: 1000, height: 800 }
const a: OverlayRect = { x: 10, y: 20, width: 100, height: 80 }
const b: OverlayRect = { x: 200, y: 220, width: 300, height: 180 }

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

type GeometryStage = 'toDip' | 'workArea' | 'placement'

interface Harness {
  readonly display: FrameDisplay
  readonly renders: Deferred<unknown>[]
  readonly errors: unknown[]
  visible(): boolean
  bounds(): OverlayRect | undefined
  failAt(stage: GeometryStage | undefined): void
}

function harness(): Harness {
  const renders: Deferred<unknown>[] = []
  const errors: unknown[] = []
  let visible = false
  let bounds: OverlayRect | undefined
  let fault: GeometryStage | undefined
  const frame: FrameWindow = {
    isDestroyed: () => false,
    setBounds(value) { bounds = value },
    executeJavaScript() {
      const render = deferred<unknown>()
      renders.push(render)
      return render.promise
    },
    showInactive() { visible = true },
    hide() { visible = false },
  }
  const display = createFrameDisplay({
    window: () => frame,
    ready: () => true,
    toDip(region) {
      if (fault === 'toDip') throw new Error('screenToDipRect failed')
      return region
    },
    workArea() {
      if (fault === 'workArea') throw new Error('getDisplayNearestPoint failed')
      return work
    },
    placement: (region): FramePlacement => {
      if (fault === 'placement') throw new Error('placement failed')
      return {
        bounds: region,
        glow: { top: 0, right: 0, bottom: 0, left: 0 },
        stroke: { top: 0, right: 0, bottom: 0, left: 0 },
      }
    },
    css: () => '',
    onError: error => { errors.push(error) },
  })
  return {
    display,
    renders,
    errors,
    visible: () => visible,
    bounds: () => bounds,
    failAt(stage) { fault = stage },
  }
}

async function assertGeometryFailure(stage: GeometryStage, message: string): Promise<void> {
  const host = harness()
  const first = host.display.show(a)
  host.renders[0]?.resolve(undefined)
  assert.equal(await first, true)
  assert.equal(host.visible(), true)
  assert.deepEqual(host.display.shownRegion(), a)

  host.failAt(stage)
  assert.equal(await host.display.show(b), false)

  assert.equal(host.visible(), false, `${stage} failure must hide the old frame`)
  assert.equal(host.display.shownRegion(), undefined, `${stage} failure must clear shownRegion`)
  assert.equal(host.display.desiredRegion(), undefined, `${stage} failure must clear desiredRegion`)
  assert.equal(host.renders.length, 1, `${stage} failure must not start a render`)
  assert.equal(host.errors.length, 1)
  assert.equal((host.errors[0] as Error).message, message)
}

describe('observation frame display authority', () => {
  it('keeps a hide final when the earlier show render resolves later', async () => {
    const host = harness()
    const showing = host.display.show(a)
    assert.equal(host.visible(), false)
    host.display.hide()
    host.renders[0]?.resolve(undefined)
    assert.equal(await showing, false)
    assert.equal(host.visible(), false)
    assert.equal(host.display.shownRegion(), undefined)
    assert.equal(host.display.desiredRegion(), undefined)
    assert.deepEqual(host.errors, [])
  })

  it('lets a newer show win while an older render is still pending', async () => {
    const host = harness()
    const first = host.display.show(a)
    const second = host.display.show(b)
    assert.deepEqual(host.bounds(), b, 'the newest request owns the bounds')
    host.renders[0]?.resolve(undefined)
    assert.equal(await first, false)
    assert.equal(host.visible(), false, 'the stale first render must not show')
    host.renders[1]?.resolve(undefined)
    assert.equal(await second, true)
    assert.equal(host.visible(), true)
    assert.deepEqual(host.display.shownRegion(), b)
  })

  it('ignores a stale failure and does not hide the newer valid frame', async () => {
    const host = harness()
    const first = host.display.show(a)
    const second = host.display.show(b)
    host.renders[1]?.resolve(undefined)
    assert.equal(await second, true)
    host.renders[0]?.reject(new Error('late render failure'))
    assert.equal(await first, false)
    assert.equal(host.visible(), true)
    assert.deepEqual(host.display.shownRegion(), b)
    assert.deepEqual(host.errors, [])
  })

  it('hides and reports only a failure that still owns the current attempt', async () => {
    const host = harness()
    const showing = host.display.show(a)
    const failure = new Error('current render failure')
    host.renders[0]?.reject(failure)
    assert.equal(await showing, false)
    assert.equal(host.visible(), false)
    assert.equal(host.display.shownRegion(), undefined)
    assert.deepEqual(host.errors, [failure])
  })

  it('hides and reports when toDip fails for the current target', async () => {
    await assertGeometryFailure('toDip', 'screenToDipRect failed')
  })

  it('hides and reports when workArea fails for the current target', async () => {
    await assertGeometryFailure('workArea', 'getDisplayNearestPoint failed')
  })

  it('hides and reports when placement fails for the current target', async () => {
    await assertGeometryFailure('placement', 'placement failed')
  })

  it('does nothing when a reflow runs after turn-end hid the frame', async () => {
    const host = harness()
    const showing = host.display.show(a)
    assert.equal(host.renders.length, 1)
    host.display.hide()
    await host.display.reflow()
    assert.equal(host.renders.length, 1, 'reflow must not render a hidden target')
    host.renders[0]?.resolve(undefined)
    assert.equal(await showing, false)
    assert.equal(host.visible(), false)
  })

  it('uses the same hide and error path when a reflow geometry step fails', async () => {
    const host = harness()
    const first = host.display.show(a)
    host.renders[0]?.resolve(undefined)
    assert.equal(await first, true)
    host.failAt('placement')
    await host.display.reflow()

    assert.equal(host.visible(), false)
    assert.equal(host.display.shownRegion(), undefined)
    assert.equal(host.display.desiredRegion(), undefined)
    assert.equal(host.errors.length, 1)
    assert.equal((host.errors[0] as Error).message, 'placement failed')
  })

  it('makes a reflow supersede an older pending show without resurrecting it', async () => {
    const host = harness()
    const first = host.display.show(a)
    const reflow = host.display.reflow()
    assert.equal(host.renders.length, 2)
    host.renders[0]?.resolve(undefined)
    assert.equal(await first, false)
    assert.equal(host.visible(), false)
    host.renders[1]?.resolve(undefined)
    await reflow
    assert.equal(host.visible(), true)
    assert.deepEqual(host.display.shownRegion(), a)
  })

  it('shows, moves, and hides normally', async () => {
    const host = harness()
    const first = host.display.show(a)
    host.renders[0]?.resolve(undefined)
    assert.equal(await first, true)
    assert.equal(host.visible(), true)
    assert.deepEqual(host.bounds(), a)

    const second = host.display.show(b)
    assert.deepEqual(host.bounds(), b)
    host.renders[1]?.resolve(undefined)
    assert.equal(await second, true)
    assert.equal(host.visible(), true)
    assert.deepEqual(host.display.shownRegion(), b)

    host.display.hide()
    assert.equal(host.visible(), false)
    assert.equal(host.display.shownRegion(), undefined)
    assert.equal(host.display.desiredRegion(), undefined)
  })
})
