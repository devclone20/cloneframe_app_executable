# Tmux-Orchestrator — third-party engine (vendored as git submodule)

- **Origin:** https://github.com/Jedward23/Tmux-Orchestrator
- **License:** MIT — the upstream repo has **no standalone `LICENSE` file**; the MIT
  grant is stated in its `README`, so the full MIT text is reproduced below (as the
  integration plan requires).
- **Role in CLONE FRAME HUB:** runs a crew of Claude agents in `tmux` windows,
  surfaced in the **HARNESS → ORCHESTRATOR** frame.
- **Integration boundary:** used **unmodified** via its shell scripts and the `tmux`
  CLI. The bridge opens a real PTY running `tmux new/attach`; the orchestrator's
  `schedule` / `send-keys` scripts run as ordinary shell commands. No source is copied
  in and no code is linked in-process.
- **Version pin:** recorded by the submodule gitlink at ship time. Informational
  reference commit at authoring time (2026-07-14): `71935302`.

## Runtime dependency: tmux (ISC)

Tmux-Orchestrator drives **tmux**, which is **not bundled** — it is expected to be
already installed on the host (`command -v tmux`). tmux is licensed **ISC**
(https://github.com/tmux/tmux). Attribution only; no tmux source ships with this app.

## MIT License (reproduced — Tmux-Orchestrator)

```
MIT License

Copyright (c) Tmux-Orchestrator authors
(https://github.com/Jedward23/Tmux-Orchestrator)

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

> If upstream later adds a canonical `LICENSE`/copyright line, replace the
> copyright holder above with the exact upstream text.
