# 0.2.15 主窗口 Computer Use 定制版：移除悬浮球、彩带与语义收口

日期：2026-10-21

交付包：

- `C:\dsh-orb-cordis\dsh-orb-0.2.15.tgz`
- 3,397,041 bytes
- SHA-256 `AB32D8966C28F290F700C53BB39A815A4470275E34687463B09F285926318EBE`

中间包 0.2.13（3,396,920 bytes）、0.2.14 都保留，不覆盖。最终真实验证使用 0.2.15。

## 1. 产品范围

正式入口只有官方 DeepSeek Harness 主窗口的 Computer Use 模式。生产包中不再有：

- 悬浮球窗口、聊天面板、头像、徽标、拖动/尺寸/停靠/菜单/history/workspace；
- 球专属会话创建、提示词、问答、preload、IPC、状态与生命周期；
- avatar、selection toolbar、native-selection、chat/theme/vendor 资源；
- 原版更新器、退出后安装、自动重拉和下载提示。

仍然保留：

- 主窗口 Computer Use 的 13 个 GUI 工具、`code_agent`/status/stop、`project_context`、停止与接管；
- 主窗口设置：后台 Agent 模型、千分比坐标、观察框彩带；
- 最小观察框绘制组件（Electron）、截图/点击/输入/窗口切换后端、证据运行器；
- 模型、坐标、设置和 koffi 隔离服务。

Tarball 内不再有 `floating`、`avatar`、`selection-toolbar`、`native-selection`、`preload.cjs`、`chat.css`、`theme.css`、`vendor/katex` 等条目。包从 0.2.12 的 24,473,456 bytes 降到 3,397,041 bytes；这是删除资源/依赖后的实际包体变化，不据此宣称运行速度提升。

## 2. 彩带现在如何独立工作

`packages/helper` 被收缩为一个只负责观察框的 Electron 进程：

- `src/main.ts`：创建透明、不可聚焦、点击穿透、content-protected 的窗口；加载 `observation-frame.html`；显示、移动、隐藏彩带；确认 `overlay-capture` / `overlay-input`；
- `src/overlay-geometry.ts`：观察矩形、描边、辉光、工作区裁切和 CSS 变量；
- `src/chrome-windows.ts`：把窗口 HWND 报给 Host 做截图排除；
- 无 preload、无 IPC 页面、无会话、无菜单、无头像。

Host 侧 `OverlayRuntime`：

- 用 loopback NDJSON + 每次启动随机 token 连接；helper 不接触带官方凭据的 HTTP URL；
- 提供 `computerUseOverlayGuard`，Computer Use 的 capture/input 区间通过它确认；
- 只启动一次；helper 退出后不循环重拉，设置页显示错误和“重新启动彩带组件”；
- 关闭彩带会停止 helper；重新打开会启动新 helper。

Windows 上窗口使用 `WDA_EXCLUDEFROMCAPTURE`，因此用户能看到彩带，但模型截图看不到；点击和键盘焦点不受影响。`DSH_ORB_FRAME_CAPTUREABLE=1` 只是开发取证开关，生产默认始终启用内容保护。

真实证据：

- 源码 helper 显示/移动/隐藏：[ribbon-0214-t1-shown.png](../.zcode/evidence/ribbon-0214-t1-shown.png)、[t2-moved](../.zcode/evidence/ribbon-0214-t2-moved.png)、[t3-hidden](../.zcode/evidence/ribbon-0214-t3-hidden.png)；
- 同样显示状态下 GDI 桌面截图看不到彩带（内容保护）：[t4-protected](../.zcode/evidence/ribbon-0214-t4-protected.png)；
- 点击穿透测试：彩带覆盖区域内点击后焦点仍是 Chrome 的 `editor`，输入 `CLICK-THROUGH` 成功，前台窗口仍是 `Orb Input Semantics Lab`：[ribbon-0214-clickthrough.png](../.zcode/evidence/ribbon-0214-clickthrough.png)；
- 安装包 0.2.15 的 helper 实际绘制/隐藏：[installed shown](../.zcode/evidence/ribbon-0215-installed-shown.png)、[installed hidden](../.zcode/evidence/ribbon-0215-installed-hidden.png)；
- 0.2.14 实际模型会话中 helper 窗口存在区间：`.zcode/evidence/helper-samples-0214.csv`（176 个样本，79 个可见样本；turn 结束后恢复不可见）；
- 设置页运行中：[settings-0215.png](../.zcode/evidence/settings-0215.png)；
- 杀死测试 helper 后的错误与左键重启界面：[settings-0214-ribbon-error.png](../.zcode/evidence/settings-0214-ribbon-error.png)。

测试 helper 异常时，设置页显示“彩带绘制组件没有启动”和“重新启动彩带组件”；点击后 helper 换新 PID 并恢复“已连接”。关闭/打开开关也分别停止/启动了 helper。

限制：只实测了单显示器 1920×1080、200% 缩放。多显示器、不同缩放和 macOS 上的实际绘制/排除未真实操作。

## 3. 子目录规则路径修复

问题：loader 的 `changes[].path` 是相对项目根的显示路径，0.2.12 的 `loadedEntryFor()` 却按事件 cwd 展开。当会话 cwd 是 `项目\src`、baseline 的 `projectRoot` 是 `..` 时，根 `AGENTS.md` 被报告未加载，`src/AGENTS.md` 被错配根摘要并 STALE，还伪造了 `src/src/AGENTS.md`。

修复：

- `LoadedInstruction` 同时保留产生事件时的 `cwd` 和 `projectRoot`；
- `projectRoot` 由该事件的 baseline identity 在当时的 cwd 上解析；cwd 切换后没有新 identity 时，只有在 `.git` 标记能证明新根时才使用标记，否则保持未确认；
- `instructions[].absolutePath` 用项目根 + 相对 path 展开，不再用 cwd；
- 报告新增 `latest_loader_project_root`；
- `latest_loader_cwd` 只表示产生事件的目录，不再被当成路径展开基；
- 保留 raw `sha1`、`loader_sha1`、`digest` 的不同含义，以及逐条 `replace`/`remove` 的历史归属。

自动化测试：

- 新增“子目录根/嵌套规则”测试：两个真实文件 loaded、摘要对应、无 stale、无 `src/src/AGENTS.md`；
- 保留 BOM、内容变更、A/B 切换、相同文本、缺少 change、replace/remove 等回归；
- `project-context.spec.ts` 24/24 通过。

真实会话（0.2.14 安装包，嵌套 fixture）：

- 会话 `session-df585997-b873-415e-bca0-3aac3ff08e1d`；
- cwd：`.zcode\verify-0.2.12-home\nested-project\src`；
- baseline identity `projectRoot: ".."`，两条 change；
- `project_context` 报告：
  - `instruction_state: loaded`、`project_scope_confirmed: true`；
  - `baseline_project_root` / `latest_loader_project_root` 都是 `nested-project`；
  - `AGENTS.md` 与 `src/AGENTS.md` 均 loaded、stale false，digest 分别为 `4c242...`、`90bba...`；
  - 没有 `src/src/AGENTS.md`；
- 规则正文真实注入，模型最终答案自动追加 `[ROOT-0214] [SRC-0214]`。
- 原始会话：[rule-0214-session.jsonl](../.zcode/evidence/rule-0214-session.jsonl)。

## 4. 文本输入语义

契约：

- `input_text` 只插入文本；只有 `submit: true` 按普通 Enter。
- 正文换行在 Windows 上使用 Shift+Enter 换行和弦，而不是裸 Enter，避免聊天框误提交。
- Tab 作为字面 U+0009 发送，不是 VK_TAB；不会把后续文本送进另一个控件。
- 其它 C0 控制字符在点击前拒绝，避免半段输入或误退格/ESC。
- `replace` 仍是先 Ctrl+A 再输入；点击聚焦后增加 80 ms settle，再输入首字符，降低新激活编辑器吞掉开头字符的概率。

真实模型会话：

- 0.2.14 会话 `session-d1a4322e-84d9-41f7-b32a-76d5e14e1d46`：
  - `input_text` 参数文本为 `第一行\nsecond\t第三行`，`replace:true`、`submit:false`；
  - Chrome 编辑框最终值精确为 `第一行\nsecond\t第三行`；
  - `active=editor`、`next=""`、`submitted=false`；
  - 事件日志可见 Shift+Enter 与字面 Tab，没有 VK_TAB 移焦。
- 同一会话的 Notepad 第一次输入观察为 `DONE 2.14`，开头 `0.` 丢失；模型发现后用 replace 重试，最终剪贴板/状态栏核对为 `DONE 0.2.14`，且未保存文件。这条异常保留，不声称已经稳定修复。
- 0.2.15 增加 settle 后，短会话 `session-ae7d8cf4-013d-4276-8717-e5448625d16c` 单次 `input_text` 得到精确 `VERIFY 0.2.15`，只调用一次 click + 一次 input_text，`submitted=false`。
- 0.2.15 最终聊天框会话 `session-f29f37c4-7044-45f9-b9e4-45afcf7e42bb`：
  - `submit:false` 输入 `第一行\nsecond\t第三行`；页面标题保持 `Orb Chat Submit Lab`，`submitted:false`、`submitCount:0`，`next` 为空；
  - 随后 `submit:true` 输入 `SUBMIT 0.2.15`；页面标题变为 `SUBMITTED Orb Chat Lab`，出现 `SUBMITTED` 标签，事件日志末行 `enter-submit`、`submitCount:1`；
  - 页面独立读取确认 `editor="SUBMIT 0.2.15"`、`status="SUBMITTED"`、`next=""`、`focused="editor"`。
- 证据：[gui-0214-session.jsonl](../.zcode/evidence/gui-0214-session.jsonl)、[gui-0214-tools.jsonl](../.zcode/evidence/gui-0214-tools.jsonl)、[gui-0215-typesession.jsonl](../.zcode/evidence/gui-0215-typesession.jsonl)、[gui-0215-chat-session.jsonl](../.zcode/evidence/gui-0215-chat-session.jsonl)、[gui-0214-lab-final.png](../.zcode/evidence/gui-0214-lab-final.png)、[chat-page-0215.png](../.zcode/evidence/chat-page-0215.png)。

## 5. 实际 Computer Use 验收

环境：

- 独立 home：`C:\dsh-orb-cordis\.zcode\verify-0.2.12-home`
- 独立 Profile：`orb-verify-0.2.13-20261021`（名字沿用，安装 0.2.15）
- Host：`dsh --profile ... --no-open --port 61816`
- UI：专用 Edge（profile `edge-profile`，CDP 9334）
- 目标窗口：专用 Chrome `Orb Input Semantics Lab`（CDP 9333）
- 模型：`DeepSeek-V4.1-Flash` / reasoning High / Computer Use 模式

0.2.14 主任务实际工具链：

- `screenshot`（保存 `C:\Users\zhq\Desktop\Screenshot 2026-10-21 at 14.09.57.png`）
- `input_text`（中文 + 换行 + 英文 + Tab）
- `open_app Notepad`
- `hotkey ctrl+n`
- `input_text`（`DONE 0.2.14`，第一次异常后 replace 重试）
- `hotkey ctrl+a`、`hotkey ctrl+c`
- `pwsh`（核对剪贴板码点）
- `open_app chrome`

最终 Chrome 文本、Notepad 文本、提交状态均已从真实页面/剪贴板核对；UI 最终截图：[gui-0214-final-ui.png](../.zcode/evidence/gui-0214-final-ui.png)。

0.2.15 最终综合任务（`session-f29f37c4-7044-45f9-b9e4-45afcf7e42bb`）实际完成了：

- `screenshot`；
- `click` + `input_text submit:false`（中文 + 真实换行 + Tab），页面未提交；
- `click` + `input_text submit:true`，页面实际提交；
- `open_app calc` 成功切到 Calculator；`open_app chrome` 切回 Chrome；
- `scroll` 读取页面事件日志。
- `open_app Calculator` 和 UWP bundle id 名称失败，模型改用 `calc` 后成功；这是 `open_app` 名称匹配差异，记录在会话中。
- UI：[chat-ui-final-0215.png](../.zcode/evidence/chat-ui-final-0215.png)；页面：[chat-page-0215.png](../.zcode/evidence/chat-page-0215.png)。

## 6. 停止与后台回归

本轮修复了 `OverlayRuntime` 的一个 abort 递归缺陷：`clearWaiter()` 直接调用 abort 监听器本身，导致栈溢出并杀死测试 Host。现在只移除 AbortSignal 监听器；新增单测“rejected aborted wait without recursive abort”通过。

真实 0.2.15 停止：

- 模型调用 `long_wait 120`，在运行中点击“停止生成”；
- UI 显示“已停止”，Host 继续运行、没有崩溃；
- 会话 `session-ae7d8cf4...`：
  - `long_wait` 结果 `Error: computer-use: wait aborted`；
  - `turn/end` seq 62 `{kind:"aborted", reason:{kind:"user"}}`。
- 证据：[stop-0215-session.jsonl](../.zcode/evidence/stop-0215-session.jsonl)、[stop-0215-longwait.png](../.zcode/evidence/stop-0215-longwait.png)。

真实后台：

- 模型调用 `code_agent`，cwd 为 `C:\Users\zhq\Documents\deepseek-harness\default-workspace`，task 为 `Start-Sleep 60` 后写 `bg-0215.txt`；
- 3 秒后 `code_agent_status` 返回 `running`；
- `code_agent_stop` 返回 `Stopped background Code agent session ... The session is idle.`；
- 后台会话 `session-84715ef3-5f14-4eb9-9abc-d4e7a27de8af`：
  - 工具结果 `tool call aborted` / `AbortError` / `ABORTED`；
  - `turn/end` seq 26 `{kind:"aborted", reason:{kind:"user"}}`；
- `C:\Users\zhq\Documents\deepseek-harness\default-workspace\bg-0215.txt` 不存在。
- 证据：[codeagent-stop-0215-session.jsonl](../.zcode/evidence/codeagent-stop-0215-session.jsonl)、[codeagent-0215.png](../.zcode/evidence/codeagent-0215.png)。

排队消息的语义仍按 0.2.12 的 25 秒实测和本轮文档描述：保留不等于自动执行，有限时间未执行不等于永久取消；旧队列恢复条件未确认。本轮没有新增全局暂停系统。

## 7. 自动化测试、typecheck 与 build

最终命令（证据运行器原生模式）：

| 阶段 | 退出码 | 证据 |
|---|---|---|
| `pnpm run typecheck` | 0 | `.zcode\evidence\commands-0215\20261021-141943-mainwindow-0215-typecheck\` |
| `pnpm test` | 0 | `.zcode\evidence\commands-0215\20261021-141948-mainwindow-0215-test\` |
| `pnpm build` | 0 | `.zcode\evidence\commands-0215\20261021-142022-mainwindow-0215-build\` |

测试计数：

- node:test（host/helper/client-settings/bundle）：87 / 87 pass；
- vitest（computer-use，29 个文件）：337 / 337 pass；
- 合计 424 / 424 pass，0 fail。

最终 `pnpm build` 后重新比对 tarball 的 `dist/host/index.js`、`dist/computer-use/index.js`、`client.js`、`dist/helper/lib/main.js`、`observation-frame.css` 与 `packages/bundle` 构建产物，五者 SHA-256 全部一致。

## 8. 包与日常 Profile

- 测试 Profile 安装版本：0.2.15；安装后的 `package.json` SHA-256 `005123...`。
- 日常 desktop Profile：仍为 0.2.5，`package.json` SHA-256 `8BAA20...`，主进程 PID 34484 仍在运行；本轮未安装、卸载、禁用或重启日常 Profile/Harness。
- 安装包内容检查：1030 个 tar 条目；无 `floating`/`avatar`/`selection-toolbar`/`native-selection`/`preload.cjs`；helper 只有 `lib/main.js` 与两个 observation-frame 资源。
- 关键文件哈希（0.2.15 tarball = 最终构建）：
  - host `9651C08A...`
  - computer-use index `4B721B64...`
  - client.js `B7AA34AC...`
  - helper main `488C8B50...`
  - observation-frame.css `BE898486...`

## 9. 删除前源码快照与恢复

- 位置：`C:\dsh-orb-cordis\.zcode\snapshots\pre-removal-20261021-134139`
- 文件树：`tree\`（245 个当时的工作区文本源码/配置/测试/文档/未跟踪文件，不含 `.git`、`node_modules`、`.zcode`、`.tgz`）
- 清单：`manifest.sha256.tsv`
- 未提交差异：`git-diff.patch`（423,624 bytes）
- Git 状态：`git-status.txt`
- 恢复方法：用 `tree\` 中对应路径覆盖当前文件；或在一个干净 checkout 上应用 `git-diff.patch`。恢复前保留当前 0.2.15 工作树和包。该快照是删除前状态，不是新版本备份；不要把它整体复制进 `.zcode` 递归。

## 10. 未验证与限制

- 用户本人单指操作、Comfort On-Screen Keyboard Pro 的完整中文输入和恢复流程：未由用户验收；自动注入不能替代。
- 多显示器、混合 DPI、跨屏拖动、macOS 实际彩带：未真实操作。
- 彩带首次运行时序：测试 home 自己下载的 Electron 运行时从 `.zcode` 路径启动时返回 0x80000003；最终真实验证通过 `DSH_ORB_ELECTRON_PATH` 使用已有的、同 SHA-256 的运行时，userData 仍独立。真实用户 `%USERPROFILE%\.dsh` 下的首次下载/启动路径需要在干净机器上再次验证。
- 测试 Profile 的 nested-src 工作区中 `pwsh` 沙箱初始化报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`；因此停止测试改用 `long_wait`，后台测试使用默认工作区。这是测试夹具/沙箱环境问题，未据此推断生产命令失败。
- Notepad 第一次输入 `DONE 0.2.14` 时观察到开头 `0.` 丢失，模型替换后成功；已增加 80 ms focus settle，但该特定异常没有在完全相同条件下再次复现。保留为已知不稳定观察。
- 真实 GUI 使用专用测试浏览器窗口；未在用户的微信、哔哩哔哩、ChatGPT 等日常窗口中操作。
- 取安装包彩带截图时，曾把用户已打开的 Notepad++ 窗口误当作测试 Notepad 移动了一次位置；未修改其文件。随后改用专用 Chrome 测试页重新取证，交付截图不含用户资料。
- `rightpad`、Receiver、Android、Motion、M/C、B/X、HID、驱动、Broker：未操作。
- 未 commit、push 或改写 Git 历史。

## 11. 交付后试用

1. 在独立测试环境安装 `dsh-orb-0.2.15.tgz`（不要用日常 Profile 做首次试用）。
2. 打开主窗口设置 → `dsh-orb 定制版`，确认版本 0.2.15、彩带“已连接”。
3. 在主窗口新建 Computer Use 对话，测试截图、点击、中文/英文输入、多行/Tab、窗口切换和停止。
4. 观察彩带是否围绕目标窗口显示；关闭/打开开关和异常重启按钮各验证一次。
5. 用户本人再用 Comfort 键盘和单指完成一次实际操作验收。

日常 Profile 不会自动升级；需要用户明确同意后，才按本地包安装流程替换。
