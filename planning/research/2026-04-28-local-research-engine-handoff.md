---
date: 2026-04-28
topic: Research engine — local sessions handed off to Duraclaw
type: brainstorm
status: complete
github_issue: null
items_researched: 5
---

# Research: Local research engine with handoff to Duraclaw

## Context

Open-ended product prompt: *"Research engine that lets users run local
sessions that can be picked up by Duraclaw."*

Disambiguated with the user as **handoff-only**: a local engine runs
Claude sessions independently on the user's machine, and on demand the
user pushes the session into Duraclaw, which spawns a cloud runner that
continues from where the local one left off. **No live transcript
sync.** No bidirectional flow. No "BYO-runner" symmetry where the cloud
treats the laptop as just another execution target.

The framing is deliberately narrow. Live observability, mobile mirroring
of in-flight local sessions, and laptop-as-execution-target for
Duraclaw-initiated work are explicitly out of scope for this round.

## Scope

| Item | Goal |
|------|------|
| SDK local session file format | What the SDK persists locally and what `resume()` consumes |
| Duraclaw resume + forkWithHistory paths | Existing primitives we'd build the pickup on |
| Identity / auth boundary | What happens when a session crosses from user creds to VPS identity creds |
| Workspace / path portability | Whether a transcript captured on `/Users/jane/proj` survives resume on `/srv/.../proj` |
| Prior art in the codebase | Adjacent specs and existing patterns that should inform the design |

## Findings

### 1. SDK session file & cross-machine resume

The Claude Agent SDK writes per-session JSONL to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Encoded cwd is
the absolute path with `/` replaced by `-` (djb2-hashed if >200 chars).
Each line is a `SessionStoreEntry` (opaque to consumers, indexed by
`(session_id, subpath, seq)`).

`query({resume: session_id, cwd})` is **disk-only**: the SDK derives the
project key from cwd, looks up `~/.claude/projects/<key>/<id>.jsonl`,
and reads it. There is no API to pass session content inline.

Duraclaw bypasses raw disk via the GH#119 SessionStore bridge:
`DuraclavSessionStore` in `packages/session-runner/src/session-store-adapter.ts:36-58`
RPCs to the DO (`SessionDO.loadTranscriptImpl`,
`apps/orchestrator/src/agents/session-do/transcript.ts:91-115`), which
serves entries from the per-session SQLite `session_transcript` table
(`apps/orchestrator/src/agents/session-do-migrations.ts:370-383`). With
`session_store_enabled: true`, the SDK never touches the runner's local
disk for prior turns — it pulls them from the DO over RPC.

**Cross-machine implication.** SDK-native `resume` across machines
requires either (a) physically copying the JSONL into the destination's
SDK project directory, or (b) the DO already holding the transcript and
the destination opting into SessionStore mode. Today only sessions that
*started inside Duraclaw* end up in the DO's `session_transcript`
table — a session that started on a user's laptop has no DO presence.

**Cited:** `packages/session-runner/src/claude-runner.ts:614-617,
757-761`; `apps/orchestrator/src/agents/session-do/runner-link.ts:304-340`;
`scripts/backfill-d1-sessions.py:1-100`; `CLAUDE.md:128-169`.

### 2. Duraclaw already has the right primitives

Two existing DO mechanisms span the design space for "pickup":

**Resume path** — `resumeDiscoveredImpl()` in
`apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:212-300`
constructs a `ResumeCommand` carrying `runner_session_id`, dials the
gateway via `triggerGatewayDial({type:'resume', ...})` in
`runner-link.ts:304-340`, and the runner calls `query({resume,
cwd})` against the SDK. Used after the 30-min idle reaper kills the
runner and the user sends a follow-up.

**Fork-with-history path** — `forkWithHistoryImpl()` in
`apps/orchestrator/src/agents/session-do/branches.ts:242-357`. It walks
local SDK history, builds a plain-text transcript via
`serializeHistoryForFork` (line 124), wraps it in
`<prior_conversation>...</prior_conversation>`, prefixes the user's new
content (line 313), and dials `triggerGatewayDial({type:'execute',
prompt: forkedPrompt})` (line 350). Note: `execute`, not `resume` — a
brand new SDK session, with the prior conversation as plain context.

The orphan auto-fork at `packages/session-runner/src/rpc-messages.ts:155-178`
already uses this flow when a stale runner is detected on the gateway.

**Cited:** `apps/orchestrator/src/agents/session-do/branches.ts:124-357`;
`packages/session-runner/src/main.ts:535-538`;
`.claude/rules/session-lifecycle.md`.

### 3. Path portability — the deciding constraint

This is the single finding that pins the design choice.

Tool-use entries in the JSONL store absolute paths **verbatim**. A
session recorded on a Mac at `/Users/jane/proj/` will contain
`Read { file_path: "/Users/jane/proj/src/index.ts" }` in the
transcript. There is no path-rewriting layer in the runner or
transcript adapter.

Two consequences for resume on the VPS at `/srv/duraclaw/.../proj/`:

1. The model re-reads its prior context from the transcript and may
   re-emit a tool call against `/Users/jane/...`. Tool fails on Linux
   FS — file not found.
2. The SDK's `rewindFiles()` may attempt to re-execute prior file
   operations against the captured paths. Same failure.

**`forkWithHistory` sidesteps both** because the model only sees the
serialised conversation as text. New tool calls execute against the
fresh cwd that Duraclaw stamped onto the runner spawn (resolved through
`packages/session-runner/src/project-resolver.ts:13-30`, with optional
`worktree_path` override from spec #115). Paths mentioned in the prior
text are read context only.

**Verdict.** For laptop → cloud handoff, **always
fork-with-history**. Raw SDK resume across machines is a trap.

### 4. Identity / auth boundary is clean

The HOME-scoped identity model (`CLAUDE.md:128-169`) cleanly separates
auth from session content:

- Session files are auth-agnostic. Anthropic's API correlates by
  `session_id`; whatever bearer the runner presents at request time is
  used for billing.
- Duraclaw selects an LRU identity at spawn (`runner-link.ts:201-289`),
  the gateway sets `HOME=<runner_home>` on the spawned process
  (`packages/agent-gateway/src/handlers.ts:287-292`), and the SDK reads
  `${HOME}/.claude/.credentials.json`.

A session that ran under the user's personal Pro/Max subscription on
their laptop can be continued under VPS identity `work1` with no
session-file change.

Real concerns are second-order:

- **Model tier mismatch.** If the local session used Opus and the
  VPS identity is on a tier that doesn't include it, the resume
  request 401s. Duraclaw already detects `authentication_failed` and
  fails over to the next identity (GH#119 P3), but if no identity has
  the requested model, the session fails hard with no degradation
  path. *Open.*
- **Prompt-cache attribution.** Cache is account-scoped. Resume under
  a different identity is a cache miss. Cost amplification is
  proportional to transcript length × resume frequency. Manageable.
- **Permission gate shift.** Local user may have run under
  `acceptEdits`; VPS identity's preference might be `default`. Tools
  that auto-approved locally start gating after handoff. By design,
  but the UI should say so.

`forkWithHistory` already drops the original `runner_session_id` and
rolls fresh, which means the cloud runner is just a new execute under
whatever identity LRU picks. None of the above is a blocker.

### 5. Prior art — everything we need exists

Four pieces of adjacent infrastructure de-risk the implementation:

- **`forkWithHistory` itself** (`branches.ts:242-357`) is the handoff
  primitive. We don't need a new RPC or wire shape — we need a new
  *origin* for the transcript content.
- **docs-runner** (`packages/docs-runner/`, spec #27) proves multiple
  runner types coexist in the cluster cleanly via dial-back auth and
  `role=` query-param multiplexing. A future "local runner with live
  observability" follows this template — but that's out of scope for
  handoff-only.
- **Spec #30 (RunnerHost / pluggable adapters)** introduces a
  `RunnerHost` axis (`vps-process | cloud | desktop`) and an
  `AdapterCapabilities` bitmap. A `desktop` host slots in here when
  we eventually want symmetric local execution. *Not needed for
  this feature; flag as the natural next layer.*
- **Spec #115 (worktrees as first-class resources)** lets us bind the
  cloud-side resumed session to an explicit worktree path via the new
  `worktree_path` field on `ExecuteCommand`. The handoff payload should
  carry a worktree reference (project name or worktreeId) so the cloud
  runner lands in the right clone.

There is **no existing "import session" or "export transcript" API**
on the orchestrator. The closest thing — `forkWithHistory` — accepts
content from a *child of an existing DO session*. We need a sibling
endpoint that accepts content from outside the cluster.

**Cited:** `planning/research/2026-04-27-cloud-runner-abstraction.md`;
`planning/specs/30-runner-adapter-pluggable.md`;
`planning/specs/27-docs-as-yjs-dialback-runners.md`;
`planning/specs/115-worktrees-first-class-resource.md`;
`planning/research/2026-04-20-session-state-surface-inventory.md`.

## Comparison: how to wire the "pickup" semantically

| Approach | Mechanic | Cross-machine works? | New code | Verdict |
|----------|----------|----------------------|----------|---------|
| **Raw SDK resume** | Copy JSONL to VPS HOME, `query({resume, cwd})` | Brittle — absolute paths in tool-use entries break on FS mismatch | File-sync, path normalisation, identity HOME injection | **Reject** |
| **SessionStore-mediated resume** | Pre-populate DO `session_transcript` from local JSONL, runner pulls via RPC | Same path-portability problem; SessionStore stores the same stale entries | Transcript-import RPC + verify SessionStore handles missing tool-result files | **Reject** for handoff (overkill, doesn't fix path issue) |
| **Fork-with-history from external transcript** | Local engine serialises conversation as text, POSTs to a new `/api/sessions/handoff` endpoint, DO inserts a fresh DO session and dials `execute` with `<prior_conversation>` envelope | Yes — text-only context, fresh tool-call cwd | New API endpoint + a thin local CLI; `serializeHistoryForFork` already exists and is reusable | **Recommended** |

## Recommendations

### Architecture (one paragraph)

The "research engine" is a small local CLI (Bun-executable, shipped via
`packages/local-engine/` or similar) that wraps the Claude Agent SDK
with research-tuned defaults and runs sessions entirely on the user's
laptop using their personal credentials. When the user is ready to
hand off, the CLI extracts the session's user/assistant turns,
serialises them with the existing `serializeHistoryForFork` shape, and
POSTs to a new `POST /api/sessions/handoff` endpoint on the
orchestrator. That endpoint creates a fresh `SessionDO`, persists the
transcript into DO history, and triggers
`triggerGatewayDial({type:'execute', prompt: '<prior_conversation>...
</prior_conversation>\n\nContinuing on Duraclaw...'})`. From that
moment the session is a normal Duraclaw cloud session — visible in
the orchestrator UI, available on mobile, subject to LRU identity
selection, observable via the standard event stream.

### What the local CLI is, concretely

Three commands, MVP:

```
duraclaw-local research "your prompt"     # interactive local session
duraclaw-local list                        # local sessions waiting for handoff
duraclaw-local handoff <session-id>        # push to Duraclaw
```

Behaviour:

- `research` runs an SDK `query()` in stream-input mode against the
  user's cwd. Session JSONL writes to `~/.claude/projects/<encoded>/...`
  as normal. The CLI keeps a `~/.duraclaw/local-engine/sessions.json`
  index mapping local session-id → cwd → last turn timestamp →
  `handed_off: bool`.
- `handoff` reads the JSONL, walks user/assistant turns into a
  fork-with-history-shaped string, prompts for the target Duraclaw
  project (or accepts `--project`), and POSTs the payload to
  `https://<orch>/api/sessions/handoff` using a PAT stored in
  `~/.duraclaw/config.json` (issued from Settings → "Local Engine").
- After a successful handoff, the CLI prints the orchestrator URL
  for the new cloud session and marks the local session
  `handed_off: true`.

### What "research-tuned defaults" buys us

This is the differentiator vs. "user just runs `claude` directly":

- **Research-mode system prompt** — bias toward read-only exploration,
  surface findings, avoid mutation. Cuts cost (no Edit churn) and
  matches the user's intent of "research now, implement on Duraclaw
  later".
- **Permission profile** — Read/Grep/Glob/WebSearch auto-approved,
  Edit/Write/Bash gated. (Or fully read-only if we want to be strict.)
- **Output capture for handoff** — the CLI watches for a
  `# Findings` / `# Recommendation` markdown section in the assistant
  output and surfaces it as the suggested handoff blurb when the user
  runs `handoff`.

This is also what makes "research engine" the right name (rather than
"local-runner" or "BYO-runner") — the local side is opinionated for
research, even though the same plumbing could later host any local
session type.

### What changes server-side

Minimal:

- **New API route**: `POST /api/sessions/handoff` in
  `apps/orchestrator/src/api/sessions.ts` (or wherever fork lives).
  Payload: `{ project, transcript: string, opening_prompt?: string,
  metadata?: {...} }`. Auth: PAT bearer.
- **DO entry point**: a sibling of `forkWithHistoryImpl` —
  `pickupFromExternalImpl(transcriptText, openingPrompt)` — that
  creates a fresh `SessionDO`, persists the transcript as history rows
  (so the UI shows the prior turns), and dials `execute` with the
  existing prior-conversation envelope.
- **Optional**: a `source: 'local-handoff'` tag on `agent_sessions`
  for analytics ("how often is this used?"). Trivial column addition.

No `shared-types` change strictly required — the new endpoint payload
is internal to the orchestrator. We can add a typed shape later if the
local engine is published as a public package.

### Phasing

- **P1 — Server-side handoff endpoint + UI affordance.** Ship
  `POST /api/sessions/handoff`, the DO `pickupFromExternalImpl`, and a
  Settings → "Local Engine" panel that issues a PAT and shows a
  one-line install command. Manually testable with `curl`. ~1 spec.
- **P2 — Local CLI MVP.** `packages/local-engine/` with the three
  commands above. Bun-built, distributed via npm + `npx`. Ships with
  research-mode defaults baked in. ~1 spec.
- **P3 — File-state handoff (deferred).** If the local session edited
  files, those changes are on the laptop, not in the cloud worktree.
  MVP says "user is expected to push their git changes; Duraclaw's
  worktree syncs from the branch." A later feature could include a
  unified diff in the handoff payload that the orchestrator applies
  to the worktree before spawning. *Out of scope for this round; call
  out as a known gap.*
- **P4 — Live observability (out of scope per user direction).** A
  future symmetric-host story that builds on spec #30's `RunnerHost`
  abstraction and the docs-runner dial-back template. Park indefinitely.

## Open questions

1. **PAT scope and lifetime.** Single short-lived token per handoff,
   or a long-lived per-laptop PAT in Settings? Suggest the latter for
   ergonomics, with revoke.
2. **Multiple Duraclaw projects on one laptop.** `--project` flag and a
   per-cwd default mapping in `~/.duraclaw/config.json`. Probably
   fine; flag for spec.
3. **Local session encryption at rest.** SDK JSONL is plaintext on the
   user's disk. If a session contains secrets, handoff payload
   inherits that. Document as a property of the SDK, not Duraclaw —
   no mitigation needed in MVP.
4. **What if the local session is mid-tool-call?** The handoff snapshot
   should refuse to ship if the last turn is an unanswered tool-use
   (`pending_tool_use`). Land the tool first, then hand off. Trivial
   guard in the CLI.
5. **Transcript size limits.** Handoff payload is JSON over HTTPS to a
   CF Worker — body limit 100MB. A 50-turn research session is
   nowhere near that, but very long sessions could exceed. R2-based
   indirection is a P3 concern at best.

## Next steps

1. **Land this doc.** It's the design intent — let it sit one cycle for
   pushback before specs.
2. **Open GH issue: "Local research engine — handoff to Duraclaw."**
   Link this doc; mark `roadmap:exploring`. The user (jhillbht) can
   confirm or redirect.
3. **If approved, write spec for P1** — server-side handoff endpoint.
   Behaviours: B1 endpoint accepts payload, B2 DO creates session
   with persisted history, B3 cloud runner spawns and emits standard
   events, B4 UI shows session as "Imported from local engine."
4. **If P1 approved, write spec for P2** — local CLI MVP.
5. **Don't pre-build P3/P4.** Validate the handoff workflow with real
   research sessions first. The "user has to push git themselves"
   limitation is the most important UX question to test, and the
   answer drives whether P3 (file-state handoff) is worth building.

## Citations

- `packages/session-runner/src/claude-runner.ts:614-617, 757-761` — SDK resume invocation
- `packages/session-runner/src/session-store-adapter.ts:36-58` — DuraclavSessionStore RPC
- `packages/session-runner/src/main.ts:535-538` — runner cmd dispatch
- `packages/session-runner/src/rpc-messages.ts:155-178` — orphan auto-fork
- `apps/orchestrator/src/agents/session-do/branches.ts:124, 242-357` — forkWithHistory
- `apps/orchestrator/src/agents/session-do/rpc-lifecycle.ts:212-300` — resumeDiscoveredImpl
- `apps/orchestrator/src/agents/session-do/runner-link.ts:201-340` — identity LRU + gateway dial
- `apps/orchestrator/src/agents/session-do/transcript.ts:39-115` — DO SessionStore
- `apps/orchestrator/src/agents/session-do-migrations.ts:370-383` — session_transcript schema
- `apps/orchestrator/src/db/schema.ts` — runner_identities, agent_sessions
- `packages/agent-gateway/src/handlers.ts:212, 287-292` — POST /sessions/start, HOME injection
- `packages/agent-gateway/src/docs-runner-handlers.ts` — second-runner-type pattern
- `packages/docs-runner/` — second-runner-type proof
- `scripts/backfill-d1-sessions.py:1-100` — local JSONL → D1 backfill
- `CLAUDE.md:128-169` — Identity Management spec
- `.claude/rules/session-lifecycle.md` — resume / fork lifecycle
- `planning/specs/1-session-runner-decoupling.md` — orphan recovery foundation
- `planning/specs/27-docs-as-yjs-dialback-runners.md` — multi-runner pattern
- `planning/specs/30-runner-adapter-pluggable.md` — RunnerHost abstraction (future)
- `planning/specs/115-worktrees-first-class-resource.md` — worktree binding
- `planning/specs/119-session-store-failover.md` — identity failover via SessionStore
- `planning/research/2026-04-27-cloud-runner-abstraction.md` — host axis
- `planning/research/2026-04-20-session-state-surface-inventory.md` — what to export
