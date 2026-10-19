# 单指操作版 dsh-orb 0.2.2：试用与回退说明

本文件是交付给「试用人」的操作卡，不包含源码改动说明。本轮**没有**安装进日常 Profile，也**没有**重启日常 Harness；安装、试用与验收由另一轮完成。

## 1. 本次产物

| 项目 | 值 |
| --- | --- |
| 安装包 | `C:\dsh-orb-cordis\dsh-orb-0.2.2.tgz` |
| 包名 / 版本 | `dsh-orb` / `0.2.2` |
| 大小 | 24,455,181 字节 |
| SHA-256 | `09B3F1CF63CF328EC8539A4E10F13E2159EC2EF7F61CC3343023B0BBB832E2B0` |
| 构建方式 | `pnpm build` + `pnpm --filter dsh-orb run pack`（`run` 不能省） |

上一轮 `dsh-orb-0.2.1.tgz`（SHA-256 `086B229F0FCDC879A247F8FF73A03F4E5BC521039BB734F10B52E171C746E1F7`）与更早的 `0.2.0` 均保留在仓库，本次没有覆盖同名文件。0.2.2 修正“提交超时恢复”：超时不再丢弃未确认任务，迟到确认能正确收敛，也不会因为文本相同而误确认或误清除其他提交；同时修正了界面截图中发现的工具行透明缝隙透出转录文字。

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
     if (Test-Path $path) { Copy-Item $path "$path.bak-0.2.2-$stamp" }
   }
   ```

3. 确认 `C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb` 当前不存在（原版已卸载）；若存在，先按第 6 节回退，不要直接覆盖。
4. 本机若已存在 `C:\Users\zhq\.dsh\dsh-orb\electron-runtime` 缓存，可保留；首次启动球时若缺失，会按插件原有逻辑下载并校验 Electron 运行时。

## 3. 安装到日常 desktop Profile

本机的 `dsh` 入口是 `C:\Users\zhq\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`；若它不在 PATH，先在当前 PowerShell 里调用它的完整路径，或把其所在目录加入本次会话的 PATH。**Profile 必须显式写 `--profile desktop`**：

```powershell
cd C:\dsh-orb-cordis
dsh plugin --profile desktop add ./dsh-orb-0.2.2.tgz
```

也可以在桌面版主窗口的插件页选择本地 tarball 安装；插件页操作的是当前打开的 desktop Profile，但不会有显式 `--profile` 参数，所以下面的核对步骤仍然要做。

安装完成后**重启 DeepSeek Harness**：helper 是独立进程，重装后必须重启宿主才会换新版本。

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

期望：`name` 为 `dsh-orb`、`version` 为 `0.2.2`，helper 的命令行包含
`C:\Users\zhq\.dsh\profiles\desktop\node_modules\dsh-orb\dist\helper\lib\main.js`。
若版本或路径不符，先不要开始试用，按第 6 节回退后重装。

首次启动时球可能先下载 Electron 运行时；设置页会显示进度，失败时点「重新下载」即可，不需要重启应用。

## 4. 隔离检查用的独立 Profile（可选，不能代替桌面试用）

需要先验证、又不想碰日常 desktop Profile 时，用**独立命名**的 Profile；它与 desktop 是两份目录，互不影响：

| 项目 | 值 |
| --- | --- |
| Profile 名 | `orb-verify-0.2.2` |
| 归属路径 | `C:\Users\zhq\.dsh\profiles\orb-verify-0.2.2` |
| 归属 | 仅用于本插件验收的临时 Profile，不属于日常 desktop |

```powershell
cd C:\dsh-orb-cordis
dsh plugin --profile orb-verify-0.2.2 add ./dsh-orb-0.2.2.tgz
dsh --profile orb-verify-0.2.2 web
```

- `plugin add` 会在首次使用时初始化这个 Profile；`dsh --profile ...` 启动的实例只读写该 Profile。
- 若要更强隔离（会话、凭据也不与日常共用），在该终端里另设 `$env:DSH_HOME` 为独立目录，Profile 路径随之变为 `$env:DSH_HOME\profiles\orb-verify-0.2.2`；不要再指向 `C:\Users\zhq\.dsh`。
- 隔离验证结束、确认不再需要后，只删除 `profiles\orb-verify-0.2.2` 这一份目录；不要删除或改名 `profiles\desktop`。

## 5. 一页操作卡（单指、左键）

- **打开**：左键单击球。面板打开后会一直保持，指针移到虚拟键盘、任务栏或别的窗口都不会收起。
- **收起**：点面板顶部「收起」，或再次单击球。未发送的草稿会保留，下次打开还在。
- **输入**：点一下输入框，再用 Free Virtual Keyboard 输入；`Enter` 为发送，`Shift+Enter` 为换行。
- **粘贴任务**：点输入框上方的「粘贴任务」。它只把剪贴板文本追加到草稿，**不会执行**；空剪贴板、非文本或读取失败会有一行短提示。确认后点「发送」。
- **发送**：点输入框右侧的大号「发送」。空输入会提示；正在提交时按钮显示「发送中…」，连续点击不会重复发送。任务被 Host 接受后，对话里会出现 Host 自己回传的**唯一一条**用户消息。
- **提交超时 / 未确认的提交**：若约 6 秒内没有收到 Host 的确认，页面把状态当作**送达未知**，不当作失败，也不自动重发：
  - 输入框为空：任务会放回输入框，同时保留在输入区上方的「未确认的提交」卡片里；
  - 输入框已有草稿：草稿不被覆盖也不被拼接，任务只保留在卡片里，提示会明确说“任务未放回”；
  - 卡片每一行都有「复制」「放回输入框」「移除记录」三个左键按钮。输入框有草稿时「放回输入框」不会覆盖，会提示先用「复制」；
  - 迟到确认会自动消除对应的卡片：若任务曾被自动放回且内容没被改过，会自动清掉那份回填；你若改过内容，修改保留；
  - 卡片按会话关联，别的会话回放的同文本消息不会误确认它；同一会话里两次有意发送相同文本仍各自独立；
  - 从卡片复制或放回后再点「发送」，是一次**新的提交**；原请求是否已被 Host 收到仍未知。
- **状态**：输入区上方常驻一行，把「本对话运行中」与后台任务的「运行中 / 已完成 / 已停止」分开显示；“未查看”只表示结果还没点开，不会把停止任务算成完成。球收起后，徽标用转圈+数字表示运行、`✓` 表示未查看的完成、`!` 表示未查看的停止。
- **停止**：本对话运行中，输入区会换成整行「停止当前对话」。它只停当前对话；上方常驻一行说明「后台任务继续运行；已执行的操作不会撤销」。
- **设置 / 主窗口**：面板顶部「设置」「主窗口」，左键一次直达，不再需要右键菜单（右键菜单仍保留）。
- **移动**：按住「移动」按钮用左键拖动整个面板；也可以直接拖球。松手后位置会保存。
- **大小**：第二行「大小 − / +」逐级缩放。大的尺寸可能越过上下切换边界，页面会跟着窗口一起翻转，球、输入区和工具行仍在同一边。大小与位置在下次启动时恢复。

## 6. 回退

1. **优先官方卸载流程**（显式指定 desktop Profile）：

   ```powershell
   dsh plugin --profile desktop remove dsh-orb
   ```

   然后重启 Harness。若日常界面里已没有 `dsh` 命令入口，用主窗口插件页移除 `dsh-orb`，效果相同。

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
   Compare-Object (Get-Content "$profile\package.json") (Get-Content "$profile\package.json.bak-0.2.2-<时间戳>")
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

同时请留意（本次未实测）：

- 用**真实 Free Virtual Keyboard** 在聊天输入框输入是否稳定；自动化只验证到浏览器键入层，没有验证真实虚拟键盘与焦点。
- 真实 Harness 模型回合中，Host 回传的用户消息、任务状态行与停止行为是否符合预期；本次没有跑真实模型回合。
- 面板位置/大小在**重启后**是否恢复；本次只做了单元测试与源码路径核对，没有在真实 helper 进程里端到端验证。
- 停止后后台任务是否继续、以及停止按钮是否只影响当前对话。

## 8. 本轮已经完成与明确未做的验证

| 验证层 | 状态 |
| --- | --- |
| 自动化测试（typecheck / node:test / vitest） | 已完成，见第 9 节 |
| 隔离界面验证（构建产物 + 无头 Chrome + stub 桥接） | 已完成，94/94 |
| 真实虚拟键盘输入 | **未做** |
| 真实 Harness 与模型回合 | **未做** |
| 安装/回退命令本身 | **未执行**（本轮不安装、不回退） |
| 用户单指操作体验验收 | **待用户本人** |

## 9. 本轮验证结果摘要

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `node:test`：416 例，415 通过；唯一失败是仓库既有的 POSIX `#!/bin/sh` 夹具在 Windows 上无法执行（见 `docs/04-addenda.md` 第 19、25 节），与本次改动无关。
- `@dsh-orb/computer-use` vitest：321/321 通过。
- 隔离界面：加载 `packages/bundle/dist/helper/assets`，无头 Chrome 驱动真实点击与键入，94/94 断言通过；截图在 `.zcode/ui/shots/`（`01-collapsed.png` … `08-unconfirmed-card.png`）。
- **本轮完整界面日志**：`.zcode/ui/logs/20261019-235537-0.2.2-smoke.log`。日志头记录了测试时间、构建产物路径与 `shell.js` / `floating.html` / `floating.css` / `submit-confirmation.js` 的 SHA-256，正文是完整 stdout，末尾是 `SMOKE-PASS 94/94` 与 `exit=0`。同目录的 `20261019-235537-0.2.2-node-test.log` 与 `…-vitest.log` 保存了本轮测试的完整输出；更早的 `.zcode/ui/smoke.log`（49/49）保留为上一轮证据。
- 打包产物：已解包核对 `dsh-orb@0.2.2`、新增资源与三平台 koffi 预编译；tarball 与构建目录中页面资源的哈希一致。

## 10. 已知限制（本版范围内）

- 面板位置与大小按每个 helper 记一份，不按显示器分别保存；显示器布局或缩放变化时，面板会夹回最近工作区，而不是恢复该显示器上次的布局。
- 对话运行中允许「收起」，但收起后只能从球上徽标（转圈 / `✓` / `!` + 数字）判断状态；完整状态行与停止按钮要展开面板才看得到。
- 停止只取消当前对话的回合；后台会话与它已经执行的点击、输入、文件修改不会回滚。
- 约 6 秒内未收到 Host 用户消息时，送达状态只能算“未知”：输入框为空才会自动放回；已有草稿时任务只留在「未确认的提交」卡片里。卡片能复制/放回，但这仍不能证明 Host 一定没有收到——再次发送前请按提示确认这是一次新提交。
- 未确认记录的迟到回显匹配依赖“同一会话 + 相同文本 + 最早发送”。同一会话中两个文本完全相同的提交按发送顺序关联；跨会话回放的同文本消息不会确认它。无法可靠关联时，记录保持“未知”，不会猜测成功。
- 真实虚拟键盘与焦点行为尚未验证；本轮没有采用持续抢焦点、全局键盘 Hook 或全局输入拦截，也没有关闭或修改 Free Virtual Keyboard。
- 本轮未改 rightpad、Android、Motion / M/C / B/X、Virtual HID、Harness 主程序与其他插件，也未安装进日常 Profile。
