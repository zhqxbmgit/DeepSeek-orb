window.__ModuleLoader__.load({
  id: '@dsh-orb/client-ui-settings-orb',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const zh = {
      nav: 'dsh-orb 定制版',
      intro: '主窗口 Computer Use 定制版：截图、点击、输入和窗口切换都在 DeepSeek Harness 主窗口内完成。',
      customTitle: '关于定制版',
      customVersion: '当前版本：{version}',
      customDescription: '这是用户自己的独立定制版，保留官方 Harness 和 Computer Use 后端。没有悬浮球，也没有独立的聊天入口。',
      customRepo: '仓库与问题反馈：',
      customUpdate: '更新只使用经过检查的本地安装包；不会自动访问原版发布源，也不会自动替换公共仓库版本。',
      linux: '主窗口 Computer Use 在 Linux 上不受支持。',
      error: '无法加载 Computer Use 设置。',
      saveError: '无法保存。',
      retry: '重试',
      backgroundTitle: '后台 Agent',
      backgroundDescription: '新建后台 code_agent 会话使用的模型与思考强度。',
      emptyCatalog: '暂无可用模型。',
      defaultEffort: '默认',
      millifractionTitle: '千分比坐标',
      millifractionDescription: '新建对话使用截图的 0–1000 比例。关闭后使用已附加图片的像素。更改此项会在新对话中生效。',
      millifractionToggle: '使用千分比坐标',
      millifractionConfirm: '新编码只在新对话中生效。当前对话不变。取消不写入、不新建。',
      frameTitle: '观察框彩带',
      frameDescription: 'Computer Use 操作某个窗口时，窗口周围显示这条彩带。彩带不抢焦点、不拦截点击，也不会进入模型截图。',
      frameToggle: '显示观察框彩带',
      frameRunning: '彩带绘制组件已连接。',
      frameDisabled: '彩带已关闭，绘制组件没有运行。',
      frameStopped: '彩带绘制组件未运行。',
      frameStarting: '正在准备彩带绘制组件…',
      frameDownloading: '正在准备独立绘制运行时，完成后会自动连接。',
      frameExtracting: '正在展开独立绘制运行时，完成后会自动连接。',
      frameFailedTitle: '彩带绘制组件没有启动',
      frameFailed: 'Computer Use 的截图和操作仍可使用，但观察框不会显示。点按钮重新启动绘制组件。',
      frameRenderFailed: '彩带绘制失败，窗口已隐藏。检查显示设置后重新启动。',
      frameRuntimeFailed: '独立绘制运行时没有准备好。检查网络后重新启动；Computer Use 其它功能不受影响。',
      frameRestart: '重新启动彩带组件',
      frameStart: '启动彩带组件',
      frameRetrying: '正在启动…',
      tccTitle: 'Mac 权限',
      tccDescription: 'Computer Use 需要屏幕录制与辅助功能。点按钮打开系统设置对应页。',
      tccAppHint: '在列表里打开 {name}。',
      tccScreenName: '屏幕录制',
      tccScreenReason: '让 agent 看见当前窗口。',
      tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
      tccScreenOpen: '打开「屏幕录制」设置',
      tccAccessibilityName: '辅助功能',
      tccAccessibilityReason: '让 agent 点击和输入。',
      tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
      tccAccessibilityOpen: '打开「辅助功能」设置',
      tccMissing: '未开启',
      tccGranted: '已开启',
      tccRelaunch: '已开启，请退出后重开',
      tccFooter: '打开开关后必须完全退出 {name} 再打开。只关主窗口无效。',
    }
    const en = {
      nav: 'dsh-orb Custom',
      intro: 'The main-window Computer Use build: screenshots, clicks, typing, and window switching all happen inside DeepSeek Harness.',
      customTitle: 'About this build',
      customVersion: 'Current version: {version}',
      customDescription: 'This is the user\'s independent custom build. It keeps the official Harness and Computer Use backend. There is no floating ball and no separate chat entry.',
      customRepo: 'Repository and issues: ',
      customUpdate: 'Updates use checked local packages only. This build does not contact the upstream release source or install a public dsh-orb over itself.',
      linux: 'Main-window Computer Use is not supported on Linux.',
      error: 'Could not load Computer Use settings.',
      saveError: 'Could not save.',
      retry: 'Retry',
      backgroundTitle: 'Background Agent',
      backgroundDescription: 'Model and reasoning effort for new background code_agent sessions.',
      emptyCatalog: 'No models available.',
      defaultEffort: 'Default',
      millifractionTitle: 'Millifraction coordinates',
      millifractionDescription: 'New chats use 0–1000 fractions of the screenshot. Turn off to use pixels of the attached image. The change takes effect in a new conversation.',
      millifractionToggle: 'Use millifraction coordinates',
      millifractionConfirm: 'The new encoding takes effect in a new conversation. The current conversation stays unchanged. Cancel leaves everything as it is.',
      frameTitle: 'Observation ribbon',
      frameDescription: 'Draws the coloured ribbon around the window Computer Use is working on. It does not take focus, block clicks, or enter model screenshots.',
      frameToggle: 'Show the observation ribbon',
      frameRunning: 'The ribbon renderer is connected.',
      frameDisabled: 'The ribbon is off; its renderer is not running.',
      frameStopped: 'The ribbon renderer is not running.',
      frameStarting: 'Preparing the ribbon renderer…',
      frameDownloading: 'Preparing the independent drawing runtime; it connects automatically when ready.',
      frameExtracting: 'Unpacking the independent drawing runtime; it connects automatically when ready.',
      frameFailedTitle: 'The ribbon renderer did not start',
      frameFailed: 'Computer Use screenshots and actions still work, but the ribbon is hidden. Use the button to restart the renderer.',
      frameRenderFailed: 'Ribbon drawing failed and the window was hidden. Check the display settings, then restart.',
      frameRuntimeFailed: 'The independent drawing runtime was not prepared. Check the network and restart; the rest of Computer Use is unaffected.',
      frameRestart: 'Restart ribbon renderer',
      frameStart: 'Start ribbon renderer',
      frameRetrying: 'Starting…',
      tccTitle: 'Mac permissions',
      tccDescription: 'Computer Use needs Screen Recording and Accessibility. Each button opens that System Settings pane.',
      tccAppHint: 'In the list, turn on {name}.',
      tccScreenName: 'Screen Recording',
      tccScreenReason: 'Lets the agent see the current window.',
      tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
      tccScreenOpen: 'Open Screen Recording settings',
      tccAccessibilityName: 'Accessibility',
      tccAccessibilityReason: 'Lets the agent click and type.',
      tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
      tccAccessibilityOpen: 'Open Accessibility settings',
      tccMissing: 'Off',
      tccGranted: 'On',
      tccRelaunch: 'On — quit and reopen',
      tccFooter: 'After you turn the switches on, quit {name} fully, then open it again. Closing the main window does not quit.',
    }

    // The main window's resolved locale rides <html lang> (dsh-client-locale);
    // a page without it falls back to the browser languages.
    function copy() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    async function request(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: {
          accept: 'application/json',
          ...(options && options.headers ? options.headers : {}),
        },
      })
      const text = await response.text()
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { error: text.slice(0, 200) }
        }
      }
      if (!response.ok) {
        const error = new Error(body && body.error ? body.error : 'request failed')
        error.status = response.status
        throw error
      }
      return body
    }

    function findModel(catalog, selection) {
      const groups = catalog && catalog.groups ? catalog.groups : []
      for (const group of groups) {
        if (!selection || group.id !== selection.provider) continue
        for (const model of group.models || []) {
          if (model.id === selection.model) return model
        }
      }
      return undefined
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `dsh-orb-set-switch${props.checked ? ' is-on' : ''}`,
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => {
          if (!props.disabled) props.onChange(!props.checked)
        },
      })
    }

    function ModelPicker(props) {
      const text = copy()
      const groups = props.catalog && props.catalog.groups ? props.catalog.groups : []
      const current = props.current || { provider: '', model: '' }
      const value = `${current.provider}\u001f${current.model}`
      const known = findModel(props.catalog, current)
      const options = []
      if (!known && current.provider && current.model) {
        options.push(h('option', { key: value, value }, `${current.provider} / ${current.model}`))
      }
      for (const group of groups) {
        options.push(h('optgroup', { key: group.id, label: group.name },
          ...(group.models || []).map((model) => h('option', {
            key: `${group.id}\u001f${model.id}`,
            value: `${group.id}\u001f${model.id}`,
          }, model.name))))
      }
      const efforts = known && known.reasoning ? known.reasoning.efforts || [] : []
      return h('div', { className: 'dsh-orb-set-pickers' },
        h('select', {
          'aria-label': props.label,
          disabled: props.disabled || options.length === 0,
          value: options.length === 0 ? '' : value,
          onChange: (event) => {
            const [provider, model] = String(event.target.value).split('\u001f')
            if (!provider || !model) return
            const next = findModel(props.catalog, { provider, model })
            const effort = next && next.reasoning ? next.reasoning.defaultEffort : undefined
            props.onSelect(effort ? { provider, model, reasoningEffort: effort } : { provider, model })
          },
        }, options.length === 0 ? h('option', { value: '' }, text.emptyCatalog) : options),
        efforts.length === 0 ? null : h('select', {
          'aria-label': text.defaultEffort,
          disabled: props.disabled,
          value: current.reasoningEffort || known.reasoning.defaultEffort || efforts[0].id,
          onChange: (event) => {
            props.onSelect({ provider: current.provider, model: current.model, reasoningEffort: event.target.value })
          },
        }, efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))))
    }

    function statusText(text, state) {
      if (state === 'granted') return text.tccGranted
      if (state === 'needsRelaunch') return text.tccRelaunch
      return text.tccMissing
    }

    function card(title, description, control) {
      return h('section', { className: 'dsh-orb-set-card' },
        h('div', { className: 'dsh-orb-set-card-main' },
          h('h3', null, title),
          description ? h('p', null, description) : null),
        control)
    }

    function customCard(text, snap) {
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.customTitle),
        snap.version ? h('p', null, text.customVersion.replaceAll('{version}', snap.version)) : null,
        h('p', null, text.customDescription),
        h('p', null, text.customUpdate),
        h('p', null,
          text.customRepo,
          h('a', {
            href: 'https://github.com/zhqxbmgit/DeepSeek-orb',
            target: '_blank',
            rel: 'noreferrer noopener',
          }, 'github.com/zhqxbmgit/DeepSeek-orb')))
    }

    function frameNotice(text, snap, disabled, mutate) {
      const frame = snap.frame || { state: 'stopped', error: '', phase: '' }
      if (frame.state === 'disabled' || snap.observationFrameEnabled === false) {
        return h('p', { className: 'dsh-orb-set-muted', role: 'status' }, text.frameDisabled)
      }
      if (frame.state === 'running') {
        return h('p', { className: 'dsh-orb-set-ok', role: 'status' }, text.frameRunning)
      }
      if (frame.state === 'starting' || frame.phase === 'downloading' || frame.phase === 'extracting') {
        const body = frame.phase === 'downloading'
          ? text.frameDownloading
          : frame.phase === 'extracting' ? text.frameExtracting : text.frameStarting
        return h('p', { className: 'dsh-orb-set-muted', role: 'status' }, body)
      }
      const failure = frame.error === 'runtime-download'
        ? text.frameRuntimeFailed
        : frame.error === 'frame-render' ? text.frameRenderFailed : text.frameFailed
      const start = frame.state === 'stopped' || frame.state === 'disabled'
      return h('div', { className: 'dsh-orb-set-notice is-error', role: 'alert' },
        h('div', { className: 'dsh-orb-set-notice-main' },
          h('h3', { className: 'dsh-orb-set-notice-title' }, text.frameFailedTitle),
          h('p', { className: 'dsh-orb-set-notice-body' }, failure)),
        h('button', {
          type: 'button',
          className: 'dsh-orb-set-notice-action',
          disabled,
          onClick: () => { void mutate('/.dsh-orb/frame/restart', {}) },
        }, start ? text.frameStart : text.frameRestart))
    }

    function tccCard(text, snap, disabled, mutate) {
      const name = snap.tcc.appName || ''
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.tccTitle),
        h('p', null, text.tccDescription),
        h('p', null, text.tccAppHint.replaceAll('{name}', name)),
        tccRow(text.tccScreenName, text.tccScreenReason, text.tccScreenPath, statusText(text, snap.tcc.screen), text.tccScreenOpen, disabled || snap.tcc.screen === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'screen' })
        }),
        tccRow(text.tccAccessibilityName, text.tccAccessibilityReason, text.tccAccessibilityPath, statusText(text, snap.tcc.accessibility), text.tccAccessibilityOpen, disabled || snap.tcc.accessibility === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'accessibility' })
        }),
        h('p', null, text.tccFooter.replaceAll('{name}', name)))
    }

    function tccRow(name, reason, path, status, open, disabled, onClick) {
      return h('div', { className: 'dsh-orb-set-tcc' },
        h('div', null,
          h('h4', null, name),
          h('p', null, reason),
          h('p', null, path),
          h('p', { className: 'dsh-orb-set-status' }, status)),
        h('button', { type: 'button', className: 'dsh-orb-set-button', disabled, onClick }, open))
    }

    const style = `
.dsh-orb-set { display: flex; flex-direction: column; gap: 16px; max-width: 720px; color: inherit; }
.dsh-orb-set-title { margin: 0; font-size: 20px; }
.dsh-orb-set-intro, .dsh-orb-set p { margin: 4px 0 0; color: color-mix(in srgb, currentColor 72%, transparent); font-size: 13px; line-height: 1.45; }
.dsh-orb-set-error, .dsh-orb-set p.dsh-orb-set-error { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-orb-set-ok { color: var(--dsw-alias-state-success-primary, #067647); }
.dsh-orb-set-muted { color: color-mix(in srgb, currentColor 58%, transparent); }
.dsh-orb-set-notice { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 10%, transparent); margin-top: 12px; }
.dsh-orb-set-notice-main { flex: 1; min-width: 0; }
.dsh-orb-set .dsh-orb-set-notice-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-orb-set p.dsh-orb-set-notice-body { margin: 4px 0 0; font-size: 13px; line-height: 1.45; color: inherit; }
.dsh-orb-set .dsh-orb-set-notice-action { flex: none; margin-left: auto; align-self: center; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; white-space: nowrap; cursor: pointer; background: var(--dsw-alias-button-info-fill, #2f6fed); color: var(--dsw-static-neutral-bluish-00, #fff); }
.dsh-orb-set .dsh-orb-set-notice-action:disabled { opacity: 0.5; cursor: default; }
.dsh-orb-set-fields { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.dsh-orb-set-card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 14px 16px; }
.dsh-orb-set-card-main { min-width: 0; }
.dsh-orb-set-row, .dsh-orb-set-card, .dsh-orb-set-tcc { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-orb-set-card { display: block; }
.dsh-orb-set h3, .dsh-orb-set h4 { margin: 0; font-size: 14px; }
.dsh-orb-set-button, .dsh-orb-set select { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; }
.dsh-orb-set-switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: color-mix(in srgb, currentColor 18%, transparent); position: relative; flex: none; }
.dsh-orb-set-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-static-neutral-bluish-00, white); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 120ms ease; }
.dsh-orb-set-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-orb-set-switch.is-on::after { transform: translateX(16px); }
.dsh-orb-set-pickers { display: flex; gap: 8px; align-items: center; flex: none; }
.dsh-orb-set-tcc { margin-top: 12px; }
.dsh-orb-set-status { font-weight: 600; }
.dsh-orb-set-fields:disabled { opacity: 0.55; }
`

    const SECTION_ID = 'orb'
    const inject = ['slots']

    function OrbSettingsSection() {
      const text = copy()
      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => { bumpLocale((count) => count + 1) })
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => { observer.disconnect() }
      }, [])
      const [state, setState] = React.useState({
        status: 'loading',
        error: '',
        snapshot: null,
        catalog: { groups: [] },
        busy: false,
      })

      async function load() {
        setState((prev) => ({ ...prev, status: prev.snapshot ? prev.status : 'loading', error: '' }))
        try {
          const [snapshot, catalog] = await Promise.all([
            request('/.dsh-orb/settings'),
            request('/.dsh-orb/models'),
          ])
          setState((prev) => ({
            ...prev,
            status: 'ready',
            error: '',
            snapshot,
            catalog: catalog || { groups: [] },
            busy: false,
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      async function refresh() {
        try {
          const snapshot = await request('/.dsh-orb/settings')
          setState((prev) => prev.snapshot ? { ...prev, snapshot } : prev)
        } catch {
          // Keep the last known state; the next poll or a page reload tries again.
        }
      }

      React.useEffect(() => {
        void load()
        const onFocus = () => { void refresh() }
        window.addEventListener?.('focus', onFocus)
        const timer = setInterval(() => { void refresh() }, 2000)
        return () => {
          window.removeEventListener?.('focus', onFocus)
          clearInterval(timer)
        }
      }, [])

      async function mutate(path, body) {
        setState((prev) => ({ ...prev, busy: true, error: '' }))
        try {
          const snapshot = await request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          setState((prev) => ({ ...prev, status: 'ready', snapshot, busy: false }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            busy: false,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      if (state.status === 'error' && !state.snapshot) {
        return h('div', { className: 'dsh-orb-set' },
          h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.error} ${state.error}`),
          h('button', { type: 'button', className: 'dsh-orb-set-button', onClick: () => { void load() } }, text.retry))
      }
      if (!state.snapshot) return h('div', { className: 'dsh-orb-set' }, h('p', null, text.nav))

      const snap = state.snapshot
      const disabled = !snap.supported || state.busy
      return h('div', { className: 'dsh-orb-set' },
        h('h2', { className: 'dsh-orb-set-title' }, text.nav),
        h('p', { className: 'dsh-orb-set-intro' }, text.intro),
        state.status === 'error' && state.error
          ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.saveError} ${state.error}`)
          : null,
        snap.supported ? null : h('p', { className: 'dsh-orb-set-banner', role: 'status' }, text.linux),
        customCard(text, snap),
        h('fieldset', { className: 'dsh-orb-set-fields', disabled },
          card(text.backgroundTitle, text.backgroundDescription, h(ModelPicker, {
            label: text.backgroundTitle,
            catalog: state.catalog,
            current: snap.background,
            disabled,
            onSelect: (selection) => { void mutate('/.dsh-orb/background-model', selection) },
          })),
          card(text.millifractionTitle, text.millifractionDescription, h(Toggle, {
            checked: snap.millifractionEnabled === true,
            label: text.millifractionToggle,
            disabled,
            onChange: (enabled) => {
              if (enabled === snap.millifractionEnabled) return
              if (!window.confirm(text.millifractionConfirm)) return
              void mutate('/.dsh-orb/millifraction', { enabled })
            },
          })),
          h('section', { className: 'dsh-orb-set-card' },
            h('div', { className: 'dsh-orb-set-row' },
              h('div', { className: 'dsh-orb-set-card-main' },
                h('h3', null, text.frameTitle),
                h('p', null, text.frameDescription)),
              h(Toggle, {
                checked: snap.observationFrameEnabled !== false,
                label: text.frameToggle,
                disabled,
                onChange: (enabled) => {
                  if (enabled === snap.observationFrameEnabled) return
                  void mutate('/.dsh-orb/observation-frame', { enabled })
                },
              })),
            frameNotice(text, snap, disabled, mutate)),
          snap.tcc && snap.tcc.applicable ? tccCard(text, snap, disabled, mutate) : null))
    }

    function apply(ctx) {
      // Rewrite the node instead of skipping when it exists: a hot reload must
      // replace the previous run's rules rather than leave them over the new markup.
      let styleNode = document.getElementById('dsh-orb-settings-style')
      if (!styleNode) {
        styleNode = document.createElement('style')
        styleNode.id = 'dsh-orb-settings-style'
        document.head.append(styleNode)
      }
      styleNode.textContent = style
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 25,
        label: () => copy().nav,
        inject: () => ({}),
      }, OrbSettingsSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
