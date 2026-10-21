# 点击测试框架修正与 A2/B2 小目标复测（0.2.17）

日期：2026-10-21

本轮只改测试夹具、控制器、评分器和文档；没有改生产点击代码，没有打包/安装/升级，没有重启日常 Harness。

## 1. 结论摘要

- **框架**：STOP 现在是整个 run 的锁存状态；A 中停止不会创建 B；停止后 late prepare 被夹具拒绝；不再用 raise/Activate/SetForegroundWindow 抢回前台；模型思考/工具执行期间每 250ms 检查停止与前台；只对当前测试 Session 调用官方 `session/cancel`。
- **事件取证**：新记录同时保存 `eventScreenX/Y`（来自 `MouseEventArgs.Location + PointToScreen`）和 `snapshotScreenX/Y`（`Cursor.Position`）。新样例 136 个鼠标事件（A2 24 + B2 112）的两种位置全部相同；旧记录没有事件位置，仍只按 snapshot 解释，不回填。
- **score-only**：只读原运行计划/环境/记录，分析写到独立 `analysis/` 目录；源目录哈希前后不变。
- **A2**：12/12 首次成功；小数坐标覆盖非整数像素、`.5` 附近、奇宽高、非零原点；实际参数、期望落点、事件落点全部一致，0px。
- **B2**：36 题，首次命中 **29/36（80.6%）**；24×24 DIP 图标 **6/12（50%）**，32×32 DIP **11/12（91.7%）**，40×20 DIP **12/12**；首次失败 7，反馈后纠正恢复 4，仍失败 3；1 题出现首次命中后的额外点击。
- 底部 93%–97.5% 的 9 个目标首次命中 **5/9**，与历史头像误点区域接近，但样本仍不足以证明长期比例。
- 6 个停止/接管故障场景全部用真实专用窗口验证；另有 12 个评分器异常单元测试。

### 1.1 计划与执行

| 组 | 计划 | 实际执行 | 首次成功 | 首次失败 | 反馈后恢复 | 仍失败 | 中止 | 未执行 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A2（小数坐标） | 12 | 12 | **12** | 0 | 0 | 0 | 0 | 0 |
| B2（小目标） | 36 | 36 | **29** | 7 | 4 | 3 | 0 | 0 |
| 合计 | 48 | 48 | **41** | 7 | 4 | 3 | 0 | 0 |

> 运行拆分：B2 36 来自 `round3-0217-224748`；该次 48 题中的 A2 12 使用的是修正前的整数映射版本。A2 计划改成非整数/`.5` 附近后，单独重跑 `round3-a2frac2-230057`，最终 A2 采用重跑结果。两组的原始会话、图片、事件都保留，不混算旧 A2。

## 2. 快照与旧证据保护

修改前快照：

- `.zcode/snapshots/pre-click-accuracy-correction-20261021-223120/`
- 6 个测试/报告文件的 SHA-256 在该目录 `manifest.json` 中；
- 旧证据根 `.zcode/evidence/click-accuracy-0217/` 当时 405 个文件的路径、字节数、SHA-256 也在同一 manifest。

本轮结束前复核：**405 个旧文件全部存在，0 个哈希变化**。旧文件没有被覆盖或清理。校验结果：[round3-validation.json](../.zcode/evidence/click-accuracy-0217/round3-validation.json)。

### 2.1 修改文件

| 文件 | 行为变化 |
|---|---|
| `fixture-window.ps1` | 全局 `stopLatched`；prepare 不再清停止；迟到 prepare 拒绝；只启动时激活一次；prepare 不再抢前台；250ms heartbeat；`MouseEventArgs.Location` 事件位置与 `Cursor.Position` 快照分开；B2 上下文标签/字体族；窗口保持 topmost 但不重新激活 |
| `runner.mjs` | run 级 STOP；运行中观察停止/前台/PID；只 cancel 当前测试 Session；不再 raise；唯一 run_id；A2/B2；首击未中即取消首 turn；反馈纠正；score-only 独立分析；实际显示器/环境测量 |
| `plan.mjs` | 旧 A/B 保留；新增 A2 12 个非整数/`.5` 附近坐标；新增 B2 36 个 24/32/40×20 DIP 小目标，RNG 真正决定目标槽位 |
| `scoring.mjs`（新） | 四项拆分评分、异常分类、独立期望、聚合工具 |
| `scoring.test.mjs`（新） | 12 个 mock 异常/边界样例 |
| `summary.mjs`（新） | 分组统计、检查拆分、turn end/取消、耗时、额外点击 |
| `display-info.ps1`（新） | DPI-aware 实际显示器测量 |
| `control-fault.ps1`（新） | 只对本轮专用夹具 STOP 的故障注入 |
| `selfcheck.ps1` | 事件位置/快照字段和 stop/late prepare 自检 |
| `README.md` | round 3 启动、停止、控制 probe、score-only、证据说明 |
| `docs/16...` | 顶部独立勘误入口（不改旧正文结论） |
| `docs/17...` | 本轮报告 |

快照：`.zcode/snapshots/pre-click-accuracy-correction-20261021-223120/`，含改前 6 个文件副本和 manifest。

## 3. 框架修正

### 3.1 全局 STOP

- `RUN_STATE.stopRequested` 是整个 run 的唯一锁存点；设置后 A、B、A2、B2 及后续组都不再创建 Session、不再 prepare、不再发 prompt/click。
- 夹具新增 `stopLatched`：STOP 后 `prepare` 只写 `prepare-rejected` 事件并保持原题，不清除停止标记。
- 新 run 必须使用未占用的 `run_id`；runner 在创建目录前检查 `RUN_DIR` / `EVIDENCE_DIR` 是否已存在。
- 停止后不再发 `raise`；夹具的 `raise` 命令也只记录 `raise-rejected`，不改变前台。

### 3.2 运行中观察

夹具每 250ms 写一次 heartbeat state，更新 `foregroundHwnd` / `guard`，因此模型思考或工具执行时控制器也能看到前台变化。控制器在 `sendAndWait` 的等待循环里检查：

- `stopped` / `stopLatched`；
- PID 是否仍存活（夹具被关闭）；
- 前台 PID 是否仍为本夹具；
- 目标中心是否仍属于本夹具或透明的 helper；
- 题号、窗口几何是否变化。

发现异常后只取消当前测试 Session 的 turn（官方 `session/cancel`），等待 `turn/end`，记录 `stopObservedAt` / `cancelRequestedAt` / `cancelEndedAt`，然后关闭夹具。没有取消未知后台任务，没有按进程名批量结束。

### 3.3 前台不符

- **启动时一次明确激活**：夹具 `Shown` 中调用一次 Bring-ToFront，记录 `startup-activated`。
- 之后 `prepare` 只做 `SetWindowPos(NOZORDER|NOACTIVATE|SHOWWINDOW)`，不 raise、不 Activate、不 SetForegroundWindow、不改 TopMost。
- 前台切到另一个专用窗口时，控制器保存现有 state/control 证据并中止，不把夹具拉回前台。
- 为避免生产彩带 helper 覆盖目标导致误判，夹具窗口在整轮测试期间保持 topmost；它不会在用户切换后重新激活，异常前台会立即中止并关闭。这是夹具/控制器行为，不是插件新增能力。

### 3.4 事件落点

新 `On-MouseEvent`：

```text
eventScreen = Sender.PointToScreen(MouseEventArgs.Location)
snapshot    = Cursor.Position
```

两者都写入 JSONL：

- `eventScreenX/Y`、`eventClientX/Y`：事件自己的位置，评分主依据；
- `snapshotScreenX/Y`、`snapshotClientX/Y`：处理时鼠标快照；
- `eventMatchesSnapshot`：两者是否相同。

新样例中 112 个鼠标事件（A2 24 + B2 112）两种位置全部相同；但保留差异字段，不用更接近期望值的那一个。旧记录只有 `screenX/Y`，没有事件位置；不补造。旧 0px 只能按 snapshot 来源解释。

### 3.5 评分器

评分拆成四项：

1. `targetHit`：事件落点是否在目标矩形内；
2. `parametersMatchSpecified`：A/A2 的实际 tool args 是否符合指定值；
3. `landingMatchesExpected`：事件落点是否等于按**实际提交参数**独立算出的整数像素；
4. `pressReleaseComplete`：down/up/激活次数是否各一次。

另有 `duplicateDowns`、`missingUp`、`duplicateActivations`、`noEvent`、`targetMiss`、`controlNoResponse`、`parameterMismatch`、`landingOffset` 等分类。`hit` 只表示目标命中/激活，不等于四项全通过；`allChecksPassed` 才是全通过。

评分单元测试 `scoring.test.mjs` 12/12：精确命中、3px 偏移、未命中、缺失释放、重复按下、重复激活、无事件、参数错误、旧 snapshot-only、事件位置优先、A2 独立期望、无 click。命令与日志见交付末尾。

### 3.6 score-only

旧问题：在分支判断前重写 plan/environment/runner.log。

现实现：

- `--score-only` 在创建任何 run 目录之前分支；
- 读取原 `plan.json`、`environment.json`、`records.json` / trial result；
- 不调用 `buildPlan()`、不重新测量当前显示器/模型；
- 不写原 run 的 plan/environment/summary/result/session/image；
- 分析写到 `.zcode/evidence/click-accuracy-0217/analysis/<sourceRunId>-<analysisId>/`；
- 写 `source-manifest-before.json` / `after.json`、`provenance.json`、`analysis.log`，包含 `sourceRunId`、`scorerVersion`、`scorerHash`、`rescoredAt`、`sourceUnchanged`。

实测：对 `baseline-0217-193852` 重新计分，源目录 184 个文件哈希前后完全一致（PowerShell 独立比对 `SOURCE_HASHES_UNCHANGED`，provenance `sourceUnchanged: true`）。分析：[baseline-0217-193852 hashcheck](../.zcode/evidence/click-accuracy-0217/analysis/baseline-0217-193852-hashcheck-224719/provenance.json)。

## 4. 停止/接管故障场景

全部使用无业务动作的专用夹具窗口。停止按钮由测试控制器用独立 DPI-aware SendInput 点击，仅作为故障注入，不计入真实点击成绩。

| # | 场景 | 运行 | 结果 | 证据 |
|---:|---|---|---|---|
| 1 | A 中 STOP，B 不创建/不执行 | `control-stop-a2-224613` | A2 记录 1 个中止；只创建 A2 Session；无 B2 组；Session 内 0 次 click；late prepare 被拒绝 | [control.jsonl](../.zcode/clicktest/runs/control-stop-a2-224613/control.jsonl) |
| 2 | B 中 STOP，后续不执行 | `control-stop-b2-224627` | B2 记录 1 个中止；`notExecuted=35`；Session 内 0 次 click | [summary](../.zcode/evidence/click-accuracy-0217/control-stop-b2-224627/summary.json) |
| 3 | 模型思考期间 STOP，取消后无新投点 | 同上两个 probe | `turn-cancel-requested` → `turn-cancel-completed`；Session `tool/call` 数 0；没有下一次 prepare | 两个 `control.jsonl` |
| 4 | 前台切到另一个专用窗口 | `control-fg-224642` | 创建第二个专用 dummy 窗口并置前；控制器记录 `foreground-not-fixture`，取消当前 turn；主夹具未重新激活；dummy 保持前台 | [control.jsonl](../.zcode/clicktest/runs/control-fg-224642/control.jsonl) |
| 5 | STOP 后迟到 prepare | `control-stop-a2-224613` | `preparedSeq` 1→1；`lastResult=prepare-rejected-after-stop`；`stopLatched=true`；`rejected=true` | 同上 `control.jsonl` |
| 6 | 夹具被关闭/归属不符 | `control-close-224659` | 运行中只结束本夹具 PID；检测 `fixture-process-exited`；记录 1 个中止；没有批量杀进程 | [control.jsonl](../.zcode/clicktest/runs/control-close-224659/control.jsonl) |

两个真实窗口：主夹具 + 用于前台切换的 `dummy-fixture`（独立 `RunDir`/`RunId`，无按钮、无业务动作）。没有用个人窗口做故障注入。

**在途竞态边界**：stop 可以在 prompt 已被接受、turn 尚未 start 的窗口内发生。此时 runner 会立即调用官方 cancel，并最多等 3 秒捕获迟到的 turn 再取消；本轮所有 stop probe 都没有在这个窗口内出现新的 click。但这不能证明所有调度时序下都绝对没有一次已接受的 prompt 开始；能保证的是：停止标记不会清除，控制器不再发新任务/新 prepare/raise，且会取消当前测试 Session 的 turn。

## 5. 旧报告勘误

### 5.1 旧 0px 是鼠标快照来源

旧 `saveTrialEvidence` 用 `Cursor.Position` 记录 `screenX/Y`；没有 `MouseEventArgs.Location` 的事件位置。新 score-only 对旧运行重算后：

- `baseline-0217-193852`：A `locationSources={event:0,snapshot:27}`，B `{event:0,snapshot:30}`；
- `baseline-0217-193246`：同样 snapshot 27/30。

旧 0px 结果仍可解释为“处理时鼠标快照与期望点一致”，但**不是**“鼠标事件自身位置”的证明。旧记录没有事件坐标，无法恢复；本轮没有补造。

### 5.2 两次基线 57 个 turn 都是控制器主动取消

旧 runner 在 click tool result 后立即 `session/cancel`。旧 session 日志：

- `baseline-0217-193852`：A 27/27、B 30/30，`turn/end` 全部 `aborted`（reason user）；57/57；
- `baseline-0217-193246`：同样 57/57；
- 工具结果到 turn end 的中位延迟 333ms / 376ms，最大 735ms / 769ms。

因此旧报告里的“57 个样例中止 0”是**样例级**结果；**turn 级**是 57/57 被控制器主动截断，不是自然完成。旧报告没有区分这两层。新报告分别统计 `turnEnds`、`natural`、`cancelled`。

### 5.3 历史头像误差

用户历史事件：模型用 y≈932，头像中心 y≈960，差 28 个千分比单位。当时截图高度约 1641px：

```text
28 / 1000 × 1641 ≈ 45.95px ≈ 46px
```

不是按工作区 2064px 得到的 58px。分类仍是模型选点偏高，不是插件坐标换算。

### 5.4 被旧 score-only 覆盖的元数据

旧 `score-only` 在分支前重写了 plan/environment/summary。可验证的证据：

- 两个旧 `environment.json` 的 `startedAt` 分别是 `11:47:02`、`11:44:54`，明显是后来重算时间，不是运行开始时间；
- 旧 `summary.json` 的 `startedAt/finishedAt` 是后来按 runner.log 重建的，`scorerVersion` 缺失；
- 旧 `plan.json` / `environment.json` 当前字节不能证明是原始字节。

本轮不“修复历史”：旧文件保留现状；新分析在独立目录，已把可由 `records.json`、session JSONL、fixture prepare 事件和 runner.log 重建的字段标明来源。无法恢复的原始字节写未知，不猜测。

## 6. 新增 A2：小数坐标落点

运行：`round3-a2frac2-230057`（A2 only，12 题）。

| 项 | 值 |
|---|---|
| 计划 / 执行 | 12 / 12 |
| 首次成功 | **12/12** |
| 指定参数匹配 | 12/12 |
| 事件落点匹配独立期望 | 12/12 |
| 完整按下/释放/激活 | 12/12 |
| 事件位置来源 | event 12，snapshot 0 |
| turn 结束 | natural-completed 12 |
| 中止 | 0 |

布局：

| 布局 | 窗口物理矩形 | 题数 |
|---|---|---:|
| A2-L0 | (811,377) 1401×901 | 4 |
| A2-L1 | (1223,509) 1387×877 | 4 |
| A2-L2 | (733,281) 1603×999 | 4 |

目标均为 200×120 物理（100×60 DIP）。归一化坐标是 4 位小数；目标放在独立换算后的整数像素上。代表样例：

| 题 | 提交坐标 | 独立映射（未取整） | 独立期望 | 真实事件 |
|---|---|---|---|---|
| A2-01 | 123.1977, 678.8013 | 983.599978, 988.599971 | 984, 989 | 984, 989 |
| A2-02 | 500.0000, 500.0000 | 1511.500000, 827.500000 | 1512, 828 | 1512, 828 |
| A2-04 | 249.4654, 360.0444 | 1160.501025, 701.400004 | 1161, 701 | 1161, 701 |
| A2-06 | 777.5775, 286.7617 | 2301.499993, 760.490011 | 2301, 760 | 2301, 760 |
| A2-09 | 101.3724, 901.4014 | 895.499957, 1181.499999 | 895, 1181 | 895, 1181 |
| A2-11 | 500.5614, 937.4274 | 1535.399924, 1217.489973 | 1535, 1217 | 1535, 1217 |

取整规则：插件把 0–1000 映射到窗口物理矩形后 `Math.round`；A2 的期望值用**实际提交值**独立换算，和插件函数无共享代码/模块。`A2-02` 是 `.5` 上取整；`A2-06`/`A2-09` 是略低于 `.5` 下取整；4 位小数和二进制浮点会让真实“未取整值”偏离名义值极小量，表里保留未取整计算值。所有 12 题 `landingDelta.max=0`，无需设置宽松容差。

证据：[A2 summary](../.zcode/evidence/click-accuracy-0217/round3-a2frac2-230057/summary.md)。

## 7. 新增 B2：小目标与底部边缘

运行：`round3-0217-224748`，B2 组 36 题。实际窗口 2562×1641 物理，位于 (600,250)；截图附件 2557×1638（源尺寸 2562×1641，attachment 轻微降采样）。窗口包含侧栏、顶部工具栏、内容区和底部账号区上下文，所有图标同色同边框。

| 目标类 | 物理尺寸 | DIP | 题数 | 首次命中 |
|---|---:|---:|---:|---:|
| 24×24 图标 | 48×48 | 24×24 | 12 | **6/12（50.0%）** |
| 32×32 图标 | 64×64 | 32×32 | 12 | **11/12（91.7%）** |
| 40×20 短文本 | 80×40 | 40×20 | 12 | **12/12（100%）** |
| 合计 | — | — | 36 | **29/36（80.6%）** |

按位置（首次命中/总数）：

| 位置 | 左 | 中 | 右 |
|---|---:|---:|---:|
| 上 | 10/11 | 4/4 | 2/3 |
| 中 | 3/4 | 3/3 | 2/2 |
| 下 | 2/3 | 2/3 | 1/3 |

底部 93%–97.5% 的 9 题：**5/9**。分拆：24 DIP 底部 0/3，32 DIP 底部 2/3，40×20 底部 3/3。左下 2/3，右下 1/3，底部中 2/3。该区域与历史头像误点更接近，但仍只有 9 个样本。

首次失败 7，均为 `target-miss`；`landingMatchesExpected` 36/36，说明这 7 次是模型选点不在目标内，不是插件把提交坐标送偏。没有 `control-no-response`、无事件、重复按下、缺失释放或重复激活。

反馈后纠正：7 次，恢复 4 次（57.1%），仍失败 3 次（B2-icon24-02、03、07）。另有 1 题 `B2-icon24-05` 首次命中后在同一 turn 又点击一次（`extraClicks=1`），首次成绩仍为命中，额外点击单独记录，不计为反馈纠正。

| 首次失败 | 目标屏幕矩形 | 首次事件 | 首次 click 参数 | 纠正 | 分类 |
|---|---|---|---|---:|---|
| B2-icon24-01 文件 | 660,890 48×48 | 672,967 | [28,437] | 672,910 命中 | target-miss |
| B2-icon24-02 历史 | 3080,770 48×48 | 3103,752 | [977,306] | 3019,1773 未中 | target-miss |
| B2-icon24-03 报表 | 2980,1820 48×48 | 3019,1724 | [944,898] | 3019,1806 未中 | target-miss |
| B2-icon24-04 搜索 | 1220,460 48×48 | 1235,447 | [248,120] | 1235,473 命中 | target-miss |
| B2-icon24-06 安全 | 680,1820 48×48 | 708,1801 | [42,945] | 708,1834 命中 | target-miss |
| B2-icon24-07 通知 | 1800,1786 48×48 | 1822,1834 | [477,965] | 1822,1845 未中 | target-miss |
| B2-icon32-12 搜索 | 2960,1818 64×64 | 3031,1834 | [949,965] | 3011,1855 命中 | target-miss |

失败样例的 before/after/correction 图片、实际参数、down/up/激活、期望计算均在 `round3-0217-224748/trials/<trialId>/result.json` 与同目录图片。首次失败不被纠正后的成功覆盖；`firstHit=29` 与 `recovery=4` 分开。

B2 及时序：

- 首次 turn：29 natural，7 次 `controller-first-click-miss-cancel`；
- 7 个纠正 turn：全部在纠正 click 后由控制器取消（`controller-correction-click-recorded-cancel`），因为只允许一次纠正且不允许继续试点；
- 合计 14 个 `session/cancel`；A2 0 个；A2+B2 共 41 个自然 turn；
- B2 逐题 turn 合计 310,365ms；中位 6,838.5ms；最大 31,896ms；wall clock 约 496.6s；
- 7 个纠正 turn 合计约 120,768ms（中位 13,015ms，最大 37,457ms），这是重试成本，不计入首次成绩；
- 工具结果延迟（首次 turn）：中位 4,281ms，最大 31,629ms；工具结果到 turn end 中位 2,189ms，最大 7,562ms。

## 8. 证据与验证分层

| 层级 | 结果 |
|---|---|
| 评分器单元/异常样例 | 12/12 通过（mock 合成事件）；`run-with-evidence` 第二次调用 exit 0，首次调用是 wrapper 参数误把 node.exe 又放进 args，属命令调用错误，不是测试失败 |
| 夹具自检（直接 DPI-aware SendInput） | `selfcheck-225716` 全部通过；事件位置=快照位置，非真实插件成绩 |
| 真实 Harness + 当前 0.2.17 click | A2 12/12；B2 29/36 首次；均为真实生产 SendInput。A2 会话 12 次 click；B2 会话 44 次 click（36 首次 + 7 反馈纠正 + 1 同轮额外点击），无 pwsh/read/screenshot/其他工具 |
| 真实停止/前台/关闭故障注入 | 6 个场景全部通过；两个专用窗口 |
| score-only 不改源 | 源 184 文件哈希前后一致；旧证据 405 文件 0 变化 |
| 其他 DPI / 多显示器 / 其他模型 | 未验证 |
| 用户单指 rightpad/Comfort 完整体验 | 未由本轮代替，仍需用户本人验收 |

关键证据：

- 新 A2：[summary](../.zcode/evidence/click-accuracy-0217/round3-a2frac2-230057/summary.md)
- 新 B2 修正分析：[summary](../.zcode/evidence/click-accuracy-0217/analysis/round3-0217-224748-final-225753/summary.md)
- B2 原始运行：[summary](../.zcode/evidence/click-accuracy-0217/round3-0217-224748/summary.md)（原始 summary 的 corrections 计数把同轮额外点击算进去了；最终分析已按 `correctionTurn` 分开）
- 汇总校验：[round3-validation.json](../.zcode/evidence/click-accuracy-0217/round3-validation.json)
- 自检：[selfcheck-225716](../.zcode/evidence/click-accuracy-0217/selfcheck-225716/selfcheck.json)
- 评分单元命令证据：[scoring-unit-r2](../.zcode/evidence/commands/20261021-230453-click-accuracy-round3-scoring-unit-r2/summary.json)
- 旧运行勘误分析：[baseline-0217-193852 errata](../.zcode/evidence/click-accuracy-0217/analysis/baseline-0217-193852-errata-225831/summary.md)、[baseline-0217-193246 errata](../.zcode/evidence/click-accuracy-0217/analysis/baseline-0217-193246-errata-225831/summary.md)
- 旧证据哈希快照：`.zcode/snapshots/pre-click-accuracy-correction-20261021-223120/manifest.json`

## 9. 最小建议

1. 本轮 A2 12/12 精确；没有证据支持改生产坐标换算或 DPI 逻辑。
2. B2 的失败全部是模型选点在目标外，后端 36/36 落点正确；不要把 24 DIP 以下的误差归因于输入后端。
3. 历史头像区域的风险真实存在：底部 93%–97.5% 的 9 个样例仅 5/9；24 DIP 图标 6/12。下一轮若要复现真实账号误点，应使用更接近账号/头像的视觉上下文和更小目标，而不是再扩大测试按钮。
4. 若要让现场可判分，最小诊断改动是让 click 结果携带“实际提交物理点 + 观察窗口物理原点”；这不改变点击行为，本轮未实施。
5. 若要降低模型选点偏高，优先设计“点击后验证控件/菜单是否真的打开，未打开最多一次纠正”的会话策略；本轮已有 7 次反馈后纠正，4 次恢复、3 次仍失败，说明单纯重试不够。

## 10. 边界

- 只改测试夹具/控制器/评分器/文档；没有改生产点击代码。
- 未安装/升级/卸载插件，未改日常 Profile，未重启日常 Harness。
- 未操作 rightpad/Receiver、Android、Motion、M/C、B/X、HID、驱动、Broker、Comfort 键盘。
- 未 commit、push、改写历史或清理旧文件。
- 本轮创建的夹具/dummy 进程已退出；测试 Computer Use 会话保留为证据；日常 Harness、彩带 helper 和用户输入设备保持运行。
- 结论只覆盖当前机器、当前 0.2.17、当前模型和这批样本；不扩大到其他 DPI、多显示器、其他模型或长期零误点。
