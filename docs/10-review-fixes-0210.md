# 0.2.10 编码边界修复

日期：2026-10-20。范围：0.2.9 检查发现的两个编码边界问题。未安装到日常 desktop Profile，未操作 rightpad。

## 1. 现场与原始证据

- Harness `0.2.1-rc.2`；日常 desktop Profile 仍为 `dsh-orb` 0.2.5；源码/包从 0.2.9 升到 0.2.10。
- 实际 Shell：Windows PowerShell `5.1.26100.9168`（Desktop），Node `24.21.0`，pnpm `11.7.0`。PowerShell 7 未安装，未实测。
- 原始检查证据：`C:\Users\zhq\AppData\Local\Temp\orb-029-review-1b7289c8f2\`，未覆盖。
- 修复后证据：`.zcode/evidence/encoding-edge-0210-final/`、`.zcode/evidence/review-0210/`、`.zcode/evidence/bundle-0210.log`。

## 2. 两个问题的根因和最终行为

### 2.1 非法 UTF-8 前缀被当作合法采样截断

根因：

- `Get-Utf8IncompleteTail` 只检查“最后一个字节是不是连续字节、前面是不是一个起始字节”，没有验证这个前缀本身是否合法。
- `E0 80` 中 `E0` 后第二字节必须在 `A0–BF`，`80` 非法；旧实现仍把 `E0 80` 整体裁掉，UTF-8 严格解码通过，返回 `valid=true`。

最终行为（[read-evidence.ps1](../../packages/bundle/runtime/read-evidence.ps1)、[run-with-evidence.ps1](../../packages/bundle/runtime/run-with-evidence.ps1)）：

- `Test-Utf8Continuation` 按起始字节验证已有连续字节：
  - `E0` 后第一字节 `A0–BF`；
  - `ED` 后第一字节 `80–9F`；
  - `F0` 后第一字节 `90–BF`；
  - `F4` 后第一字节 `80–8F`；
  - 其余连续字节 `80–BF`。
- 只有已经出现的前缀合法、且只是缺少后续字节时，才返回“可裁掉的不完整字符数”。
- 已有非法前缀返回 0，不裁切；BOM 正文严格验证失败，`encoding_valid=false`，保留 `head_hex`。
- `sample-prefix` 仍只表示采样前缀，不表示整文件已验证。

### 2.2 有效 UTF-16 代理对被采样边界误判无效

根因：

- UTF-16 边界只处理“奇数字节”，没有处理“采样/预览末尾是合法高代理码元，低代理码元在边界之后”。
- 严格解码把高代理当作孤立码元，返回 `encoding_valid=false`。

最终行为：

- 新增 UTF-16 码元读取和高/低代理判断。
- BOM 后的采样前缀若在偶数边界结束于高代理码元，只裁掉该 2-byte 码元后再严格验证；前面的正文仍必须完整合法。
- 奇数字节 + 前面高代理的组合，裁掉“半个码元 + 高代理”（3 bytes）后再严格验证。
- head 预览切在代理对中间时裁 2 bytes；tail 预览从低代理开始时，只有前一码元确实为高代理才跳过 2 bytes。
- 真实 EOF 的孤立高/低代理、奇数字节、正文损坏仍判无效，不因“在边界附近”而放行。
- UTF-16LE 和 UTF-16BE 都使用同一套码元逻辑；runner 只做采样检测，reader 同时处理 head/tail。

## 3. 原样例修正前后字段对照

| 样例 | 修复前 | 修复后 |
|---|---|---|
| BOM + 65531×`a` + `E0 80 80` + 5000×`a`，65536 采样末尾 `E0 80` | reader/runner `utf-8`、`sample-prefix`、`valid=true` | reader/runner `utf-8`、`sample-prefix`、`valid=false`；无裁切；保留 hex |
| 同一文件，head 预览落在 `E0 80` | 可能靠裁切通过 | `valid=false`，`boundary_trimmed_head_bytes=0`，`head_bytes=105`，hex 保留 |
| 有效 UTF-16LE BOM，高代理在第 65534–65535 字节，低代理在采样后 | reader `valid=false` | reader/runner `utf-16le`、`sample-prefix`、`valid=true` |
| UTF-16BE 同样采样切分 | 未覆盖 | `valid=true` |
| UTF-16LE 预览 head 切在代理对中间、tail 从低代理开始 | 可能 invalid | head `a`、tail `b`，各裁 2，`valid=true` |
| UTF-16BE 同样预览 | 未覆盖 | 同样 head `a`、tail `b`，`valid=true` |
| UTF-16 真实 EOF 孤立高代理 | 可能靠边界通过 | `valid=false`，trim 0，hex `fffe61003dd8` |
| 7-byte `BOM+abc+FF` | `valid=true`、head `abc`、trim 1 | `valid=false`、head `abc�`、trim 0、`head_hex=efbbbf616263ff` |
| 90000-byte 中文 UTF-8 | utf-8 sample-prefix | 仍 utf-8，head/tail 边界正确 |
| 短中文/GB18030/中文路径和备注 | 通过 | 继续通过 |

原始 `encoding-edge-review.json` 的 before：`invalid_sample_reader.encoding_valid=true`、`invalid_sample_runner.encoding_valid=true`、`valid_utf16_reader.encoding_valid=false`。
修复后 `.zcode/evidence/encoding-edge-0210-final/encoding-edge-review.json`：对应字段为 `false`、`false`、`true`，且 invalid 的 `boundary_trimmed_*` 为 0、保留原始字节。

## 4. 测试与证据

| 项目 | 结果 |
|---|---|
| `pnpm run typecheck` | exit 0，`.zcode/evidence/typecheck-0210.log` |
| `pnpm build` | exit 0，`.zcode/evidence/build-0210.log` |
| `pnpm --filter @dsh-orb/computer-use test` | **346/346**，30 files，`.zcode/evidence/vitest-0210.log` |
| bundle tests | **23/23**（evidence 19 + install 4），`.zcode/evidence/bundle-0210.log` |
| `pnpm test` | **445 total / 444 pass / 1 fail**，`.zcode/evidence/full-test-0210.log` |

新增/扩展 evidence 行为断言：

- 非法 UTF-8 前缀在 65536 采样边界：reader 和 runner 都 `valid=false`；
- 非法前缀在预览边缘：不裁切、hex 保留；
- 有效 UTF-16LE/BE 代理对跨采样边界：reader 和 runner `valid=true`；
- UTF-16LE/BE head/tail 代理对边界：正确预览；
- UTF-16 真实 EOF 孤立代理：`valid=false`；
- 原 7-byte 损坏 EOF、90000-byte 中文、GB18030、短中文继续通过。

唯一失败仍是既有 `deferred-install.test.ts:85`：从 npmmirror 安装不存在的 `dsh-orb@0.2.0`，`ERR_PNPM_NO_MATCHING_VERSION`；与本轮无关，未修改无关夹具。

保留行为：后台会话实际目录契约、baseline 事件来源、`.cmd` 默认拒绝、`.exe` 参数原样、native 退出码、超时进程树、超限 74、原始日志、summary 限制、中文路径/备注、剪贴板/布局/submissionId/超时恢复。均有既有测试或本轮回归证据。

未实测：0.2.10 真实安装、真实 Harness 会话、真实 GUI/rightpad、用户单指体验、PowerShell 7。

## 5. 包

`pnpm --filter dsh-orb run pack` exit 0，`.zcode/evidence/pack-0.2.10.log`：

- 路径：`C:\dsh-orb-cordis\dsh-orb-0.2.10.tgz`
- 版本：0.2.10
- 大小：**24,484,545** bytes
- SHA-256：**2A98E8D43015ECE7D2701735543812A4B4BA631C47D2CE4924ABC22C36723138**

包内关键资源与最终构建 6/6 一致（`.zcode/evidence/artifact-review-0210.json`）：

- run: `222E28189880A103E38D53239E4F8535D181C4B1BAF832DCCFF3AAAAEA777379`
- read: `A35A1A610DEFC82C73B63FC633565A6A96256010775196473FF84B9FB7F31F38`
- code-agent: `1B8E302807CA98E7B50DAA69141F5D7B41DD0AC43A8BA4A6C156F543A6035496`

旧包 0.2.0–0.2.9 全部保留。

## 6. 试用与恢复

- 在独立 Profile 安装 0.2.10；日常 Profile 本轮未动。
- 编码诊断先看 `encoding_valid` 与 `encoding_verified`：`sample-prefix` 只表示已检查前缀，不等于整文件验证。
- `boundary_trimmed_*` 非 0 只应在预览切在合法字符内部时出现；真实 EOF 的损坏应为 0 并保留 hex。
- 回滚：官方插件管理器切回 0.2.9/0.2.8/0.2.7/0.2.5；保留 session、旧包、日志和证据。
