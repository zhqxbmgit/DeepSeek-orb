# 0.2.16 可靠性修正：彩带迟到显示与启动生命周期

日期：2026-10-21

基线：0.2.15（3,397,041 bytes，SHA-256 `AB32D896...`）。本轮只做可靠性修正，保留主窗口 Computer Use、彩带、后台任务和停止能力。

最终交付版本以本次打包结果为准；旧包保留。

## 1. 修正一：迟到的显示结果不能推翻隐藏

### 根因

0.2.15 的 helper `showFrame()` 在 `executeJavaScript()` 之后才写 `shownRegion` 并 `showInactive()`，但没有判断等待期间是否已经收到隐藏或新的显示请求。因此：

1. show 进入异步渲染；
2. hide 同步隐藏并返回 ack；
3. 旧 show 的 await 完成，继续 `showInactive()`；
4. 彩带重新出现。

旧 show 的失败回调也会无条件 `hideFrame()`，可能隐藏更新后的有效彩带。

### 修改

新增 `packages/helper/src/frame-display.ts`，由它唯一管理：

- 当前目标 `desiredRegion`；
- 最近实际显示的 `shownRegion`；
- 每次显示/移动/隐藏的递增 epoch；
- 显示、移动、隐藏、显示器 reflow 和失败回调。

规则：

- 每次 show 都取得新的 epoch；异步 render 完成后必须仍是当前 epoch 且仍有目标，才可写状态、`showInactive()`；
- hide 先递增 epoch、清空目标，再隐藏窗口；
- 新 show/reflow 使旧 show 失效；
- 旧 show 的失败不隐藏、不报告更新后的有效彩带；
- 当前 show 失败才隐藏并报告；
- reflow 只重放当前最新目标，不会复活已经隐藏的目标；
- 窗口销毁/不可用/未 ready 时不启动显示。

`main.ts` 不再直接维护 `shownRegion` 或直接写 render，只把消息交给该状态机；Host 的 `overlay-error` 仍由状态机当前失败回调产生。

彩带窗口的不可聚焦、点击穿透、content protection 和外观代码未改。

### 行为测试

`packages/helper/tests/frame-display.test.ts` 直接测试生产状态机，使用可控制的 Promise 屏障，不复制实现：

- show 未完成时 hide，旧 show 后成功，最终仍隐藏；
- 旧 show 未完成时新 show，最终属于新请求；
- 旧请求迟到失败，不隐藏新帧、不产生错误回调；
- 当前失败才隐藏并报告；
- turn-end/hide 后 reflow 不重新显示；
- reflow 使旧 show 失效；
- 正常 show、move、hide。

7/7 通过。

## 2. 修正二：启动中关闭再开启

### 根因

0.2.15 的 `OverlayRuntime.start()` 在 `starting` Promise 存在时直接返回旧 Promise；`stop()` 让旧 generation 失效，但没有清掉/替换这个 Promise。随后 `start()` 仍返回旧启动，旧启动在 generation 检查处退出，于是：

- `enabled=true`；
- 状态 `stopped`；
- helper 从未启动；
- 旧 finally 还可能清除新启动的记录。

### 修改

`OverlayRuntime` 现在按 generation 管理启动：

- `starting` 记录 `{generation, promise}`；
- 同 generation 的重入加入现有启动；
- stop 清除启动记录并递增 generation；
- 新 start 创建新 generation 和自己的 Promise；
- 旧 Promise 的 `finally` 只比较自己的 entry，不清理新 entry；
- 下载、监听、目录准备、spawn 每个异步边界都重新检查 generation/stopping；
- 旧监听在失效后自行关闭，避免遗留 socket；
- 旧 helper 的 exit/error 回调用 generation 和 child 身份双重检查；
- 启动失败、错误状态、stop 都会释放启动记录；
- helper 已 spawn 但尚未连接时，重复 start 加入同一启动，不重复 spawn；
- 失败仍可见，设置页仍提供左键重启；不会无限自动重拉。

为便于测试，`OverlayRuntime` 构造函数新增可选依赖注入（resolve binary、listen、spawn、mkdir、helper main、home path）；生产默认值仍是原有实现。

### 行为测试

`packages/host/tests/overlay-runtime.test.ts` 使用真实 `OverlayRuntime` 和可控 fake 依赖：

- 下载未完成时关闭再开启，第二次正常解析并 spawn 新 helper；
- 启动未完成时显式 restart，只有当前启动的 helper；
- 关闭后不重开，旧下载完成也不 spawn；
- 旧失败晚于新启动，不干扰新状态；
- 已 spawn 未连接时连续 start 不重复 spawn；
- 旧监听在失效后关闭；
- 连续关闭/开启/restart 只保留最新启动。

原有 abort 递归回归测试保留。

## 3. 默认运行时路径真实验证

前一轮测试 home 位于工作区 `.zcode`，下载的 Electron 从该路径启动返回 `0x80000003`，因此当时使用了 `DSH_ORB_ELECTRON_PATH`，不能算默认路径通过。

本轮使用工作区外的独立 home：

- home：`C:\Users\zhq\.dsh-orb-verify\0.2.16-home`
- Profile：`orb-verify-0.2.16-20261021`
- Host 启动时明确删除 `DSH_ORB_ELECTRON_PATH`，没有系统/用户环境变量修改。

真实结果：

- Host 日志：`downloading Electron 44.0.0` → `extracting` → `Electron 44.0.0 is ready`；
- 默认运行时：`C:\Users\zhq\.dsh-orb-verify\0.2.16-home\dsh-orb\electron-runtime\electron.exe`，44.0.0，SHA-256 `1DC2D12E...`；
- helper：`...\profiles\orb-verify-0.2.16-20261021\node_modules\dsh-orb\dist\helper\lib\main.js`；
- userData：`...\dsh-orb\frame-helper\088491092f6918f3`；
- helper 连接成功，设置页显示“彩带绘制组件已连接”。

关闭再开启：

- 关闭后 helper 进程消失，设置显示“彩带已关闭”；
- 再开启后新 helper PID 启动并连接。

左键恢复：

- 结束测试 helper PID 后，设置页显示“彩带绘制组件没有启动”和“重新启动彩带组件”；
- 左键按钮得到新 helper PID，状态恢复“已连接”。

因此本机隔离环境的**默认下载、缓存、启动路径**已真实通过；这不代表所有干净机器均已验证。

## 4. 彩带真实 Electron 行为验证

使用 0.2.16 安装包 helper、默认运行时和独立 userData，通过 fake host socket 发送：

1. 同一 socket 数据块中的 show + hide：最终截图无彩带；ack 顺序为 hide 先于 show。这复现了迟到的 show 场景，最终保持隐藏。
2. 正常 show：彩带出现。
3. 正常 move：彩带移动到新的目标矩形。
4. 正常 hide：彩带消失。

证据：

- `ribbon-0216-race-hidden.png`
- `ribbon-0216-shown.png`
- `ribbon-0216-moved.png`
- `ribbon-0216-hidden.png`

这是真实 Electron 进程的渲染和 socket 行为；逻辑层竞态测试另有 7 个可控屏障用例。race/show/move/hide 截图使用测试专用 `DSH_ORB_FRAME_CAPTUREABLE=1` 才能看到彩带，不代表生产截图会包含它。

生产模式另做了一次内容保护核对：不设置 `DSH_ORB_FRAME_CAPTUREABLE`，发送正常 show 后截取桌面，截图无彩带，见 `ribbon-0216-protected.png`。该次前台最终切到了个人浏览器，未形成点击穿透证据，详见第 9 节。

## 5. 最终 0.2.16 主窗口验证

独立 home/Profile 中安装最终 0.2.16 包，默认运行时路径，Computer Use 模式，模型 `DeepSeek-V4.1-Flash`。

真实模型会话 `session-0b5e51db-ea78-48f4-9034-c912bdab0d5d` 实际调用：

- screenshot；
- click；
- input_text replace:true submit:false，文本 `第一行\nsecond\t第三行`；
- click；
- input_text replace:true submit:true，文本 `SUBMIT 0.2.16`；
- scroll。

独立读取页面确认：

- 第一次未提交，`submitCount:0`，`editor="第一行\nsecond\t第三行"`，`next=""`，焦点保持 `editor`；
- 第二次提交，页面标题 `SUBMITTED Orb Chat Lab`，`submitCount:1`；
- 没有点击 Send。

证据：`gui-0216-default-session.jsonl`、`gui-0216-default.png`、`chat-page-0216.png`、`chat-ui-final-0216.png`。

设置页版本 0.2.16、默认运行路径状态：`settings-0216-default-runtime.png`；helper 错误状态：`settings-0216-error.png`。

## 6. 自动化、构建与包体

最终命令均通过 `packages/bundle/runtime/run-with-evidence.cmd` 的 native 模式记录：

| 阶段 | 退出码 | 结果 | 证据 |
|---|---:|---|---|
| `pnpm run typecheck` | 0 | 通过 | `.zcode/evidence/commands-0216/20261021-155519-reliability-0216-typecheck-typecheck/` |
| `pnpm test` | 0 | node:test 101/101；vitest 337/337；合计 438/438；0 fail；0 skip | `.zcode/evidence/commands-0216/20261021-155529-reliability-0216-test-test/` |
| `pnpm build` | 0 | 通过 | `.zcode/evidence/commands-0216/20261021-155610-reliability-0216-build-build/` |
| `pnpm --filter dsh-orb run pack` | 0 | 生成最终包 | 命令输出 |

最终 tarball：

- `C:\dsh-orb-cordis\dsh-orb-0.2.16.tgz`
- 3,397,896 bytes
- SHA-256 `7C9F3068B268A7F2A78E13A0299E62EB1069D8D3E3421080578EFA24873B3353`
- 1030 个 tar 条目；无悬浮球/旧聊天/头像/选择工具栏/旧更新逻辑。

最终隔离 Profile 重新安装该 tarball 后，`package.json`、`README.md`、`dist/host/index.js`、`dist/helper/lib/main.js`、`observation-frame.css`、`client.js` 与 tarball 解包内容 SHA-256 全部一致。最终 Host 启动日志见 `.zcode/evidence/host-0216-final.log`，helper PID 33484 由测试 Host 启动并连接；随后已结束。

## 7. 日常 Profile 与保护边界

- 日常 desktop Profile 保持 0.2.5，未安装、卸载、禁用、启用或重启；主进程仍为本轮开工时的桌面 Harness 进程。
- 未修改 Harness 主程序、rightpad/Receiver、Android/Motion/M-C/B-X/HID/驱动/Broker、Comfort/虚拟键盘。
- 未执行 commit、push 或 Git 历史写操作。
- 旧包、旧文档、旧证据均保留。

## 8. 修改前快照

`C:\dsh-orb-cordis\.zcode\snapshots\pre-0.2.16-reliability-20261021-153925`

包含本轮将修改的 20 个源码/测试/配置/文档文件、`manifest.sha256.tsv`、`working-tree-before.patch` 和 `git-status.txt`。

## 9. 未验证/限制

- 用户本人用 Comfort On-Screen Keyboard 和 rightpad 的单指完整体验仍需本人验收。
- 多显示器、混合缩放、macOS 彩带未真实操作。
- 启动竞态与显示竞态的可控行为测试是逻辑层验证；真实 Electron 只复现了“同一数据块 show+hide”和正常 show/move/hide，未在真实 GUI 中人为制造下载中开关的时间窗。
- 本机默认运行时路径通过，不等于所有干净机器已通过。
- 之前 Notepad 首字符丢失的观察没有在本轮扩大为后端重写；本轮主窗口文本回归使用确定性测试页。
- 直接点击穿透验证没有形成可靠证据：一次尝试中前台被用户已打开的个人浏览器窗口抢走，操作立即停止。那次尝试可能向该个人窗口发送了一次点击和键盘字符 `OUTSIDE`；无法确认点击落在页面何处，未有意点击视频/链接，也未修改文件。之后没有继续对任何个人窗口做 GUI 操作。0.2.16 主窗口的 click/input 在 helper 连接时通过，但没有单独锁定“彩带显示瞬间”的点击穿透证据；0.2.15 的点击穿透证据仍作为历史证据，不能替代本轮。
- 日常 Harness 主窗口没有被操作；测试浏览器、测试 helper 和测试 Host 已结束。
- 仓库 `README.zh-CN.md` 在本轮开工前已经是错误编码的 mojibake 文本；本轮只按字节更新了其中的 ASCII 版本行，没有扩大为重写整篇中文文档。最终 tarball 不包含该文件。
