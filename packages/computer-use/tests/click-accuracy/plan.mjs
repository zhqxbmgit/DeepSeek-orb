// Trial plan for the 0.2.17 click-accuracy baseline.
//
// The plan is deterministic from SEED. It contains target truth (rectangles,
// labels, expected centers); the Computer Use conversations never receive this
// file or its path. The runner uses it to render the fixture, to compute the
// independently expected landing, and to score real events.

export const SEED = 20261021
export const DPI_SCALE = 2
export const SCREEN = { width: 3840, height: 2160, workHeight: 2064, dpi: 192, scale: 2 }

function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a += 0x6D2B79F5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle (items, rng) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function rectAtCenter (cx, cy, width, height) {
  return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height }
}

const A_LAYOUTS = [
  {
    id: 'L0-original',
    window: { x: 1150, y: 380, width: 1400, height: 900 },
    targetSize: { width: 220, height: 140 },
    // Client-area centers. Normalized 0-1000 values are exactly 150/500/850
    // horizontally and 360/500/800 vertically for every A layout.
    xs: [210, 700, 1190],
    ys: [324, 450, 720],
  },
  {
    id: 'L1-moved',
    window: { x: 1550, y: 680, width: 1400, height: 900 },
    targetSize: { width: 220, height: 140 },
    xs: [210, 700, 1190],
    ys: [324, 450, 720],
  },
  {
    id: 'L2-resized',
    window: { x: 950, y: 300, width: 1600, height: 1000 },
    targetSize: { width: 220, height: 140 },
    xs: [240, 800, 1360],
    ys: [360, 500, 800],
  },
]

const POSITION_NAMES = [
  ['top-left', 'top-center', 'top-right'],
  ['middle-left', 'center', 'middle-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
]

export function buildATrials () {
  const trials = []
  let index = 0
  for (const layout of A_LAYOUTS) {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        index += 1
        const cx = layout.xs[col]
        const cy = layout.ys[row]
        const targetId = 'target'
        const targetLabel = `A-${layout.id}-R${row + 1}C${col + 1}`
        trials.push({
          trialId: `A-${layout.id}-${String(index).padStart(2, '0')}`,
          group: 'A',
          layoutVersion: layout.id,
          index,
          maxAttempts: 1,
          window: layout.window,
          targetId,
          targetLabel,
          targetRect: rectAtCenter(cx, cy, layout.targetSize.width, layout.targetSize.height),
          targetCenterClient: { x: cx, y: cy },
          positionName: POSITION_NAMES[row][col],
          sizeClass: 'a-target',
          instruction: `点击目标「${targetLabel}」。坐标由测试控制程序给出，不要自行选点。`,
          buttons: [{
            id: targetId,
            label: targetLabel,
            isTarget: true,
            fontPt: 18,
            rect: rectAtCenter(cx, cy, layout.targetSize.width, layout.targetSize.height),
          }],
        })
      }
    }
  }
  return trials
}

const LARGE_TARGETS = [
  '确认测试', '开始测试', '提交测试', '应用设置', '保存记录',
  '打开报告', '停止录制', '继续测试', '导出结果', '刷新列表',
]
const LARGE_DISTRACTORS = [
  '取消测试', '暂停测试', '提交设置', '应用记录', '保存报告',
  '打开记录', '停止测试', '继续录制', '导出设置', '刷新结果',
  '确认设置', '取消记录', '重置测试', '查看测试',
]

const SMALL_TARGETS = [
  '确认提交', '开始录制', '保存草稿', '应用更改', '打开目录',
  '停止上传', '继续下载', '导出表格', '刷新缓存', '重置筛选',
]
const SMALL_DISTRACTORS = [
  '取消提交', '暂停录制', '保存草稿副本', '应用默认值', '打开上级目录',
  '停止下载', '继续上传', '导出文件', '刷新列表', '重置排序',
  '确认更改', '取消上传', '清除缓存', '查看目录',
]

const DENSE_TARGETS = [
  '打开测试报告', '打开测试记录', '打开测试设置', '导出测试报告', '导出测试记录',
  '保存测试报告', '保存测试记录', '刷新测试报告', '复制测试报告', '删除测试记录',
]
const DENSE_DISTRACTORS = [
  '打开运行日志', '打开调试日志', '打开运行设置', '导出运行报告', '导出调试记录',
  '保存运行报告', '保存调试记录', '刷新运行报告', '复制调试记录', '删除测试报告',
  '打开测试快照', '导出测试快照', '保存测试快照', '刷新测试记录',
]

function makeLargeLayout (targetSlot, targetLabel, rng, index) {
  const slots = []
  const xs = [140, 590, 1040]
  const ys = [190, 570]
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      slots.push({
        id: `slot-${row}-${col}`,
        rect: { x: xs[col], y: ys[row], width: 420, height: 230 },
      })
    }
  }
  const distractors = shuffle(LARGE_DISTRACTORS.filter(label => label !== targetLabel), rng)
  const labels = []
  let d = 0
  for (let i = 0; i < slots.length; i += 1) {
    labels.push(i === targetSlot ? targetLabel : distractors[d++])
  }
  const buttons = slots.map((slot, i) => ({
    id: slot.id,
    label: labels[i],
    isTarget: i === targetSlot,
    fontPt: 17,
    rect: slot.rect,
  }))
  return {
    layout: 'B-large',
    buttons,
    targetId: slots[targetSlot].id,
    targetLabel,
    targetRect: slots[targetSlot].rect,
    instruction: `点击「${targetLabel}」按钮。`,
    sizeClass: 'large',
    sizeDip: { width: 210, height: 115 },
  }
}

function makeSmallLayout (targetSlot, targetLabel, rng) {
  const xs = [140, 480, 820, 1160]
  const ys = [180, 460, 740]
  const slots = []
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      slots.push({ id: `slot-${row}-${col}`, rect: { x: xs[col], y: ys[row], width: 300, height: 120 } })
    }
  }
  const distractors = shuffle(SMALL_DISTRACTORS.filter(label => label !== targetLabel), rng)
  const labels = []
  let d = 0
  for (let i = 0; i < slots.length; i += 1) {
    labels.push(i === targetSlot ? targetLabel : distractors[d++])
  }
  const buttons = slots.map((slot, i) => ({
    id: slot.id,
    label: labels[i],
    isTarget: i === targetSlot,
    fontPt: 11,
    rect: slot.rect,
  }))
  return {
    layout: 'B-small',
    buttons,
    targetId: slots[targetSlot].id,
    targetLabel,
    targetRect: slots[targetSlot].rect,
    instruction: `点击「${targetLabel}」按钮。`,
    sizeClass: 'small',
    sizeDip: { width: 150, height: 60 },
  }
}

function makeDenseLayout (targetSlot, targetLabel, rng) {
  const rows = []
  for (let i = 0; i < 10; i += 1) {
    rows.push({ id: `row-${i}`, rect: { x: 250, y: 190 + i * 76, width: 1100, height: 64 } })
  }
  const distractors = shuffle(DENSE_DISTRACTORS.filter(label => label !== targetLabel), rng)
  const labels = []
  let d = 0
  for (let i = 0; i < rows.length; i += 1) {
    labels.push(i === targetSlot ? targetLabel : distractors[d++])
  }
  const buttons = rows.map((row, i) => ({
    id: row.id,
    label: labels[i],
    isTarget: i === targetSlot,
    fontPt: 10,
    rect: row.rect,
  }))
  return {
    layout: 'B-dense-menu',
    buttons,
    targetId: rows[targetSlot].id,
    targetLabel,
    targetRect: rows[targetSlot].rect,
    instruction: `在菜单中选择「${targetLabel}」。`,
    sizeClass: 'dense',
    sizeDip: { width: 550, height: 32 },
  }
}

export function buildBTrials () {
  const rng = mulberry32(SEED ^ 0x5B5B)
  const largeSlots = [0, 1, 2, 3, 4, 5, 0, 2, 3, 5]
  const smallSlots = [0, 3, 8, 11, 4, 7, 1, 2, 5, 9]
  const denseSlots = [0, 9, 4, 5, 1, 8, 2, 7, 3, 6]
  const trials = []
  let index = 0
  for (let i = 0; i < 10; i += 1) {
    index += 1
    const layout = makeLargeLayout(largeSlots[i], LARGE_TARGETS[i], rng, index)
    trials.push({ trialId: `B-large-${String(index).padStart(2, '0')}`, group: 'B', index, maxAttempts: 2, window: { x: 1100, y: 300, width: 1600, height: 1000 }, layoutVersion: 'B-large', ...layout })
  }
  for (let i = 0; i < 10; i += 1) {
    index += 1
    const layout = makeSmallLayout(smallSlots[i], SMALL_TARGETS[i], rng, index)
    trials.push({ trialId: `B-small-${String(i + 1).padStart(2, '0')}`, group: 'B', index, maxAttempts: 2, window: { x: 1100, y: 300, width: 1600, height: 1000 }, layoutVersion: 'B-small', ...layout })
  }
  for (let i = 0; i < 10; i += 1) {
    index += 1
    const layout = makeDenseLayout(denseSlots[i], DENSE_TARGETS[i], rng, index)
    trials.push({ trialId: `B-dense-${String(i + 1).padStart(2, '0')}`, group: 'B', index, maxAttempts: 2, window: { x: 1100, y: 300, width: 1600, height: 1000 }, layoutVersion: 'B-dense-menu', ...layout })
  }
  return trials
}

export function annotateGeometry (trial) {
  const win = trial.window
  const tx = win.x + trial.targetRect.x + trial.targetRect.width / 2
  const ty = win.y + trial.targetRect.y + trial.targetRect.height / 2
  const xf = (tx - win.x) / win.width
  const yf = (ty - win.y) / win.height
  const xBand = xf < 1 / 3 ? 'left' : xf > 2 / 3 ? 'right' : 'center'
  const yBand = yf < 1 / 3 ? 'top' : yf > 2 / 3 ? 'bottom' : 'middle'
  return {
    targetCenterScreen: { x: tx, y: ty },
    position: {
      xFraction: Number(xf.toFixed(4)),
      yFraction: Number(yf.toFixed(4)),
      xBand,
      yBand,
      name: `${yBand}-${xBand}`,
    },
  }
}

export function buildPlan () {
  const a = buildATrials()
  const b = buildBTrials()
  const trials = [...a, ...b].map(trial => {
    const g = annotateGeometry(trial)
    return {
      ...trial,
      targetCenterScreen: g.targetCenterScreen,
      position: g.position,
      sizePhysical: trial.sizeClass === 'large'
        ? { width: 420, height: 230 }
        : trial.sizeClass === 'small'
          ? { width: 300, height: 120 }
          : trial.sizeClass === 'dense'
            ? { width: 1100, height: 64 }
            : { width: 220, height: 140 },
      sizeDip: trial.sizeDip ?? { width: 110, height: 70 },
    }
  })
  return { seed: SEED, screen: SCREEN, aCount: a.length, bCount: b.length, trials }
}

// --------------------------------------------------------- round-3 additions
// A2: 12 decimal-coordinate samples on odd-sized, non-zero-origin windows.
// Each `dx/dy` is applied to an integer base centre before the independent
// inverse mapping. The exact mapped pixel is therefore non-integer (often at
// or within 0.01 px of a .5 rounding boundary); the target is placed at the
// rounded integer pixel. The plugin's Math.round is exercised without importing
// its conversion function.

const A2_LAYOUTS = [
  {
    id: 'A2-L0-odd1401x901',
    window: { x: 811, y: 377, width: 1401, height: 901 },
    centers: [
      { x: 984, y: 989, dx: -0.4, dy: -0.4, note: 'non-integer both axes' },
      { x: 1512, y: 828, dx: -0.5, dy: -0.5, note: 'x and y exactly .5 boundary' },
      { x: 2002, y: 640, dx: 0.4, dy: -0.5, note: 'near right edge, y .5' },
      { x: 1161, y: 701, dx: -0.499, dy: 0.4, note: 'just below .5' },
    ],
  },
  {
    id: 'A2-L1-odd1387x877',
    window: { x: 1223, y: 509, width: 1387, height: 877 },
    centers: [
      { x: 1686, y: 1094, dx: 0.5, dy: 0.4, note: 'x exactly .5, rounds up' },
      { x: 2302, y: 760, dx: -0.5, dy: 0.49, note: 'near right edge, x .5' },
      { x: 1324, y: 1298, dx: 0.49, dy: -0.5, note: 'left-bottom, near .5' },
      { x: 2471, y: 800, dx: -0.49, dy: -0.4, note: 'right-top' },
    ],
  },
  {
    id: 'A2-L2-odd1603x999',
    window: { x: 733, y: 281, width: 1603, height: 999 },
    centers: [
      { x: 895, y: 1181, dx: 0.5, dy: 0.5, note: 'left-bottom, both .5' },
      { x: 2174, y: 620, dx: -0.5, dy: 0.4, note: 'right-top, x .5' },
      { x: 1535, y: 1217, dx: 0.4, dy: 0.49, note: 'bottom, tight margin' },
      { x: 1434, y: 700, dx: -0.4, dy: -0.4, note: 'near top' },
    ],
  },
]

function specifiedFromExact (window, exact) {
  return {
    x: Number(((exact.x - window.x) / window.width * 1000).toFixed(4)),
    y: Number(((exact.y - window.y) / window.height * 1000).toFixed(4)),
  }
}

function expectedFromSpecified (window, specified) {
  return {
    x: Math.round(window.x + specified.x / 1000 * window.width),
    y: Math.round(window.y + specified.y / 1000 * window.height),
  }
}

export function buildA2Trials () {
  const trials = []
  let index = 0
  for (const layout of A2_LAYOUTS) {
    for (const base of layout.centers) {
      index += 1
      const exact = { x: base.x + base.dx, y: base.y + base.dy }
      const specified = specifiedFromExact(layout.window, exact)
      const expected = expectedFromSpecified(layout.window, specified)
      const rect = rectAtCenter(expected.x - layout.window.x, expected.y - layout.window.y, 200, 120)
      if (rect.x < 1 || rect.y < 176 || rect.x + rect.width > layout.window.width - 1 || rect.y + rect.height > layout.window.height - 1) {
        throw new Error(`A2 ${layout.id} ${index}: target rect out of safe window: ${JSON.stringify(rect)}`)
      }
      const trialId = `A2-${String(index).padStart(2, '0')}`
      trials.push({
        trialId,
        group: 'A2',
        layoutVersion: layout.id,
        index,
        maxAttempts: 1,
        window: layout.window,
        targetId: 'target',
        targetLabel: trialId,
        targetRect: rect,
        targetCenterClient: { x: expected.x - layout.window.x, y: expected.y - layout.window.y },
        targetCenterScreen: expected,
        specified,
        expected,
        exactMapping: { x: Number(exact.x.toFixed(6)), y: Number(exact.y.toFixed(6)) },
        roundingFraction: { x: Number((exact.x % 1).toFixed(6)), y: Number((exact.y % 1).toFixed(6)) },
        roundingNote: base.note,
        position: { name: 'decimal-coordinate' },
        sizeClass: 'a2-target',
        sizePhysical: { width: 200, height: 120 },
        sizeDip: { width: 100, height: 60 },
        instruction: `点击目标「${trialId}」。坐标由测试控制程序给出，不要自行选点。`,
        buttons: [{
          id: 'target',
          label: trialId,
          isTarget: true,
          fontPt: 17,
          rect,
        }],
      })
    }
  }
  return trials
}

// B2: 36 screenshot-only samples on a 2562x1641 physical window with toolbar,
// sidebar and bottom-account context. Target slots and labels are both driven
// by the seeded RNG, so the seed changes the actual target position, not just
// distractor text.
const B2_GLYPHS = [
  { name: '设置', symbol: '⚙' },
  { name: '账号', symbol: '👤' },
  { name: '报表', symbol: '📊' },
  { name: '文件', symbol: '📁' },
  { name: '搜索', symbol: '🔍' },
  { name: '通知', symbol: '🔔' },
  { name: '收藏', symbol: '⭐' },
  { name: '历史', symbol: '🕒' },
  { name: '云同步', symbol: '☁' },
  { name: '安全', symbol: '🔒' },
  { name: '邮件', symbol: '✉' },
  { name: '设备', symbol: '🖥' },
]
const B2_TEXTS = [
  '设置', '账号', '报表', '文件', '搜索', '通知',
  '收藏', '历史', '云同步', '安全', '邮件', '设备',
]

const B2_WINDOW = { x: 600, y: 250, width: 2562, height: 1641 }

const B2_SLOTS = {
  icon24: [
    { id: 's0', x: 400, y: 210, width: 48, height: 48 },
    { id: 's1', x: 620, y: 210, width: 48, height: 48 },
    { id: 's2', x: 840, y: 210, width: 48, height: 48 },
    { id: 's3', x: 60, y: 360, width: 48, height: 48 },
    { id: 's4', x: 60, y: 500, width: 48, height: 48 },
    { id: 's5', x: 60, y: 640, width: 48, height: 48 },
    { id: 's6', x: 1200, y: 700, width: 48, height: 48 },
    { id: 's7', x: 2480, y: 520, width: 48, height: 48 },
    { id: 's8', x: 2480, y: 680, width: 48, height: 48 },
    { id: 's9', x: 80, y: 1570, width: 48, height: 48 },
    { id: 's10', x: 1200, y: 1536, width: 48, height: 48 },
    { id: 's11', x: 2380, y: 1570, width: 48, height: 48 },
  ],
  icon32: [
    { id: 's0', x: 400, y: 210, width: 64, height: 64 },
    { id: 's1', x: 650, y: 210, width: 64, height: 64 },
    { id: 's2', x: 900, y: 210, width: 64, height: 64 },
    { id: 's3', x: 60, y: 350, width: 64, height: 64 },
    { id: 's4', x: 60, y: 520, width: 64, height: 64 },
    { id: 's5', x: 60, y: 690, width: 64, height: 64 },
    { id: 's6', x: 1200, y: 700, width: 64, height: 64 },
    { id: 's7', x: 2460, y: 500, width: 64, height: 64 },
    { id: 's8', x: 2460, y: 680, width: 64, height: 64 },
    { id: 's9', x: 80, y: 1568, width: 64, height: 64 },
    { id: 's10', x: 1200, y: 1530, width: 64, height: 64 },
    { id: 's11', x: 2360, y: 1568, width: 64, height: 64 },
  ],
  text40x20: [
    { id: 's0', x: 400, y: 210, width: 80, height: 40 },
    { id: 's1', x: 650, y: 210, width: 80, height: 40 },
    { id: 's2', x: 900, y: 210, width: 80, height: 40 },
    { id: 's3', x: 1150, y: 210, width: 80, height: 40 },
    { id: 's4', x: 60, y: 380, width: 80, height: 40 },
    { id: 's5', x: 60, y: 520, width: 80, height: 40 },
    { id: 's6', x: 60, y: 660, width: 80, height: 40 },
    { id: 's7', x: 1200, y: 700, width: 80, height: 40 },
    { id: 's8', x: 2440, y: 520, width: 80, height: 40 },
    { id: 's9', x: 80, y: 1580, width: 80, height: 40 },
    { id: 's10', x: 1200, y: 1580, width: 80, height: 40 },
    { id: 's11', x: 2360, y: 1580, width: 80, height: 40 },
  ],
}

const B2_CONTEXT = [
  { id: 'ctx-sidebar', text: '侧栏', x: 20, y: 200, width: 100, height: 24 },
  { id: 'ctx-toolbar', text: '工具栏', x: 300, y: 180, width: 160, height: 24 },
  { id: 'ctx-content', text: '内容区', x: 1000, y: 560, width: 160, height: 24 },
  { id: 'ctx-account', text: '底部账号区', x: 40, y: 1480, width: 200, height: 28 },
]

function b2Class (sizeClass) {
  if (sizeClass === 'icon24') return { slots: B2_SLOTS.icon24, physical: { width: 48, height: 48 }, dip: { width: 24, height: 24 }, fontPt: 14, fontFamily: 'Segoe UI Emoji' }
  if (sizeClass === 'icon32') return { slots: B2_SLOTS.icon32, physical: { width: 64, height: 64 }, dip: { width: 32, height: 32 }, fontPt: 18, fontFamily: 'Segoe UI Emoji' }
  return { slots: B2_SLOTS.text40x20, physical: { width: 80, height: 40 }, dip: { width: 40, height: 20 }, fontPt: 8, fontFamily: 'Microsoft YaHei UI' }
}

export function buildB2Trials () {
  const rng = mulberry32(SEED ^ 0xB202)
  const classes = ['icon24', 'icon32', 'text40x20']
  const trials = []
  let index = 0
  for (const sizeClass of classes) {
    const meta = b2Class(sizeClass)
    const slotOrder = shuffle(meta.slots, rng)
    const labelOrder = shuffle(sizeClass === 'text40x20' ? B2_TEXTS : B2_GLYPHS, rng)
    for (let i = 0; i < 12; i += 1) {
      index += 1
      const slot = slotOrder[i]
      const target = labelOrder[i]
      const targetName = sizeClass === 'text40x20' ? target : target.name
      const targetText = sizeClass === 'text40x20' ? target : target.symbol
      const distractors = shuffle(labelOrder.filter(x => (sizeClass === 'text40x20' ? x : x.name) !== targetName), rng)
      const labels = []
      let cursor = 0
      for (const s of meta.slots) {
        if (s.id === slot.id) labels.push(target)
        else labels.push(distractors[cursor++])
      }
      const buttons = meta.slots.map((s, n) => ({
        id: s.id,
        label: sizeClass === 'text40x20' ? labels[n] : labels[n].symbol,
        isTarget: s.id === slot.id,
        fontPt: meta.fontPt,
        fontFamily: meta.fontFamily,
        rect: { x: s.x, y: s.y, width: s.width, height: s.height },
      }))
      const targetRect = { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
      const center = { x: B2_WINDOW.x + slot.x + slot.width / 2, y: B2_WINDOW.y + slot.y + slot.height / 2 }
      const xf = (center.x - B2_WINDOW.x) / B2_WINDOW.width
      const yf = (center.y - B2_WINDOW.y) / B2_WINDOW.height
      const xBand = xf < 1 / 3 ? 'left' : xf > 2 / 3 ? 'right' : 'center'
      const yBand = yf < 1 / 3 ? 'top' : yf > 2 / 3 ? 'bottom' : 'middle'
      const trialId = `B2-${sizeClass}-${String(i + 1).padStart(2, '0')}`
      trials.push({
        trialId,
        group: 'B2',
        layoutVersion: `B2-${sizeClass}`,
        index,
        maxAttempts: 2,
        window: B2_WINDOW,
        targetId: slot.id,
        targetLabel: sizeClass === 'text40x20' ? targetName : `${targetName} ${targetText}`,
        targetRect,
        targetCenterClient: { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 },
        targetCenterScreen: center,
        position: {
          xFraction: Number(xf.toFixed(4)),
          yFraction: Number(yf.toFixed(4)),
          xBand,
          yBand,
          name: `${yBand}-${xBand}`,
        },
        sizeClass,
        sizePhysical: meta.physical,
        sizeDip: meta.dip,
        instruction: sizeClass === 'text40x20'
          ? `点击「${targetName}」短文本项。`
          : `点击「${targetName}」图标（${targetText}）。`,
        contextLabels: B2_CONTEXT,
        buttons,
      })
    }
  }
  return trials
}

export function buildPlan2 () {
  const a2 = buildA2Trials()
  const b2 = buildB2Trials()
  return {
    seed: SEED,
    screen: SCREEN,
    a2Count: a2.length,
    b2Count: b2.length,
    trials: [...a2, ...b2],
  }
}

