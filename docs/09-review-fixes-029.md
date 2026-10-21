# 0.2.9 成果检查剩余问题修复

日期：2026-10-20。范围：0.2.8 检查发现的三个问题。未安装到日常 desktop Profile，未操作 rightpad。

> 0.2.9 检查又发现非法 UTF-8 采样前缀和 UTF-16 代理对采样边界两个问题；修复见 [10-review-fixes-0210.md](10-review-fixes-0210.md)，本轮编码行为以 0.2.10 为准。

## 1. 现场与证据

- Harness `0.2.1-rc.2`；日常 desktop Profile 仍为 `dsh-orb` 0.2.5；源码/包从 0.2.8 升到 0.2.9。
- 实际 Shell：Windows PowerShell `5.1.26100.9168`（Desktop），Node `24.21.0`，pnpm `11.7.0`。PowerShell 7 未安装，未实测。
- 0.2.8 原始检查证据：`C:\Users\zhq\AppData\Local\Temp\orb-028-review-1c40dc533e\`，未覆盖。
- 本轮修复后证据在 `.zcode/evidence/`；原始 `review.mjs` 和 `continue-review.mjs` 被复制到新目录运行。

## 2. 三项问题的根因、最终契约和修改

### 2.1 继续后台会话时声明目录与实际目录不同

根因：

- 继续 `session_id` 时，显式 `cwd` 只与 `header.cwd`、历史登记目录 `known.cwd`、live 目录做“任一匹配”校验。
- 创建目录 A 会匹配历史，即使实际 live 当前目录已是 B；随后 `Project scope: A` 入队，实际会话仍在 B。
- 原实现没有使用当前目录核对，也没有区分 live 与 cold 会话的目录来源。

最终契约（[code-agent.ts](../../packages/computer-use/src/code-agent.ts)）：

- 继续已有会话时，当前目录只取实际来源：
  - live Session：`workingDirectory.get(session)`；
  - live 事件不可用时：该 Session 的 `snapshotEvents()` 中 `working-directory/change`；
  - cold Session：`sessionController.inspect()` 返回的完整 `events` 中 `working-directory/change`。
- 创建目录 `header.cwd` 只作为事件序列起点，不是已验证的当前目录；没有事件来源时拒绝继续，不回退创建/历史目录。
- 显式 `cwd` 必须与当前目录一致（Windows 路径按 `resolve` 比较）；不一致立即抛错，不调用 `prompt`，不改 `workingDirectory`。
- 不自动调用 `workingDirectory.set`，不改变运行中后台会话目录。
- 不传 `cwd` 时使用实际当前目录，并用它生成 `Project scope`。
- 保留 caller 归属、`standard` preset、子代理拒绝等既有校验。

修改：`packages/computer-use/src/code-agent.ts`、`packages/computer-use/tests/code-agent.spec.ts`。

### 2.2 缺少目录历史时旧 baseline 被当前 cwd 重新赋项目

根因：

- `project_context` 曾把 `input.baselineCwd`（工具传入的当前服务目录）作为 baseline 来源的 fallback。
- 当 header A、当前 B、历史只有旧 baseline，且没有 `working-directory/change` 时，fallback 把 baseline 解释成 B，返回 loaded。

最终契约（[project-context.ts](../../packages/computer-use/src/project-context.ts)）：

- baseline 的目录来源只由真实事件顺序决定：header 起点 + baseline 之前的 `working-directory/change`。
- 删除 `input.baselineCwd` 回退；当前目录服务只用于报告 `session_cwd`/`cwd_source`，不能给旧 baseline 赋项目身份。
- 没有 baseline 目录来源返回 `unconfirmed`/pending，不猜测。
- 保留 A baseline 后切 B、B baseline、A/B 同内容、新增规则、去重、更新/移除、预算通知清除等逻辑。
- 不新增规则正文注入器。

修改：`packages/computer-use/src/project-context.ts`、`packages/computer-use/tests/project-context.spec.ts`。

### 2.3 真实 EOF 损坏被当作预览边界裁切

根因：

- `Detect-Encoding` 看到 UTF-8 BOM 就直接返回 `valid=true`，没有验证 BOM 后的正文。
- `Decode-Boundary` 无论预览是否在文件内部，都尝试裁掉 1–3 bytes；7-byte `BOM+abc+FF` 把 FF 当“半个字符”删掉，得到 `abc` 且 valid=true。

最终契约（[read-evidence.ps1](../../packages/bundle/runtime/read-evidence.ps1)、[run-with-evidence.ps1](../../packages/bundle/runtime/run-with-evidence.ps1)）：

- BOM 只作为编码提示；BOM 后正文仍严格验证。BOM 文件正文损坏时保留 `encoding=utf-8`/`source=detected-bom`，但 `encoding_valid=false`。
- 只有预览范围确实切在文件内部（head 未到 EOF、tail 未到文件开头）才允许边界调整；真实 EOF/BOF 不裁字节。
- 裁切只处理合法的 UTF-8 多字节字符不完整前缀，以及 UTF-16 的奇数边界；非法字节 `FF` 不因“删几个直到通过”而被隐藏。
- 无法确定时保留原始字节，返回 `encoding_valid=false`、`head_hex`；不静默替换。
- runner 与 reader 使用相同的 BOM 正文验证和合法的采样边界规则。

修改：`packages/bundle/runtime/run-with-evidence.ps1`、`packages/bundle/runtime/read-evidence.ps1`、`packages/bundle/tests/evidence.test.mjs`。

## 3. 原复现与修复后结果

| 原复现 | 修复前 | 修复后 |
|---|---|---|
| 创建 A、live 当前 B、继续显式 A | 接受，scope A，prompt 增加，实际 B，set 0 | 明确拒绝；prompts 1→1；set 0；错误说明 A≠B 且未改变会话 |
| 创建 A、当前 B、继续显式 B | 未覆盖 | 接受，scope B，实际 B |
| 创建 A、当前 B、继续不传 cwd | 未覆盖 | 接受，scope B |
| cold 会话 events 显示 B，显式 A | 未覆盖 | 拒绝，不排队 |
| cold 会话 events 显示 B，显式 B/不传 | 未覆盖 | 接受，scope B |
| 其它 caller 的后台会话 | 拒绝 | 仍拒绝 |
| header A、当前 B、只有 A baseline，无 change | loaded B，confirmed | unconfirmed，baseline A |
| A baseline 后切 B，尚无 B baseline | 可能 loaded | unconfirmed |
| 切 B 后新 B baseline | 可能 loaded | loaded B，confirmed |
| 7-byte BOM+abc+FF | valid=true，head abc，trim 1，truncated=true | valid=false，head `abc�`，trim 0，head_bytes=7，hex `efbbbf616263ff` |
| UTF-16 BOM + 不完整 EOF | 未覆盖 | valid=false，无边界裁切 |
| 90000-byte UTF-8 | utf-8 sample-prefix | 仍 utf-8，head/tail 边界正确 |
| 非法字节靠近预览边缘 | 可能靠裁切通过 | 不裁切，valid=false，保留 hex |

对应证据：

- `.zcode/evidence/continue-contract-029c/continue-contract.json`
- `.zcode/evidence/continue-review-029/continue-review.json`
- `.zcode/evidence/review-029b/review.json`
- `.zcode/evidence/bundle-029.log`

## 4. 后台任务入队目录证据

`continue-contract-029c`：

- `current_target_cwd` 为 B；
- 显式 A：`rejected.is_error=true`，`prompts_before=1`、`prompts_after=1`，`working_directory_set_calls=0`；
- 显式 B：`accepted_b.queued_scope = Project scope: B`，`prompt_count=2`；
- 不传 cwd：`implicit_b.queued_scope = Project scope: B`，`prompt_count=3`；
- 错误文本明确 `cwd A does not match the current directory B ... session was not changed`。

cold 会话由单元测试覆盖：`inspect().events` 含 `working-directory/change B` 时显式 A 拒绝、显式 B/不传接受。

## 5. baseline 来源充分/不足

- 不足：`review-029b.project.missing_change_event` 为 `unconfirmed`，`baseline_cwd=A`，target B 未确认；`old_baseline_with_change` 同样 `unconfirmed`。
- 充分：`new_baseline_with_change` 为 `loaded`，`baseline_cwd=B`，`confirmed=true`。
- `review-029b` 保留原 A/B 同内容样例；未因内容相同放宽。
- 单元测试 20 条覆盖：初始 A、A baseline 后切 B、B baseline、无 change、partial、dedupe、更新/移除、预算通知清除。

## 6. 真实 EOF 与正常边界

- 原 7-byte 文件：`encoding=utf-8`、`source=detected-bom`、`encoding_verified=whole`、`encoding_valid=false`、`boundary_trimmed_head_bytes=0`、`head_bytes=7`、`truncated=false`、`head_hex=efbbbf616263ff`。
- 同一文件内部预览 `HeadBytes=7`（有后续字节）也不裁 FF，valid=false。
- UTF-16LE BOM + 奇数末尾：valid=false，边界 trim 0，保留 hex。
- 有效 90000-byte UTF-8：`utf-8/sample-prefix`，head `大`、tail `鱼`，边界各 1；正常合法多字节裁切仍工作。
- 短中文、GB18030、中文路径/备注继续通过；PowerShell 5.1 实测，PowerShell 7 未实测。

## 7. 测试、日志、失败项

| 项目 | 结果 |
|---|---|
| `pnpm run typecheck` | exit 0，`.zcode/evidence/typecheck-029.log` |
| `pnpm build` | exit 0，`.zcode/evidence/build-029.log` |
| `pnpm --filter @dsh-orb/computer-use test` | **346/346**，30 files，`.zcode/evidence/vitest-029.log` |
| bundle tests | **19/19**（evidence 15 + install 4），`.zcode/evidence/bundle-029.log` |
| `pnpm test` | **441 total / 440 pass / 1 fail**，`.zcode/evidence/full-test-029.log` |

唯一失败仍是既有 `deferred-install.test.ts:85`：从 npmmirror 安装不存在的 `dsh-orb@0.2.0`，`ERR_PNPM_NO_MATCHING_VERSION`；与本轮无关，未修改无关夹具。

保留的既有修正（均有测试/证据）：`.cmd` 默认拒绝及安全 ASCII 例外、`.exe` 参数原样、native 7、超限 74/command 0/evidence incomplete、timeout 无迟到写入、长中文 UTF-8、剪贴板、发送/停止分离、多行几何、submissionId、超时恢复。

未实测：0.2.9 真实安装、真实 Harness 会话、真实 GUI/rightpad、用户单指体验、PowerShell 7。

## 8. 包

`pnpm --filter dsh-orb run pack` exit 0，`.zcode/evidence/pack-0.2.9.log`：

- 路径：`C:\dsh-orb-cordis\dsh-orb-0.2.9.tgz`
- 版本：0.2.9
- 大小：**24,483,131** bytes
- SHA-256：**326B20F7E982B9CC2FF2C5416616FAF98C8D5C58B24656E9225D24C9EA161208**

包内关键资源与最终构建 6/6 一致（`.zcode/evidence/artifact-review-029.json`）：

- run: `69EAF8061A27DD7E859A63A8C507D4BD23B79249F8DC14AD31C52E5136E00657`
- read: `D9E29D0F50E8EC9E23E4A664559DE41C684CC674EFE6765DD5B6255AF71A22B2`
- code-agent: `1B8E302807CA98E7B50DAA69141F5D7B41DD0AC43A8BA4A6C156F543A6035496`

旧包 0.2.0–0.2.8 全部保留。

## 9. 试用与恢复

- 在独立 Profile 安装 0.2.9；日常 Profile 本轮未动。
- 继续后台会话：先看实际目录，显式 cwd 只传当前目录；不一致应拒绝而不是排队。
- `project_context`：项目切换后确认 `baseline_cwd` 来自新的 `working-directory/change` + baseline，而不是当前目录兜底。
- reader：真实 EOF 损坏应 `encoding_valid=false` 且有 hex；`encoding_verified=whole` 不等于正文有效。
- 回滚：官方插件管理器切回 0.2.8/0.2.7/0.2.6/0.2.5；保留 session、旧包、日志和证据。
