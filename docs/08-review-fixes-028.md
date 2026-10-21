# 0.2.8 检查问题定向修复

日期：2026-10-20。范围：0.2.7 检查发现的三个问题。未安装到日常 desktop Profile，未操作 rightpad。

> 0.2.8 检查又发现继续后台会话目录、baseline 无目录历史和真实 EOF 损坏三个问题；修复见 [09-review-fixes-029.md](09-review-fixes-029.md)，本轮实现以 0.2.9 为准。

## 1. 现场

- Harness `0.2.1-rc.2`；日常 desktop Profile 仍为 `dsh-orb` 0.2.5；源码本轮从 0.2.7 升到 0.2.8。
- 实际 Shell：Windows PowerShell `5.1.26100.9168`（Desktop）。Node `24.21.0`，pnpm `11.7.0`。PowerShell 7 本机未安装，未实测。
- 0.2.7 检查证据保留在 `C:\Users\zhq\AppData\Local\Temp\orb-027-review-ac38a3d8c1\`。本文件 before 数字来自其中 `review-findings.json` / `edge-review.json` / `cmd-literal-review.json`；after 数字来自 `.zcode/evidence/`。

## 2. 三项问题的根因、行为和修改

### 2.1 .cmd/.bat 参数被 CMD 改写或执行额外命令

根因：

- `native-cmd-shim` 把 JSON 参数拼成 `cmd.exe /d /s /c "... %*"`。`%`、`^`、`"`、`&` 等由 CMD 解释：`%VAR%` 被展开，`^` 被转义，`&echo` 被当成新命令。
- 旧实现只在拼接文本上做有限引用，无法同时保留任意参数，也不会在执行前拒绝。

修改 [run-with-evidence.ps1](../../packages/bundle/runtime/run-with-evidence.ps1)：

- native 模式优先直接启动 `.exe`；参数数组按 Windows CreateProcess 规则逐个引用，不经过 CMD/PowerShell 文本。
- `.cmd/.bat` 默认 **拒绝**，错误信息要求改用 `.exe`（例如 `node.exe` + `pnpm.cjs`），或在明确知道参数安全时使用 `-AllowCmdShim`。
- `-AllowCmdShim` 下仍逐项预检：空参数、非 ASCII、引号、`%`、`^`、`&`、`|`、`<`、`>`、括号、控制字符一律在启动前拒绝；失败返回 2，不启动 shim、不执行任何部分命令。
- 不自动回退到拼接 PowerShell/CMD 文本；没有新增通用 CMD 转义器。

### 2.2 项目切换后仍用 header.cwd

根因：

- `Session.header.cwd` 是不可变的创建目录；实际当前目录由 `workingDirectory` 服务/session projection 维护。
- `project_context` 从未读取该服务，并把旧 baseline 的相对 `projectRoot` 直接按传入的当前目录重新解释；因此旧 A 记录可能被当成 B。
- `code_agent` 新建/继续也优先使用 header，而不是当前工作目录。

修改 [project-context.ts](../../packages/computer-use/src/project-context.ts) 与 [code-agent.ts](../../packages/computer-use/src/code-agent.ts)：

- `project_context` 通过本机实际服务 `ctx.get('workingDirectory').get(session)` 读取当前目录（测试/旧适配器兼容 `current()`）；报告同时给出 `session_cwd`（当前）、`header_cwd`（创建）、`baseline_cwd` 和 `cwd_source`。
- loader baseline 的相对 `projectRoot` 按 **baseline 产生时**的目录解释：跟踪 `working-directory/change` 事件；存在变更后不再用新 cwd 重新解释旧 baseline。
- 没有可靠目录来源时保持 `unconfirmed`；`project_dir` 参数本身不证明会话已切换项目。
- `code_agent` 新建和继续时优先使用 `workingDirectory` 当前目录；用户显式 `cwd` 仍优先，继续时会校验它属于 header/已记录/当前目录之一。任务 `Project scope` 使用实际目录。
- 仍复用官方 loader，不新增规则正文注入器。

### 2.3 长 UTF-8 中文日志被判为 GB18030

根因：

- 编码探测只读前 65536 bytes。90000 bytes 的“大肥鱼”重复在 65536 处截断一个 UTF-8 字符；严格 UTF-8 解码失败后误选 GB18030。
- reader 的 head/tail 也在多字节字符中间截断，且 `encoding_valid=true` 没有说明是采样还是全文件。

修改 [run-with-evidence.ps1](../../packages/bundle/runtime/run-with-evidence.ps1) 与 [read-evidence.ps1](../../packages/bundle/runtime/read-evidence.ps1)：

- 仅在采样为 `sample-prefix` 时允许尾部最多 3 个不完整字节；整文件采样仍严格解码，不静默丢弃错误。
- 每个 log 增加 `encoding_verified`（`whole` / `sample-prefix`）和 `encoding_sample_bytes`；`encoding_valid` 只表示该次检测的采样/边界成功，不冒充整文件已验证。
- reader 对 head 尾部、tail 起始的多字节边界最多调整 3 bytes，返回 `boundary_trimmed_head_bytes` / `boundary_trimmed_tail_bytes`；全部不成立时标 `encoding='unknown'`、`encoding_valid=false`，并返回 hex。
- GB18030/UTF-16/短中文路径、备注、reader 逻辑保持兼容；不修改系统代码页或用户配置。

## 3. 修复前后结果

| 原复现 | 修复前 | 修复后 |
|---|---|---|
| `.cmd` 参数 `%DSH_REVIEW_EXPAND%` | `EXPANDED_BY_CMD`，exit 0 | `.cmd` 默认拒绝，exit 2；无参数改变 |
| `.cmd` 参数 `x^y` / `a"b` / `a"b^c` | `x^y` / `a"b` / `a"bc` | 全部执行前拒绝，exit 2 |
| `.cmd` 参数 `abc"&echo ...&rem xyz` | 额外 stdout `REVIEW_ONLY_UNEXPECTED`，exit 0 | 拒绝，exit 2，marker 不存在，无额外 echo |
| 直接 `.exe` 参数数组 | 正常 | 仍原样：空格、中文、空参数、引号、`^`、`%` 均保留；12/12 evidence tests |
| 本仓库实际 typecheck | 通过 | `node.exe + pnpm.cjs run typecheck` native 入口 exit 0，summary `.zcode/evidence/commands-028-final/20261020-225524-review028-pnpm-typecheck-final/summary.json` |
| header A / 当前 B / loader B | 未读 workingDirectory，报告 A 未确认 | 读服务 1 次，报告当前 B、header A、baseline B，`loaded`；见 `.zcode/evidence/working-directory-review-028/` |
| 当前 B，只有 A 的旧 baseline | 可能按 B 重新解释 | `unconfirmed`；`movedSessionWithOldEvents` 不再 loaded |
| 新增未加载规则 | 总状态可能 loaded | 有可靠当前目录/header 时 `partial`；无 provenance 时 `unconfirmed` |
| 90000-byte 中文 UTF-8 | summary/reader `gb18030`，预览乱码 | `utf-8`、`sample-prefix`，reader head/tail 正确中文 |
| 4-byte head / 4-byte tail 边界 | 可能乱码/编码无效 | `utf-8`、valid，head `大`、tail `鱼`，边界各裁 1 byte |
| 无效字节流 | 可能伪装成功 | `unknown`、`encoding_valid=false`、hex 预览 |

说明：原 `review.mjs` 的两个直接函数调用没有 header/baseline cwd（`movedSessionWithOldEvents`、`missingRules`），现在都按保守契约返回 `unconfirmed`；`missingRules` 的 `partial` 由带可靠目录来源的单元测试和工具路径验证。不能从一份没有目录来源的 baseline 推断“新增规则属于当前项目”。

## 4. 验证

- `pnpm run typecheck`：exit 0，`.zcode/evidence/typecheck-028.log`。
- `pnpm build`：exit 0，`.zcode/evidence/build-028.log`。
- `pnpm --filter @dsh-orb/computer-use test`：**343/343**，`.zcode/evidence/vitest-028.log`。
  - project-context 19 条（含当前目录 B、旧 A baseline、无 provenance、partial、去重、预算、replace/remove）。
  - code-agent 36 条（含新建/继续使用 workingDirectory B）。
- `node --test packages/bundle/tests/*.test.mjs`：**16/16**（evidence 12 + install 4），`.zcode/evidence/bundle-028.log`。
  - 新增 `.cmd` 拒绝/安全参数、直接参数原样、长 UTF-8、边界、无效编码测试。
- `pnpm test`：**438 条，437 通过，1 失败**，`.zcode/evidence/full-test-028.log`。
  - 唯一失败仍是 `deferred-install.test.ts:85` 从 npmmirror 安装不存在的 `dsh-orb@0.2.0`，`ERR_PNPM_NO_MATCHING_VERSION`；既有夹具/网络问题，不用来凑全绿。
- 实际 pnpm typecheck native 入口：exit 0，summary 5,397 bytes，status `exited_zero`，`command_exit_code=0`，`shell_exit_code=null`。
- 原 `edge-review.mjs` 重跑：`.zcode/evidence/edge-review-028/`；cmd 四个特殊输入均 exit 2，无 marker；长 UTF-8 summary/reader utf-8。
- 原 `cmd-literal` 输入：`.zcode/evidence/cmd-literal-028c/`；exit 2、marker false、unexpected_echo false；安全 ASCII `.cmd` + `-AllowCmdShim` 仍返回原参数。

未实测：0.2.8 真实安装/Harness 会话、真实 GUI、rightpad、用户单指体验；PowerShell 7。

## 5. 包

`pnpm --filter dsh-orb run pack` exit 0，`.zcode/evidence/pack-0.2.8.log`：

- 路径：`C:\dsh-orb-cordis\dsh-orb-0.2.8.tgz`
- 版本：0.2.8
- 大小：**24,480,230** bytes
- SHA-256：**7BF5A08EA48E0BEED78F0C78FC0F7BC9EE7A360C9981EAE6C0E8A2FC6C0D9A74**

包内关键文件与最终构建一致（`.zcode/evidence/artifact-review-028.json`，6/6 match）：

- run: `07BE124B466D0F22C5CF3FD2B9D72506988517365CBF2CB2718165A477B90D01`
- read: `D2900845660B914ECFFB61FA43EFC98AE6EFB547823207718AC5A69E546C2AFA`
- code-agent: `B438CF6C20F55DDEF6291108151B6C32D860EFC4CD1F51BF0DF38D5D4899ABA4`

旧包 0.2.0–0.2.7 全部保留。

## 6. 试用与恢复

- 单独 Profile 安装 0.2.8；日常 desktop Profile 本轮未动。
- 先确认 `project_context` 的 `session_cwd`/`header_cwd`/`baseline_cwd`/`cwd_source`；项目切换后重新调用。
- 构建/测试用 `node.exe + pnpm.cjs` native 入口，不用 `.cmd`；确需 `.cmd` 时只传安全 ASCII 并显式 `-AllowCmdShim`。
- 中文长日志用 reader 检查 `encoding_verified` 与边界字段；不把 sample-prefix 说成整文件已验证。
- 回滚：官方插件管理器切回 0.2.7/0.2.6/0.2.5；保留 session、旧包、日志和证据，不删目录。
