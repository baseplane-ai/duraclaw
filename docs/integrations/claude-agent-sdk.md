# Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Source package / configuration: `packages/session-runner/package.json` (pin) and `packages/session-runner/src/claude-runner.ts` + `packages/session-runner/src/titler.ts` (call sites).

## Version

Pinned at `^0.2.119` in `packages/session-runner/package.json` -> `dependencies."@anthropic-ai/claude-agent-sdk"`. The matching native sidecars (`@anthropic-ai/claude-agent-sdk-linux-x64`, `-linux-x64-musl`) are pulled in transitively; `claude-runner.ts` resolves the glibc bin explicitly to avoid the SDK's musl-first lookup on Bun (see lines around 57).

## Footprint

The SDK is the library duraclaw wraps. Every runner is essentially a thin process that runs **one SDK `query()`** and pipes its events into the dial-back transport. Two runner shapes both depend on the SDK:

- `packages/session-runner/` — the per-session SDK owner. Calls `query(...)` for new turns and `query({resume: sdk_session_id})` for resume. Plumbs the SDK's `SessionStore` interface through `DuraclavSessionStore` (`session-store-adapter.ts`) so transcript bytes are mirrored into Durable Object SQLite. Registers `PostToolUse` hooks for file-change tracking. Imports `SDKAssistantMessageError` and the `SessionKey` / `SessionStore` / `SessionStoreEntry` types directly.
- `packages/session-runner/src/titler.ts` — a one-shot `query()` (different model, no tools, `maxTurns=1`, `settingSources: []` to disable project hooks) that runs in parallel with the main session to generate session titles.
- `packages/docs-runner/` — the same SDK wrapped for the docs-as-yjs subsystem (separate spawn target, separate bundle).

Surfaces consumed: `query()`, `SessionStore` (lossless cross-spawn resume), the SDK's hook system, and the message-shape types the runner translates into `GatewayEvent`s.

## Where session files live

The on-disk session file is a project-scoped artifact written by the SDK under the project directory (SDK convention). The runner reads it once per spawn via `query({resume})`. Duraclaw additionally **mirrors** transcript bytes into DO SQLite via the `SessionStore` adapter so an account-failover spawn (GH#119) can resume losslessly under a different identity / HOME — without the mirror, the new HOME's project dir would be empty.

## Assumptions

- The on-disk session file is the SDK's resume contract — read-once-per-spawn, **immutable per turn**, located under the project directory by SDK convention.
- The session file format is **stable across patch versions** (version skew between two spawned runners on the same session is implicitly allowed inside the `^0.2.119` semver range).
- `query()` is **single-call-per-turn** — duraclaw's runner stays alive across turns by blocking on a queue between SDK calls; it does not spin up a fresh `query()` per user message.
- Hook names / event shapes (`partial_assistant` from `stream_event.content_block_delta.text_delta` and `thinking_delta`, `assistant`, `tool_result`, `result`, etc.) are stable — the runner's event translator pattern-matches on them.
- The `SessionStore` interface (`append`, `load`, `delete`, `rewind`-style methods) is the SDK's official extensibility seam for transcript persistence and remains the supported way to interpose on transcript bytes.
- `query()` authenticates via the Claude Code OAuth subscription that the runner's `HOME` directory points at — no `ANTHROPIC_API_KEY` required.

## What would break if

- The session file format changed mid-version (or the SDK switched to a non-file resume model) -> every cross-spawn resume would fail, and account failover (GH#119) would lose its lossless invariant; duraclaw would need a parallel transcript-replay mechanism.
- The `SessionStore` interface were removed or changed signature -> the DO-SQLite mirror would silently stop working and the failover invariant would be at risk.
- Hook / event names changed without a SemVer-major bump -> the runner's translator would silently drop messages, manifesting as missing tool results or vanished thinking deltas.
- The OAuth-via-HOME auth model changed (e.g., requiring `ANTHROPIC_API_KEY` per-process) -> the identity-management subsystem would need to plumb keys instead of HOME directories.
- A SemVer-major SDK bump landing across only some runners during a rolling deploy -> two runners on the same session could disagree about file format; the bundle pipeline must always ship runners as a self-contained unit.

## See also

- [`docs/theory/boundaries.md`](../theory/boundaries.md) — `claude-agent-sdk` boundary entry.
- [`docs/theory/data.md`](../theory/data.md) — the SDK transcript file as the resume contract; how `SessionStore` makes failover lossless across identities.
- [`docs/theory/dynamics.md`](../theory/dynamics.md) — when resume vs. fresh-spawn fires (idle reaper, rate-limit cooldown, orphan recovery).
- `packages/session-runner/src/claude-runner.ts` — primary `query()` call site and resume path.
- `packages/session-runner/src/session-store-adapter.ts` — `DuraclavSessionStore` adapter implementing the SDK's `SessionStore` interface.
- `packages/session-runner/src/titler.ts` — secondary one-shot `query()` for title generation.
