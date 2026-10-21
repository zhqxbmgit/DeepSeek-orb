# 0.2.10 独立 Profile 真实接入验证

日期：2026-10-21。范围：安装、激活、规则加载、后台目录、证据工具、停止范围。未修改源码，未安装到日常 desktop Profile。

## 1. 隔离与实际安装

- 独立 Harness home：`C:\dsh-orb-cordis\.zcode\verify-0.2.10-home`
- 独立 Profile：`orb-verify-0.2.10-20261021`
- 测试 Profile 路径：`C:\dsh-orb-cordis\.zcode\verify-0.2.10-home\profiles\orb-verify-0.2.10-20261021`
- 测试 web 端口：`61810`；测试实例已关闭，端口已释放。

隔离措施：

- 使用独立 `DSH_HOME`，因此 sessions、storages、`dsh-orb/floating-session.json`、helper-data、native 和 Profile 都在测试 home 下。
- 只从日常 home 复制 `.credentials.yaml` 到测试 home（未输出内容），用于模型访问；日常源文件未修改。
- 新建 Profile 使用 `--from-default-profile web` 初始化 base + web-app，再用官方 `dsh plugin --profile ... add` 安装本地 0.2.10 包。
- 测试 B workspace 条目是在测试实例停止时写入测试 home 的 `storages\workspace.json`，仅用于构造 B 测试项目；随后通过 UI workspace 选择 B。不是日常数据。

安装结果：

- 测试 Profile `package.json`：`dsh-orb` 依赖为 `file:C:/dsh-orb-cordis/dsh-orb-0.2.10.tgz`，bundles 为 `base`、`web-app`、`dsh-orb`。
- 实际安装包版本：`0.2.10`。
- 安装包：`C:\dsh-orb-cordis\dsh-orb-0.2.10.tgz`，24,484,545 bytes，SHA-256 `2A98E8D43015ECE7D2701735543812A4B4BA631C47D2CE4924ABC22C36723138`（本轮未重新打包）。
- 测试 Host 日志：`dsh-orb: version 0.2.10`，并启动 `helper socket 127.0.0.1:59644`。
- 安装的 `runtime/run-with-evidence.ps1`、`runtime/read-evidence.ps1`、`dist/computer-use/code-agent.js` 的 SHA-256 与 0.2.10 包/最终构建一致：
  - run `222E28189880A103E38D53239E4F8535D181C4B1BAF832DCCFF3AAAAEA777379`
  - read `A35A1A610DEFC82C73B63FC633565A6A96256010775196473FF84B9FB7F31F38`
  - code-agent `1B8E302807CA98E7B50DAA69141F5D7B41DD0AC43A8BA4A6C156F543A6035496`

日常 Profile 未被替换：

- 版本仍为 `0.2.5`。
- `package.json` SHA-256：`10D40255AE7EDD58D8884CF8CA3B2A6F80F0C47154BD83B64ABF8297FC2E3FBF`
- `cordis.patch.yml` SHA-256：`6C445B45432F648B5F9BFE196C686D89EEF283E7DBA73A062BB3FF63589E787D`
- `pnpm-lock.yaml` SHA-256：`4365CE2AB128D62FF58B16241915AEDBD91B16C7C5FD471C014218799342E671`
- 日常主进程 `19688` 仍在运行；未重启、未结束日常 Harness。

## 2. 真实模型与规则验证

### 2.1 主窗口 Computer Use，项目 A

- 项目 A：`...\verify-0.2.10-home\dsh_orb`，有 `.git` 和 `AGENTS.md`，规则要求最终答案追加 `[ORB-A]`。
- 真实会话：`session-8da43292-3494-4219-b958-cfd7a7c953e8`，header cwd A，preset computer-use。
- 模型被要求调用 `project_context`，但没有在任务里透露 marker。
- 实际 `project_context` 工具结果：`project_dir=A`，`baseline_cwd=A`，`Cwd source: service`。
- 模型最终答案自动包含 `[ORB-A]`，并创建 `proof-a.txt`（5 bytes，`hello`）。
- 重要异常：第一次 A 的 `AGENTS.md` 是带 UTF-8 BOM 的文件（72 bytes），loader digest 为 `4fbf2c1b0919d1ee85297a7035b06335a01624ed`，而插件按原始字节计算的 SHA-1 为 `2f137616ad28070e0010c8023a55cd4476f05249`，因此 `project_context` 报 `partial`/`STALE`。改写为无 BOM 的 68-byte 文件后，digest `e6e653af8862c903d675ae0c79d5cd4b62d8928a`，下一次请求变为 `loaded`，marker 仍为 `[ORB-A]`。
- 结论：规则正文确实自动加载（模型推理明确写出“Also append [ORB-A]”，最终答案也带 marker）；但 BOM 文件的 loader digest 与插件 raw SHA-1 不一致，是 `project_context` 的新缺陷，本轮未改源码。

### 2.2 主窗口 Computer Use，项目 B

- 项目 B：`...\verify-0.2.10-home\project-b`，有 `.git`、`AGENTS.md`，marker `[ORB-B]`。
- 通过 UI workspace 选择 B，创建新的 Computer Use 会话：`session-a39fe7d5-964e-4f8a-9ffa-9d3155a7d379`，header cwd B。
- 实际工具结果：`project_dir=B`、`baseline_cwd=B`、`session_cwd=B`、state `loaded`、scope confirmed true、AGENTS.md 68 bytes。
- 模型最终答案包含 `[ORB-B]`；`proof-b-main.txt` 为 12 bytes `hello-b-main`，无 BOM、无换行。
- UI 截图：`.zcode\evidence\verify-0210-b-main.png`；文本：`.zcode\evidence\verify-0210-b-main.txt`。

### 2.3 同会话工作目录切换与旧 baseline

- 在 B 会话中调用官方 `working_directory` 工具切换到 A；session log 有 `working-directory/change` seq 75。
- 紧随其后的 `project_context` **实际工具结果**：
  - `Current cwd: A`
  - `Session header cwd: B`
  - `Loader baseline cwd: B`
  - `state: unconfirmed`，`project scope confirmed: false`
  - 警告：当前目录 A 与 header B 不同，loader 仍属于 B。
- 这是正确的“短暂未确认”状态，未把 B 的旧 baseline 赋给 A。
- 注意：模型最终文字错误地重复了上一轮的 `session_cwd: B`；本报告以 session 事件中的 tool result 为准，不以模型声称的字段为准。随后下一轮模型未再次调用 project_context，因此切到 A 后的新 A baseline 未在真实会话中继续观察到。

### 2.4 code_agent 后台 standard 会话

- 主 A 会话创建后台会话 `session-cd5e0173-bcd1-475c-a124-1fdb091c2f51`，header cwd A，preset standard。
- loader 事件 seq 13：`AGENTS.md` digest `e6e653af...`，baseline identity `projectRoot:""`。
- 后台最终答案包含 `[ORB-A]`；创建 `proof-code.txt` 10 bytes `hello-code`，验证命令 exit 0。
- 主 B 会话创建后台会话 `session-247f9a69-3ddf-4f25-947b-6ce1394cea8a`，header cwd B，preset standard。
- loader 事件 seq 10：`AGENTS.md` digest `d9bc9e7d...`，最终答案包含 `[ORB-B]`；创建 `proof-b.txt` 7 bytes `hello-b`。
- 在 B 后台会话上显式继续旧 A 目录：工具返回
  `code_agent cwd "A" does not match the current directory "B" ... the session was not changed`；
  没有新 prompt，B 后台任务继续完成。
- 这说明显式旧目录不会改变运行中的后台会话，也不会被误认为当前目录。

### 2.5 悬浮球 / helper

- 测试 Host 启动后多次报告：
  `helper started pid ...`
  `helper exited (2147483651); retry N`
- 实际 `verify-0210-web.err.log` / `verify-0210-web2.err.log` 可复现。
- 手工直接用测试 helper 的 Electron 加 `--no-sandbox` 可以启动并输出 `dsh-orb helper: ball ...`（`verify-0210-helper-manual2.err.log`、`verify-0210-helper-nosandbox...`）；只加 `--disable-gpu` 仍退出。
- 因此：悬浮球路径**未完成真实模型验证**；当前测试环境需要 `--no-sandbox`，而安装的 Host 启动参数未包含它。这是环境/启动参数缺陷，未修改源码。主窗口 Computer Use（web）可用。

## 3. 证据工具（实际安装路径）

使用测试 Profile 内安装的：
`...\node_modules\dsh-orb\runtime\run-with-evidence.ps1`

| 任务 | 工具 exit | command exit | evidence | 结果 |
|---|---|---|---|---|
| 正常命令 | 0 | 0 | complete | stdout 11 bytes、stderr 12 bytes，UTF-8 whole |
| native `process.exit(7)` | 7 | 7 | complete | shell null |
| 4098-byte stdout，上限 1024 | **74** | **0** | truncated，complete false | written 1024 |
| 60s sleep，timeout 1s | **124** | 124 | timed_out，complete false | 延迟 marker 未出现 |

补充：

- stdout/stderr 分别保存；summary 字段与实际行为一致。
- 中文 EvidenceRoot `...\正常` 和中文 note `正常证据` 保存正确；reader 通过 `-LogEnv` 读取 UTF-8 内容成功。
- reader 返回 `encoding=utf-8`、`encoding_verified=whole`、`encoding_valid=true`。
- 证据路径：`.zcode\evidence\verify-0210-evidence\`。

## 4. 停止范围审计

- 发送 60 秒 `Start-Sleep` 任务，然后点击 UI“停止生成”：
  - UI 显示“已停止”；
  - session `turn/end` 为 `{kind:"aborted", reason:{kind:"user"}}`；
  - 对应 tool result 为 `AbortError / tool call aborted`；
  - 60 秒命令没有产生完成文件。
- 在运行中提交的后续请求被写入 session 的 `agent/inbox/spliced` `next-turn`（seq 122），但 turn 7 abort 后没有自动开始新 turn；UI 仍把它留在输入区。测试实例随后关闭。
- 因此“停止当前 turn 已生效”有证据；**同会话已排队消息是否继续未得到确认，观察结果偏向未继续**，需要后续单独定位。
- `code_agent_stop` 未在本轮真实会话中执行；独立后台任务在 stop 前已完成，未验证“停止主 turn 后后台继续”及 `code_agent_stop` 对排队工作的效果。列为未完成。
- 日常 Harness 未按进程名批量结束；只结束了本轮测试 Host/Chrome 的明确 PID。

## 5. 未通过 / 未完成

- 悬浮球 Computer Use 真实模型路径：helper 在当前测试环境退出 2147483651；手工加 `--no-sandbox` 可启动，但 Host 未使用该参数，未完成真实连接。
- 主 B→A 切换后的新 A baseline：已观察到切换后 `unconfirmed`，但下一轮模型未再次调用工具，未观察到 A 的新 baseline loaded。
- 同会话排队消息继续：未确认，疑似未继续。
- `code_agent_stop`、主 turn 停止后独立后台继续：未测试。
- 用户单指体验 / rightpad / 真实 GUI 鼠标操作：未测试；本轮没有操作 rightpad、Receiver、Android、HID、键盘软件。
- 0.2.10 未安装到日常 Profile。

## 5.1 现有自动化

- `pnpm run typecheck`：exit 0，`.zcode/evidence/typecheck-0210-verify.log`。
- `pnpm test`：445 total / 444 pass / 1 fail，`.zcode/evidence/full-test-0210-verify.log`；唯一失败仍是既有 `deferred-install` 夹具（npmmirror 无 `dsh-orb@0.2.0`）。
- 本轮未修改源码或重新打包；安装包仍是交付的 0.2.10。

## 6. 最终状态与证据路径

- 测试 Host、测试 Chrome 已关闭；端口 61810 已释放；测试 Profile、测试项目和证据保留。
- 日常 Profile 0.2.5 和主进程 19688 仍在，配置哈希未变。
- 测试 Profile：`C:\dsh-orb-cordis\.zcode\verify-0.2.10-home\profiles\orb-verify-0.2.10-20261021`
- 测试项目：
  - A：`...\verify-0.2.10-home\dsh_orb`
  - B：`...\verify-0.2.10-home\project-b`
- 测试会话（解压/原始）：
  - A 主会话：`.zcode\evidence\verify-0210-session1.jsonl`、stop 版本 `verify-0210-session-stop2.jsonl`
  - B 主会话：`.zcode\evidence\verify-0210-main-b-session.jsonl`、切换版本 `verify-0210-main-b-switch.jsonl`
  - 后台 A：`.zcode\evidence\verify-0210-code-session.jsonl`
  - 后台 B：`.zcode\evidence\verify-0210-code-b-session.jsonl`
- 截图/文本：`.zcode\evidence\verify-0210-b-main.png`、`.zcode\evidence\verify-0210-b-main.txt`
- 安装日志：`.zcode\evidence\verify-0210-install.log`
- Host 日志：`.zcode\evidence\verify-0210-web.err.log`、`verify-0210-web2.err.log`
- helper 手工证据：`.zcode\evidence\verify-0210-helper-manual2.err.log`、`verify-0210-helper-nosandbox...`
- 证据工具：`.zcode\evidence\verify-0210-evidence\`
- 停止会话：`.zcode\evidence\verify-0210-session-stop2.jsonl`
