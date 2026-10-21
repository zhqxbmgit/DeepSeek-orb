# dsh-orb

English | [涓枃](README.zh-CN.md)

An unofficial personal custom build for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It keeps the official Harness and adds **main-window Computer Use** plus the observation ribbon. It does **not** provide a floating ball, a separate chat surface, or an automatic updater.

> **Disclaimer** 鈥?This is an independent project, not affiliated with, endorsed by, or connected to DeepSeek AI. DeepSeek and the DeepSeek logo belong to DeepSeek AI. The original dsh-orb project is MIT-licensed; its copyright, license, and source attribution are preserved in [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Repository and issue tracker: <https://github.com/zhqxbmgit/DeepSeek-orb>

## What this build is

The official Harness main window is the product. The Computer Use preset mounts the desktop tools, `code_agent` for background work, the rule/project inspection tool, and a settings section. The only auxiliary process is a small Electron window that draws the observation ribbon.

There is no floating ball, no ball chat panel, no avatar, no ball menu, no workspace/history entry, and no automatic plugin update. Updates are deliberate local-package installs of a checked tarball.

## Main-window Computer Use

- Screenshots, clicks, typing, scrolling, dragging, hotkeys, application switching, and post-action screenshots run from the main-window conversation.
- `code_agent` sends long investigations or artifact work to an independent background standard session. `code_agent_status` reports it; `code_agent_stop` cancels that background session's current turn and running command.
- `project_context` reports the working directory, project root, retained `AGENTS.md` chain, hashes, truncation/omission, and handoff files. Loader paths are resolved against the project root recorded at each loader event, so a session started in `project\src` reports both `project\AGENTS.md` and `project\src\AGENTS.md` correctly.
- `input_text` inserts text and only `submit: true` presses plain Enter. A newline in the text is inserted as a **Shift+Enter line break**, so a chat composer is not submitted by the body. Tab is inserted as a literal U+0009 character and never moves focus. Other control characters are rejected before the focus click.
- The `screenshot` tool saves one image to the Desktop and puts it on the clipboard.

## Observation ribbon

The ribbon marks the window region the Agent is observing. It is deliberately separate from the Agent's session:

- A minimal Electron process loads `observation-frame.html`, positions a transparent, non-focusable, click-through window around the observed rectangle, and acknowledges capture/input intervals.
- On Windows the frame uses `WDA_EXCLUDEFROMCAPTURE`, so it is visible to the user but never enters the Agent's screenshots. Clicks pass through it; it never takes the keyboard focus.
- The frame follows the reported rectangle across moves and display rescaling and hides on `turn/end`, cancellation, an invalid target, or a drawing failure.
- Settings shows whether the renderer is connecting, running, disabled, or failed, and provides a left-click **Restart ribbon renderer** action after a failure. It does not relaunch in an endless loop.
- Drawing a transparent always-on-top gradient frame needs a Chromium window. The plugin uses a pinned stock Electron runtime in an isolated `userData` directory; it does not reuse or modify the Harness executable. A cached runtime is reused; the first run may prepare/download it and the settings page reports that phase.

The helper has one job: draw, show, hide, and acknowledge. It owns no conversation, prompt, question, avatar, history, workspace, or update state.

## Rules, project scope, and evidence

- The official `@deepseek-ai/dsh-agent-instructions` loader remains the only component that injects rule prose. `project_context` reports only paths, byte counts, SHA-1 evidence hashes, loader digests, and omission/truncation state.
- A loader `changes[].path` is project-relative. Each retained record keeps the `cwd` and `projectRoot` that were effective when its loader message was produced. `baseline_project_root` and `latest_loader_project_root` are reported separately.
- When provenance is missing, the report stays `unconfirmed` rather than guessing from identical text or rebinding old records to the current directory.
- The evidence runner under `runtime/` records raw stdout/stderr, separate exit-code fields, encoding checks, truncation, and its own timeouts. A bare exit 0 is not tests-passed or deployed.

## Install

Use only a local tarball that you inspected:

```sh
dsh plugin add ./dsh-orb-0.2.17.tgz
```

There is no automatic check of the upstream release source and no public-registry update path in this build. Keep old tarballs; do not install the public `dsh-orb` over this custom build.

## Build from source

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm --filter dsh-orb run pack
```

`run` is required. The pack script assembles the package and its runtime dependencies (`koffi`, `zod`, and the koffi platform prebuilds) into `dsh-orb-<version>.tgz`.

## Requirements

- DeepSeek Harness with the Web UI (desktop app or `dsh web`), built against dsh `0.1.7-rc.2`; declared compatibility is `>=0.1.7-rc.2 <0.3.0-0`.
- Windows x64 or macOS. Linux loads the settings/background pieces but has no GUI backend or ribbon.
- Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0` when building from source.

## Stop semantics

- Stopping the current conversation cancels its current turn; the active tool receives `AbortError` and the owned command process ends. Clicks, typing, and file edits already performed are not rolled back.
- Queued messages are retained (`keepInbox: true`) but were not observed to start automatically in a 25-second check. Retention is not proof of permanent cancellation, and the old queue's recovery condition is unconfirmed; do not assume a manual resend can never duplicate work.
- A background `code_agent` is a separate session and keeps running when the main turn stops. `code_agent_stop` stops that target. Its completion notice can still wake the stopped conversation.
- The plugin does not add a global pause system or change the official scheduler.

## Status and limitations

- User acceptance with the Comfort On-Screen Keyboard and the one-finger rightpad workflow is not replaced by automated tests.
- Multi-display and mixed-DPI ribbon behavior has only limited coverage; the main tested display was 1920脳1080 at 200% scaling.
- The helper's first use may need the cached Electron runtime; the download path is pinned and settings exposes failure/restart, but a machine without network cannot draw the ribbon until a runtime is present.
- This custom build is not published to the public registry. Use the local tarball.

## License and upstream

[MIT](LICENSE). This project is an independent derivative of the MIT-licensed [mini-yifan/dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis) and uses the official DeepSeek Harness without modifying it. Upstream-derived code and assets are disclosed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
