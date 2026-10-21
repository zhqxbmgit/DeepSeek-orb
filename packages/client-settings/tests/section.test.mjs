import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))

function loadSection() {
  const calls = []
  const styles = []
  const stateSlots = []
  const effects = []
  let cursor = 0
  let registered
  let plugin
  let lang = ''
  const snapshot = {
    supported: true,
    version: '0.2.13',
    background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    millifractionEnabled: false,
    observationFrameEnabled: true,
    frame: { state: 'running', error: '', phase: '' },
    tcc: { applicable: false },
  }
  const catalog = {
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      }],
    }],
  }
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter(child => child != null && child !== false && child !== true)
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = cursor++
      if (stateSlots[index] === undefined) stateSlots[index] = { current: initial }
      return [stateSlots[index].current, (next) => {
        stateSlots[index].current = typeof next === 'function' ? next(stateSlots[index].current) : next
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (stateSlots[index] === undefined) stateSlots[index] = { current: initial }
      return stateSlots[index]
    },
    useEffect(effect) {
      effects[cursor] = effect
      cursor += 1
    },
  }
  const sandbox = {
    AbortController,
    window: { confirm: () => true },
    document: {
      documentElement: { lang },
      getElementById: id => styles.find(node => node.id === id) ?? null,
      head: { append(node) { styles.push(node) } },
      createElement: tag => ({ id: '', textContent: '', tag }),
    },
    navigator: { language: 'zh-CN' },
    fetch: async (path, options = {}) => {
      calls.push({ path, options })
      if (String(path).includes('token') || String(path).startsWith('http')) throw new Error(`credentialed fetch ${path}`)
      if (path === '/.dsh-orb/settings') return json(snapshot)
      if (path === '/.dsh-orb/models') return json(catalog)
      const body = options.body === undefined ? {} : JSON.parse(options.body)
      if (path === '/.dsh-orb/background-model') snapshot.background = body
      else if (path === '/.dsh-orb/millifraction') snapshot.millifractionEnabled = body.enabled
      else if (path === '/.dsh-orb/observation-frame') {
        snapshot.observationFrameEnabled = body.enabled
        snapshot.frame = body.enabled
          ? { state: 'starting', error: '', phase: '' }
          : { state: 'disabled', error: '', phase: '' }
      } else if (path === '/.dsh-orb/frame/restart') {
        snapshot.observationFrameEnabled = true
        snapshot.frame = { state: 'starting', error: '', phase: '' }
      } else throw new Error(`unexpected endpoint ${path}`)
      return json(snapshot)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  }
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      plugin = spec.factory(id => {
        if (id === 'react') return React
        throw new Error(id)
      })
      return plugin
    },
  }
  runInContext(readFileSync(join(here, '../client.js'), 'utf8'), createContext(sandbox))
  const ctx = {
    slots: {
      inject(_name, register) { register() },
      register(spec, Component) { registered = { spec, Component } },
      entries() { return [] },
    },
    get() { return undefined },
    effect(run) { return run() },
  }
  plugin.apply(ctx)

  function render() {
    cursor = 0
    return registered.Component()
  }
  async function flush() {
    for (let index = 0; index < effects.length; index += 1) {
      if (effects[index] === undefined) continue
      await effects[index]()
      effects[index] = undefined
    }
    for (let index = 0; index < 8; index += 1) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return {
    calls,
    snapshot,
    spec: registered.spec,
    render,
    flush,
    setSnapshot(patch) {
      const slot = stateSlots.find(item => item?.current && item.current.snapshot)
      if (slot === undefined) throw new Error('settings state is not loaded')
      slot.current = { ...slot.current, snapshot: { ...slot.current.snapshot, ...patch } }
    },
    setLang(next) {
      lang = next
      sandbox.document.documentElement.lang = next
    },
  }
}

function json(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
}

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) walk(child, predicate, found)
  return found
}

function plainText(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(plainText).join(' ')
}

async function readyPage() {
  const page = loadSection()
  page.render()
  await page.flush()
  page.render()
  return page
}

describe('main-window settings section', () => {
  it('identifies the custom build and keeps every fetch relative', async () => {
    const page = await readyPage()
    assert.equal(page.spec.id, 'orb')
    assert.equal(page.spec.label(), 'dsh-orb 定制版')
    const text = plainText(page.render())
    assert.match(text, /关于定制版/u)
    assert.match(text, /当前版本：0\.2\.13/u)
    assert.match(text, /github\.com\/zhqxbmgit\/DeepSeek-orb/u)
    assert.match(text, /本地安装包/u)
    assert.match(text, /观察框彩带/u)
    assert.doesNotMatch(text, /启用悬浮球|检查更新|自动检查更新|悬浮球头像|会话清理|Agent 工作区/u)
    assert.ok(page.calls.length > 0)
    for (const call of page.calls) {
      assert.equal(String(call.path).startsWith('/.dsh-orb/'), true)
      assert.equal(String(call.path).includes('token'), false)
    }
    assert.deepEqual(page.calls.map(call => call.path).sort(), ['/.dsh-orb/models', '/.dsh-orb/settings'])
  })

  it('exposes exactly the coordinate and ribbon switches and saves them', async () => {
    const page = await readyPage()
    const tree = page.render()
    const switches = walk(tree, node => node?.props?.role === 'switch')
    assert.equal(switches.length, 2)
    const frame = switches.find(node => node.props['aria-label'] === '显示观察框彩带')
    const coordinates = switches.find(node => node.props['aria-label'] === '使用千分比坐标')
    assert.ok(frame)
    assert.ok(coordinates)
    coordinates.props.onClick()
    await page.flush()
    assert.equal(page.snapshot.millifractionEnabled, true)
    frame.props.onClick()
    await page.flush()
    assert.equal(page.snapshot.observationFrameEnabled, false)
    assert.equal(page.snapshot.frame.state, 'disabled')
    assert.deepEqual(
      page.calls.filter(call => call.options.method === 'POST').map(call => call.path).sort(),
      ['/.dsh-orb/millifraction', '/.dsh-orb/observation-frame'],
    )
  })

  it('offers a left-click restart when the renderer failed', async () => {
    const page = await readyPage()
    page.setSnapshot({ frame: { state: 'error', error: 'helper-exited', phase: '' } })
    const tree = page.render()
    const alert = walk(tree, node => node?.props?.role === 'alert')
    assert.ok(alert.length > 0)
    const button = walk(tree, node => node?.type === 'button' && plainText(node).includes('重新启动彩带组件'))[0]
    assert.ok(button, 'restart button must be reachable')
    button.props.onClick()
    await page.flush()
    assert.equal(page.snapshot.frame.state, 'starting')
    assert.equal(page.calls.some(call => call.path === '/.dsh-orb/frame/restart' && call.options.method === 'POST'), true)
  })

  it('shows preparation instead of an enabled-but-empty ribbon', async () => {
    const page = await readyPage()
    page.setSnapshot({ frame: { state: 'starting', error: '', phase: 'downloading' } })
    const text = plainText(page.render())
    assert.match(text, /正在准备独立绘制运行时/u)
    assert.doesNotMatch(text, /彩带绘制组件已连接/u)
  })

  it('does not expose update, ball, avatar, workspace, or history controls', async () => {
    const page = await readyPage()
    const text = plainText(page.render())
    for (const label of ['插件更新', '启用悬浮球', '悬浮球头像', 'Agent 工作区', '清理会话']) {
      assert.equal(text.includes(label), false, `${label} must not be rendered`)
    }
    assert.equal(page.calls.some(call => /\/(update|ball|runtime|avatar|workspace|history|jump|settings-open)/u.test(String(call.path))), false)
  })

  it('switches the custom label with the main-window locale', async () => {
    const page = await readyPage()
    page.setLang('en-US')
    assert.equal(page.spec.label(), 'dsh-orb Custom')
    assert.match(plainText(page.render()), /Updates use checked local packages only/u)
    assert.match(plainText(page.render()), /Observation ribbon/u)
  })
})
