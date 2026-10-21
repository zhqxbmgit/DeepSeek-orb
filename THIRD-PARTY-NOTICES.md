# Third-party notices

This project is an unofficial plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and includes code and assets derived from third-party sources. Their licenses are reproduced below as required. This project itself is licensed under [MIT](LICENSE).

## DeepSeek Harness (deepseek-ai/deepseek-harness)

- Website: https://github.com/deepseek-ai/deepseek-harness
- License: MIT, Copyright (c) 2026 DeepSeek

Portions of this repository are derived from, ported from, or vendored from the DeepSeek Harness repository and its published npm packages (`@deepseek-ai/*`), including but not limited to:

- `packages/helper/assets/observation-frame.css` — the glowing observation-frame style derived from the official desktop overlay.
- `packages/computer-use` — vendored from the official `packages/experimental/tool-computer-use` package, then renamed and modified.
- Observation-frame / overlay-guard semantics and timing constants ported from the official desktop app.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

DeepSeek, the DeepSeek logo, and the DeepSeek avatar artwork are trademarks or copyrighted works of DeepSeek AI. This unofficial project claims no affiliation with or endorsement by DeepSeek AI.

## dsh-orb-cordis (mini-yifan)

- Repository: https://github.com/mini-yifan/dsh-orb-cordis
- License: MIT

This build is an independent custom derivative of the original MIT-licensed dsh-orb-cordis plugin. Its copyright and license notice are preserved in [LICENSE](LICENSE).

## Other dependencies

Runtime and development dependencies declared in the workspace packages (for example `koffi`, `zod`, `tsdown`, `typescript`, `vitest`) keep their own licenses as published on npm; this repository does not vendor or redistribute their source.
