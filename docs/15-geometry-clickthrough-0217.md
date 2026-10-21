# 0.2.17 收尾：几何异常处理与真实点击穿透验证

日期：2026-10-21

基线：0.2.16（3,397,896 bytes，SHA-256 `7C9F...`）。本轮只处理两个收尾项，不扩展功能。

最终包：

- `C:\dsh-orb-cordis\dsh-orb-0.2.17.tgz`
- 3,397,919 bytes
- SHA-256 `ED4571E81053E7E5CE95F2154AEF1C9DE9F19AE5D8E9182B8814C60D6A55B8A4`
- 1030 个 tar 条目；不带悬浮球、旧聊天、头像、选择工具栏或旧更新逻辑

## 1. 几何异常处理

### 根因

0.2.16 `createFrameDisplay().show()` 中：

```ts
const attempt = ++epoch
desired = region
const dip = deps.toDip(region)
const work = deps.workArea(...)
const placement = deps.placement(dip, work)
try { ...render... } catch { ...hide/onError... }
```

三个几何步骤在 `try` 外。它们抛错时：

- `show()` 直接 reject；
- `desired` 已是新目标；
- 旧窗口仍可见，`shownRegion`/实际 bounds 仍是旧目标；
- 没有 `onError`，设置页看不到异常；
- `main.ts` 的拒绝处理只 ack。

Codex 对生产函数注入 `toDip`、`workArea`、`placement` 抛错，三种情况均得到 `visibleAfterCurrentFailure: true`、`errorNotifications: []`。

### 修改

`frame-display.ts` 把几何准备移入同一个 `try`：

```ts
const attempt = ++epoch
desired = region
try {
  const dip = deps.toDip(region)
  const work = deps.workArea(...)
  const placement = deps.placement(dip, work)
  window.setBounds(placement.bounds)
  await window.executeJavaScript(...)
} catch (error) {
  if (attempt !== epoch || desired === undefined) return false
  hide()
  deps.onError?.(error)
  return false
}
```

行为：

- 当前请求几何失败 → `hide()` 清空 `desired`/`shown` 并隐藏；
- `onError` 走现有 `overlay-error` 链路，设置页可见；
- `show()` resolve false，`main.ts` 仍 ack，Host 不会等超时；
- 旧 epoch 的迟到成功/失败仍被 epoch 检查挡住；
- reflow 调用同一个 `show()`，共享同一套错误和有效性规则；
- 没有新增固定延时，没有重写窗口/显示系统。

### 三个故障注入的实际结果

使用真实 `createFrameDisplay`，先成功显示 A，再让 B 的几何步骤抛错：

| 故障点 | visibleAfterCurrentFailure | onError | shownRegion | desiredRegion |
|---|---:|---|---|---|
| `toDip` | false | `screenToDipRect failed` | null | null |
| `workArea` | false | `getDisplayNearestPoint failed` | null | null |
| `placement` | false | `placement failed` | null | null |
| reflow 的 `placement` | false | `reflow placement failed` | null | null |

完整 JSON：[geometry-fault-0217.json](../.zcode/evidence/geometry-fault-0217.json)

`actualBounds` 仍记录旧 A，因为窗口被隐藏而不是重新 setBounds；可见性、shownRegion 和 desiredRegion 均已清理。

新增测试在 [frame-display.test.ts](../packages/helper/tests/frame-display.test.ts)：

- 三个几何故障点分别隐藏、清理、报错；
- reflow 几何故障同样处理；
- 原有迟到显示、迟到失败、hide、reflow、正常显示测试继续通过。

### 验证级别

以上三个故障是逻辑层故障注入，不是真实显示器变化。没有为了验证而破坏显示器配置；真实 Windows 界面只验证正常显示和点击穿透。

## 2. 真实点击穿透验证

### 专用测试目标

没有复用用户浏览器或任何个人窗口。创建独立 WinForms fixture：

- 标题：`ORB-0217-TARGET`
- 进程：PID 30956（测试结束后已停止）
- 顶层窗口句柄：`2820294`
- 目标按钮：`COUNT ME`，点击只增加计数并写本地 JSON，无表单、链接、网络
- 窗口物理 bounds：`(700,250)-(1486,881)`
- 按钮物理 bounds：`(833,428)-(1263,578)`
- 测试点：`(845,440)`，在按钮内，也在彩带可见边缘覆盖范围内
- 显示缩放：200%，fixture 报告 DPI 192；物理屏幕 3840×2160

fixture 进程和窗口句柄来自本轮创建的进程及 `GetWindowRect`/WinForms 状态文件，不依赖标题或“当前前台”推断。

### 彩带几何

为让点击点落在彩带可见带下，显示目标区取按钮内缩 24 物理像素：

- 区域物理：`(857,452)-(1239,554)`，`382×102`
- 区域 DIP：`(429,226)-(620,277)`，`191×51`
- helper 原生窗口：`(786,380)-(1314,626)`，`528×246`
- helper PID：11244
- helper HWND：`1903510`
- `WS_EX_TRANSPARENT`：true（`exStyle 136839208`）
- z-order：helper=1，target=2（helper 在目标之上）
- 测试点 `(845,440)` 在 helper rect 内，且在目标区外（位于可见带）

helper 使用 0.2.17 安装包、默认 Electron 运行时、独立临时 userData；**没有设置** `DSH_ORB_FRAME_CAPTUREABLE`，即生产 content protection 模式。

### 验证顺序和结果

1. **helper 隐藏**：同一物理点 `(845,440)`，`WindowFromPoint` 返回 fixture 按钮，foreground=target/30956；`SendInput` 后计数 **0 → 1**。
2. **显示 helper**：show 被 ack；helper 窗口可见、bounds 覆盖测试点、`WS_EX_TRANSPARENT=true`、z-order 高于 target；foreground 仍是 target/30956。
3. **helper 显示时**：同一个点 `(845,440)` 通过 `WindowFromPoint + SetCursorPos + SendInput` 注入；fixture 计数 **1 → 2**；点击后 foreground 仍是 target/30956；helper 没有获得焦点。
4. helper 随后被结束；没有留下测试 helper。

测试结果：[clickthrough-result-0217.json](../.zcode/evidence/clickthrough-result-0217.json)
fixture 最终计数截图：[clickthrough-0217-target.png](../.zcode/evidence/clickthrough-0217-target.png)

### 测试专用 z-order 调整

fixture 为了隔离个人窗口设为 topmost；Windows 因此把 topmost fixture 放在 helper 之上。第一次 guard 正确返回 `helper-not-above-target`，没有发送点击。

随后测试脚本只对 helper 调用一次：

```text
SetWindowPos(helper, HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)
```

这是测试脚本的 z-order 调整，不修改生产 helper 代码；生产 helper 本身已 `alwaysOnTop` 且通常高于非 topmost 目标窗口。调整后 guard 重新检查 foreground、point ownership、helper PID/rect/transparency 和 z-order，全部通过才注入点击。

### 前台归属不匹配拦截

创建第二个专用 fixture：

- 标题：`ORB-0217-DUMMY`
- PID：33808
- HWND：6686708
- 计数：0

将 dummy 设为前台，然后对 target 调用 guard。guard 在发送任何输入前返回：

```json
{
  "sent": false,
  "reason": "foreground-mismatch",
  "foregroundHwnd": 6686708,
  "foregroundPid": 33808,
  "targetHwnd": 2820294,
  "targetPid": 30956
}
```

退出码 20；target 计数仍为 2，dummy 计数仍为 0。完整记录：[mismatch-result-0217.json](../.zcode/evidence/mismatch-result-0217.json)

### 输入路径

- 使用真实 Windows `SendInput`（C# `INPUT` 数组，鼠标左键 down/up）；
- 点击前 `WindowFromPoint` 校验落点窗口；
- 点击前 `SetCursorPos` 并读取 cursor 校验；
- 点击前和移动后均重新读取 `GetForegroundWindow` + PID；
- 没有使用 DOM.click、CDP 页面事件、向窗口直接发消息或全局 Hook；
- 没有发送文字或快捷键。

### 与截图的关系

本轮没有用“截图看不到彩带”来证明隐藏，因为生产 content protection 本来就会让普通截图看不到彩带。判断依据是：

- helper show ack；
- helper 原生窗口可见、bounds、`WS_EX_TRANSPARENT`；
- z-order；
- foreground PID/HWND；
- fixture 点击计数。

## 3. 原有竞态修正回归

0.2.16 的延迟显示/隐藏和启动生命周期修正继续保留：

- `frame-display` 全部旧测试通过；
- `overlay-runtime` 启动生命周期测试通过；
- abort 递归测试保留；
- 多行/Tab/submit:false/submit:true 回归通过；
- 后台任务、项目规则、证据工具未修改。

## 4. 自动化、构建、打包

| 阶段 | 退出码 | 结果 | 证据 |
|---|---:|---|---|
| `pnpm run typecheck` | 0 | 通过 | `.zcode/evidence/commands-0217/20261021-161842-geometry-0217-typecheck-typecheck/` |
| `pnpm test` | 0 | node:test 105/105；vitest 337/337；合计 442/442；0 fail；0 skip | `.zcode/evidence/commands-0217/20261021-161852-geometry-0217-test-test/` |
| `pnpm build` | 0 | 通过 | `.zcode/evidence/commands-0217/20261021-161934-geometry-0217-build-build/` |
| `pnpm --filter dsh-orb run pack` | 0 | 生成最终包 | 命令输出 |

新增 4 个 helper 测试（三个几何点 + reflow 故障），node:test 从 101 增至 105；vitest 仍 337。

最终代码哈希：

- `dist/helper/lib/main.js`：`4FCD4945FAD0E2399DDDAEB42B00F5FD3B0AAA3FF265D3C4BA4EBE47E73E72C4`
- `dist/host/index.js`：`1D343E554A702A1E2480C69BA86321B3B81BB771A451F84B8F1669BE84665845`
- `client.js`：`B7AA34AC54858032DD322040EB6B3FDD5A82EE416A25B842DA479AC9D228B69C`
- 彩带 CSS：`BE898486F0AF2576996FBA8FBF0E54526CAE1561EDE91FB376A11E7B1984A9FE`

## 5. 隔离安装

- Home：`C:\Users\zhq\.dsh-orb-verify\0.2.16-home`
- Profile：`orb-verify-0.2.17-20261021`
- 安装版本：0.2.17
- 默认 Electron 运行时：`...\dsh-orb\electron-runtime\electron.exe`（缓存复用，未设置 `DSH_ORB_ELECTRON_PATH`）
- 最终 Host 日志：[host-0217-final.log](../.zcode/evidence/host-0217-final.log)
- 最终 helper：PID 9848，测试 Host 启动，连接后已结束
- `package.json`、`dist/host/index.js`、`dist/helper/lib/main.js`、`client.js`、`README.md` 与最终 tarball 解包内容 SHA-256 全部一致

## 6. 日常 Profile 与清理

- 日常 desktop Profile 仍为 0.2.5，主进程 34484；未安装、卸载、禁用、启用或重启。
- 未修改 Harness 主程序、rightpad/Receiver、Android/Motion/M-C/B-X/HID/驱动/Broker、Comfort/虚拟键盘。
- 测试 Host、helper、fixture、dummy 均已结束；测试 home/Profile/脚本/证据保留。
- 未执行 commit、push 或 Git 写操作。

## 7. 快照与限制

修改前快照：

`C:\dsh-orb-cordis\.zcode\snapshots\pre-0.2.17-geometry-20261021-1610`

限制：

- 三个几何故障只做可控逻辑注入；没有在真实显示器变化中制造故障。
- 点击穿透 fixture 为测试而 topmost；helper 的最终 z-order 由测试脚本显式提升。生产 helper 本身是 always-on-top，但本轮没有在普通非 topmost 用户窗口上重复该测试。
- 点击穿透证据是实际 Windows 输入，不是模型 Computer Use 工具链的点击；两者共用 Windows 输入后端，但本轮没有重新跑模型 GUI 任务。
- 用户本人用 Comfort 键盘/rightpad 的单指完整体验仍需本人验收。
- 在严格 guard 完成前有两次早期点击尝试，target 计数未增加；当时尚未用 WindowFromPoint/归属检查，无法完全证明落点。它们没有计入证据；之后改用 foreground/PID/WindowFromPoint/helper z-order 全部匹配才发送输入。
- 0.2.16 的个人浏览器边界事件仍保留在 [docs/14](14-reliability-0216.md)；本轮没有主动访问个人浏览器或调查其内容。
