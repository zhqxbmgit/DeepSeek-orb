# dsh-orb-cordis 项目约定

本文件由官方 `@deepseek-ai/dsh-agent-instructions` 载入。它只写长期适用、会改变执行结果的约定；历史计划、旧日志和示例命令不是本轮指令。

## 1. 项目范围

- 这是用户自己的独立定制版 `dsh-orb` 源码仓库，不是跟随上游发布节奏的发行分支；官方 DeepSeek Harness 主程序和现有电脑操作后端保留不动。仓库：https://github.com/zhqxbmgit/DeepSeek-orb
- **主窗口 Computer Use 是唯一正式使用路径。** 生产源码和安装包不再包含悬浮球、聊天面板、头像、菜单或球的会话生命周期；主窗口的截图、点击、输入、窗口切换和后台协作不依赖球运行。
- 观察框彩带是保留功能，由 `packages/helper` 中一个只负责绘制、显示/隐藏和确认 overlay 区间的最小 Electron 组件提供。它不持有会话、提示词、聊天记录、工作区或更新逻辑；失败时通过设置页左键可达的“重新启动彩带组件”恢复，不自动反复拉起重试。
- 只通过经过检查的本地安装包升级；不自动访问原版发布源，不自动安装公共仓库的原版 `dsh-orb`。更新说明和问题反馈指向用户仓库。
- 修改在 `C:\dsh-orb-cordis` 的独立源码工作区完成，不直接改已安装的 `node_modules` 作为成果。
- 本文件所在目录就是项目根，`.git` 是根标记。`Set-Location` / `cd` 只改变当前 shell 进程；任务的项目目录以 Session 的 `cwd` 或用户明确给出的路径为准。
- 当前未提交的修改、新增文件、旧安装包、日志和证据都保留。不要为了“干净”而清理它们。

## 2. 工具链（Windows）

实际 shell 是 Windows PowerShell 5.1（Desktop），不是 PowerShell 7。每个 `pwsh` 工具调用都是新进程，`cd` 不会跨调用保留；用 `workdir` 或绝对路径。

Node 和 pnpm 不一定在 `PATH`。每次需要时先执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. .\scripts\dev-env.ps1
```

`dev-env.ps1` 找到 Harness 自带的 Node 24.21.0 / pnpm 11.7.0，把 shim 放进 `.zcode\dev-bin`，并输出实际版本、cwd。不要修改系统 PATH 或用户级执行策略。

常用命令：

```powershell
pnpm run typecheck
pnpm test
pnpm --filter @dsh-orb/computer-use test
pnpm build
pnpm --filter dsh-orb run pack
```

- `run` 不能省略；打包版本由 `packages/bundle/package.json` 决定。
- 新包必须使用未占用的 patch 版本，保留全部旧 `.tgz`。
- 完整测试里已知的环境/夹具失败要单独说明，不得算成全量通过。

## 3. 受保护边界

没有用户在本轮的明确授权，不要：

- 修改 `C:\rightpad` 的源码、配置、手机布局或资料；不要停止、重启、替换 Receiver。
- 构建、部署或重启 Android；修改 Motion、M/C、B/X、Virtual HID、驱动或 Broker。
- 修改或关闭 Comfort On-Screen Keyboard / Free Virtual Keyboard。
- 修改 DeepSeek Harness 主程序。
- 安装/更新日常 desktop Profile、切换日常配置、重启日常 Harness。
- commit、push、改写历史或删除旧文件。

运行中的 rightpad 不是试验对象。需要真实加载验证时，先交付源码、构建产物和验证方案，并明确未实测项。

## 4. 规则载入

- 规则由官方 loader 注入，`project_context` 只报告路径、字节数、SHA-1、遗漏/截断/过期状态，不重复注入正文。
- 普通主窗口开发会话和 `code_agent` 后台标准会话使用官方 `standard` preset 的规则链。
- 主窗口 Computer Use 的 preset 必须挂载 `@deepseek-ai/dsh-agent-instructions`，预算与 standard 相同（65536 bytes）。悬浮球不再是产品入口，不要求为它保留 preset。
- `code_agent` 在 git 项目内默认使用调用会话的项目目录，不再盲目新建子目录；这样后台标准会话能从项目根载入同一组 `AGENTS.md`。
- `project_context` 读取本机 `workingDirectory` 服务的 `get(session)` 作为当前目录，`session.header.cwd` 只作为创建目录显示；loader baseline 的相对项目根按 baseline 产生时的目录解释（`working-directory/change` 事件），没有可靠目录来源时保持 `unconfirmed`。`project_dir` 参数本身不能证明会话已切换项目。
- loader 的 `changes[].path` 是相对**项目根**的显示路径，不能按事件 cwd 展开。`project_context` 为每条已加载记录保留产生该事件的 `cwd` 和 `projectRoot`；报告同时给出 `baseline_project_root` 与 `latest_loader_project_root`。cwd 在项目子目录时，根 `AGENTS.md` 与 `src/AGENTS.md` 必须分别匹配真实文件，不能再生成 `src/src/AGENTS.md`。
- `code_agent` 新建和继续后台工作时优先使用 `workingDirectory` 的当前目录；继续时若显式 `cwd` 与实际当前目录不一致，直接拒绝并且不改变运行中的会话。用户显式路径仍用于新建会话，并经过既有目录校验。
- 用户明确指定的交接文档才读；使用 `project_context` 的 `handoff`，最多 4 个文件、每个 16 KiB、合计 32 KiB。不要递归扫描 `docs/`、历史记录或旧日志。

## 5. 命令结果与证据

不要只靠“exit 0”宣布任务完成。状态至少分开记录：

- `command exit`：命令进程退出码。
- `tests`：实际断言/计数和测试日志。
- `deployed`：实际安装/部署证据。
- `production verified`：真实环境验证证据。

没有对应证据就写“未验证”或“部分完成”。

保存命令结果时，用仓库或已安装插件里的伴生脚本，不要重写 Shell 执行器。构建/测试等外部程序优先用 native 模式：

```powershell
$runner = if (Test-Path "$env:DSH_PROFILE_DIR\node_modules\dsh-orb\runtime\run-with-evidence.cmd") {
  "$env:DSH_PROFILE_DIR\node_modules\dsh-orb\runtime\run-with-evidence.cmd"
} else {
  (Resolve-Path .\packages\bundle\runtime\run-with-evidence.cmd).Path
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# 外部程序：真实退出码直接保留，不依赖 exit 语句
$env:DSH_EVIDENCE_ARGS = ConvertTo-Json @($env:DSH_PNPM,'run','typecheck') -Compress
& $runner -TaskId 'reliability-028' -Phase 'typecheck' `
  -NativeProgram $env:DSH_NODE -NativeArgsEnv 'DSH_EVIDENCE_ARGS' `
  -EvidenceRoot '.zcode\evidence\commands'

# 任意 PowerShell 脚本：退出码按 PowerShell 进程记录
$env:DSH_EVIDENCE_COMMAND = @'
Write-Output 'inspect only'
exit 0
'@
& $runner -TaskId 'reliability-027' -Phase 'inspect' `
  -CommandEnv 'DSH_EVIDENCE_COMMAND' -EvidenceRoot '.zcode\evidence\commands'
```

要点：

- native 模式用 `-NativeProgram` + `-NativeArgsEnv`（JSON 字符串数组），不经过 PowerShell 文本解析。优先启动 `.exe`，例如 `node.exe` + `pnpm.cjs`；`.cmd/.bat` 默认拒绝，只有显式 `-AllowCmdShim` 且参数全部为安全 ASCII（无引号、`%`、`^`、`&`、`|`、重定向、括号、空参数）时才允许，并记录为 `native-cmd-shim`。
- 脚本模式（`-CommandText` / `-CommandEnv`）只报告 PowerShell 进程退出码，不会推断脚本里外部程序的退出码；需要真实构建/测试退出码时用 native 模式，或显式 `exit $LASTEXITCODE`。
- summary 的 `command_exit_code`、`shell_exit_code`、`tool_exit_code` 分开；`command_status` 与 `evidence_status` 也分开。
- 原始 stdout / stderr 各自写入 `stdout.log` / `stderr.log`；日志是原始字节，summary 为每个流记录检测到的 `encoding`（`utf-8`、`gb18030`、`utf-16le`、`utf-16be` 或 `unknown`）、`encoding_valid`、`encoding_verified`（`whole` / `sample-prefix`）和采样大小。前缀采样能解码不等于整份文件已验证；reader 会在 head/tail 边界裁掉不完整多字节字符，并报告 `boundary_trimmed_*`。
- 单个日志默认上限 16 MiB，summary 上限 64 KiB，命令文本上限 128 KiB。日志超限时保留前缀并记录 `written_bytes`、`dropped_bytes` 和 `truncated`。
- 超限时工具返回 **74**，同时保留原命令的 `exit_code`（例如命令本身是 0）；`status` 为 `exited_zero_evidence_truncated`，`evidence_complete=false`。不能把这时的证据当作完整原始日志，也不能说命令失败。
- 超时由 runner 自己的 Windows job object 处理，只结束本次命令的进程树；返回 124，不按 node/PowerShell/Electron 进程名批量结束。
- 读大日志前先看大小；用 `read-evidence.cmd -Log ... -HeadBytes 8192 -TailBytes 2048`，不要一次读进上下文。日志预览会返回检测编码。
- 中文路径、备注、native 参数用环境变量入口：`-EvidenceRootEnv`、`-NoteEnv`、`-NativeArgsEnv`、`-NativeProgramEnv`；读日志/摘要用 `read-evidence.cmd -LogEnv` / `-SummaryEnv`。PowerShell 5.1 的 `-File` 参数绑定可能破坏非 ASCII 参数。
- 写入失败时脚本返回 2 并保留上一份有效 summary 和原始日志；不要删除证据目录。

## 6. 停止与后台

区分下面这些事实，不能互相替代：

- **当前 turn 取消**：停止按钮取消当前 Session 的当前 turn；会话事件记录 `turn/end` `aborted`（用户原因），正在执行的工具收到 `AbortError`。
- **工具/命令结束**：该 turn 对应的 PowerShell 等命令进程会结束；已完成的点击、键入和文件修改不会回滚。插件按住的按键/鼠标按钮必须在 abort/异常路径释放；不要把杀进程当成统一停止方案。
- **消息保留**：官方 `sessionController.cancel` 使用 `keepInbox: true`，已排队消息会留在队列中。现有实测只覆盖 25 秒观察：期间没有自动开始新 turn，手动 Ctrl+Enter 也没有恢复。保留不等于自动执行，有限时间没执行也不等于永久取消；旧队列在什么条件下恢复尚未确认，不能把“手动重发”一概描述成无重复风险。
- **独立后台继续**：后台 `code_agent` 是独立 Session，主 turn 停止不会取消它。用 `code_agent_stop` 停止对应后台当前 turn 及其正在运行的命令；实测 `code_agent_stop` 会返回 AbortError、`turn/end` aborted，并使目标命令进程结束。
- **后台通知唤醒**：后台完成通知仍可能唤醒被停止的 Computer Use 对话。这是现有通知契约，不是“停止所有工作”，也不是新的统一暂停系统。本轮不修改官方调度器。

## 7. 验证分层

分别报告，不能互相替代：

- 自动化单元/集成测试。
- stub 桥接或隔离 UI 测试。
- 真实 Harness 会话（若未安装本轮包，明确写“未实测”）。
- 真实 Windows GUI 操作（rightpad 运行实例不作为实验对象）。
- 用户单指体验（由用户本人验收）。

## 8. 交付

- 说明原本已有、实际失效、本轮补齐的边界。
- 给出改动文件、行为变化、测试日志和失败项。
- 给出新包路径、版本、字节数、SHA-256；保留旧包。
- 给出试用步骤和恢复方案。
- 交付后等待检查，不自动安装到日常 Profile。
