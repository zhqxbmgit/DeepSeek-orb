# 0.2.12 主窗口定制版：开发与真实验收

日期：2026-10-21
交付包：`C:\dsh-orb-cordis\dsh-orb-0.2.12.tgz`

## 1. 产品定位

本轮把 `dsh-orb` 从“悬浮球插件”调整为**用户自己的主窗口 Computer Use 定制版**：

- 官方 DeepSeek Harness 和现有 Computer Use 后端保留。
- 主窗口 Computer Use 是唯一正式入口；默认不启动悬浮球/helper。
- 设置页明确显示“dsh-orb 定制版”、当前版本、用户仓库和“只使用本地安装包更新”。
- 不再实例化/启动原版 `UpdateChecker`；设置页没有插件更新、悬浮球启用、头像、工作区或历史清理入口。
- 保留主窗口必需的设置：后台 Agent 模型、千分比坐标、观察框彩带；设置页可通过左键进入。
- 包名继续使用 `dsh-orb`；MIT 许可和来源说明保留。
- 仓库/问题反馈：https://github.com/zhqxbmgit/DeepSeek-orb

安装后的 patch：

```yaml
orb-host:
  config:
    autoStart: false
```

Host 日志只有 web port、Profile 和 `dsh-orb: version 0.2.12`，没有 helper 启动；GUI 验收期间也没有 helper 进程。

设置页截图：[settings-custom-0212.png](../.zcode/evidence/settings-custom-0212.png)，文本：[settings-custom-0212.txt](../.zcode/evidence/settings-custom-0212.txt)。截图中没有悬浮球或更新控件，只有定制版说明、后台模型、千分比和观察框。

## 2. BOM 规则误报 STALE

### 结论

官方 loader 的 digest 覆盖的是**解码后的 UTF-8 文本、去掉文件开头一个 U+FEFF**，保留其余字符和换行。`project_context` 现在同时计算：

- `sha1`：原始文件字节摘要，仅用于证据；
- `loader_sha1`：与 loader 语义一致的内容摘要；
- `digest`：loader 事件中的摘要。

STALE 只比较 `loader_sha1` 与 `digest`。没有 trim 全文、统一换行或忽略空白。

### 真实复测

测试项目：`.zcode\verify-0.2.12-home\rule-b`。

- `AGENTS.md` 76 bytes，带 UTF-8 BOM。
- 原始 `sha1`：`2beff4a5fcd26e5bd21bb745d12c158dac023f48`
- `loader_sha1` / `digest`：`9a47a6750fa338d3a5229224e6b94ec9ec97136a`
- 真实会话 `project_context`：`state: loaded`、`project_scope_confirmed: true`、`stale: false`、`warnings` 无 STALE。
- 规则正文被真实注入，模型最终答案自动追加 `[ORB-RULE-B]`。

会话证据：`.zcode\evidence\rule-0212-session.jsonl`（baseline seq 10，digest `9a47...`；project_context seq 22）。原始会话：`.zcode\verify-0.2.12-home\sessions\--C-dsh-orb-cordis-.zcode-verify-0.2.12-home-rule-b--\session-8abf58ab-2d11-4901-86aa-f058ae0e8624\session.v4.jsonl.zstd`。

自动化测试覆盖：

- 带 BOM：raw sha1 与 loader hash 不同，仍 loaded、非 stale；
- 无 BOM：三者一致；
- 真实正文修改（包括只加一个换行）：stale=true；
- loader 的换行不被统一。

## 3. 目录切换后的 replace 归属

### 修正

`instructionObservationFrom` 现在按事件顺序追踪每个 loader 消息产生时的 cwd：

- baseline 保留初始项目身份；
- 后续 `set`/`replace`/`remove` 记录各自的 cwd；
- `project_context` 按每条规则证据的 cwd 重建绝对路径，不再把所有旧 retained 记录绑定到当前目录；
- 报告新增 `latest_loader_cwd`；
- 没有可靠 cwd 的更新保持不可确认；
- `baseline_project_root` 保留历史 baseline，不被覆盖。

### 真实复测

同一 Computer Use 会话：

- 起始项目 B：rule-b，BOM baseline；
- `working-directory/change` seq 38 从 B 到 A；
- A 的真实 `agent-instructions` **replace** seq 45，digest `a621cceb2a2e921de1e72d24e0e393f0f6514089`，没有 `baseline: true`；
- 下一次 `project_context` seq 60：
  - `state: loaded`
  - `project_scope_confirmed: true`
  - `latest_loader_cwd: ...\rule-a`
  - `baseline_cwd: ...\rule-b`
  - `baseline_project_root: ...\rule-b`
  - `AGENTS.md` digest/loader_sha1/sha1 都是 `a621...`
  - `loaded: true`，`stale: false`
  - 唯一 warning 说明当前 cwd 与 header 不同、loader scope 在 A；没有“证据属于 B、A 未确认”的误报。
- 模型最终答案追加 `[ORB-RULE-A]`。

这说明 A 的 replace 证据被正确归属，同时 B 的历史 baseline 保留为历史，而不是把旧 retained 整体改绑到 A。

回归测试使用同一真实会话帧形状：B baseline → change A → replace A；并覆盖“切换后未收到 A 更新时不确认”“A/B 文本相同但 cwd 不同不误归属”“缺少 change 事件时不归属”等。`packages/computer-use/tests/project-context.spec.ts` 23/23 通过。

## 4. 真实 Computer Use 操作验收

### 环境

- 测试 home：`.zcode\verify-0.2.12-home`
- 测试 Profile：`orb-verify-0.2.12-20261021`
- 安装包：`dsh-orb-0.2.12.tgz`
- Host：`dsh --profile ... --no-open --port 61812`
- UI：headless Chrome CDP 9225，仅用于发送任务和读取 UI 状态；模型操作通过 Computer Use 工具执行。
- 目标窗口：测试 Chrome `Orb GUI Lab`；测试 Notepad `second.txt - Notepad`。
- 模型/路由：`deepseek-account` / `deepseek-flash` / reasoning `high`，Computer Use 模式。

### 模型实际完成的工具链

模型会话 `session-39c2e266-7a90-42b0-86ad-8a02e539b7df`，32 步，实际调用：

- `screenshot`
- `list_apps`
- `open_app`（chrome、notepad）
- `click`
- `input_text`
- `hotkey`
- `open_app` 切回 chrome

关键结果：

| 步骤 | 工具 | 结果 |
|---|---|---|
| 首屏 | screenshot | 当前前台是 ChatGPT，模型没有误操作 |
| 找窗口 | list_apps | 确认 Chrome、Notepad 运行 |
| 切窗口 | open_app chrome | 标题 `Orb GUI Lab`，看到输入框和按钮 |
| 聚焦输入 | click | 首次点击后前台异常跳到 DeepSeek Harness，未命中；模型重新 open_app 后换位置点击，输入框出现光标 |
| 中文输入 | input_text | 输入“你好” |
| 英文输入 | input_text | 输入“ Orb”，输入框显示“你好 Orb” |
| 点击按钮 | click | 绿色结果区显示“结果：你好 Orb” |
| 切到 Notepad | open_app notepad | 标题 `second.txt - Notepad`，19 个字符 |
| 定位编辑区 | click | 多次坐标重试后光标到行尾 |
| 输入 Second OK | input_text | 第一次画面显示末尾为“KK”（模型放大核对）；模型删除两个字符后分两次输入“O”“K”，最终显示 `Second window testSecond OK`，28 个字符 |
| 切回 Chrome | open_app chrome | 输入框仍为“你好 Orb”，绿色结果区仍为“结果：你好 Orb” |

证据：

- 结果截图：[gui-0212-result.png](../.zcode/evidence/gui-0212-result.png)（真实 `结果：你好 Orb`）
- Notepad 最终截图：[gui-0212-notepad-final.png](../.zcode/evidence/gui-0212-notepad-final.png)（真实 `Second window testSecond OK`）
- 最终切回截图：[gui-0212-final.png](../.zcode/evidence/gui-0212-final.png)
- 模型会话 JSONL：[gui-0212-session.jsonl](../.zcode/evidence/gui-0212-session.jsonl)
- 会话原始文件：`.zcode\verify-0.2.12-home\sessions\--C-Users-zhq-Documents-deepseek-harness-default-workspace--\session-39c2e266-7a90-42b0-86ad-8a02e539b7df\session.v4.jsonl.zstd`
- `screenshot` 工具按设计保存了桌面 PNG：`C:\Users\zhq\Desktop\Screenshot 2026-10-21 at 12.22.12.png`。

### 失败与限制，不隐藏

- 第一次点击输入框时前台跳到 DeepSeek Harness，模型没有把这次当作成功，重新切 Chrome 后重试成功。
- 第一次 `input_text("Second OK")` 后截图显示 `KK`；模型放大到 120% 后删除重试。**同一份 0.2.12 安装代码的独立复测**（直接用安装包的 `typeUnicode` 输入 `Second OK` 到新的 Notepad 测试页）显示正确 `Second OK`，因此这是一次无法稳定复现的观察，不把它判为稳定的字符映射缺陷；真实最终结果已确认正确。
- `hotkey` 的 `"+"`、`"="` 键名被拒绝（`unknown key`），模型改用 Notepad 菜单“查看 → 缩放 → 放大”；这是工具键名覆盖限制。
- 第一次 Notepad 点击未命中编辑区，后续重试成功；属于 GUI 定位/窗口重叠问题。
- 本次验收使用自动输入；**用户单指 + Comfort On-Screen Keyboard Pro 的完整输入体验未由本人验收**。Free Virtual Keyboard 窗口在截图中出现，但模型没有点击或修改它。

## 5. 停止范围实测

测试目录：`C:\Users\zhq\Documents\deepseek-harness\default-workspace\orb-stop-lab`。没有使用 `Stop-Process` 按进程名批量结束。

### 5.1 主 turn 停止

命令：

```powershell
[IO.File]::WriteAllText((Join-Path $lab 'stop-start.txt'), [string]$PID)
Start-Sleep -Seconds 60
[IO.File]::WriteAllText((Join-Path $lab 'stop-end.txt'), 'DONE')
```

- start 文件 PID：29312。
- 从 UI 点击“停止生成”后：
  - `turn/end` seq 24 `{kind:"aborted", reason:{kind:"user"}}`
  - tool result seq 22 `AbortError` / `tool call aborted`
  - `stop-end.txt` 不存在
  - 进程 29312 已结束（停止后 3 秒查询无结果）
- 因此：**turn 被取消、工具返回取消、对应 PowerShell 命令进程结束**三者都有独立证据。

### 5.2 排队消息

运行中提交的“只回复 QUEUED-ACK”：

- 写入 `agent/inbox/spliced` seq 21，target `next-turn`；
- turn 1 abort 后没有启动新 turn；
- UI 仍显示该排队消息，25 秒后仍未自动执行；
- 手动按 Ctrl+Enter 也未恢复执行（turn 已停止）。
- 结论：**排队消息保留，但没有自动执行，也没有自动恢复**；需要用户重新发送。不能把“保留”当作“会执行”。

### 5.3 独立后台继续

后台会话 `session-20aec0ec-182d-4c9a-b5de-081d91bf5878` 运行 45 秒写入 `bg-indep-start.txt`（PID 19780）和 `bg-indep-end.txt`（DONE）。

- 主会话随后前台运行 60 秒脚本，运行中被停止。
- 主会话 `turn/end` seq 110 aborted，前台进程 29560 结束，`fg-stop-end.txt` 不存在。
- 后台 PID 19780 继续运行，45 秒后写入 `bg-indep-end.txt` = DONE，后台 `turn/end` completed。
- 后台完成通知唤醒主会话：主会话 seq 111 写入 `computer-use` notice，之后 turn 5 完成并报告后台结果。
- 结论：**主 turn 停止不会停止独立后台；后台完成通知会唤醒主对话**。

### 5.4 code_agent_stop

后台会话 `session-5ad779de-0238-48f6-a8fa-7be219b1d9fd`：

- 后台已写入 `code-stop2-start.txt`（PID 33980），正在 `Start-Sleep 60`；
- 主会话确认 `code_agent_status` 为 running 后调用 `code_agent_stop`；
- 返回原文：`Stopped background Code agent session ... The session is idle. ...`
- 后台 session：
  - tool result seq 32 `AbortError` / `tool call aborted`
  - `turn/end` seq 34 `{kind:"aborted", reason:{kind:"user"}}`
  - PID 33980 已结束
  - `code-stop2-end.txt` 不存在
- 结论：**code_agent_stop 停止了目标后台当前 turn 和正在运行的命令，不只是改状态文字**。

第一次立即 stop 的后台还没写入 start 就被停止；第二次等待 5 秒、确认 running 后再 stop，作为有效证据。

## 6. 测试、构建与包

### 测试

| 组 | 结果 | 日志 |
|---|---|---|
| Computer Use | 350 / 350 pass | `.zcode\evidence\final-computer-use-0212.log` |
| helper + client-settings | 195 / 195 pass | `.zcode\evidence\final-helper-client-0212.log` |
| bundle/install layout | 23 / 23 pass | `.zcode\evidence\final-bundle-0212.log` |
| host 全量 | 215 / 216，1 失败 | `.zcode\evidence\final-host-0212.log` |
| 根 `pnpm test` | 433 / 434，1 失败（`&&` 在此停止，CU 未在该次运行中执行） | `.zcode\evidence\final-all-0212.log` |
| 合计（分组） | 783 / 784 pass；CU 单独 350/350 | — |

唯一失败是既有 `deferred-install` 夹具：

```text
ERR_PNPM_NO_MATCHING_VERSION
No matching version found for dsh-orb@0.2.0
from https://registry.npmmirror.com/
```

它测的是已删除的原版 after-exit 更新安装路径，不是本轮主窗口 Computer Use 回归；未算作全绿。

### typecheck / build

- `pnpm run typecheck`：exit 0，`.zcode\evidence\final-typecheck-0212.log`
- `pnpm build`：exit 0，`.zcode\evidence\final-build-0212.log`
- `pnpm --filter dsh-orb run pack`：exit 0，生成 0.2.12

### 包

- 路径：`C:\dsh-orb-cordis\dsh-orb-0.2.12.tgz`
- 大小：24,473,456 bytes
- SHA-256：`AA45445B2FFDCD96CB926B6145F8C6CF317B6EA166CC757C1EB75FC4B870AEEA`
- 安装到测试 Profile 后版本 0.2.12。
- 安装后的 Computer Use / Host / client SHA-256 与 `packages\bundle` 构建产物一致：
  - `dist/computer-use/index.js`：`67BD7071497D3CF29BC0420B6608705BF6D67332B8975E8D22398985CF50326D`
  - `dist/host/index.js`：`8E34928A98B8C2B276C03BEEEBD375209B223D2597B76D47645DF2D32D9C8E98`
  - `client.js`：`4C88FD3C208D5352B3956405984F71407C0E4250594F41ECBCB96EC9874C5124`

0.2.11 也是本轮产生的中间包；保留，不覆盖。最终交付以 0.2.12 为准。

## 7. 日常 Profile 与最终状态

- 日常 desktop Profile 保持 0.2.5；本轮未安装、未卸载、未重启、未修改共享配置。
- 日常主进程 `1664` 仍在运行。
- 日常包哈希沿用开工核对值；详见最终答复。
- 测试 Host、测试 UI Chrome、目标 Chrome/Notepad 测试窗口和后台命令已在本轮结束前停止；测试 Profile、项目、日志、截图和证据保留。
- 测试 home：`.zcode\verify-0.2.12-home`
- 测试 Profile：`...\profiles\orb-verify-0.2.12-20261021`

## 8. 尚未验证

- 用户本人单指体验、Comfort On-Screen Keyboard Pro 的完整操作路径：未由用户验收。
- rightpad、Receiver、Android、Motion、M/C、B/X、HID、驱动和 Broker：未操作。
- 原版更新源访问：本轮生产路径没有实例化更新检查器；没有主动访问原版发布源。
- 0.2.12 未安装到日常 desktop Profile。
- 真实 GUI 只覆盖测试 Chrome/Notepad；没有操作微信、哔哩哔哩、ChatGPT 等前台窗口。
