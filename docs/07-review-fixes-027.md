# 0.2.7 检查问题定向修复

日期：2026-10-20。范围：0.2.6 检查发现的五类问题。未安装到日常 desktop Profile，未操作 rightpad。

> 0.2.7 检查又发现 `.cmd` 参数改写、当前工作目录和长 UTF-8 采样边界问题；修复见 [08-review-fixes-028.md](08-review-fixes-028.md)，本轮相关实现以 0.2.8 为准。

## 1. 现场

- Harness `0.2.1-rc.2`；日常 desktop Profile 仍为 `dsh-orb` 0.2.5；源码本轮从 0.2.6 升到 0.2.7。
- 实际 Shell：Windows PowerShell `5.1.26100.9168`（Desktop）。Node `24.21.0`，pnpm `11.7.0`。
- 0.2.6 检查证据保留在 `C:\Users\zhq\AppData\Local\Temp\orb-026-review-243173a933\`。before 数字来自其中的 `review-findings.json`、`project-review.json`、`runner-review.json`、`overflow-review.json`；after 数字来自本仓库 `.zcode/evidence/`。

## 2. 五类问题的根因、行为和修改

### 2.1 project_context 把旧项目记录认成新项目

根因：

- 旧实现按相对路径 `AGENTS.md` 和 SHA-1 digest 匹配文件；没有解析官方 baseline identity 中的 `projectRoot`，也没有把目标项目目录与 baseline 的项目根比较。
- `project_dir` 只被当成“要显示的目录”，没有参与“这条 loader 记录属于哪个项目”的判定。
- 旧实现只按 `loadedCount` 和 `truncated/omitted/stale` 算总状态；新出现、从未加载的文件不影响 `instruction_state`。
- 同一 candidate group 内的内容去重没有建模，容易把合法去重误报为缺失。

修改 [project-context.ts](../../packages/computer-use/src/project-context.ts)：

- 解析官方 `baselineIdentity` 的 `projectRoot`，以 Session cwd 解析成绝对项目根（`baseline_project_root`）。
- `project_scope_confirmed` 只在 baseline 项目根与目标 `project_root` 相同、且 baseline 身份有效时为真。
- 每个 candidate 的 loaded 判定同时要求：目标文件绝对路径与 loader 记录 path 解析后的绝对路径相同、digest 存在；不再只比较相对文件名。
- 新 baseline 会重置旧 retained 状态；增量 set/replace/remove 合并到最新 baseline。项目切换不会保留旧项目的 changes。
- `instruction_state` 增加 `unconfirmed`；有未加载的适用文件、omitted、truncated、stale 时为 `partial`；只有全部适用文件已加载且没有已知缺口才为 `loaded`。
- 按官方同一 candidate group（同一目录，或两个 user-global 根）做 **trimmed content SHA-1** 去重；重复文件标 `deduplicated=true`、`duplicate_of`，不再算缺失。
- 新 baseline 没有预算通知时清除旧 `budget_notice`；旧截断/omitted 不再粘在新 baseline 上。
- 目标目录在 Session cwd 之下、其嵌套规则不在已加载链时，标记 `within_session_scope=false` 并返回 `partial`。
- `project_context` 的 schema/render 同步增加 `project_scope_confirmed`、`baseline_project_root`、`deduplicated`、`duplicate_of`、`within_session_scope`、`unconfirmed`。

### 2.2 超时后子进程仍在运行

根因：

- 旧 C# 只 `Process.Kill()` 外层 PowerShell；没有 Windows Job Object，也没有对孙进程做归属控制。
- 输出管道和关闭顺序没有确认；超时摘要可能在子进程继续写日志时写入。

修改 [run-with-evidence.ps1](../../packages/bundle/runtime/run-with-evidence.ps1)：

- 每次执行创建自己的 Windows Job Object；子进程启动后立即 `AssignProcessToJobObject`。
- 超时先对本次 PID 做 `taskkill /PID <pid> /T /F`（按 PID 树，不按进程名），再 `TerminateJobObject`，覆盖 job 赋值竞态漏掉的子进程。
- 正常结束也关闭 job 句柄，避免残留后代继续占用 stdout/stderr 管道。
- 两个输出泵线程 join，检查 `Drained`；随后等待日志长度稳定两次，才计算 SHA-256、写 summary。未 drain 时不把摘要当最终结果，返回工具失败并保留原始日志。
- 不改插件统一取消，不按 node/PowerShell/Electron 名称批量结束。

### 2.3 外部命令失败被记录成 0

根因：

- 旧 runner 只有 `powershell.exe -File command.ps1` 模式。脚本里执行外部程序但不写 `exit $LASTEXITCODE` 时，PowerShell 进程退出 0，runner 就记录 0。
- 不能通过解析任意 PowerShell 文本安全推断外部程序退出码。

修改：

- 新增明确的 native 入口：`-NativeProgram` + `-NativeArgsEnv`（JSON 字符串数组）。
- `.exe` 直接 CreateProcess；`.cmd/.bat` 通过 `cmd.exe /d /s /c`，摘要标 `native-cmd-shim`。
- 脚本模式保留，但摘要明确 `exit_code_scope=powershell-script`，并警告脚本模式不推断 native 退出码；需要真实构建/测试状态时用 native 模式。
- 新增 `command_exit_code`、`shell_exit_code`、`tool_exit_code`、`command_status`、`evidence_status`、`evidence_complete`。

### 2.4 中文日志编码不一致

根因：

- 旧 runner 保留原始 GBK 字节，却在 summary 固定写 `environment.encoding='utf-8'`；旧 reader 固定按 UTF-8 解码。
- 设置父进程 `StandardOutputEncoding` 并不会让 PowerShell 5.1 子进程改变输出编码。

修改：

- runner 自身 JSON stdout 固定 UTF-8；脚本模式的生成脚本开头显式设置子进程 `[Console]::OutputEncoding` 和 `$OutputEncoding` 为 UTF-8。
- native 模式不假设编码；保留原始字节，对每个 log 按 BOM/严格 UTF-8/GB18030/UTF-16 探测，记录 `encoding`、`encoding_source`、`encoding_valid`。
- [read-evidence.ps1](../../packages/bundle/runtime/read-evidence.ps1) 按检测或显式 `-Encoding` 解码 head/tail；未知编码返回 hex，不冒充 UTF-8。
- 中文 path/note/native 参数/日志 path 提供环境变量入口（`-EvidenceRootEnv`、`-NoteEnv`、`-NativeArgsEnv`、`-NativeProgramEnv`、`-LogEnv`、`-SummaryEnv`），避开 PowerShell 5.1 `-File` 的非 ASCII 参数问题。

### 2.5 日志超限仍返回 0

根因：

- 旧实现把 `truncated=true` 写在 summary 里，但仍以命令退出码 0 退出，且 `status` 仍为 `exited_zero`；AGENTS 要求超限返回非零，测试却接受 0。

修改：

- 保留流式 cap、`written_bytes`、`dropped_bytes`、`truncated`。
- 超限时原命令 `exit_code` / `command_exit_code` 保留；`evidence_status='truncated'`、`evidence_complete=false`、`status='exited_zero_evidence_truncated'`（命令本身非零时用 `exited_nonzero_evidence_truncated`）。
- 命令 0 但证据截断时工具返回 **74**；命令本身非零时工具返回原非零码；超时 124；工具内部失败 2。
- 不覆盖上一份有效 summary，不自动清理证据目录。

## 3. 原复现修复前后

| 检查 | 修复前 | 修复后 |
|---|---|---|
| project A 记录、project B 相同 AGENTS | B `instruction_state=loaded`，`loaded=true`，无警告 | B `unconfirmed`，`loaded=false`，警告 baseline 属于 A |
| 新增未加载 CLAUDE.local | `loaded=true`，文件 `loaded:false` | `partial`，文件 `loaded:false` |
| 同内容去重 | 可能报缺失 | `loaded`，CLAUDE.md `deduplicated=true`，`duplicate_of=AGENTS.md` |
| project A 后 project B baseline | 旧 changes 可能残留 | 最新 baseline 重置，B 正确；A 对 B 为 unconfirmed |
| 新 baseline 解除旧 budget notice | 旧 omitted/truncated 可能残留 | 清除，完整加载 |
| timeout 子进程 5 秒后写 marker | marker 存在，child 继续 | marker 不存在，PID gone；summary `timed_out`/124 |
| node `process.exit(7)`，脚本不写 exit | runner 0 / exited_zero | 脚本模式仍 0（明确标 powershell-script）；native 模式 7，command/shell/tool 分别记录 |
| 中文 stdout/stderr | 原始 GBK 字节，summary 称 UTF-8，reader 乱码 | 脚本模式日志 UTF-8；native GBK 探测为 gb18030；reader 返回正确中文 |
| 4098 bytes stdout，cap 1024 | 工具 exit 0，status exited_zero | 工具 exit **74**，`status=exited_zero_evidence_truncated`，`exit_code=0`，`written=1024`，`dropped=3074` |

after 证据：

- `.zcode/evidence/project-review-027.out.json`（同项目 loaded、跨项目 unconfirmed、新规则 partial、去重、预算清除、真实帧跨项目）
- `.zcode/evidence/overflow-review-027/overflow-review.json`（原 overflow 脚本重跑，process_exit 74）
- `.zcode/evidence/runner-review-027/runner-review.json`（原 timeout 脚本重跑，child_continued 为空；child PID gone）
- `.zcode/evidence/runner-review-027/runner-evidence/`（原始日志和 summary）
- `.zcode/evidence/evidence-027.log`（8 个 runner 行为测试）

真实 loader 更新证据（主窗口 standard，cwd `C:\dsh-orb-cordis`）：同一 Session 先有 baseline seq 965（digest `3a8476bb...`），本轮修改 AGENTS 后收到官方 `replace` seq 2853（digest `e37ba66c40dba01020187ea0e893854e36b7815b`）；磁盘 SHA-1 一致。证据 `.zcode/evidence/current-session-027-instructions.json`。

## 4. 测试

- `pnpm run typecheck`：exit 0，日志 `.zcode/evidence/typecheck-027.log`。
- `pnpm build`：exit 0，日志 `.zcode/evidence/build-027.log`。
- `pnpm --filter @dsh-orb/computer-use test`：30 files，**338/338 通过**，日志 `.zcode/evidence/vitest-027.log`。
  - `project-context.spec.ts` 15 条：跨项目、partial、去重、项目切换、预算清除、目标在 cwd 之下、replace/remove、工具输出等。
- `node --test packages/bundle/tests/evidence.test.mjs`：**8/8**，日志 `.zcode/evidence/evidence-027.log`。
- `node --test packages/bundle/tests/*.test.mjs`：12/12（含安装布局 4 条）。
- `pnpm test`：**434 条，433 通过，1 失败**，日志 `.zcode/evidence/full-test-027b.log`。
  - 唯一失败仍是 `packages/host/tests/deferred-install.test.ts:85` 从 npmmirror 安装不存在的 `dsh-orb@0.2.0`，返回 `ERR_PNPM_NO_MATCHING_VERSION`；测试期望假管理器 ok。与本轮改动无关。
  - 根脚本 `&&` 阻止后续 vitest；已单独运行 338/338，不能写作全量通过。
- PowerShell 7：本机未安装 `pwsh`，未实测；所有 runner/reader 结果均为 Windows PowerShell 5.1。

未实测：

- 0.2.7 真实安装、真实 Harness 会话、真实 desktop Profile 规则刷新。
- 真实长构建/测试命令的 timeout；仅用独立 Node 子进程验证。
- 真实 Windows GUI、rightpad、用户单指体验。

## 5. 包

`pnpm --filter dsh-orb run pack` exit 0，日志 `.zcode/evidence/pack-0.2.7.log`。

- 路径：`C:\dsh-orb-cordis\dsh-orb-0.2.7.tgz`
- 版本：0.2.7
- 大小：`24,478,275` bytes
- SHA-256：`5A017A636F9273787FED27B26AA8269567ED7735921C08C6664B2BEE4148DC5C`

包内 `runtime/run-with-evidence.ps1`、`runtime/read-evidence.ps1`、`dist/computer-use/code-agent.js` 的 SHA-256 与当前构建产物一致：

- run: `5DA3071E9F82349773423C103904DBFC1ACE8EFF6992702B3E1BF0F5B9A6F8F0`
- read: `534282BCFA4477B3319856618135819A88FD7189696A6F00A7DA9D0F8F0DDC50`
- code-agent: `1B29D3F47670AE76048B813EE240E241AA8D318802FE487034300E7AE3D0E869`

对照记录：`.zcode/evidence/artifact-review-027.json`，6 个文件全部 `match=true`。旧包 0.2.0–0.2.6 全部保留。

## 6. 试用与恢复

- 在单独 Profile 安装 0.2.7；日常 desktop Profile 本轮未动。
- 先让主窗口 standard 会话读 `AGENTS.md`，再用 `project_context` 检查 `project_scope_confirmed`、`baseline_project_root`、`instruction_state`。
- 用 native 模式跑 `pnpm run typecheck`，确认 `command_exit_code` 与工具 exit 一致。
- 用 `Write-Output` 中文和 `cmd /c echo` 中文各跑一次，确认 summary encoding 与 reader 内容。
- 用 `-MaxLogBytes 1024` 跑超限，确认工具 74 且 command 0、evidence truncated。
- 用独立测试子进程验证 timeout，不接触 rightpad。
- 回滚：官方插件管理器切回 0.2.6/0.2.5；保留 session、证据、旧包，不删目录。
