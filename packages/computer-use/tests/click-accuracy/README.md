# 点击准确性测试夹具（0.2.17 基线，round 3）

本目录是 dsh-orb 主窗口 Computer Use 的可重复点击准确性测试。它只服务于测试，不随插件包发布（`package.json` 的 `files` 只含 `lib`）。修正后的 0.2.17 结果与旧报告勘误见 [docs/17](../../../../docs/17-click-accuracy-correction-0217.md)。

## 1. 它测什么

计入成绩的每次点击都经过：

```text
真实 Computer Use 会话（computer-use preset）
  -> 当前已安装 dsh-orb 0.2.17 的 click 工具
  -> 生产 Windows SendInput 路径
  -> 夹具窗口真实 WM_LBUTTONDOWN / WM_LBUTTONUP / Click
```

夹具/runner 不投点。计分看夹具收到的事件和 click 工具的实际参数；工具返回成功、模型自述“已点中”都不单独证明命中。

- **A2（12 题）**：小数坐标、奇宽高窗口、非零原点、非整数像素和 `.5` 附近取整；模型必须逐字提交给定坐标。
- **B2（36 题）**：只看本轮自动附带截图和文字任务；24×24 DIP 图标、32×32 DIP 图标、40×20 DIP 短文本各 12；含侧栏/工具栏/底部账号区上下文，覆盖中心、左右边缘、左下、右下及截图 93%–97.5% 纵向区域。
- 旧 A/B 计划保留在 `plan.mjs`，但 round 3 默认使用 A2/B2。

## 2. 启动

前置检查（只读）：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. .\scripts\dev-env.ps1
$env:DSH_WEB_URL
Get-Content "$env:DSH_PROFILE_DIR\node_modules\dsh-orb\package.json" | ConvertFrom-Json | Select-Object version
```

完整 round 3（A2 + B2；真实 Computer Use 会话 + 一个测试窗口）：

```powershell
node .\packages\computer-use\tests\click-accuracy\runner.mjs `
  --run-id "round3-0217-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
  --groups A2,B2
```

单独跑：

```powershell
node ...\runner.mjs --run-id a2-only --groups A2
node ...\runner.mjs --run-id b2-only --groups B2
node ...\runner.mjs --run-id probe --groups B2 --limit-b2 1
```

runner 会用未占用的 `run_id`；已存在的 `RUN_DIR` / `EVIDENCE_DIR` 直接拒绝，不会覆盖旧运行。

## 3. 停止

- **左键 STOP**：测试窗口左上角红色“停止测试 (STOP)”。夹具立即 `stopLatched`、停止接受测试点击、保存已有事件；控制器在 250ms heartbeat 内看到并停止整个 run。
- **整个 run**：STOP 后 A/B/A2/B2 及后续组都不再创建/调度；不发送新 prompt、click、prepare 或 raise；late prepare 被夹具拒绝。
- **控制器中断**：`Ctrl+C` 设置同一个 stop 标记；runner 只对当前测试 Session 调官方 `session/cancel`，等 `turn/end` 后关闭夹具，不批量杀进程。
- **不再抢前台**：启动时夹具激活一次；之后 prepare 不 Activate、不 SetForegroundWindow、不改 TopMost。前台不符时保存证据并中止，不把夹具拉回前台。
- **竞态边界**：prompt 已被接受但 turn 尚未 start 时，stop 会立即 cancel 并等最多 3 秒捕获迟到 turn；Stop 后不会再发新任务，但不能证明所有调度时序下绝对没有一次已接受 prompt 开始。

## 4. 控制故障自检

runner 的 `--control-probe` 用专用无业务窗口注入故障，停止按钮由控制器用独立 DPI-aware SendInput 点击，不计入真实成绩：

```powershell
# A2 中 STOP；不创建 B2；随后 late prepare 必须被拒绝
node ...\runner.mjs --run-id control-stop-a --groups A2,B2 `
  --limit-a2 1 --limit-b2 1 --control-probe stop-late-prepare

# B2 中 STOP；后续不再执行
node ...\runner.mjs --run-id control-stop-b --groups B2 --limit-b2 5 --control-probe stop

# 前台切到第二个专用 dummy 窗口；主夹具不得抢回
node ...\runner.mjs --run-id control-fg --groups B2 --limit-b2 1 --control-probe foreground

# 运行中关闭本夹具 PID；检测后中止，不批量杀进程
node ...\runner.mjs --run-id control-close --groups B2 --limit-b2 1 --control-probe close
```

`--control-probe` 只用于故障验证；正常 A2/B2 成绩不要混入这些 run。

## 5. 夹具协议

```text
<run>/fixture/command.json  {"seq":1,"command":"prepare","trial":{...}}
<run>/fixture/state.json    窗口/DPI/题号/按钮矩形/guard/stopLatched/heartbeat
<run>/fixture/events.jsonl  每次 down/up、激活、准备、prepare-rejected、stop、startup-activated
```

- `prepare`：设置物理窗口、创建按钮/上下文标签、重置计数；不激活窗口。
- `raise`：明确拒绝，只写 `raise-rejected`。
- `stop` / `exit`：停止 / 退出。
- 控件 `Bounds` 就是命中矩形；没有透明外扩热区。
- 每题布局冻结；点击只改计数/结果文字，下一次 prepare 才换题。
- 夹具每 250ms 写 heartbeat state，供控制器在模型思考时检查前台/PID。

`state.guard` 是夹具侧独立测量：

- `foregroundIsSelf`：`GetForegroundWindow` 的 PID 是否为本夹具；
- `windowIsSelf`：目标中心 `WindowFromPoint` 的 PID 是否为本夹具；
- `windowTransparent`：若目标中心被 helper 彩带覆盖，是否 `WS_EX_TRANSPARENT`。

## 6. 事件位置与评分

夹具 `On-MouseEvent` 同时写：

- `eventScreenX/Y`、`eventClientX/Y`：`MouseEventArgs.Location` 经 `PointToScreen` 的物理位置，作为评分主依据；
- `snapshotScreenX/Y`、`snapshotClientX/Y`：`Cursor.Position` 处理时快照；
- `eventMatchesSnapshot`：两者是否相同。

旧记录只有 `screenX/Y`（snapshot），没有事件位置；不补造。旧 0px 只能按 snapshot 来源解释。

评分四项分开：

1. `targetHit`：事件是否在目标矩形内；
2. `parametersMatchSpecified`：A/A2 实际参数是否符合指定值；
3. `landingMatchesExpected`：事件是否等于按实际参数独立算出的整数像素；
4. `pressReleaseComplete`：down/up/激活是否各一次。

`hit` 只表示目标命中/激活；`allChecksPassed` 才是四项全通过。另有重复按下、缺失释放、重复激活、无事件、target miss、control no-response、参数不匹配、landing offset 等分类。

评分单元测试：

```powershell
node --test .\packages\computer-use\tests\click-accuracy\scoring.test.mjs
```

## 7. 重新计分（不修改原运行）

```powershell
node ...\runner.mjs --run-id <sourceRunId> --score-only --analysis-id <unique>
```

- 只读原 `plan.json`、`environment.json`、`records.json` / trial result；
- 不重新生成计划，不重新读取当前显示器/模型；
- 不写原 run 的任何文件；
- 分析写到 `.zcode/evidence/click-accuracy-0217/analysis/<sourceRunId>-<analysisId>/`；
- 写 `summary.json`、`summary.md`、`analysis.log`、`provenance.json`、`source-manifest-before/after.json`；
- `provenance.json` 含 sourceRunId、scorerVersion、scorerHash、rescoredAt、sourceUnchanged。

## 8. 证据布局

```text
.zcode/evidence/click-accuracy-0217/<runId>/
  environment.json
  plan.json / runner.log / records.json
  summary.json / summary.md
  trials/<trialId>/result.json
  trials/<trialId>/before.png|webp / after.png|webp / after-correction.*
  sessions/<group>-<sessionId>.jsonl
  fixture/events.jsonl / state.json / fixture.log
  control.jsonl
```

`analysis/<sourceRunId>-<analysisId>/` 是 score-only 独立输出；旧 run 不被覆盖。

## 9. 夹具自检

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass `
  -File .\packages\computer-use\tests\click-accuracy\selfcheck.ps1
```

自检使用直接 DPI-aware SendInput，只验证夹具：目标 down/up/激活、事件位置与快照、空白点击无激活、新题重置、STOP 停止、物理 DPI 192 与窗口矩形。自检不计入真实插件准确率。

## 10. 边界

- 只测当前机器：3840×2160、200%、单显示器、192 DPI、千分比坐标模式。
- 不测其他 DPI、多显示器、其他模型、其他 Windows 输入后端。
- 不修改生产源码、不安装包、不改日常 Profile、不重启日常 Harness、不操作 rightpad/Comfort。
- 彩带保持生产状态；夹具 guard 把透明 helper 视为可点击，但不主动隐藏/关闭彩带。
- 本轮结论只覆盖实际样本；不宣称长期零误点。
