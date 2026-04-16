---
date: 2026-04-16
topic: PTY-based gateway — frankentui WASM vs xterm.js PTY streaming
status: complete
type: library-evaluation + feasibility
github_issue: null
related:
  - planning/research/2026-04-10-agent-sdk-gap-analysis.md
  - planning/research/2026-04-10-pluggable-agent-gateway.md
---

# Research: PTY Gateway — frankentui WASM vs. xterm.js Streaming

## Context & Motivation

The agent-gateway currently drives `@anthropic-ai/claude-agent-sdk` (`packages/agent-gateway/src/adapters/claude.ts`) to run Claude Code sessions. The 2026-04-10 SDK gap analysis documented that the SDK is a **strict subset** of the Claude Code TUI: checkpoint/rewind, context-usage, task events, hooks, session-state transitions, rate-limit events, prompt suggestions, and more either lag or are missing entirely. New TUI features (DEC 2026 alt-screen, Kitty keyboard protocol, Remote Control, AutoDream, etc. — see Q1 2026 changelog) land in the TUI first and the SDK plays catch-up.

**Hypothesis under evaluation:** replace (or augment) the SDK adapter with a PTY that spawns the real `claude` CLI, then either:

- **Option A — xterm.js streaming:** pipe raw ANSI/VT bytes from the PTY over WebSocket, render with xterm.js in the browser.
- **Option B — frankentui WASM:** render the TUI inside a WASM module in the browser.

This document evaluates both, with an explicit feasibility verdict on frankentui.

## TL;DR

- **Option B is not viable.** `frankentui` is a **widget framework** compiled to WASM, not a terminal emulator. It renders apps *built with its own widget API* to WebGPU; it does **not** parse ANSI/VT, has explicit "no-xterm.js" guidance, and does not host external PTY programs. It cannot render `claude`'s TUI.
- **Option A is viable and well-trodden.** Many OSS projects (`clsh`, `claude-conduit`, `claude-remote-terminal`, `247-claude-code-remote`, `CloudeCode`, `Kurogoma4D/claude-code-server`) already ship the pattern: `node-pty` (or Bun PTY) spawns `claude`, `xterm.js` on the browser side, WebSocket bridge in the middle.
- **Recommended direction:** a **hybrid, opt-in secondary adapter**, not a replacement. Keep the SDK path for structured message rendering (ai-elements, DB persistence, multi-session switching); add a PTY adapter behind the existing `AgentAdapter` interface for a "raw TUI" view when parity gaps bite. Wrap PTY sessions in `tmux` for persistence/reconnect.

## Research Type

Library/tech evaluation combined with feasibility study. Methodology: read frankentui README + landing page, check gateway source, compare with prior-art PTY-in-browser projects, cross-reference 2026-04-10 SDK gap analysis.

---

## 1. frankentui — Technical Fit

### What it actually is

Per [github.com/Dicklesworthstone/frankentui](https://github.com/Dicklesworthstone/frankentui) and [frankentui.com](https://frankentui.com/):

- **Rust TUI kernel** (~850K LOC, 20 crates, nightly toolchain, MIT + OpenAI/Anthropic rider).
- Layered architecture: `ftui-core` (lifecycle/events) → `ftui-render` (diff/ANSI presenter) → `ftui-layout` (flex/grid/panes) → `ftui-runtime` (Elm-style model/update/view) → `ftui-widgets` (80+ widgets) → `ftui-style` (CSS-like themes).
- **Targets:** native terminal (via `ftui-tty`) and **browser/WASM** (via `ftui-web` + `ftui-showcase-wasm`). Web build uses **wasm-pack + WebGPU canvas rendering**, ~3.4 MB WASM bundle, "60fps zero-GC" claims.
- `ftui-pty` exists but is labelled "PTY-based test utilities" — it drives an `ftui` app through a PTY for testing, not the other way around.

### Critical finding: frankentui cannot host `claude`

- It is **not a terminal emulator**. It does not consume ANSI/VT byte streams. It consumes events (`ftui-core::event::Event`) and produces frames rendered directly to WebGPU — bypassing the DOM/ANSI pipeline entirely.
- The project page explicitly contrasts itself with xterm.js/hterm: *"GPU draws directly to a canvas at 60fps. No DOM nodes, no layout thrashing"* and *"explicit no-xterm.js guidance"*. It positions as a **replacement** for xterm.js-style terminals, not a compatible layer.
- To render `claude`'s TUI with frankentui, someone would have to **port `claude`'s UI** to frankentui's widget API. `claude` is a closed-source Node/React-Ink-ish TUI; we don't have the source and wouldn't want to maintain a fork.

### Could it still be useful?

Narrow scenario: if we **wrote our own TUI** for Duraclaw (custom orchestrator TUI, not `claude`), frankentui would be a strong candidate for a unified native+web renderer. That's a separate product decision, not a gateway-parity solution. **For the stated problem, frankentui is the wrong tool.**

### Verdict on Option B

**Infeasible.** Moving on.

---

## 2. Option A — PTY + xterm.js Streaming

### Architecture sketch

```
Browser (xterm.js)
  │  WebSocket (binary + JSON control frames)
  ▼
CF Worker (pass-through via tunnel, no message parsing)
  ▼
Gateway (Bun)
  ├─ spawn `claude` in PTY  ←── [or `tmux new-session -d -s <id> claude`]
  ├─ stdout/stderr → binary frames → WS
  └─ WS → stdin, SIGWINCH on resize control frame
```

- **Transport:** our existing WebSocket already handles JSON. Adding binary frames for PTY bytes is cheap. Control frames stay JSON (`resize`, `signal`, `tmux-attach`).
- **PTY library:** Bun has native PTY via `spawn({ stdio: ['pipe', 'pipe', 'pipe'] })` with a TTY helper, or we can use `@lydell/node-pty` / `@homebridge/node-pty-prebuilt-multiarch` if Bun's support is insufficient. Need to verify Bun PTY maturity before committing.
- **Persistence:** wrap in `tmux new-session -d -s duraclaw-<sessionId>` so the browser can detach/reattach, multiple clients can mirror, and scrollback survives WS drops. Prior art (`clsh`) does exactly this.
- **Browser:** `xterm.js` + `xterm-addon-fit` + `xterm-addon-webgl` (GPU renderer). ~200KB gzipped.

### Prior art (all follow this pattern)

| Project | Stack | Notes |
|---|---|---|
| `QuivrHQ/247-claude-code-remote` | Express + ws + node-pty, Next.js + xterm.js | Tailscale for transport; Fly.io VM provisioning |
| `my-claude-utils/clsh` | Express + ws + node-pty + tmux | Tmux wrapping for persistence — closest to what we want |
| `A-Somniatore/claude-conduit` | Mac daemon + WebSocket + xterm.js | Discovers Claude sessions on host |
| `ishaquehassan/claude-remote-terminal` | PTY + xterm.js in Android wrapper | Mobile-first, LAN discovery |
| `Adoom666/CloudeCode` | PTY + WebSocket + Cloudflare tunnel | Same tunnel pattern as ours |
| `Kurogoma4D/claude-code-server` | WebSocket + PTY + web UI | Minimal reference implementation |

None of them get rich message rendering — they are raw terminal views. That's the core trade-off.

### What we **gain**

1. **Automatic feature parity** with Claude Code TUI. Every new TUI feature (DEC 2026 alt-screen, Kitty kbd, prompt suggestions, AutoDream UI, etc.) works the day it ships in `claude`.
2. **No SDK version pinning drift.** SDK 0.2.98 → 0.3.x migrations no longer block us.
3. **Real slash commands work.** `/resume`, `/login`, `/config`, any user-installed commands — all "just work" because the TUI handles them.
4. **Checkpoints, rewind, context display** — all the Tier 1 gaps from the 2026-04-10 analysis come free.

### What we **lose**

1. **Structured message UI.** ai-elements rendering, per-turn cards, tool-call inspector, file-change overlays — all depend on `GatewayEvent` JSON. A raw ANSI stream has no semantics. We'd either drop those features in PTY mode or build a screen-scraper (fragile).
2. **Database persistence of messages.** SessionAgent DO today persists `GatewayEvent`s into SQLite. An ANSI stream doesn't map cleanly. We'd persist raw bytes and lose queryability.
3. **Orchestrator value-add.** Cmd+K fuzzy finder over messages, file-change tracking (issue #40), mobile swipe previews (issue #31) — these are meaningful *because* messages are structured. In raw-TUI mode they degrade to "show a terminal".
4. **Tool-use permission UI.** Our `AskUserQuestion` / `permission_request` flow intercepts tools via SDK `canUseTool`. In PTY mode, the TUI handles its own prompts and we only see the rendered output.
5. **Multi-client coherence.** The TUI assumes single-controller. Mirroring to multiple browsers needs tmux + read-only observers for non-driving clients.
6. **Bandwidth & mobile.** ANSI streams spike hard during compilation output, npm install, etc. SDK messages are more compact.
7. **Testability regression.** Current adapter is unit-testable (`claude.test.ts`, `codex.test.ts`); PTY + tmux integration tests are noticeably harder.

### Risks specific to our stack

- **Cloudflare Worker passthrough.** We already proxy WS through a Worker. Binary frames are fine, but Worker WS has per-message size caps and cumulative-duration limits — need to verify under sustained PTY throughput.
- **Durable Object fit.** `SessionAgent` DO is designed around `GatewayEvent` JSON. Pushing raw bytes through it defeats its purpose (message history, replay). Options: (a) DO becomes a transparent byte pipe for PTY mode; (b) skip DO for PTY mode and use a direct tunnel route.
- **Bun PTY maturity.** Unknown. Needs a 1-day spike. If weak, drop to `node-pty` on a small Node sidecar.
- **Authentication inside `claude`.** The CLI uses `~/.claude/auth.json` on the VPS. Multi-tenant orchestrator would need per-user `$CLAUDE_CONFIG_DIR` — doable but an extra axis.

---

## 3. Comparison Matrix

| Criterion | SDK adapter (status quo) | PTY + xterm.js (Option A) | PTY + frankentui (Option B) |
|---|---|---|---|
| Feature parity with TUI | Partial, lagging | **Automatic, full** | N/A (can't host `claude`) |
| Structured messages | **Yes** | No (raw ANSI) | N/A |
| Rich UI (ai-elements, cards) | **Yes** | No | N/A |
| Checkpoint/rewind, context %, task events | Missing/partial | **Yes (via TUI)** | N/A |
| Multi-client mirror | Built-in via DO | Needs tmux + observers | N/A |
| Mobile-friendly | **Yes** | OK (xterm.js works) | N/A |
| Persistence across reconnect | DO replay | tmux attach | N/A |
| Bandwidth | Low | Medium-High (bursty) | N/A |
| Implementation cost | 0 (exists) | ~1-2 sprints | ∞ (would require porting `claude`'s UI) |
| Ongoing maintenance | SDK version churn | `claude` CLI arg drift, tmux ops | — |

---

## 4. Recommendation

### Don't pursue frankentui for this problem

It's a great project for a different job (building our own TUI with a shared native+web renderer). It cannot solve "render Claude Code TUI in the browser" because it is not a VT emulator and does not host PTY programs.

### Pursue PTY + xterm.js as a **secondary adapter**, not a replacement

Concretely, in order of cost:

1. **Short-term: close SDK Tier-1 gaps** per 2026-04-10 research. `interrupt()`, `setModel()`, `setPermissionMode()`, `rewindFiles()`, context-usage, rate-limit events, session-state events. That recovers ~80% of current parity pain at low cost and preserves structured UI.

2. **Medium-term: add a `PtyClaudeAdapter`** implementing `AgentAdapter` alongside `ClaudeAdapter`:
   - Spawn `claude` inside `tmux` (`tmux new -d -s duraclaw-<sessionId>`; attach with `tmux attach -t ...`).
   - Add `terminal_bytes` / `terminal_resize` / `terminal_signal` variants to `GatewayEvent` / `VpsCommand`.
   - Orchestrator gets a per-session "Terminal" tab powered by xterm.js; existing structured tab continues to run on the SDK adapter.
   - User toggles which adapter drives new sessions; both can coexist for the same project.

3. **Long-term: reconsider once SDK stabilizes.** If the SDK catches up on checkpointing/rewind and Remote Control, retire the PTY adapter or keep it as a power-user escape hatch.

### Why hybrid over replacement

The orchestrator's value is **not** "render a terminal in the browser" — dozens of OSS projects already do that. Its value is multi-session orchestration, structured message history, file-change tracking, fuzzy finder, mobile previews. Those features require structured data. Replacing the SDK adapter with raw PTY throws away the structured channel and regresses the product.

A PTY adapter is an **escape hatch** for parity gaps, not the primary path.

---

## 5. Spike Plan (if we proceed with Option A)

One week of work to de-risk:

1. **Day 1:** Bun PTY spike. Spawn `bash` in a PTY from Bun, echo bytes over WS, verify resize via `SIGWINCH`. If Bun's PTY is weak, decide whether to add a minimal Node sidecar or shell out to `script`/`unbuffer`.
2. **Day 2:** xterm.js integration in orchestrator. Standalone page, binary WS, `FitAddon`, `WebglAddon`, keyboard + paste working.
3. **Day 3:** tmux wrapper — attach/detach, mirror two browsers against same session, verify scrollback survives WS drop.
4. **Day 4:** `PtyClaudeAdapter` skeleton, protocol variants, capability flag so orchestrator chooses between SDK vs PTY at session creation.
5. **Day 5:** Mobile smoke test (iOS Safari, Android Chrome), CF Worker WS bandwidth under compile-heavy workload, teardown/cleanup on abort, end-to-end demo.

Gate at day 5: if mobile or CF WS throughput is rough, park the feature behind a flag; if clean, ship behind a per-session opt-in.

---

## 6. Open Questions

- Does CF Workers WebSocket sustain ≥500 KB/s throughput per connection for the duration of long PTY sessions without hitting billing/time limits? Needs measurement.
- Do we want tmux on the VPS at all (adds a dep + ops surface), or is an in-process ring buffer + replay enough for our reconnect needs?
- Should the orchestrator's existing `SessionAgent` DO be the pipe for PTY bytes (to keep the single-WS-per-session model), or should PTY sessions use a second route that bypasses the DO?
- Auth scoping: per-user `CLAUDE_CONFIG_DIR` for `claude` login state in a multi-tenant world — where does that config live and who manages rotation?

---

## 7. Sources

- [github.com/Dicklesworthstone/frankentui](https://github.com/Dicklesworthstone/frankentui)
- [frankentui.com](https://frankentui.com/) — landing/feature page
- [frankentui.com/web](https://frankentui.com/web) — live WASM demo
- [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)
- [github.com/microsoft/node-pty](https://github.com/microsoft/node-pty)
- [github.com/mame/xterm-pty](https://github.com/mame/xterm-pty)
- Prior art: [247-claude-code-remote](https://github.com/QuivrHQ/247-claude-code-remote), [clsh](https://github.com/my-claude-utils/clsh), [claude-conduit](https://github.com/A-Somniatore/claude-conduit), [claude-remote-terminal](https://github.com/ishaquehassan/claude-remote-terminal), [CloudeCode](https://github.com/Adoom666/CloudeCode), [claude-code-server](https://github.com/Kurogoma4D/claude-code-server)
- Internal: `planning/research/2026-04-10-agent-sdk-gap-analysis.md`, `planning/research/2026-04-10-pluggable-agent-gateway.md`, `packages/agent-gateway/src/adapters/claude.ts`
