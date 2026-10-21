# 0.2.6 可靠性与证据记录

日期：2026-10-20。范围：规则载入、命令结果保存、停止覆盖范围。未安装到日常 desktop Profile。

> 这是 0.2.6 的历史记录。检查发现的 project_context 跨项目误认、runner 超时子进程、native 退出码、编码和超限返回码问题，已由 [07-review-fixes-027.md](07-review-fixes-027.md) 描述并修复；本文相关实现细节以 0.2.7 为准。

## 1. 现场核对

- DeepSeek Harness：`0.2.1-rc.2`（`DeepSeek Harness.exe` FileVersion，`app.asar/package.json` 同版本）。
- 源码与 desktop Profile 中的 `dsh-orb`：检查时均为 `0.2.5`。本轮源码版本升到 `0.2.6`，未覆盖 Profile。
- 实际 Shell：Windows PowerShell `5.1.26100.9168`（Desktop），不是 PowerShell 7。官方 `@deepseek-ai/dsh-tool-pwsh` 在这台机器上最终调用的是 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`；每次工具调用是新进程。
- Node：`24.21.0`；pnpm：`11.7.0`；npm：`12.2.0`。Node/pnpm/npm 不在默认 `PATH`，由 `scripts/dev-env.ps1` 从 Harness runtime 定位并在 `.zcode\dev-bin` 生成临时 shim。该脚本只改当前进程的 PATH，不改系统或用户级设置。
- 官方 `@deepseek-ai/dsh-agent-instructions` 已在 `app.asar` 中，standard preset 默认挂载，预算 65536 bytes。Computer Use preset 之前没有这一行。

## 2. 规则载入：已有、失效、补齐

### 原本已有

- standard preset 的官方 AGENTS 载入、嵌套规则、内容去重、预算截断、移除/更新通知都在官方包内。
- `code_agent` 创建的是 first-class standard Session，因此理论上也会走 standard preset 的规则链。
- Computer Use 的 `code_agent` 支持显式 `cwd`；`project_context` 不需要自建第二套注入器。

### 实际失效

- Computer Use preset 的插件清单里没有 `agent-instructions`；旧测试还明确断言它“不应存在”。因此主窗口 Computer Use 和悬浮球 Computer Use 都拿不到项目 AGENTS 链。
- 实际旧悬浮日志（`session-9185e520-3121-4fdd-a257-07e3b17dade9`）的 cwd 是 `C:\Users\zhq\.dsh\dsh_orb`；日志中 `agent-instructions` 事件数为 0。
- 同一会话的真实 `code_agent` 调用（seq 68）没有传 cwd。旧逻辑在 `.dsh\dsh_orb` 下新建了 `no-new-work-needed-this-is-only-to-confi` 子目录；后台会话自然拿不到 `C:\dsh-orb-cordis` 的规则。
- 先前把“工具调用成功”当成效率提高，没有把“规则是否进入实际模型上下文”当成可观测事实。

### 本轮补齐

- `packages/computer-use/presets/computer-use/agent.cordis.yml` 与 `packages/bundle/cordis.patch.yml` 增加官方 `@deepseek-ai/dsh-agent-instructions`，预算 65536 bytes。
- 新增 `project_context` 只读工具（注册在 `code-agent.ts` 的同一 preset 内）：
  - 报告 Session cwd、任务项目目录、`.git` 根；
  - 从官方 loader 的 durable `agent-instructions` 消息读取实际 retained 的 path、scope、SHA-1 digest、baseline identity；
  - 对比当前磁盘 SHA-1，标出 stale；
  - 解析官方 budget notice，标出 omitted / truncated / budget；
  - 只按用户明确列出的路径读 handoff，最多 4 个文件、每个 16 KiB、合计 32 KiB，不递归扫描目录；
  - 不重复返回 AGENTS 正文。
- `code_agent` 在 git 项目内创建新会话时，优先复用调用会话的项目目录，不再总是新建子目录；如果用户给了 `cwd` 或 `project_context.project_dir`，按用户路径。非项目 workspace 的独立产物仍保留“新子目录”行为。
- 排队给后台 standard Session 的任务前加 `Project scope:` 与 `Project root:`，并明确“规则由 standard loader 载入，不要重述”，不复制整份 AGENTS。
- 新增根 `AGENTS.md`，把项目目录、工具链、保护边界、证据协议、停止边界写成长期约定；它由官方 loader 载入。

### 实际载入证据（主窗口 standard）

本轮在创建 `C:\dsh-orb-cordis\AGENTS.md` 后，当前真实 standard Session 的下一次请求收到官方 baseline：

- Session：`session-7d92f1be-eabd-4ca9-a5d4-fc05c2244159`，preset `standard`，cwd `C:\dsh-orb-cordis`。
- baseline 事件：`seq=965`，`action=set`，`path=AGENTS.md`，digest `3a8476bb755b011d7d96625f6128f9f1ced9d83f`。
- 磁盘 `Get-FileHash AGENTS.md -Algorithm SHA1`：`3A8476BB755B011D7D96625F6128F9F1CED9D83F`，完全一致。
- 证据：`.zcode/evidence/current-session-instructions.json`；解压后的会话 `.zcode/evidence/current-session.jsonl`。

### 未实测

- 0.2.6 的 Computer Use preset 没有在真实 desktop Profile 中安装；主窗口 Computer Use、悬浮球 Computer Use、后台 `code_agent` 的真实规则载入属于“源码/单测/静态验证”，不是真实 Harness 会话。
- 悬浮球默认 workspace 是 `C:\Users\zhq\.dsh\dsh_orb`。如果用户不把 workspace 指到项目、也不在任务里给出项目路径，短任务仍无法自动知道 `C:\dsh-orb-cordis`；本轮不擅自修改日常 workspace。试用时需一次性设置 workspace，或在任务中写项目路径。
- 项目切换、规则文件在长会话中的更新/移除只做了官方机制和 mock 事件验证；未做真实长会话演练。

## 3. 命令结果与证据

新增 `packages/bundle/runtime/`：

- `run-with-evidence.ps1`：启动一个子 PowerShell，stdout/stderr 分别写入文件；用 C# 读取线程在**生成过程中**按字节封顶，超出部分丢弃并记录 `dropped_bytes`。随后只从标量/固定字段构造 summary JSON，不序列化 Process、Exception 或 .NET 对象。
- `run-with-evidence.cmd`：ExecutionPolicy 受限时的直接入口；复杂命令通过 `-CommandEnv` 传文本，避免 PowerShell 5.1 原生参数绑定丢内嵌引号。
- `read-evidence.ps1` / `.cmd`：summary 最大 64 KiB；log 只返回 size、SHA-256、受限 head/tail，不整文件读入上下文。

边界：

- 单条日志默认 16 MiB，可显式调低；summary 64 KiB；命令文本 128 KiB；warning/note 4096 字符；数组固定；JSON depth 6。
- summary 包含 `status`（`exited_zero`/`exited_nonzero`/`timed_out`）、`exit_code`、`counts`、`claims`、`logs[].path/bytes/written_bytes/dropped_bytes/sha256`、`environment` 和 `limits`。
- `claims.tests` 不会因为退出 0 自动变成 passed；有 counts 时也只写 `counts-recorded-not-independently-verified`。deployment/production 默认 `not-recorded`。
- 写入失败返回 2，保留上一份 summary 与原始日志；不删除证据目录。
- 已存在 `run-with-evidence.ps1` 的直接调用受 ExecutionPolicy 限制；试用和 AGENTS 中明确先 `Set-ExecutionPolicy -Scope Process Bypass -Force`，或用 `.cmd`。

正常/失败/超限/写入失败的实际大小见第 5 节测试。最终脚本的本机样例（`.zcode/evidence/final-cases/`）：

| 样例 | status / exit | summary | stdout | stderr | 说明 |
|---|---|---|---|---|---|
| 正常 | `exited_zero` / 0 | 3,709 bytes | 11 bytes | 0 | 3 个 check counts |
| 命令失败 | `exited_nonzero` / 3 | 3,596 bytes | 16 bytes | 16 bytes | 不写成测试失败 |
| 输出超限 | `exited_zero` / 0 | 3,694 bytes | 4,096 / 204,000 bytes，丢弃 199,904 | 0 | 流式截断 |

日志分别在同目录 `stdout.log` / `stderr.log`；summary 里保留路径、大小、SHA-256 和 dropped_bytes。

## 4. 停止覆盖

| 入口 | 实际取消 | 排队消息 | 后台 code_agent | 已执行 GUI/文件 | 迟到结果 | 恢复保护 |
|---|---|---|---|---|---|---|
| 悬浮球“停止当前对话” | 当前 ball Session 的当前 turn：`orb:stop` → `stopTurn` → `sessionController.cancel({sessionId})` → `agent.cancel({kind:'user'}, {keepInbox:true})` | **保留**，会继续执行 | 不取消，独立 Session | 不回滚 | 后台任务完成通知仍可唤醒该对话 | `turnEpoch` 守卫避免把 cancel 期间新起的 turn 关掉；现有测试覆盖 prompt/wake-up/open 三条路径 |
| 主窗口“停止” | 官方主窗口自己的 Session cancel；插件未改主程序 | 按官方 `keepInbox` 语义保留 | 不取消 | 不回滚 | 同样可能有后台通知 | 未在本轮真实主窗口演练；按同一 sessionController 路径判断 |
| `code_agent_stop` | 目标后台 standard Session 的当前 turn：`agent.cancel({kind:'user'})`（不带 keepInbox） | **丢弃**该后台会话排队 follow-up | 只停指定会话 | 不回滚，不删文件 | watch 被 abort，不投递完成通知 | 只能停本 Computer Use caller 登记的会话；跨 caller 拒绝 |
| 禁用/关闭悬浮球 helper | `halt()` 停 watch、agent poll、socket、helper 进程 | 不处理 Session inbox | 不取消 | 不回滚 | 当前 turn 可能继续运行，而界面不再显示 | **缺口**：`halt()` 不 cancel 当前 session；本轮未改结构 |

- 键鼠释放：Windows click/drag/hotkey 的 `finally` 保证按钮和按键反向释放；macOS HID 取消路径用不带 abort signal 的释放脚本。测试覆盖 click、drag、hotkey 取消。
- 官方 pwsh 工具在调用取消时按官方契约 kill 对应 job；本轮未用长任务做真实停止演练，不能把“取消调用”当作已验证的命令终止证据。
- 后台运行数量：`background-status.js` 分开统计 running/completed/stopped，9 条测试通过；界面已有独立“后台 N 个任务运行中”。
- 最小界面修正：停止说明现在明确“本对话当前回合”、排队消息和后台会继续、完成通知仍可能唤醒、已执行操作不撤销。没有新增统一暂停/恢复按钮，没有承诺一键停止所有工作。

### code-agent-unattended 现状

`packages/computer-use/src/code-agent-unattended.ts` 在 `code_agent` 接受任务后给该后台 Agent 挂：

- `approval/request` 一律返回 `allowed-once`，不区分工具、路径、风险或项目规则；
- `user-questions/request`：plan-review 选 approve；有 `(Recommended)` 选推荐；否则选第一个选项（multiSelect 全选）；没有选项时返回 `Stop. Return the short result you already have...`。

这是既有的“无人值守”行为，本轮未重写、未声称项目规则能约束它。它只作用于被 `code_agent` 派出的后台 standard Agent；主窗口/Computer Use 自己的审批不由此处接管。

## 5. 验证结果

### 通过

- `pnpm run typecheck`：exit 0。
- `pnpm build`：exit 0。
- `pnpm --filter @dsh-orb/computer-use test`：30 files，331/331 通过；日志 `.zcode/evidence/vitest-final.log`。
  - 新增 `project-context.spec.ts` 8 条：根发现、规则链顺序/摘要、loader 事件、pending、显式 handoff 截断/拒目录、4 文件上限、工具输出、runner 定位。
  - `preset.spec.ts` 6/6，Computer Use composition 和 built overlay 均断言官方 loader 行与 65536 预算。
  - `code-agent.spec.ts` 35/35，新增项目 cwd 与 `Project scope` 两条。
- `node --test packages/bundle/tests/*.test.mjs`：9/9。
  - evidence：正常、失败、4 KiB 超限、保存失败旧结果保留、bounded reader。
  - install：link 和 tarball 安装布局，包含 `runtime/` 四个文件。
- `shell-render.test.ts` + `background-status.test.ts`：50/50。
- `pnpm --filter dsh-orb run pack`：最终重跑 exit 0，日志 `.zcode/evidence/pack-0.2.6-clean2.log`。
- 用本轮新证据脚本记录最终包：summary 3,828 bytes，`status=exited_zero`，stdout 405 bytes，证据目录 `.zcode/evidence/commands-final/20261020-192531-reliability-026-final-package-2/`。

### 完整 `pnpm test` 的失败

`pnpm test` exit 1：node:test 431 条，430 通过，1 条失败。

- 失败：`packages/host/tests/deferred-install.test.ts:85` “marks the install as running before pnpm starts…”
- 原因：测试尝试从 `https://registry.npmmirror.com/` 安装不存在的 `dsh-orb@0.2.0`，返回 `ERR_PNPM_NO_MATCHING_VERSION`；测试期望假管理器返回 ok。
- 这是既有的网络/夹具依赖，不是本轮规则、证据或停止修改引入。基线同一测试也失败（当时还多一条 bundle install 失败，因为 npm 不在 PATH；`scripts/dev-env.ps1` 把本地 npm 加入 PATH 后，bundle install 已通过）。
- 由于根脚本用 `&&`，该失败会阻止后面的 `pnpm --filter @dsh-orb/computer-use test`；已单独运行并通过 331/331。因此不能写作“全量测试通过”。日志 `.zcode/evidence/full-test-final.log`。

### 未实测

- 0.2.6 真实安装、真实 Harness 重启、真实模型回合中的 Computer Use/后台规则载入。
- 真实主窗口停止按钮、真实长命令 kill、后台任务 stop 的真实 GUI。
- 未做真实 Windows GUI 操作；未以运行中的 rightpad 为实验对象。
- 用户单指体验。

## 6. 交付物

- 源码：`AGENTS.md`、`packages/computer-use/src/project-context.ts`、`packages/bundle/runtime/*`、`scripts/dev-env.ps1`，以及上述 preset/测试修改。
- 新包：`C:\dsh-orb-cordis\dsh-orb-0.2.6.tgz`
  - 版本 `0.2.6`
  - 大小 `24,471,124` bytes
  - SHA-256 `49ADEA3C243517DC06FA60676C823E75DB2D3E097B0E687F80F2EC66B38038D0`
  - 旧包 0.2.0–0.2.5 均保留；首次/中间 0.2.6 构建副本保存在 `.zcode/evidence/dsh-orb-0.2.6-first.tgz`（SHA-256 `944C52BC4C572910D66108681780BBFE285D4AEC8EA6E08B17DAE4C4ADBB86E8`），最终交付以仓库根的 final 包为准。
- tarball 已解包核对：`package.json` version 0.2.6、`cordis.patch.yml` 含 loader 行、`runtime/` 四文件、`dist/computer-use/code-agent.js` 含 `project_context`。

### 试用

1. 用单独 profile 安装 `dsh-orb-0.2.6.tgz`；不要直接覆盖日常 desktop Profile。
2. 首轮先让主窗口 standard 会话读一条短任务（例如“用一句话说出 AGENTS.md 要求的三类证据”），确认 `agent-instructions` 出现在请求上下文；再看 `project_context` 是否返回同一路径和 digest。
3. 把悬浮球 workspace 指向 `C:\dsh-orb-cordis`，或让任务明确写项目路径；再发一条短任务，触发 `code_agent` 后检查后台 session cwd 和 `Project scope`。
4. 用证据脚本跑正常、`exit 3`、超限三条小命令；确认 summary 大小、日志截断和 claims。
5. 停止测试：先发一条可中止的长任务，点“停止当前对话”；确认当前 turn 结束、排队消息/后台任务按表面语义继续、没有新工作被误称为已取消。真实长任务和 GUI 由用户验收。

### 恢复

- 本轮没有安装，所以无需回滚日常 Profile。
- 若试用 0.2.6 出问题：用官方插件管理器改回 `dsh-orb-0.2.5.tgz`，不删除 session、旧包和证据；不要用杀进程作为统一恢复手段。
- 若规则异常：先用 `project_context` 看 loader 是否 `pending/none/omitted/stale`；若只是当前请求尚未 durable，以当前请求里的 `<system-reminder>` 为准，等下一请求再看。
- 若证据目录写失败：保留原目录，换一个可写 `-EvidenceRoot`；旧 summary 不会被覆盖。
