---
date: 2026-04-26
topic: kata-codex driver coexistence
type: feasibility
status: complete
github_issue: 109
items_researched: 3
---

# Research: kata-codex driver coexistence

## Context

`packages/kata/` is currently a session-driver shim for Claude Code: it
registers hooks in `.claude/settings.json`, writes native task files to
`~/.claude/tasks/{sessionId}/*.json`, expects skills loaded from
`~/.claude/skills/`, and bakes `Invoke /skill-name` into the task
instructions it generates. GH#109 asks for kata to **also** drive
sessions under OpenAI Codex CLI in the same project — neither driver
aware of the other. The two must coexist: a developer can run a kata
session under Claude in one terminal and codex in another against the
same checkout, sharing `.kata/` state.

Note: this is unrelated to the runner-side codex work in GH#107 / PR#108
(which is about `packages/session-runner` and the runtime `RunnerAdapter`
interface). Different layer, different problem.

Classification: **feasibility study** — three items, run in parallel,
heavy external research on codex CLI's extension surface, exhaustive
internal audit of kata's Claude coupling, and a survey of prior art.

## Scope

| # | Item | Approach |
|---|---|---|
| A | Codex CLI extension surface | Web/docs deep-dive (very thorough): hooks, system prompt injection, sub-agent format, skills, config, install, version |
| B | Kata's Claude-only integration audit | Codebase deep-dive: every `.claude/` write, hook handler, skill invocation, hardcoded "claude" string, default selection |
| C | Prior art on multi-driver workflow CLIs | forge, OpenCode, Aider, Overstory, Claude Agent SDK, Anthropic Managed Agents, claude-code-router |

## Findings

### Item A — Codex CLI extension surface

**The big surprise: codex's extension surface is ~80% conceptually
parallel to Claude Code's.** Same six lifecycle events, same trust-gated
project-local config dir, same auto-loaded project markdown file, same
skills concept with progressive disclosure. Names and contracts differ
in detail; concepts are 1:1 for everything except sub-task spawning.

**1. Hook / lifecycle events.** Codex exposes six events:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PermissionRequest`, `Stop`. (Kata uses 5 of these; `PermissionRequest`
is codex-only and we can ignore it.) Registered in
`.codex/hooks.json`, `.codex/config.toml` `[hooks]` table, or the
user-level equivalents under `~/.codex/`. Project-local hooks load only
when the project is marked `trust_level = "trusted"` in the user
config. Stdin is a single JSON object with `session_id`,
`transcript_path`, `cwd`, `hook_event_name`, `model`, plus event-specific
fields (e.g. `tool_name`, `tool_input` for `PreToolUse`). Stdout is JSON
with fields like `continue`, `stopReason`, `systemMessage`,
`permissionDecision`. PreToolUse blocks via `permissionDecision: "deny"`
**or** exit code 2. Hooks cannot modify tool inputs — only feedback
via `systemMessage` and `additionalContext`. Feature-gated by
`features.codex_hooks = true` (default true in 0.124+).

**2. System-prompt / context injection.** Codex auto-discovers
`AGENTS.md` from project root and parents (direct parallel to Claude's
`CLAUDE.md`). Plus three config-driven layers in `.codex/config.toml`:
`developer_instructions` (inline string), `model_instructions_file`
(path to a custom file), `instructions` (reserved). Layering precedence:
built-in < `~/.codex/AGENTS.md` < project `developer_instructions` <
project `AGENTS.md` < CLI override.

**3. Sub-task / sub-agent spawn format.** **No markdown-driven task file
system.** This is the one architectural mismatch. Codex sub-agents are
pre-defined TOML files in `~/.codex/agents/` or `.codex/agents/`, with
fields `name`, `description`, `developer_instructions`, optional `model`,
`sandbox_mode`, `mcp_servers`. Spawning is **model-driven** (codex
decides when to invoke based on the agent's description), not
file-driven by an external orchestrator. There is also an experimental
`spawn_agents_on_csv` tool for batch parallel work, but it's CSV-shaped
and not generally useful for sequenced phase tasks.

**4. Skills.** Same shape as Claude's: directory with `SKILL.md` (YAML
frontmatter + markdown), optional `scripts/`, `references/`, `assets/`.
Loaded from `.agents/skills/` (project, **not** `.codex/skills/`),
`~/.agents/skills/` (user), `~/.codex/skills/.system/` (built-in).
Invoked **explicitly** as `$skill-name` or **implicitly** when prompt
matches the skill's description. No mechanism for custom slash commands
— slash commands are hardcoded.

**5. Config file.** TOML. User: `~/.codex/config.toml`. Project (trust-
gated): `.codex/config.toml`. Hierarchical override (CLI > profile >
project > user > system > defaults). Trust is project-wide, all-or-
nothing — if a project is untrusted, everything in `.codex/` is
ignored.

**6. Install detection.** `which codex` returns the binary (typically
`~/.bun/bin/codex` or `~/.npm-global/bin/codex`). `codex --version`
prints version. `~/.codex/` directory existence confirms first-run
config has been created. `CODEX_HOME` env var overrides config dir.

**7. Version constraints.** Stable channel is 0.125.0 (April 2026).
Hooks stabilized in 0.124.0. Target 0.124+ for hook stability. Watch
issues #19199 (hook config startup failure) and #17532 (project-scoped
hooks in config.toml sometimes don't fire interactively — workaround:
use `hooks.json`).

**Verdict for kata coexistence.** Hooks: clean, with the caveat that
project trust must be granted. System instructions: clean. Skills:
shape-compatible, dir-and-sigil-different. Config: clean. Sub-tasks:
**fundamental mismatch — needs invention**. Stop-hook detection: needs
its own string; kata's current Claude-prefix detector won't match codex.

### Item B — Kata's Claude coupling audit

The audit found 12 categories of coupling spanning ~20 source files and
~40 test files. Punch list with severity (✗ critical / ⚠ high or medium
/ ★ low):

| # | Coupling | File / line | Severity |
|---|---|---|---|
| 1 | `.claude/settings.json` hook registration | `src/commands/setup.ts:174-195, 101-168`; `teardown.ts:128` | ⚠ high |
| 2 | `~/.claude/tasks/{id}/*.json` writes | `src/commands/enter/task-factory.ts:357,358,430-503,568-599` | ✗ critical |
| 3 | Hook stdin/stdout assumes Claude shape | `src/commands/hook.ts:36-57, 154-204, 210-280, 285-353, 1077-1391` | ⚠ high |
| 4 | Skill invocation `Invoke /${skill}` baked in | `task-factory.ts:174,281,307`; `batteries/kata.yaml:21` | ⚠ medium |
| 5 | Skills installed only to `~/.claude/skills/` | `src/session/lookup.ts:137-148`; `scaffold-batteries.ts:311-350` | ⚠ medium |
| 6 | Tool-name enumeration (`Edit`/`Write`/`Bash`/...) | `hook.ts:296-310, 1089-1104, 1329-1391` | ⚠ medium |
| 7 | `CLAUDE_CODE_ENABLE_TASKS` env var | `src/utils/tasks-check.ts:14,22-24`; `doctor.ts:266`; `providers/claude.ts:149` | ★ low |
| 8 | Default provider `'claude'` | `src/providers/step-runner.ts:68,71,72`; `agent-run.ts:53`; `providers.ts:138` | ★ low |
| 9 | Stop-hook-feedback string detection | `hook.ts:677-697` | ⚠ medium |
| 10 | Transcript reading at `~/.claude/projects/.../*.jsonl` | `hook.ts:613-632` | ⚠ medium (uncertain — codex location TBD) |
| 11 | `kata setup` only writes to `.claude/` | `setup.ts:351-377` | ⚠ high |
| 12 | `kata doctor` only inspects `.claude/settings.json` | `doctor.ts:57-110, 260-298, 193-206` | ★ low |

**Top 5 risk hot-spots** (Item B's ranking):

1. **Hook stdin/stdout JSON contract** — every handler in `hook.ts`
   assumes Claude's shape. Effort: high.
2. **Native task file format & paths** — written, read, and counted
   throughout (stop conditions, dep checks, evidence). No abstraction
   today. Effort: high.
3. **Tool-name enumeration scattered through hook handlers** — needs
   per-driver translation. Effort: medium.
4. **Skill invocation syntax baked into task instructions** — codex
   uses `$skill`, not `/skill`. Effort: medium.
5. **Default provider strings + env-var name** — small but pervasive.
   Effort: low–medium (free win).

**Free wins** (easily refactorable, lowers coupling fast):

- Provider defaults: `?? 'claude'` → `?? config.default_provider`
- Env var lookup table per driver: `{claude: CLAUDE_CODE_ENABLE_TASKS, codex: ...}`
- Hook event-name table per driver (event names happen to match for the 5 we use, but parameterize anyway)
- `getSettingsPath(driver)` → `.claude/settings.json` | `.codex/hooks.json`
- Tool-name canonical → driver translation table

**Effort estimate:** 40-60 engineer-hours to production-ready
coexistence. Distributes roughly: path abstraction + config (5-10h),
hook protocol adapter (10-15h), task format bridging (8-12h), tool-name
mapping (5-8h), test parameterization (10-15h).

### Item C — Prior art

Seven projects evaluated. Compressed matrix:

| Project | Hook abstraction | Skill injection | Config ownership | Coexistence model | Activity |
|---|---|---|---|---|---|
| **forge** | ACP protocol (6 methods) | implicit per agent | registry-driven | sequential swap | active |
| **OpenCode** | plan→build gate | provider-specific | canonical JSON + provider | swap per session | very active (140k★) |
| **Aider** | git state flow | unified per-model | three-tier hierarchy | mix (swap per task) | active |
| **Overstory** | 26 lifecycle events + gates | dynamic overlay injection | multi-level + worktree | **true coexistence** (10+) | active |
| **Claude SDK** | 26 hooks (canonical) | per-subagent custom | per-subagent scoped | coexist in session | production |
| **Managed Agents** | implicit orchestration | prompt-embedded | per-workflow | single lead+workers | production |
| **claude-code-router** | request-response only | format transformation | route-based | mix per request | active |

**Patterns worth stealing (top 3):**

1. **Overstory's multi-driver native-config pattern.** Each driver
   writes to its own native config files (Claude:
   `settings.local.json`, Sapling: `.sapling/guards.json`, Pi:
   `.pi/extensions/`). Workflow tool owns canonical task/state and
   translates per driver at the edge. Closest fit for kata — true
   coexistence, not swap.
2. **Canonical lifecycle event vocabulary + per-driver translators**
   (Claude SDK + Overstory). Existing kata event names become the
   canonical vocabulary; driver adapters translate native →
   canonical at the entry point.
3. **Dynamic config overlay injection** (Overstory). Workflow generates
   base config, overlays task variables at runtime. Same agent
   definition serves 100 tasks. Maps directly to our codex-task plan:
   render task list into `developer_instructions` per-session, refresh
   on state change.

**Anti-patterns to avoid:**

1. **Forcing all drivers through a single protocol** (ACP-first
   thinking). Wrong layer for kata. PR#108 uses ACP at the runner layer
   where it fits; kata sits above the agent's process boundary, where
   protocol unification creates a new N×M problem and leaks driver
   semantics.
2. **Centralizing all communication through the orchestrator.** Not
   directly relevant for kata (no peer agents) but worth noting for
   future epics that consider sub-agent coordination.

## Comparison: Claude vs codex extension surface

| Surface | Claude Code | Codex CLI | Compatibility |
|---|---|---|---|
| **Hook events used** | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop | Same five (plus PermissionRequest, kata-irrelevant) | ★ 1:1 |
| **Hook registration file** | `.claude/settings.json` `hooks.<event>[]` | `.codex/hooks.json` OR `.codex/config.toml` `[hooks]` | ★ Parallel |
| **Hook stdin** | `{session_id, tool_name, tool_input, ...}` | `{session_id, transcript_path, cwd, hook_event_name, model, ...}` | ⚠ Similar but distinct fields |
| **Hook stdout** | `{decision: 'block'\|'allow', hookSpecificOutput: {...}}` | `{continue, stopReason, systemMessage, permissionDecision, ...}` | ⚠ Different vocab; PreToolUse blocking via exit-2 in codex |
| **Project context** | `CLAUDE.md` (auto-loaded) | `AGENTS.md` (auto-loaded) | ★ Direct parallel |
| **Project config dir** | `.claude/` (trust-gated) | `.codex/` (trust-gated) | ★ Direct parallel |
| **System-prompt injection** | implicit via `CLAUDE.md` | `developer_instructions` in config.toml or `AGENTS.md` | ★ Available |
| **Skills directory** | `~/.claude/skills/` and `.claude/skills/` | `~/.agents/skills/` and `.agents/skills/` (note: `.agents/`, not `.codex/`) | ★ Same shape |
| **Skill invocation** | `/skill-name` | `$skill-name` (explicit) or implicit by description | ⚠ Different sigil |
| **Native sub-task spawning** | `~/.claude/tasks/{id}/*.json` (markdown task files, kata-driven) | None. Sub-agents are TOML, model-driven only | ✗ **Architectural mismatch** |
| **Tool-name namespace** | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `TaskCreate`, `TaskList`, `TaskUpdate`, `Skill`, `AskUserQuestion`, `Agent` | Different (`apply_patch`, MCP-based, not 1:1) | ⚠ Translation table |
| **Stop-hook feedback prefix** | `"Stop hook feedback:"` | Different (codex-specific) | ⚠ Per-driver detector |

★ = clean parallel. ⚠ = needs adapter shim. ✗ = needs invention.

## Recommendations

### 1. Introduce a `Driver` abstraction inside `packages/kata/src/drivers/`

Distinct from the existing `AgentProvider` (which is for `agent-run`
task delegation — different concern). The `Driver` represents the
**session-driver** identity: which CLI is running this kata session,
where does it expect hooks, where does it look for skills, what's its
ceremony file name, etc.

```
packages/kata/src/drivers/
  types.ts          ← Driver interface
  claude.ts         ← writes .claude/settings.json, ~/.claude/tasks/, ~/.claude/skills/
  codex.ts          ← writes .codex/hooks.json, .codex/config.toml, ~/.agents/skills/
  detect.ts         ← detect installed drivers from PATH + ~/.{claude,codex}/
  index.ts          ← registry: { claude: claudeDriver, codex: codexDriver }
```

Rough interface:

```ts
interface Driver {
  name: 'claude' | 'codex'
  isInstalled(): boolean
  writeHookRegistration(cwd: string, hookCommand: string): void
  removeHookRegistration(cwd: string): void
  parseHookInput(stdin: string): CanonicalHookInput
  formatHookOutput(canonical: CanonicalHookOutput): string
  toolNameMap(): Record<string, string>          // canonical → native
  nativeTaskStore: NativeTaskStore               // pluggable
  skillsDir(scope: 'user' | 'project'): string
  skillInvocationPrefix(): '/' | '$'
  ceremonyFileName(): 'CLAUDE.md' | 'AGENTS.md'
  detectStopHookFeedback(text: string): boolean
}
```

### 2. `kata setup` becomes driver-multiplexing

Detect installed drivers (`isInstalled()` per driver). Write hook
registration to **each** detected driver. Both runs are independent —
re-running `kata setup` after installing a second driver adds the second
without touching the first. Trust gating remains the user's
responsibility (codex requires marking the project trusted; kata can
emit a one-line nudge in `kata doctor`).

### 3. Two parallel hook entry points (decided)

`kata setup` registers `kata hook --driver=claude <event>` in
`.claude/settings.json` and `kata hook --driver=codex <event>` in
`.codex/hooks.json`. Each entry point parses the driver's native stdin
shape, calls the same canonical handler logic, formats the driver's
native stdout. This keeps the per-driver shim thin (~50 LoC each) and
testable in isolation. No auto-detection failure mode.

### 4. Codex tasks live in `developer_instructions` (decided)

Since codex has no `~/.claude/tasks/`-equivalent, kata stores codex
"native tasks" in `.kata/sessions/{id}/native-tasks/{taskId}.json`
(canonical) and **renders them as markdown into `.codex/config.toml`
`developer_instructions` at `kata enter` time**. Refresh on task state
change (which fires from existing `TaskUpdate` hook plumbing). Codex
sees the task list as part of its system prompt, not as files. This is
the only true invention; everything else is path/format adapters. The
canonical `.kata/sessions/{id}/native-tasks/` store works for both
drivers — claude.ts mirrors it into `~/.claude/tasks/`, codex.ts
renders it into `developer_instructions`.

### 5. Free wins land first as a separate `chore:` PR

Items #7 (env-var table), #8 (default provider config), and the
parameterization parts of #4–#6 are mechanical refactors that don't
need the full Driver interface. Land them first — they make the
subsequent driver-abstraction work cleaner and shrink the surface area
of GH#109's main PR.

## Open questions

These move into P1 (interview) for explicit user decision:

1. **Codex transcript file location.** Item B flagged `hook.ts:613-632`
   reads `~/.claude/projects/<encoded>/<session>.jsonl`. Where does
   codex store transcripts? Need to either confirm a location and write
   a parser, or make transcript-reading optional (it's used by
   `hasActiveBackgroundAgents` checks — degrade gracefully).
2. **Skill installation strategy.** Currently kata installs skills to
   `~/.claude/skills/kata-{name}/`. Codex looks in `~/.agents/skills/`.
   Should kata install to **both** (duplication, but simple), or
   symlink one to the other (fragile), or pick one canonical location
   and configure each driver to read from it (codex: yes via config;
   Claude: unclear)?
3. **First-class trust handshake.** Codex requires the project be
   marked trusted in `~/.codex/config.toml` `[projects."<path>"]
   trust_level = "trusted"` for project-scoped hooks/config to load.
   Should `kata setup` write this entry, prompt the user, or just emit
   a `kata doctor` warning?
4. **Behavior when only one driver is installed.** Should `kata setup`
   silently skip the missing driver, or warn? When a session starts
   under the missing driver later (e.g. user installs it), is `kata
   setup --rerun` the only way to wire it in?
5. **PostToolUse and PermissionRequest events.** Kata uses
   PostToolUse but PermissionRequest is codex-only. Worth wiring it up
   for codex parity with Claude's permission-gate flows, or skip and
   keep the canonical vocab to the 5 events kata already uses?
6. **Test parameterization scope.** ~40 test files mock `.claude/`
   directly. Refactor to a driver-parameterized fixture, or run two
   matrix builds (claude / codex) over the same test suite?

## Next steps

1. Move to P1 (interview) — drive the 6 open questions above to
   decisions.
2. Write feature spec (P2) with B-IDs grouped by layer:
   - **Layer 0** (free wins): env-var table, default-provider config,
     hook-event name table.
   - **Layer 1** (Driver abstraction): types.ts, registry, both drivers.
   - **Layer 2** (Setup multiplexing): `kata setup` writes both,
     `kata doctor` inspects both.
   - **Layer 3** (Hook adapter): two entry points, canonical handler.
   - **Layer 4** (Native tasks): pluggable `NativeTaskStore`,
     codex-renders-into-config-toml implementation.
   - **Layer 5** (Skills): dual install, sigil parameterization.
   - **Layer 6** (Test refactor): driver-parameterized fixtures.
3. Verification plan: a Claude session and a codex session, in the same
   checkout, each run `kata enter task` → some-phase work →
   TaskUpdate(completed) → `kata can-exit` → `kata close`, without
   either driver tripping on the other's state.
4. Stretch: validate codex 0.125.0+ behavior in CI (or document the
   minimum supported codex version in the spec).

## Sources

- [Hooks – Codex | OpenAI Developers](https://developers.openai.com/codex/hooks)
- [Configuration Reference – Codex | OpenAI Developers](https://developers.openai.com/codex/config-reference)
- [Agent Skills – Codex | OpenAI Developers](https://developers.openai.com/codex/skills)
- [Custom instructions with AGENTS.md – Codex | OpenAI Developers](https://developers.openai.com/codex/guides/agents-md)
- [Subagents – Codex | OpenAI Developers](https://developers.openai.com/codex/subagents)
- [Slash commands in Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/slash-commands)
- [Non-interactive mode – Codex | OpenAI Developers](https://developers.openai.com/codex/noninteractive)
- [Changelog – Codex | OpenAI Developers](https://developers.openai.com/codex/changelog)
- [GitHub - openai/codex](https://github.com/openai/codex)
- Local: `/home/ubuntu/.codex/config.toml`, `/home/ubuntu/.codex/hooks.json`, `/home/ubuntu/.codex/skills/.system/`
- `codex --version` → `codex-cli 0.125.0`; `which codex` → `/home/ubuntu/.bun/bin/codex`
- [forge-agents/forge](https://github.com/forge-agents/forge)
- [OpenCode](https://github.com/opencode-ai/opencode)
- [Aider-AI/aider](https://github.com/Aider-AI/aider)
- [jayminwest/overstory](https://github.com/jayminwest/overstory)
- [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Anthropic Managed Agents](https://www.anthropic.com/engineering/managing-agents)
- [Addy Osmani: Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [claude-code-router](https://github.com/musistudio/claude-code-router)
- [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
- Adjacent: `planning/research/2026-04-25-acp-codex-runner.md` (R7 forge dive)
- Adjacent: `planning/research/2026-04-24-kata-runner-convergence.md`
- Codebase audit: `packages/kata/src/commands/setup.ts`, `hook.ts`, `enter/task-factory.ts`, `session/lookup.ts`, `providers/`, `utils/tasks-check.ts`, `commands/doctor.ts`, `batteries/kata.yaml`, `batteries/skills/`, `batteries/templates/`
