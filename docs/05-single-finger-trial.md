# 单指操作版 dsh-orb 0.2.5：试用与回退说明

本文件是交付给「试用人」的操作卡，不包含源码改动说明。本轮已把 0.2.5 安装到 desktop Profile，并完成真实 Electron 窗口的多行边缘复测；真实 FVK 只完成部分路径，仍需用户本人验收。

## 1. 本次产物

| 项目 | 值 |
| --- | --- |
| 安装包 | `C:\dsh-orb-cordis\dsh-orb-0.2.5.tgz` |
| 包名 / 版本 | `dsh-orb` / `0.2.5` |
| 大小 | 24,456,721 字节 |
| SHA-256 | `65014FC3F24FE4102073D73A426589966E2639988D5FA88ED4D66178678C73FB` |
| 构建方式 | `pnpm build` + `pnpm --filter dsh-orb run pack`（`run` 不能省） |

上一轮 `dsh-orb-0.2.4.tgz`（SHA-256 `CE24E22934D99CFCDB8B5E5ED0DD358A4BA2219A4B8CC865B7ADDDC5E4E515ED`）与更早的 0.2.0 / 0.2.1 / 0.2.2 / 0.2.3 均保留在仓库，本次没有覆盖同名文件。0.2.5 只修 0.2.4 遗留的“多行草稿发送后，原发送区域连点误停”：提交时锁定 composer 的提交前高度，直到该回合结束，完整保留原发送按钮命中区；停止仍为旁边的独立大按钮。

安装包内已含 helper 页面资源与 `koffi` 三平台（darwin-arm64 / darwin-x64 / win32-x64）预编译产物，安装时不需要再从 npm 拉取运行依赖。

## 2. 试用前的核对与备份（建议逐条做）

1. 确认 Harness 版本与当前 Profile，并记录安装前的插件清单：

   ```powershell
   dsh plugin --profile desktop list --depth=0
   ```

2. 备份 desktop Profile 的插件清单文件（若存在）到同目录，文件名带时间戳，**不要删除原文件**：

   ```powershell
   $profile = 'C:\Users\zhq\.dsh\profiles\desktop'
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   foreach ($name in 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
     $path = Join-Path $profile $name
     if (Test-Path $path) { Copy-Item $path "$path.bak-0.2.5-$stamp" }
   }
   ```

3. 确认 `C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb` 当前不存在（原版已卸载）；若存在，先按第 6 节回退，不要直接覆盖。
4. 本机若已存在 `C:\Users\zhq\.dsh\dsh-orb\electron-runtime` 缓存，可保留；首次启动球时若缺失，会按插件原有逻辑下载并校验 Electron 运行时。

## 3. 安装到日常 desktop Profile

本机的 `dsh` 入口是 `C:\Users\zhq\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`；若它不在 PATH，先在当前 PowerShell 里调用它的完整路径，或把其所在目录加入本次会话的 PATH。**Profile 必须显式写 `--profile desktop`**：

```powershell
cd C:\dsh-orb-cordis
dsh plugin --profile desktop add ./dsh-orb-0.2.5.tgz
```

也可以在桌面版主窗口的插件页选择本地 tarball 安装；插件页操作的是当前打开的 desktop Profile，但不会有显式 `--profile` 参数，所以下面的核对步骤仍然要做。

安装完成后先打开「设置 → 悬浮球」核对版本；0.2.5 支持 Host 热加载，本次安装没有重启整个 Harness。若页面仍显示旧版或 helper 仍加载旧资源，先关闭球窗口让 Host 重拉 helper；仍不生效时用官方插件页禁用/启用 dsh-orb bundle，最后才考虑重启 Harness。

### 安装后核对实际加载版本与路径

```powershell
# pnpm 记录的依赖版本
dsh plugin --profile desktop list dsh-orb --depth=0

# 插件包本身的清单
$plugin = 'C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb'
(Get-Content (Join-Path $plugin 'package.json') -Raw | ConvertFrom-Json) |
  Select-Object name, version

# 运行中的球 helper：确认它加载的是上面这个插件目录，而不是旧副本
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*dsh-orb*helper*main.js*' } |
  Select-Object ProcessId, CommandLine
```

期望：`name` 为 `dsh-orb`、`version` 为 `0.2.5`，helper 的命令行包含
`C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb\dist\helper\lib\main.js`。
若版本或路径不符，先不要开始试用，按第 6 节回退后重装。

首次启动时球可能先下载 Electron 运行时；设置页会显示进度，失败时点「重新下载」即可，不需要重启应用。

## 4. 隔离检查用的独立 Profile（可选，不能代替桌面试用）

需要先验证、又不想碰日常 desktop Profile 时，用**独立命名**的 Profile；它与 desktop 是两份目录，互不影响：

| 项目 | 值 |
| --- | --- |
| Profile 名 | `orb-verify-0.2.5` |
| 归属路径 | `C:\Users\zhq\.dsh\profiles\orb-verify-0.2.5` |
| 归属 | 仅用于本插件验收的临时 Profile，不属于日常 desktop |

```powershell
cd C:\dsh-orb-cordis
dsh plugin --profile orb-verify-0.2.5 add ./dsh-orb-0.2.5.tgz
dsh --profile orb-verify-0.2.5 web
```

- `plugin add` 会在首次使用时初始化这个 Profile；`dsh --profile ...` 启动的实例只读写该 Profile。
- 若要更强隔离（会话、凭据也不与日常共用），在该终端里另设 `$env:DSH_HOME` 为独立目录，Profile 路径随之变为 `$env:DSH_HOME\profiles\orb-verify-0.2.5`；不要再指向 `C:\Users\zhq\.dsh`。
- 隔离验证结束、确认不再需要后，只删除 `profiles\orb-verify-0.2.5` 这一份目录；不要删除或改名 `profiles\desktop`。

## 5. 一页操作卡（单指、左键）

- **打开**：左键单击球。面板打开后会一直保持，指针移到虚拟键盘、任务栏或别的窗口都不会收起。
- **收起**：点面板顶部「收起」，或再次单击球。未发送的草稿会保留，下次打开还在。
- **输入**：点一下输入框，再用 Free Virtual Keyboard 输入；`Enter` 为发送，`Shift+Enter` 为换行。
- **粘贴任务**：点输入框上方的「粘贴任务」。它等待系统剪贴板读取完成后只把文本追加到草稿，**不会执行**；空剪贴板、非文本或读取失败会分别给出准确提示，草稿和未确认记录不动。
- **发送**：点输入框右侧的大号「发送」。空输入会提示；正在提交时按钮显示「发送中…」。任务被 Host 接受后，对话里会出现 Host 自己回传的**唯一一条**用户消息，并带回本次提交的 submission id。
- **运行中的按钮布局**：发送后原「发送」位置保留为禁用的「运行中」按钮，停止是输入框旁边**另一块固定的大按钮**，不再占用发送位置。快速双击/连点发送只会提交一次，也不会误触停止。
- **复制**：消息旁的复制图标和未确认卡片里的「复制」都要等系统写入成功后才显示「已复制」；写入失败会提示「复制失败，请重试」，不会假装成功。
- **提交超时 / 未确认的提交**：若约 6 秒内没有收到 Host 的确认，页面把状态当作**送达未知**，不当作失败，也不自动重发：
  - 输入框为空：任务会放回输入框，同时保留在输入区上方的「未确认的提交」卡片里；
  - 输入框已有草稿：草稿不被覆盖也不被拼接，任务只保留在卡片里，提示会明确说“任务未放回”；
  - 卡片每一行都有「复制」「放回输入框」「移除记录」三个左键按钮。输入框有草稿时「放回输入框」不会覆盖，会提示先用「复制」；
  - 迟到确认会自动消除对应的卡片：若任务曾被自动放回且内容没被改过，会自动清掉那份回填；你若改过内容，修改保留；
  - 卡片只认 Host 对**本次提交**的实时回显（携带本页生成、随任务发出的 submission id）。同一会话的历史回放、重复投递的旧消息，即使文本完全相同，也不会确认它、清空卡片或清除回填；两次有意发送相同文本仍各自独立；
  - 从卡片复制或放回后再点「发送」，是一次**新的提交**；原请求是否已被 Host 收到仍未知。
- **状态**：输入区上方常驻一行，把「本对话运行中」与后台任务的「运行中 / 已完成 / 已停止」分开显示；“未查看”只表示结果还没点开，不会把停止任务算成完成。球收起后，徽标用转圈+数字表示运行、`✓` 表示未查看的完成、`!` 表示未查看的停止。
- **停止**：本对话运行时，输入框旁会出现整行「停止当前对话」按钮，与禁用的「运行中」发送按钮分离。单击一次只停当前对话；上方常驻说明「后台任务继续运行；已执行的操作不会撤销」。
- **设置 / 主窗口**：面板顶部「设置」「主窗口」，左键一次直达，不再需要右键菜单（右键菜单仍保留）。
- **移动**：按住「移动」按钮用左键拖动整个面板；也可以直接拖球。松手后位置会保存。
- **大小**：第二行「大小 − / +」逐级缩放。大的尺寸可能越过上下切换边界，页面会跟着窗口一起翻转，球、输入区和工具行仍在同一边。大小与位置在下次启动时恢复。

## 6. 回退

1. **优先官方卸载流程**（显式指定 desktop Profile）：

   ```powershell
   dsh plugin --profile desktop remove dsh-orb
   ```

   然后重启 Harness。日常界面里也可用左键回退：主窗口左侧「插件」→「已安装插件」→ dsh-orb → 详情页右上角红色「卸载」按钮（本版已确认该入口存在；卸载演练尚未执行）。

2. **卸载后核对插件相关变化**：

   ```powershell
   dsh plugin --profile desktop list --depth=0
   Test-Path 'C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb'
   ```

   期望：列表里不再有 `dsh-orb`，`Test-Path` 为 `False`，插件页不再显示悬浮球条目。

3. **恢复旧版**（如确实需要）：把原版 `dsh-orb@0.1.8` 的 tarball 用同一 Profile 安装，再重启：

   ```powershell
   dsh plugin --profile desktop add <原版-tarball-路径>
   ```

4. **整份清单备份只用于故障恢复**：第 2 节的文件是“某一时刻”的快照。恢复前先核对快照之后是否新增/改动过其它插件或配置，例如：

   ```powershell
   $profile = 'C:\Users\zhq\.dsh\profiles\desktop'
   Compare-Object (Get-Content "$profile\package.json") (Get-Content "$profile\package.json.bak-0.2.5-<时间戳>")
   ```

   若差异里出现备份之后才安装的其它插件，不要整份覆盖；只把与 `dsh-orb` 相关的条目改回去，或请维护者合并。只有在确认没有其它变更、且 Profile 已无法启动时，才整份恢复。

5. **只重置面板位置/大小**：关闭 Harness 后删除
   `C:\Users\zhq\.dsh\dsh-orb\helper-data\<profile-hash>\panel-geometry.json`
   （`<profile-hash>` 是 `dsh-orb` 目录下对应 Profile 的 16 位十六进制目录）。该文件只存球位置与面板尺寸，不含对话内容。
6. **不要**为了回退去修改 `C:\rightpad`、Free Virtual Keyboard、Motion / M/C / B/X 参数或 Virtual HID 后端；本次改动不涉及它们。

## 7. 试用中请记录的四类结果

按用户要求，界面变好不等于效率提高，请在真实任务上记录：

1. **任务正确性**：结果是否正确、是否需要纠正。
2. **完整耗时**：从开始描述任务到确认结果的总时间。
3. **返工次数**：需要重说、重发、重新点击的次数。
4. **出错后的恢复**：面板/停止/粘贴/提交确认出错时，恢复要几步、是否丢草稿或丢任务。

同时请留意：

- 用**真实 Free Virtual Keyboard** 在聊天输入框输入是否稳定；本轮只验证到真实多键/候选部分路径，完整中文句子仍需本人验收。
- 真实 Harness 模型回合、Host 回传的用户消息、任务状态行与停止行为已在 0.2.5 复测；后台任务继续范围尚未实测。
- 面板位置/大小在**完整 Harness 重启后**是否恢复尚未实测；本轮只验证了 helper 重拉后的几何保留。
- 官方插件页的「卸载」按钮已确认存在，但本轮未执行卸载演练。

## 8. 本轮已经完成与明确未做的验证

| 验证层 | 状态 |
| --- | --- |
| 自动化测试（typecheck / node:test / vitest） | 已完成，见第 9 节 |
| 隔离界面验证（构建产物 + 无头 Chrome + stub 桥接） | 已完成，133/133；多行矩阵 241/241 |
| 多行草稿边缘连点矩阵 | **已完成**：单行/多行/自动换行 × 上下 × 四档尺寸，五点命中、同坐标连点、单独停止 |
| 真实虚拟键盘输入 | **部分完成**：多键/候选路径已记录，完整中文句子待用户验收 |
| 真实 Harness 与模型回合 | **已完成**：设置页显示 0.2.5；模型回合、真实多行边缘连点与停止均通过 |
| 安装 | **已完成**：官方流程安装到 desktop Profile |
| 官方卸载演练 | **未执行**：已确认插件详情页有左键「卸载」按钮 |
| 用户单指操作体验验收 | **待用户本人** |

## 9. 本轮验证结果摘要

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `node:test`：426 例，425 通过；唯一失败是仓库既有的 POSIX `#!/bin/sh` 夹具在 Windows 上无法执行（见 `docs/04-addenda.md` 第 19、28 节），与本次改动无关。
- `@dsh-orb/computer-use` vitest：321/321 通过。
- 隔离界面：加载 `packages/bundle/dist/helper/assets`，无头 Chrome 驱动真实点击与键入，133/133 断言通过；另有多行专用矩阵 241/241（单行/多行/自动换行 × 上下 × 四档尺寸，五个有效点、同坐标连点、单独停止）。
- **本轮完整界面日志**：`.zcode/ui/logs/20261020-135721-0.2.5-smoke.log`。日志头记录了测试时间、构建产物路径与 `shell.js` / `floating.html` / `floating.css` / `submit-confirmation.js` 的 SHA-256，正文是完整 stdout，末尾是 `SMOKE-PASS 133/133` 与 `exit=0`。同目录的 `20261020-135721-0.2.5-node-test.log` 与 `20261020-135721-0.2.5-vitest.log` 保存了本轮测试的完整输出；多行专用矩阵日志为 `.zcode/ui/logs/20261020-135721-0.2.5-multiline.log`（`MULTILINE-PASS 241/241`）。
- 真实 Electron：设置页显示 0.2.5；helper PID 2960（13:54:48）加载 `profiles\desktop\node_modules\dsh-orb\dist\helper\lib\main.js`。多行草稿提交后同一坐标连点，session 只出现一条用户 prompt、无停止请求；随后单独 Stop 使该回合在 2 秒内 `aborted/user`。异步粘贴、复制成功反馈与 0.2.4 行为保留。
- 打包产物：已解包核对 `dsh-orb@0.2.5`、composer 几何锁、异步剪贴板、固定发送/停止布局、页面资源与三平台 koffi 预编译；tarball 与构建目录中页面资源的哈希一致。

## 10. 已知限制（本版范围内）

- 面板位置与大小按每个 helper 记一份，不按显示器分别保存；显示器布局或缩放变化时，面板会夹回最近工作区，而不是恢复该显示器上次的布局。
- 对话运行中允许「收起」，但收起后只能从球上徽标（转圈 / `✓` / `!` + 数字）判断状态；完整状态行与停止按钮要展开面板才看得到。
- 停止只取消当前对话的回合；后台会话与它已经执行的点击、输入、文件修改不会回滚。
- 约 6 秒内未收到 Host 用户消息时，送达状态只能算“未知”：输入框为空才会自动放回；已有草稿时任务只留在「未确认的提交」卡片里。卡片能复制/放回，但这仍不能证明 Host 一定没有收到——再次发送前请按提示确认这是一次新提交。
- 未确认记录的确认依据是“本页生成、随任务发出的 submission id 被 Host 原样回传到实时回显”，不再依赖文本或历史回放。历史回放（包括同一会话、同一文本）没有该 id，不会确认、清空或解锁任何记录；同一会话里两次有意发送相同文本各自带不同 id。若 Host 端没有回传 id（例如只升级了半个包），记录会保持“未知”并出现在卡片里，不会被当成成功。该机制只证明“Host 收到了这条实时提交”，不证明任务执行成功，也不承诺绝对只执行一次。
- 真实 FVK 已做部分验证：多键点击能进入输入框并弹出中文输入法候选条，点击候选能把字符插入草稿；但本轮自动点击没有得到完整的中文句子，键位/候选焦点仍需用户本人按真实节奏验收。没有用剪贴板或模拟输入替代这一步。
- 本轮没有重启整个 Harness；Host/client bundle 通过官方插件管理页热重载，helper 重拉到 PID 2960。完整 Harness 重启、真实 Electron 窗口重启后的位置/大小恢复、后台任务继续范围、官方卸载演练尚未执行。
- 本轮未改 rightpad、Android、Motion / M/C / B/X、Virtual HID、Harness 主程序与其他插件。
