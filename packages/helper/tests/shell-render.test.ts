import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The ball page is a browser-only module (window/document at import time), so
 * these rendering fixes are pinned at the source level, the way drag-input and
 * transcript-model guard shell.js. Comments are stripped: only live code counts.
 */
const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * An asset as the pins below read it, with its line endings normalized. The patterns anchor on
 * `\n`, and a Windows checkout (`core.autocrlf=true`) has CRLF on disk, which is not what any of
 * them are pinning.
 * @param relative - asset path relative to this test file.
 * @returns the asset text with `\r\n` folded to `\n`.
 */
function source(relative: string): string {
  return readFileSync(join(here, relative), 'utf8').replaceAll('\r\n', '\n')
}

const shell = source('../assets/shell.js')
const code = shell.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
const highlight = source('../assets/highlight.js')

describe('ball page render guards', () => {
  it('appends the web-fetch meta without the undefined url reference', () => {
    assert.match(code, /fetch\.append\(meta\)/)
    assert.equal(code.includes('fetch.append(url'), false)
  })

  it('keeps drawing the rest of a frame when one item fails', () => {
    assert.match(code, /for \(const item of list\) \{\s*try \{/)
    assert.match(code, /catch \(error\) \{\s*console\.error\(/)
  })

  it('builds chip icons as nodes instead of innerHTML strings', () => {
    assert.match(code, /status\.replaceChildren\(icon\(/)
    assert.equal(code.includes('status.innerHTML = icon('), false)
  })

  it('keeps the card expander mounted while it toggles the hidden rows', () => {
    assert.equal(code.includes('expand.remove()'), false)
    assert.match(code, /target\.insertBefore\(row, expand\)/)
    assert.match(code, /expand\.textContent = open \? chatLabels\.collapse/)
  })

  it('copies the rows the tool cards show, read at click time', () => {
    // The reader runs on click, so the clipboard follows the cap and the expander.
    assert.match(code, /copyText\(copy, \(\) => terminalCopyText\(/)
    assert.match(code, /querySelectorAll\('\.term-line'\)/)
    assert.match(code, /copyText\(copy, \(\) => readCopyText\(/)
    assert.match(code, /querySelectorAll\('\.read-content'\)/)
    assert.match(code, /copyText\(copy, \(\) => searchCopyText\(/)
    assert.match(code, /querySelectorAll\('\.search-file-path, \.search-line'\)/)
  })

  it('re-upgrades tracked roots once a lazy grammar lands', () => {
    assert.match(highlight, /const root = ref\.deref\(\)/)
    assert.match(highlight, /upgradeCodeBlocks\(root, \{ track: false \}\)/)
  })

  it('tracks a re-rendered root once instead of once per render', () => {
    assert.match(highlight, /known = new WeakSet\(\)/)
    assert.match(highlight, /if \(track && !known\.has\(root\)\)/)
    assert.equal(highlight.includes('if (track) tracked.add(new WeakRef(root))'), false)
  })

  it('keeps the ball wrapped: only the panel far edge moves for the strip', () => {
    const css = source('../assets/floating.css')
    // The panel is the window minus its chrome, so the ball at the near edge always sits
    // inside it: a stale strip state must never leave the ball outside the panel.
    assert.equal(/--panel-w|width:\s*var\(--panel-w\)/.test(css), false)
    assert.match(css, /#panel \{\s*position: absolute;\s*inset: var\(--chrome\);/)
    // The panel and the strip are placed from the same offset, so they cannot drift apart.
    assert.match(css, /--panel-left:\s*calc\(var\(--chrome\) \+ var\(--strip-w\)\)/)
    assert.match(css, /body\.has-strip\.strip-left #panel \{\s*left:\s*var\(--panel-left\);\s*right: var\(--chrome\);/)
    assert.match(css, /body\.has-strip\.strip-right #panel \{\s*right: var\(--panel-left\);\s*left: var\(--chrome\);/)
    assert.match(css, /body\.has-strip\.strip-left #agent-strip \{\s*left:\s*0;\s*width:\s*calc\(var\(--panel-left\) \+ var\(--strip-tuck\)\)/)
    // The old rules sized the strip from a hard-coded panel width instead of the panel's own.
    assert.equal(css.includes('right: calc(320px'), false)
    // `--panel-left` is declared on the root and computes with `--strip-w`, so the page must
    // set that one on the root too: a body-scoped value would leave the offset at 12px.
    assert.match(code, /document\.documentElement\.style\.setProperty\('--strip-w'/)
    assert.equal(code.includes("document.body.style.setProperty('--strip-w'"), false)
  })

  it('re-syncs the host geometry whenever the reservation and the chips disagree', () => {
    // Both directions, and even while the strip is hidden: the reservation follows the chip
    // list, so a missed message would either cover the chips or leave a gap beside them.
    assert.match(code, /if \(document\.body\.classList\.contains\('has-strip'\) !== \(agentItems\.length > 0\)\) void syncStrip\(\)/)
    assert.match(code, /async function syncStrip\(\)/)
    assert.match(code, /await api\.syncStrip\?\.\(\)/)
    // Once on startup, so a state message lost across a page load heals before the first click.
    assert.match(code, /renderUnconfirmed\(\)\n(?:\s*\/\/[^\n]*\n)*\s+void syncStrip\(\)\n\}/)
  })

  it('dismisses a finished chip from its own control instead of the chip body', () => {
    const css = source('../assets/floating.css')
    const preload = source('../preload.cjs')
    const main = source('../src/main.ts')
    // A button inside a button is invalid markup and swallows the inner click, so the row is a
    // container and each control is a button of its own.
    assert.match(code, /const chip = document\.createElement\('div'\)/)
    assert.equal(code.includes("const chip = document.createElement('button')"), false)
    assert.match(code, /open\.className = 'agent-chip-open'/)
    assert.match(code, /dismiss\.className = 'agent-chip-dismiss'/)
    assert.match(code, /api\.dismissAgent\?\.\(item\.sessionId\)/)
    // Only a finished stretch has anything to dismiss: while it runs, that chip is the only trace
    // of the task. The × sits exactly where the unread dot used to.
    assert.match(code, /if \(item\.unread === true\) \{\n\s+chip\.dataset\.dismiss = 'true'\n\s+const dismiss = document\.createElement\('button'\)/)
    assert.equal(code.includes('agent-chip-unread'), false)
    assert.equal(css.includes('agent-chip-unread'), false)
    assert.match(css, /\.agent-chip-dismiss \{/)
    // The collapsed row cannot hold status + elapsed + ×, so the elapsed time steps aside instead of
    // being cut into a half glyph beside the ×.
    assert.match(css, /\.agent-chip\[data-dismiss="true"\]:not\(:hover\):not\(:focus-within\) \.agent-chip-time \{\n\s+display: none;/)
    // Hovering — or tabbing into either control — expands the row, which is what reveals both the
    // task name and the ×.
    assert.match(css, /\.agent-chip:hover,\n\.agent-chip:focus-within \{\n\s+width: 100%;/)
    // The click has a bridge: page → preload → helper → host.
    assert.match(preload, /ipcRenderer\.send\('orb:agent-dismiss', id\)/)
    assert.match(main, /ipcMain\.on\('orb:agent-dismiss',[\s\S]{0,160}?type: 'agent-dismiss'/)
  })
})

/**
 * A turn in the conversation on screen must be visible: the ball comes back from the screen edge,
 * the panel opens and stays pinned. The page only ever sees the displayed conversation's turns —
 * the host streams that one session — so this cannot fire for a background conversation's agent.
 */
describe('agent work keeps the panel on screen', () => {
  it('promotes the panel from the collapsed and docked states when a turn starts', () => {
    assert.match(code, /if \(next\) \{\n(?:\s*\/\/[^\n]*\n)*\s+void showWorkPanel\(\)/)
    assert.match(code, /async function showWorkPanel\(\) \{\n\s+if \(pageClosed\(\)\) return\n(?:\s*\/\/[^\n]*\n)*\s+if \(docked !== undefined\) await unsnapDocked\(\)\n\s+await setExpanded\(true\)\n\s+pinBall\(\)/)
  })

  it('never docks while the turn is running', () => {
    // The dock paths carry the turn state to the main process as `canDock`: a release on a
    // screen edge cannot dock the ball while the agent is working.
    assert.match(code, /api\.dragMove\(!\(running \|\| asking\(\)\)\)/)
    assert.match(code, /api\.dragEnd\(panelDrag \? false : !\(running \|\| asking\(\)\)\)/)
  })

  it('locks only the two conversation-switch controls, and only while running', () => {
    assert.match(code, /function setWorkLocked\(locked\) \{[\s\S]{0,220}document\.body\.classList\.toggle\('work-locked', locked\)/)
    // The lock follows the turn, and a transcript reset (a conversation switch) clears it.
    assert.match(code, /setWorkLocked\(running\)/)
    assert.match(code, /function clearTranscript\(\) \{[\s\S]{0,600}setRunning\(false\)/)
    // Both controls answer a click while locked with the inline notice instead of switching.
    assert.match(code, /historyButton\.addEventListener\('click', \(\) => \{\n\s+if \(workLocked\) \{\n\s+showHint\(messages\.workLocked\)/)
    assert.match(code, /newConversation\.addEventListener\('click', \(\) => \{\n\s+if \(workLocked\) \{\n\s+showHint\(messages\.workLocked\)/)
    // A notice, never a dialog, and it clears itself.
    assert.match(code, /hintTimer = setTimeout\(\(\) => \{\n\s+hintTimer = undefined\n\s+hint\.hidden = true\n\s+\}, HINT_MS\)/)
    assert.equal(code.includes('confirm('), false)
    assert.equal(code.includes('alert('), false)
  })

  it('gives both locked controls a tooltip that explains the refusal', () => {
    assert.match(code, /historyButton\.title = workLocked \? messages\.historyLocked : messages\.history/)
    assert.match(code, /newConversation\.title = workLocked \? messages\.newLocked : messages\.fresh/)
    assert.match(code, /function refreshAllText\(\) \{\n\s+applyStaticText\(\)\n\s+applyLockedLabels\(\)/)
  })

  it('ships the notice element and its styles', () => {
    const html = source('../assets/floating.html')
    const css = source('../assets/floating.css')
    assert.match(html, /<p id="hint" role="status" hidden><\/p>/)
    assert.match(css, /body\.work-locked #history,\nbody\.work-locked #new-conversation \{\n\s+opacity: 0\.45;/)
  })
})

/**
 * The single-finger layout: left click opens, nothing on pointer-leave closes, an explicit
 * button collapses. These are pinned at the source level like the rest of the page, because
 * the page is a browser-only module.
 */
describe('stable panel for one-finger use', () => {
  it('never opens or closes the panel from pointer movement', () => {
    assert.equal(code.includes('syncExpand'), false)
    assert.equal(code.includes('function scheduleCollapse'), false)
    assert.match(code, /document\.body\.addEventListener\('pointerleave', \(\) => \{\n\s+dockPointerInside = false\n\s+if \(pointerHeld \|\| dragging\) return/)
    // Leaving is explicitly not a collapse; only a docked sliver still answers hover.
    assert.match(code, /if \(docked !== undefined && dockHoverArmed\) void unsnapDocked\(\)/)
  })

  it('opens on a left click and closes on a second click or the explicit button', () => {
    assert.match(code, /if \(expanded\) \{\n\s+await collapsePanel\(\)\n\s+return\n\s+\}\n\s+pinned = true\n\s+document\.body\.classList\.add\('pinned'\)\n\s+await setExpanded\(true\)/)
    assert.match(code, /async function collapsePanel\(\) \{\n\s+pinned = false\n\s+document\.body\.classList\.remove\('pinned'\)\n\s+await setExpanded\(false, true\)/)
    assert.match(code, /collapseButton\.addEventListener\('click', \(\) => \{ void collapsePanel\(\) \}\)/)
  })

  it('keeps an unsent draft across a collapse', () => {
    // Nothing on the collapse path touches the composer text; only a successful send clears it.
    const collapse = code.slice(code.indexOf('async function collapsePanel'), code.indexOf('async function collapsePanel') + 300)
    assert.equal(collapse.includes('clearPrompt'), false)
    const expanded = code.slice(code.indexOf('async function setExpanded'), code.indexOf('async function collapsePanel'))
    assert.equal(expanded.includes('clearPrompt'), false)
    assert.match(code, /function clearPrompt\(\) \{\n\s+prompt\.textContent = ''/)
  })

  it('does not grab the system focus to stay open', () => {
    assert.equal(code.includes('win.focus('), false)
    assert.equal(code.includes('window.focus('), false)
    assert.equal(code.includes("ipcRenderer.send('orb:focus'"), false)
  })
})

describe('send and paste are left-click buttons', () => {
  const html = source('../assets/floating.html')
  const preload = source('../preload.cjs')
  const main = source('../src/main.ts')

  it('ships a big submit button inside the composer form', () => {
    assert.match(html, /<form id="composer">[\s\S]*?<button id="send" type="submit"><\/button>\n\s+<\/form>/)
    assert.match(source('../assets/floating.css'), /#send \{\n\s+position: absolute;\n\s+top: 50%;/)
  })

  it('keeps Enter and Shift+Enter working next to the button', () => {
    assert.match(code, /prompt\.addEventListener\('keydown', \(event\) => \{\n\s+if \(event\.key !== 'Enter' \|\| event\.shiftKey \|\| isComposing\(event\)\) return/)
    assert.match(code, /composer\.addEventListener\('submit', \(event\) => \{\n\s+event\.preventDefault\(\)\n\s+void submitComposer\(\)/)
  })

  it('refuses empty input and waits for the Host echo instead of drawing a second message', () => {
    assert.match(code, /if \(submitting\) return\n\s+const text = promptText\(prompt\)\.trim\(\)\n\s+if \(text === ''\) \{\n\s+showHint\(messages\.needText\)/)
    assert.match(code, /submitting = true\n\s+renderSendState\(\)/)
    // The Host already publishes the accepted prompt; a local bubble would duplicate it.
    assert.equal(code.includes('echoUser'), false)
    assert.equal(code.includes('local-user:'), false)
    assert.match(code, /entryId = submitTracker\.expect\(payload, sessionId\)\n\s+if \(entryId === null\) return\n\s+inFlightEntryId = entryId/)
    // The composer is cleared only after the IPC write, so a throwing bridge keeps the draft.
    assert.match(code, /api\.send\(payload\)\n\s+clearPrompt\(\)/)
    assert.match(code, /submitTimer = setTimeout\(\(\) => \{ expireSubmit\(entryId\) \}, SUBMIT_TIMEOUT_MS\)/)
  })

  it('keeps a timed-out task as a separate recoverable record', () => {
    assert.match(code, /function expireSubmit\(entryId\)[\s\S]{0,420}?submitTracker\.expire\(entryId\)/)
    // The timeout never discards the entry: only an echo or the user's explicit remove does.
    const expire = code.slice(code.indexOf('function expireSubmit'), code.indexOf('function focusPromptEnd'))
    assert.equal(expire.includes('submitTracker.clear'), false)
    assert.equal(expire.includes('submitTracker.remove'), false)
    // Auto-fill only into an empty composer, and the two notices match the two outcomes.
    assert.match(expire, /if \(promptText\(prompt\)\.trim\(\) === ''\) \{/)
    assert.match(expire, /autoFilled = \{ entryId: entry\.id, text: entry\.text \}/)
    assert.match(expire, /showHint\(messages\.submitUnconfirmedRestored\)/)
    assert.match(expire, /showHint\(messages\.submitUnconfirmedKept\)/)
    // A left-click card lists each unresolved task with copy / restore / remove.
    assert.match(html, /<section id="unconfirmed" hidden>/)
    assert.match(html, /<ul id="unconfirmed-list"><\/ul>/)
    assert.match(code, /const entries = submitTracker\.list\(\)\.filter\(\(entry\) => entry\.status === 'timedOut'\)/)
    assert.match(code, /copy\.textContent = messages\.unconfirmedCopy/)
    assert.match(code, /restore\.textContent = messages\.unconfirmedRestore/)
    assert.match(code, /remove\.textContent = messages\.unconfirmedRemove/)
    assert.match(code, /if \(promptText\(prompt\)\.trim\(\) !== ''\) \{\n\s+showHint\(messages\.unconfirmedRestoreBlocked\)/)
  })

  it('lets a late echo converge only the entry it belongs to', () => {
    assert.match(code, /const confirmed = submitTracker\.observe\(block, sessionId\)\n\s+if \(confirmed !== null\) handleConfirmed\(confirmed\)/)
    assert.match(code, /function handleConfirmed\(entry\)[\s\S]{0,500}?auto !== null && auto\.entryId === entry\.id/)
    assert.match(code, /const untouched = promptText\(prompt\) === auto\.text/)
    assert.match(code, /if \(untouched\) \{\n\s+clearPrompt\(\)\n\s+showHint\(messages\.submitConfirmedLate\)/)
    assert.match(code, /showHint\(messages\.submitConfirmedLateEdited\)/)
    // A turn start only releases a submission whose echo already arrived.
    assert.match(code, /if \(next\) releaseConfirmedSubmit\(\)/)
    assert.match(code, /function releaseConfirmedSubmit\(\)[\s\S]{0,260}?if \(submitTracker\.has\(inFlightEntryId\)\) return/)
    assert.equal(code.includes('submitTracker.clear()'), false)
  })

  it('matches the Host echo by payload and leaves transcript keys to the Host', () => {
    const tracker = source('../assets/submit-confirmation.js')
    assert.match(tracker, /export function createSubmitTracker\(\)/)
    assert.match(tracker, /if \(block\.kind !== 'user'\) return null/)
    assert.match(tracker, /if \(entry\.text !== block\.text\) continue/)
    // Oldest-first assignment keeps two identical sends apart; confirmation removes exactly
    // that entry and never rewrites a transcript row.
    assert.match(tracker, /for \(const entry of entries\.values\(\)\)/)
    assert.match(tracker, /entries\.delete\(entry\.id\)\n\s+return snapshot\(entry\)/)
    assert.equal(tracker.includes('upsertBlock'), false)
    assert.equal(tracker.includes('local-user'), false)
  })

  it('pastes through the helper process and never sends', () => {
    assert.match(html, /<button id="paste" type="button"><\/button>/)
    assert.match(preload, /readClipboard\(\) \{\n\s+return ipcRenderer\.invoke\('orb:read-clipboard'\)/)
    assert.match(main, /ipcMain\.handle\('orb:read-clipboard'[\s\S]{0,260}?clipboard\.readText\(\)/)
    assert.match(code, /const merged = mergePastedText\(promptText\(prompt\), clip, PROMPT_LIMIT\)/)
    const paste = code.slice(code.indexOf('async function pasteTask'), code.indexOf('async function changePanelSize'))
    assert.equal(paste.includes('api.send'), false)
    // An empty or unreadable clipboard is a visible answer.
    assert.match(paste, /messages\.clipboardEmpty/)
    assert.match(paste, /messages\.clipboardFailed/)
    assert.match(paste, /messages\.pasteAppended/)
  })

  it('keeps the paste implementation testable outside the browser', () => {
    const merge = source('../assets/composer-text.js')
    assert.match(merge, /export function mergePastedText\(draft, clip, limit\)/)
    assert.match(merge, /export const PASTE_SEPARATOR = '\\n\\n'/)
  })
})

describe('left-click entries for settings and the main window', () => {
  const html = source('../assets/floating.html')
  const preload = source('../preload.cjs')
  const main = source('../src/main.ts')

  it('puts both entries in the tool row as labelled buttons', () => {
    assert.match(html, /<button id="open-settings" type="button"><\/button>\n\s+<button id="open-main" type="button"><\/button>/)
    assert.match(code, /openSettingsButton\.textContent = messages\.settings/)
    assert.match(code, /openMainButton\.textContent = messages\.mainWindow/)
  })

  it('bridges each click page → preload → helper → host', () => {
    assert.match(preload, /openMain\(\) \{\n\s+ipcRenderer\.send\('orb:open-main'\)/)
    assert.match(preload, /openSettings\(\) \{\n\s+ipcRenderer\.send\('orb:open-settings'\)/)
    assert.match(main, /ipcMain\.on\('orb:open-main',[\s\S]{0,120}?type: 'open-main'/)
    assert.match(main, /ipcMain\.on\('orb:open-settings',[\s\S]{0,120}?type: 'open-settings'/)
    assert.match(code, /openSettingsButton\.addEventListener\('click', \(\) => \{\n\s+if \(typeof api\.openSettings === 'function'\) api\.openSettings\(\)/)
    assert.match(code, /openMainButton\.addEventListener\('click', \(\) => \{\n\s+if \(typeof api\.openMain === 'function'\) api\.openMain\(\)/)
  })
})

describe('panel position and size survive a restart', () => {
  const html = source('../assets/floating.html')
  const preload = source('../preload.cjs')
  const main = source('../src/main.ts')

  it('restores the ball origin and the panel size before the window opens', () => {
    assert.match(main, /geometryPath = join\(app\.getPath\('userData'\), 'panel-geometry\.json'\)/)
    assert.match(main, /const stored = readGeometry\(geometryPath\)/)
    assert.match(main, /const restored = restoreOrigin\(stored\.ball\)/)
    assert.match(main, /restoredPanel = stored\.panel/)
    assert.match(main, /new FloatingPlacement\([\s\S]{0,420}?restoredPanel\)/)
  })

  it('persists on every committed move, resize and release', () => {
    assert.match(main, /function persistGeometry\(\)[\s\S]{0,520}?serializeGeometryStore\(placement\.ballOrigin\(\), placement\.panelSize\(\)\)/)
    assert.match(main, /const result = await placement\.endDrag\(cursor, canDock !== false\)\n\s+logDockDiagnostics\(cursor, result\)\n\s+persistGeometry\(\)/)
    assert.match(main, /const state = placement\.setPanelSize\(step\.size\)\n\s+persistGeometry\(\)/)
  })

  it('returns the applied layout with the new size and the page adopts it', () => {
    // The window direction can cross the up/down boundary in this exact step; the
    // handler must hand that state to the page instead of keeping only width/height.
    assert.match(main, /const state = placement\.setPanelSize\(step\.size\)[\s\S]{0,320}?return \{\n\s+ok: true,\n\s+changed: true,[\s\S]{0,120}?state,/)
    assert.match(code, /if \(result\.state !== null && typeof result\.state === 'object'\) \{\n\s+applyDirection\(result\.state\)/)
  })

  it('offers left-click size buttons and a left-drag move grip', () => {
    assert.match(html, /<button id="panel-smaller" type="button"><\/button>\n\s+<button id="panel-larger" type="button"><\/button>/)
    assert.match(html, /<button id="move-grip" type="button"><\/button>/)
    assert.match(preload, /resizePanel\(direction\) \{\n\s+return ipcRenderer\.invoke\('orb:panel-size', direction\)/)
    assert.match(main, /ipcMain\.handle\('orb:panel-size'[\s\S]{0,420}?stepPanelSize/)
    assert.match(code, /moveGrip\.addEventListener\('pointerdown'[\s\S]{0,260}?movingPanel = true\n\s+beginPointer\(moveGrip, event\)\n\s+api\.dragPress\(\)/)
    assert.match(code, /api\.dragMove\(false\)/)
  })

  it('re-fits the panel when a display changes', () => {
    assert.match(main, /screen\.on\('display-metrics-changed', reflow\)/)
    assert.match(main, /screen\.on\('display-added', reflow\)/)
    assert.match(main, /screen\.on\('display-removed', reflow\)/)
    assert.match(main, /const state = placement\.reflow\(\)/)
  })
})

describe('running and background state stay separate', () => {
  const html = source('../assets/floating.html')

  it('always shows which chat runs and how much background work remains', () => {
    assert.match(html, /<p id="task-state" role="status"><\/p>/)
    // One model feeds the line and the badge, so they cannot disagree about a state.
    assert.match(code, /import \{ describeTaskStatus \} from '\.\/background-status\.js'/)
    assert.match(code, /function taskStatusModel\(\)[\s\S]{0,260}?describeTaskStatus\(\{ running, elapsed, items: agentItems, labels: messages \}\)/)
    assert.match(code, /taskState\.textContent = model\.text\n\s+taskState\.dataset\.state = model\.state/)
  })

  it('keeps the stop scope honest', () => {
    assert.match(code, /stopNote: '停止只作用于本对话，后台任务继续运行；已执行的操作不会撤销'/)
    assert.match(code, /stop\.textContent = stopPending \? messages\.stopping : messages\.stop/)
    assert.match(code, /showHint\(messages\.stopRequested\)/)
    assert.match(code, /api\.stop\(\)/)
    // A stop request is sent once; the button stays disabled until the turn ends or times out.
    assert.match(code, /if \(stopPending\) return\n\s+stopPending = true\n\s+renderTurnbar\(\)\n\s+api\.stop\(\)/)
    assert.match(code, /stopTimer = setTimeout\(\(\) => \{\n\s+stopTimer = undefined\n\s+stopPending = false\n\s+renderTurnbar\(\)\n\s+\}, STOP_TIMEOUT_MS\)/)
  })

  it('does not describe a stop as an undo', () => {
    assert.equal(code.includes('自动撤销'), false)
    assert.match(code, /已执行的操作不会撤销/)
  })

  it('draws every badge from the same model so stopped work is never green', () => {
    assert.match(html, /<span id="ball-badge" hidden><\/span>/)
    assert.match(source('../assets/floating.css'), /#ball-badge\[data-kind="running"\]/)
    assert.match(source('../assets/floating.css'), /#ball-badge\[data-kind="stopped"\]/)
    assert.match(code, /const badge = taskStatusModel\(\)\.badge/)
    assert.match(code, /if \(badge\.kind === 'running'\) \{/)
    assert.match(code, /if \(badge\.kind === 'done'\) \{/)
    assert.match(code, /ballBadge\.append\(`!/)
  })
})
