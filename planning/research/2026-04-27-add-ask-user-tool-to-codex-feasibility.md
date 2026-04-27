# Adding an `ask_user` tool to coding agents that lack one — and why this is really about a Duraclaw MCP runtime

**Date:** 2026-04-27
**Type:** Feasibility study → strategic architecture proposal
**Context:** Duraclaw orchestrates multi-driver session runners. Claude has
a first-class `AskUserQuestion` gate (issue #113 documents a bug there).
Codex (#112 / #107) and Gemini CLI (#110) are landing as co-equal drivers,
but their `RunnerAdapter`s declare `supportsPermissionGate: false` (see
`packages/session-runner/src/adapters/codex.ts:53`). Question: can we add
ask-user behaviour to drivers that don't ship it natively, without forking
the upstream CLI?

**The narrow question generalises.** Once you start building an MCP
server to give codex an `ask_user` tool, you realise that's the right
shape for *every* cross-driver capability — and that Duraclaw owns the
UI anyway, so the CLIs are headless model-runners. The conclusion is
larger than "add a tool": Duraclaw should ship a **portable agent
runtime** as an MCP server, and the per-driver adapters collapse into
"point this CLI at the runtime." See §7 for the strategic reframe; §1–6
remain as the original feasibility study that got us there.

**TL;DR**

Yes — and you don't need to fork. Codex and Gemini both support
**MCP servers** as the supported extension surface for adding tools. An
ask-user tool implemented as an MCP tool is the correct mechanism. The
hard part is not registration — it's the **synchronous-blocking
semantics** every coding agent's tool loop requires (the model call must
park until the human answers) and the **MCP client timeout policies**
that kill long-running tool calls.

There are three viable paths, in increasing order of fidelity:

| Path | Mechanism | Fidelity | Cost | Recommended for |
|------|-----------|----------|------|-----------------|
| **A. MCP tool (in-process)** | Codex/Gemini call a Duraclaw-served MCP tool; runner blocks on it; resolves when DO sends `resolve-gate` | High — real tool call, real tool result, no prompt heuristics | Medium — must run an MCP transport per session | **Recommended** |
| **B. Skill / system-prompt** | Markdown skill teaches model to ask a structured question in chat; user answers in chat; model parses | Low — prompt-engineered, not deterministic; depends on model compliance | Trivial | Stopgap / ambiguity coaxing |
| **C. Fork the CLI** | Patch a native `ask_user_question` tool into upstream codex / gemini | Highest — first-class TUI integration | High — tracking upstream forever | Only if MCP timeouts prove unfixable |

Path A is what the community is converging on (paulp-o/ask-user-questions-mcp,
the closed-but-popular openai/codex#9904 PR, and the relevant openai
community thread all point here). Path C is dead weight unless we want to
own a codex fork.

---

## 1. State of the world (April 2026)

### 1.1 Claude Agent SDK — first-class

`AskUserQuestion` is a built-in tool. The SDK pauses execution and
fires `canUseTool` against the host application; the host returns the
selected option, and the tool result is delivered back to the model on
the same turn. This is the gold-standard ergonomic — Duraclaw's existing
`ask_user` GatewayEvent + `resolve-gate` GatewayCommand pair mirrors it.

Source: [Claude Agent SDK — Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input).

### 1.2 OpenAI Codex CLI — no native ask_user, but MCP-ready

A community PR ([openai/codex#9904](https://github.com/openai/codex/pull/9904))
proposed a native `ask_user_question` tool with TUI overlay. It was
**closed by an OpenAI maintainer** with the reason that OpenAI is
"not currently accepting feature contributions" — file an enhancement
request instead. The umbrella enhancement issue
[openai/codex#9926](https://github.com/openai/codex/issues/9926) is open
but not on the roadmap. So **upstream codex has no ask-user tool today
and isn't taking patches for one**.

What codex does support:
- **MCP servers** registered in `~/.codex/config.toml` under
  `[mcp_servers.<name>]` ([codex MCP docs](https://developers.openai.com/codex/mcp);
  [config reference](https://github.com/openai/codex/blob/main/docs/config.md)).
- Per-tool approval modes (`approve` vs `prompt`) and
  `default_tools_approval_mode`.
- `tool_timeout_sec` per server (default 60s) and `startup_timeout_sec`.
- `supports_parallel_tool_calls`.
- The Codex SDK already surfaces MCP calls in its event stream as
  `item.completed` of type `mcp_tool_call` (see
  `packages/session-runner/src/adapters/codex.ts:355` — Duraclaw is
  already translating these to `tool_result` GatewayEvents). Adding a new
  MCP tool requires **zero adapter changes** on the consumption side.

Codex CLI also added a "skills" mechanism that can invoke MCP tools.

### 1.3 Gemini CLI — MCP-ready

Same picture: Gemini CLI supports MCP servers via
`~/.gemini/settings.json` (`mcpServers` block), with first-call
permission prompts and per-server trust settings. See
[Gemini CLI MCP servers](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html).
No native ask-user tool, but the extension point is identical.

### 1.4 Existing community implementations

- **[paulp-o/ask-user-questions-mcp](https://github.com/paulp-o/ask-user-questions-mcp)**
  — production-ish MCP server. Multi-choice with "Other", queueing for
  parallel agents, rejection mechanism, stale-session detection. Three
  delivery modes: MCP server (Cursor/Claude Desktop/Claude Code),
  OpenCode plugin, agent skill. Uses a separate `auq` CLI window for
  the human side.
- **[sanchomuzax/AskUserQuestion-tool-for-Codex](https://github.com/sanchomuzax/AskUserQuestion-tool-for-Codex)**
  — pure skill (`SKILL.md`) approach. Prompt-engineering only. Lives in
  `~/.codex/skills/`. Effectiveness depends on model recognising
  ambiguity cues.
- The [OpenAI community thread](https://community.openai.com/t/using-askusertool-in-codex-cli/1370218)
  has a user reporting success with the skill route ("30+ questions for
  10% context") but no native path.

### 1.5 Known failure mode worth flagging

[gstack#1066](https://github.com/garrytan/gstack/issues/1066) — "Codex
skills that call AskUserQuestion silently fail in Default mode." The
silent failure is exactly the symptom we'd see if codex's MCP-tool
timeout fires while a human is thinking, and it parallels Duraclaw's
own [issue #113](https://github.com/baseplane-ai/duraclaw/issues/113)
(AskUserQuestion gate lost on stream close). Whatever we build needs
explicit handling for the long-block case.

---

## 2. Why MCP is the right surface (Path A)

### 2.1 Mechanism

Each Duraclaw session-runner already wraps a SDK (`@openai/codex-sdk`,
shortly `@google/generative-ai`/gemini SDK). The runner is the only
process that needs to know about Duraclaw's wire protocol.

Proposed flow for codex/gemini:

```
runner spawns -> registers in-process stdio MCP server "duraclaw-gate"
                 exposing tool: ask_user(question, options, multi_select?, allow_other?)
runner starts thread w/ --mcp-server duraclaw-gate (or via config.toml)
codex/gemini lists tools -> sees ask_user
LLM calls ask_user -> MCP request hits runner's handler
  -> runner emits GatewayEvent { type: 'ask_user', ... }  (existing wire shape)
  -> handler awaits a resolution promise keyed by mcp request id
DO receives ask_user -> UI renders -> user picks
DO sends GatewayCommand { type: 'resolve-gate', answer }
runner resolves the keyed promise -> MCP returns tool result -> LLM continues
```

This reuses everything: the existing GatewayEvent/Command shapes
(`packages/shared-types/src/index.ts`), the existing UI gate component,
the existing DO `resolve-gate` plumbing. The only new code is:
1. A small in-process MCP server (or stdio child) inside the codex/gemini
   adapter that exposes `ask_user`.
2. Wiring from the MCP tool handler into the adapter's promise table.
3. Setting `supportsPermissionGate: true` in the adapter's
   `capabilities`.

### 2.2 Why MCP beats forking

- **Upstream is hostile to feature PRs**, at least for codex (see #9904
  outcome). A fork has to be maintained against active upstream
  development across two CLIs, and we'd lose the ability to consume
  user-installed binaries (`CODEX_BIN_PATH`).
- **MCP is the documented contract**. Future codex/gemini changes are
  unlikely to break MCP; that's the whole point of having it.
- **Codex SDK already surfaces `mcp_tool_call` items** with arguments
  and structured_content results. Our adapter is already translating
  them. We don't need to add a new event type — we add a new
  *interpretation* of an existing one (or just emit the existing
  `ask_user` GatewayEvent inside the MCP handler, before returning the
  tool result, so the DO sees the gate without inspecting MCP payloads).
- **Per-tool approval mode** can be set to bypass codex's confirmation
  prompt for our MCP server (`default_tools_approval_mode = "approve"`),
  so the LLM-to-user gate isn't double-gated by a CLI-to-tool gate.

### 2.3 The hard problem: blocking tool calls vs MCP timeouts

This is the only real engineering risk, and it's what's killed every
naïve implementation:

- **Codex `tool_timeout_sec` defaults to 60s.** A human will not always
  answer in 60 seconds. We must set this per-server, e.g.
  `tool_timeout_sec = 86400` (24h) on the duraclaw-gate entry.
- **Some MCP clients ignore per-server timeouts** and apply a global
  cap. paulp-o's README explicitly calls this out as a limitation.
  We need a verification step (test fixture) that confirms codex
  honours the override.
- **Stream-close semantics** — Duraclaw's own #113 shows the runner
  parks correctly on `PushPullQueue.waitForNext()` but "something kills
  the stream anyway" and resume loses the gate. We need to make sure
  the MCP request-id survives runner restart. Two options:
    (a) Persist `{mcp_request_id, gate_id}` in DO so a re-spawned
        runner can re-issue the MCP response when the gate resolves
        post-resume — but this requires the *same* MCP server instance
        to still be holding the codex MCP request, which it won't after
        a restart.
    (b) Treat resume as "abort the MCP call, the model will re-call
        ask_user on its next turn" — simpler, but loses the answer
        unless we feed it back via the resume prompt.

    Option (b) is what the orphan-recovery path already does for
    `forkWithHistory`. Easiest to start there.
- **Heartbeats** — the runner's BufferedChannel already heartbeats over
  the dial-back WS, but codex's MCP server doesn't get heartbeats.
  Long blocks may look hung to the codex CLI. Need to verify codex
  doesn't kill the server on stdio idle.

### 2.4 In-process vs separate-process MCP

The Claude Agent SDK exposes `createSdkMcpServer` for in-process tools
([Claude custom tools docs](https://platform.claude.com/docs/en/agent-sdk/custom-tools)).
Codex and Gemini take MCP servers as **external commands**
(`command = "..."` in the config). That means we either:

- **Spawn a stdio subprocess** from the runner with a tiny MCP wrapper
  that round-trips over a Unix socket back to the runner, or
- **Embed MCP transport in the runner itself** and pass codex a stub
  command that just connects to that socket.

The first is simpler; the second has fewer moving parts. Either way
this is meaningful infrastructure — it's the main implementation cost
of Path A.

---

## 3. Why Path B (skill / prompt) is a stopgap, not a solution

The skill route works *somewhat*:
- Zero infrastructure
- Works the same across codex / gemini / claude
- Can be installed alongside the kata skill machinery already in PR #112

But it's not a tool — it's a chat instruction. Failure modes:
- Model may decide not to ask. No deterministic gate.
- Output format depends on the model following a JSON schema in
  freeform text. Smaller models drift.
- No structured event for the DO to render a proper picker UI; the user
  sees a chat message and types back, losing the option-picker UX.
- Won't satisfy the use cases in #110 / #113 where a real
  decision-tree gate is the point.

Useful as a *complement* to Path A — the skill teaches the model
*when* to call the MCP tool. But the tool needs to exist for any
deterministic gate behaviour.

---

## 4. Why Path C (fork) is a last resort

Looks tempting because:
- First-class TUI integration matches Claude's UX
- Can read codex internals, no MCP timeout problems
- Avoids stdio plumbing

Costs:
- Maintain a fork of an actively-developed Rust codebase indefinitely.
- Distribute a custom codex binary and convince users to use it
  (breaks the "use whatever codex they have" story behind
  `CODEX_BIN_PATH`).
- Doesn't generalise to gemini — we'd have two forks.
- OpenAI explicitly closed the matching upstream PR; merging back is
  not a credible exit ramp.

Only worth revisiting if MCP timeouts prove un-bypassable on either CLI.

---

## 5. Recommendations for Duraclaw

1. **Adopt Path A (MCP tool) as the canonical approach** for codex and
   gemini drivers. Set `supportsPermissionGate: true` only after the
   MCP-gate path is wired.
2. **Spec it as a single piece of cross-driver infra**, not per-driver.
   Build one `duraclaw-gate-mcp` package; the codex and gemini adapters
   register it differently but consume it identically. Keep the existing
   `ask_user` GatewayEvent shape — that's the abstraction that
   shielded the DO from driver differences in the first place.
3. **Test the timeout override empirically before committing**. Write a
   2-line fixture: an MCP tool that sleeps 10 minutes, called from
   codex with `tool_timeout_sec = 86400`. If codex kills it at 60s
   despite the override, we have a real problem and need to escalate.
4. **Resume semantics — start with the abort-and-re-prompt model**
   (Option (b) in §2.3). This lines up with how `forkWithHistory`
   already handles stream loss for orphans, and avoids the harder
   "transfer an in-flight MCP request to a new process" problem.
5. **Block #113's fix on understanding (3) and (4)**, because the same
   stream-close issue will hit codex/gemini once they get a gate. The
   fix should be one solution that covers all three drivers.
6. **Keep the skill (Path B) as ambiguity coaching only.** Ship a
   `ask-user-question` skill that nudges the model to *call the MCP
   tool* when it detects ambiguity. The skill itself does no
   prompt-based Q&A.

## 6. Open questions

- Does codex's `tool_timeout_sec` actually override for human-in-the-loop
  durations, or is there a hard ceiling? (must verify)
- Does Gemini CLI have an equivalent timeout knob, or do we need to
  send keep-alive responses? (didn't find clean docs)
- For multi-question / tabbed-UI parity with Claude's
  `AskUserQuestion`, do we want to wrap a single MCP call around
  multiple questions (matches Claude's batch shape) or one call per
  question? Batch is closer to existing wire protocol; per-question is
  simpler for the LLM to use.
- Should the MCP server be one-per-runner (in-process, scoped to one
  session) or one-per-VPS (multi-tenant, keyed by session id in
  arguments)? In-process is simpler and matches our session-runner
  isolation model.

---

## 7. Strategic reframe — Duraclaw as a portable agent runtime

The §1–6 feasibility study answers "how do we give codex an ask_user
tool." The right answer to a slightly bigger question — *what should
Duraclaw's relationship to coding-agent CLIs actually be?* — reshapes
the work substantially. This section captures that reframe.

### 7.1 Duraclaw owns the UI

The browser/mobile UI is the only surface humans see. Codex's TUI,
Gemini's TUI, Claude Code's TUI, the CLI approval prompts, the status
bars, the slash-command UX — none of it ships in front of a Duraclaw
user. The CLIs are **headless model+toolloop processes**. We should
build for that, not against it.

That changes the framing of the MCP server:

- **It's not a "fill the gaps in codex" layer.** It's the *control
  plane* between Duraclaw's UI and any coding-agent CLI willing to
  speak MCP.
- **Cosmetic CLI features don't matter.** A native `ask_user_question`
  TUI overlay in codex would not be better than an MCP tool, because
  the user never sees codex's TUI.
- **Driver-native variance becomes uninteresting.** What matters is
  whether the driver can mount an MCP server. Codex, Gemini, and
  Claude all can. That's the contract.

### 7.2 The MCP server is the runtime ABI

Beyond `ask_user`, the same in-process MCP server is the natural home
for every cross-driver capability the CLIs don't ship uniformly:

- `ask_user` — the gate (v1 driver)
- `request_permission` — pre-tool approval routed to our UI
- `task_progress` / `task_started` / `task_notification` — model-driven
  task lifecycle
- `get_context_usage` — tool-callable context budget
- `fork_session` / `rewind` — Duraclaw lifecycle ops with no native
  CLI equivalent
- `read_kata_state` — workflow files surfaced as schemaed reads, not
  filesystem grep
- `open_artifact` — push images/files/links into the Duraclaw UI
- `spawn_subsession` / `wait_for_session(id)` /
  `read_session_artifact(id, path)` — orchestration primitives no
  single-session CLI ships
- `kata.enter_mode` / `kata.update_task` / `kata.get_status` —
  workflow semantics (see §7.4)

All of these become **driver-agnostic** the moment they live in the
MCP runtime. Adding a new CLI (Aider, Cursor's agent, the next thing)
becomes a 200-line adapter, not a feature-by-feature parity exercise.

### 7.3 The capability matrix collapses

`RunnerAdapter.capabilities` currently enumerates per-driver features:
`supportsPermissionGate`, `supportsRewind`, `supportsSubagents`,
`supportsContextUsage`, etc. (see
`packages/session-runner/src/adapters/codex.ts:49`). Most of those
flags exist because driver A ships a feature driver B doesn't.

With the runtime, the flags shrink to the genuinely irreducible:

- `streamsThinkingDeltas` — SDK-level, not MCP-able (the model's own
  output stream, not a tool call)
- `supportsCleanInterrupt` — mid-stream abort, also SDK-level
- `nativeFileTools` — whether the driver edits files itself or we
  provide edit-via-MCP

Everything else — gates, approvals, todos, progress, fork, rewind,
model swap, context introspection — moves into the MCP runtime and
stops being a per-driver concern. The DO sees identical wire shapes
regardless of which CLI is behind the runner.

**Stronger move:** prefer MCP over driver-native even when both exist.
Claude has native `AskUserQuestion`; codex doesn't. The instinct is
"use Claude's native, MCP-shim for codex." But uniformity has value:
if every driver including Claude uses `duraclaw__ask_user`, then the
wire payload, the gate-resume logic, the UI component, and the bug
surface (#113) are *one* code path instead of branching on driver.
The native Claude tool becomes a fallback we don't bother with.

### 7.4 What the runtime can't do (be honest about this)

- **Streaming partial output mid-tool.** MCP tools are
  request/response. Long-running progress requires either polling
  (model calls progress tool repeatedly) or fire-and-forget
  notifications. Mid-tool deltas like Claude's `partial_assistant`
  remain SDK-level.
- **Tool-name aesthetics in model reasoning.** The model sees
  `duraclaw__ask_user`, not the prettier `AskUserQuestion`. Skill
  prompts have to teach the model the namespaced name.
- **Model proactivity.** MCP tools are *available*. The model has to
  *choose* to call them. The skill route (Path B in §3) becomes the
  *coaching layer* on top of the runtime: ship a `duraclaw-skills`
  package teaching each driver *when* to reach for the runtime tools.
- **CLI-level UX.** Codex's CLI prompts, status bar, etc. stay
  codex's. We can't theme codex from MCP. Doesn't matter for the
  headless runner case (which is all of Duraclaw).

### 7.5 What this means for kata

PR #112 lands a substantial driver abstraction in `packages/kata`:
hook adapter, setup multiplex, skill dual-install, per-driver
tool-name mapping, doctor checks, no-op gate. **All of it exists
because the CLIs don't speak Duraclaw's protocol natively, so we're
shimming via each CLI's bespoke hook system.** Hooks are the
workaround. MCP is the contract.

Once the MCP runtime exists, kata splits into two things:

**Dies:**
- Hook adapter (`kata hook --driver=codex`) — no more intercepting
  per-CLI hook stdin/stdout shapes
- Per-driver setup multiplex (`~/.claude/settings.json` +
  `~/.codex/hooks.json` registration)
- Hook-registration doctor checks
- Tool-name-mapping table in the Driver abstraction
- Dual-install skill ceremony (`~/.claude/skills/` +
  `~/.agents/skills/`)
- Most of the `Driver` interface itself — replaced by "configure CLI
  to mount the Duraclaw MCP runtime"

**Survives, but moves into the runtime:**
- Mode/phase/task semantics → MCP tools (`kata.enter_mode`,
  `kata.update_task`, `kata.get_status`, `kata.can_exit`). The model
  calls them; humans hit them via the Duraclaw UI.
- Methodology content (skills, workflow templates, `.kata/kata.yaml`)
  → data files the runtime reads and serves uniformly. Same authoring
  model, different delivery path.
- Native-task store (`.kata/sessions/{id}/native-tasks/`) → still
  canonical filesystem persistence, but the runtime owns reads/writes
  instead of every driver mirroring through hooks.

**Possibly survives:** a thin `kata` CLI for headless/standalone use
— humans who want mode tracking in a raw terminal session without
spinning up a full Duraclaw runner. But that's a small shell over the
same MCP, not the current sprawl.

**The uncomfortable bit:** PR #112 is large recent work specifically
dedicated to the per-driver hook approach. The runtime path obsoletes
most of it. Two ways to handle:

1. **Land #112 as-is, deprecate incrementally** as runtime parity
   grows. Hooks coexist with MCP for a release or two; cut the hook
   path once feature parity lands. Cost: short-lived code, ships
   value now.
2. **Pivot mid-flight** toward the MCP-native architecture. Cost:
   re-architecting in-flight work, lower total throwaway code.

Choice depends on how solid the runtime story is in detail (timeout
verification, resume semantics — §2.3) and how much of #112 is
already merged. If most of #112 is in main, option 1 is forced.

### 7.6 Driver abstraction collapse

Today there are two parallel driver abstractions doing slightly
different jobs:

- `Driver` in `packages/kata/src/drivers/` — hook input/output
  translation, tool-name mapping, skill paths, ceremony files
- `RunnerAdapter` in `packages/session-runner/src/adapters/` —
  SDK-level wire translation for the in-flight session

With the runtime, the abstraction is the runtime. Both `Driver` and
`RunnerAdapter` collapse into "configure the CLI to mount the Duraclaw
MCP runtime, and translate the SDK's event stream to GatewayEvents."
Same coverage, much less surface area.

### 7.7 Recommended forward shape (revised)

1. **Spec it as the Duraclaw runtime ABI**, not as "ask_user MCP."
   v1 ships `ask_user` because that's the immediate need (#113 +
   #110 + codex parity), but the architecture is built so v2/v3
   capabilities (§7.2) land without re-litigating the mechanism.
2. **Single shared package** — `packages/duraclaw-runtime-mcp` or
   similar — with a tool registry that the codex/gemini/claude
   adapters mount.
3. **Use it from Claude too**, eventually, even where Claude has
   native equivalents. One wire shape, one bug surface, one UI
   component, three drivers.
4. **Decide the #112 pivot vs. coexist question explicitly** before
   building runtime work. The longer #112's hook abstraction lives,
   the more code calls into it that has to be rewritten.
5. **Verify codex `tool_timeout_sec` override empirically** (§2.3)
   before committing — the runtime depends on long-blocking tool
   calls. If codex caps timeouts despite per-server overrides, the
   runtime needs a different shape (heartbeat tokens / re-poll
   semantics).
6. **Resume semantics: start abort-and-re-prompt** (§2.3 option (b)).
   Aligns with the existing `forkWithHistory` orphan-recovery path.
7. **Sequence:** `ask_user` (v1, satisfies #110 and #113 cleanly)
   → `request_permission` + task lifecycle (v1.1) → kata.* tools and
   PR #112 deprecation (v2) → orchestration primitives (v3).

### 7.8 Naming the thing

Calling it "the Duraclaw MCP" is fine in conversation. For specs and
package names, "Duraclaw runtime ABI" or "agent runtime" is the more
honest framing — it sets the expectation that this is a contract
every driver speaks, not a one-off ask_user shim.

---

## Sources

- [openai/codex#9926 — Enhancement: interactive ask_user_question tool](https://github.com/openai/codex/issues/9926)
- [openai/codex#9904 — Closed PR for native ask_user_question](https://github.com/openai/codex/pull/9904)
- [Codex MCP docs](https://developers.openai.com/codex/mcp)
- [Codex config reference (config.md)](https://github.com/openai/codex/blob/main/docs/config.md)
- [Codex SDK MCP tool-call event PR — openai/codex#5899](https://github.com/openai/codex/pull/5899)
- [Gemini CLI MCP servers](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)
- [Gemini CLI MCP server setup tutorial](https://geminicli.com/docs/cli/tutorials/mcp-setup/)
- [paulp-o/ask-user-questions-mcp](https://github.com/paulp-o/ask-user-questions-mcp)
- [sanchomuzax/AskUserQuestion-tool-for-Codex](https://github.com/sanchomuzax/AskUserQuestion-tool-for-Codex)
- [Claude Agent SDK — custom tools (createSdkMcpServer)](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude Agent SDK — handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input)
- [OpenAI community — Using AskUserTool in codex-cli](https://community.openai.com/t/using-askusertool-in-codex-cli/1370218)
- [gstack#1066 — Codex skills calling AskUserQuestion fail silently](https://github.com/garrytan/gstack/issues/1066)
- Local: `packages/session-runner/src/adapters/codex.ts:53` (capabilities), `:355` (mcp_tool_call handling)
- Local: Duraclaw issue #113 (AskUserQuestion gate lost on stream close)
- Local: Duraclaw issue #110 (GeminiCliAdapter)
