---
initiative: runner-adapter-kata-extension
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 85
created: 2026-04-24
updated: 2026-04-24
blocks_on: "GH#30 P1"
phases:
  - id: p1
    name: "Extend AdapterStartOptions + ClaudeAdapter honor"
    tasks:
      - "Add `maxTurns?: number`, `allowedTools?: ReadonlyArray<string>`, `permissionMode?: PermissionMode` to `AdapterStartOptions` in `packages/shared-types/src/runner-adapter.ts`"
      - "Update `ClaudeAdapter` (post-#30-P1 file: `packages/session-runner/src/adapters/claude.ts`) to pass `maxTurns`, `allowedTools`, and `permissionMode` through to the SDK's `query()` options when present"
      - "Add `supportsMaxTurns: boolean` and `supportsAllowedTools: boolean` to `AdapterCapabilities`"
      - "Unit tests: verify ClaudeAdapter passes the three fields through to the SDK; verify omitting them preserves existing unbounded behavior"
    test_cases:
      - id: "opts-passthrough-claude"
        description: "ClaudeAdapter constructed with {maxTurns: 3, allowedTools: ['Read','Grep'], permissionMode: 'bypass'} passes all three to the underlying SDK query() call"
        type: "unit"
      - id: "opts-undefined-noop"
        description: "ClaudeAdapter constructed without the optional fields behaves identically to pre-extension (no turn cap, all tools, SDK-default permissions)"
        type: "unit"
      - id: "opts-empty-tools-textonly"
        description: "ClaudeAdapter constructed with {allowedTools: []} passes empty array to SDK (text-only mode — no tools offered)"
        type: "unit"
      - id: "opts-max-turns-subtype"
        description: "ClaudeAdapter emits type:'result' with subtype !== 'success' when SDK exits due to maxTurns limit (mock SDK to simulate turn-cap exit; assert subtype is non-success, not a hardcoded string)"
        type: "unit"
      - id: "is-all-tools-helper"
        description: "isAllTools(undefined) → true, isAllTools(['all']) → true, isAllTools([]) → false (text-only), isAllTools(['Read']) → false"
        type: "unit"
      - id: "capability-bitmap-extended"
        description: "ClaudeAdapter.capabilities includes supportsMaxTurns: true and supportsAllowedTools: true"
        type: "unit"
  - id: p2
    name: "Document kata convergence + file follow-up issue"
    tasks:
      - "Add JSDoc block to `AdapterStartOptions` in `runner-adapter.ts` documenting the kata convergence call pattern (single-turn drive, event collection, text extraction)"
      - "Update spec #30 non-goals section to reference GH#85 and state that kata convergence is tracked separately"
      - "File follow-up issue: `feat(kata): migrate kata/providers onto @duraclaw/shared-types RunnerAdapter` linking to this spec and spec #30"
    test_cases:
      - id: "docs-present"
        description: "JSDoc on AdapterStartOptions describes the single-turn kata pattern with example pseudocode"
        type: "manual"
      - id: "follow-up-filed"
        description: "GH issue exists titled 'feat(kata): migrate kata/providers onto RunnerAdapter' with links to #85 and #30"
        type: "manual"
---

# feat(runner-adapter): extend AdapterStartOptions for kata convergence

## Overview

Kata was migrated into the monorepo at `packages/kata/` and ships its
own parallel provider layer wrapping the same coding-agent CLIs (Claude,
Codex, Gemini) that spec #30 generalizes for session-runner. This spec
extends #30's `AdapterStartOptions` with three optional fields so that
kata's step-runner can converge onto the single `RunnerAdapter` streaming
interface rather than maintaining a separate `AgentProvider` abstraction.

Blocks on #30 P1 landing (RunnerAdapter interface extraction +
ClaudeAdapter refactor). Spec #30 is currently `status: approved`; P1 is
not yet implemented. File paths referencing post-#30 artifacts
(`packages/session-runner/src/adapters/claude.ts`,
`packages/shared-types/src/runner-adapter.ts::AdapterStartOptions`) are
forward references — the implementer must verify the actual file layout
after #30 P1 lands. If #30 P1 ships with renamed fields or restructured
types, update B1/B2 field names accordingly — the semantic contract
(optional run-level knobs honoured by adapters) is stable regardless of
surface-level naming.

## Feature Behaviors

### B1: AdapterStartOptions carries kata-required run-level knobs

**Core:**
- **ID:** adapter-start-opts-extension
- **Trigger:** Any caller constructs `AdapterStartOptions` — session-runner
  (existing), kata step-runner (future migration), or test harness.
- **Expected:** Three new optional fields are available on `AdapterStartOptions`:
  - `maxTurns?: number` — maximum agentic turns. `undefined` = unbounded
    (adapter's own default, typically no limit). Adapters that cannot enforce
    turn limits (`supportsMaxTurns: false`) silently ignore the field.
  - `allowedTools?: ReadonlyArray<string>` — per-tool filter using canonical
    tool names (aligned with Claude Code: `'Read'`, `'Grep'`, `'Edit'`,
    `'Bash'`, etc.). Special value `['all']` means unrestricted.
    `undefined` = all tools available (same as `['all']`). Adapters that
    cannot filter tools (`supportsAllowedTools: false`) silently ignore.
  - `permissionMode?: PermissionMode` — initial permission mode for the
    session. `undefined` = adapter resolves from project settings.
    `PermissionMode` is the existing union from #30:
    `'plan' | 'auto' | 'approve' | 'bypass'`. The mid-session
    `setPermissionMode()` method on `RunnerAdapter` remains the path for
    changing mode after `run()` starts. This field sets the *initial* value
    only.
  All three fields are optional and backwards-compatible — existing
  session-runner callers that omit them get identical behavior to today.
  Additionally, a shared `isAllTools(tools?: ReadonlyArray<string>): boolean`
  helper is exported from the same file. Truth table:
  `isAllTools(undefined)` → `true`, `isAllTools(['all'])` → `true`,
  `isAllTools([])` → `false` (text-only), `isAllTools(['Read'])` → `false`.
- **Verify:** TypeScript compilation succeeds with and without the new fields
  populated. `tsc --noEmit` on `packages/shared-types` passes. Grep
  `packages/shared-types/src/runner-adapter.ts` confirms the three fields
  are present on `AdapterStartOptions` with correct types and JSDoc.
- **Source:** `packages/shared-types/src/runner-adapter.ts` — the
  `AdapterStartOptions` type definition (created by spec #30 P1)

#### API Layer

Extended `AdapterStartOptions` type (additive — no new endpoints):

```ts
export type AdapterStartOptions = {
  sessionId: string
  project: string
  worktree?: string
  model?: string
  prompt: string
  resumeSessionId?: string
  env: Readonly<Record<string, string>>
  signal: AbortSignal
  onEvent: (event: GatewayEvent) => void
  onCommand: <T extends GatewayCommand>(handler: (cmd: T) => void) => () => void

  // ── Kata convergence fields (GH#85) ──

  /**
   * Maximum agentic turns before the adapter stops.
   * undefined = unbounded (adapter's own default).
   * Adapters with supportsMaxTurns: false silently ignore.
   */
  maxTurns?: number

  /**
   * Per-tool filter using canonical tool names.
   * undefined or ['all'] = all tools available.
   * Adapters with supportsAllowedTools: false silently ignore.
   */
  allowedTools?: ReadonlyArray<string>

  /**
   * Initial permission mode for the session.
   * undefined = adapter resolves from project settings / env.
   * Mid-session changes use setPermissionMode() on RunnerAdapter.
   */
  permissionMode?: PermissionMode
}
```

#### Data Layer

Two new fields on `AdapterCapabilities`:

```ts
export type AdapterCapabilities = {
  // ... existing 11 fields from spec #30 ...
  supportsMaxTurns: boolean         // adapter enforces maxTurns option
  supportsAllowedTools: boolean     // adapter filters tools per allowedTools
}
```

---

### B2: ClaudeAdapter honors the three new fields

**Core:**
- **ID:** claude-adapter-opts-honor
- **Trigger:** `ClaudeAdapter.run(opts)` is called with any combination of
  `maxTurns`, `allowedTools`, `permissionMode` populated.
- **Expected:**
  - `maxTurns` → passed to `query()` options as the SDK's `maxTurns`
    parameter (maps directly — Claude Agent SDK already supports this).
    When set, the SDK exits `query()` after N tool-use rounds even if the
    task is incomplete. The existing `ResultEvent.subtype: string` field
    (already defined in `packages/shared-types/src/index.ts`) carries the
    SDK's native stop-reason string — no new type addition needed. The
    adapter forwards the SDK's result verbatim via the existing
    `claude-runner.ts` pattern (`subtype: result.subtype`). The test
    should mock the SDK to return a non-`'success'` subtype when the turn
    cap fires. Assert `subtype !== 'success'` rather than a hardcoded
    literal — the exact string is SDK-version-dependent.
  - `allowedTools` → passed to `query()` options as the SDK's
    `allowedTools` parameter (verified present at
    `@anthropic-ai/claude-agent-sdk` sdk.d.ts:1003 in the installed
    version). The SDK's tool-dispatch only offers the listed tools to the
    model. `['all']` is treated as "offer everything" (omit the SDK
    parameter). Empty array `[]` means text-only mode — no tools offered.
  - `permissionMode` → mapped to the SDK's `permissionMode` parameter on
    `query()`. The `PermissionMode` union from #30 uses short names
    (`'bypass'`, `'approve'`, etc.). The Claude Agent SDK's actual
    `PermissionMode` type (verified against `@anthropic-ai/claude-agent-sdk`
    installed in this monorepo) is:
    `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.
    **ClaudeAdapter must normalize via a concrete map:**
    ```ts
    const PERMISSION_MODE_MAP: Record<PermissionMode, string> = {
      plan: 'plan',              // identity
      auto: 'auto',              // identity
      approve: 'default',        // #30's 'approve' = SDK's 'default' (ask on each tool)
      bypass: 'bypassPermissions', // #30's 'bypass' = SDK's 'bypassPermissions'
    }
    ```
    Sets the initial mode; subsequent `setPermissionMode()` calls use
    the same map.
  - When any field is `undefined`, the adapter omits it from the SDK call,
    preserving pre-extension behavior (unbounded turns, all tools,
    SDK/project-default permissions).
  - `ClaudeAdapter.capabilities` declares `supportsMaxTurns: true` and
    `supportsAllowedTools: true`.
- **Verify:** Four unit tests:
  - `opts-passthrough-claude`: mock SDK `query()`, assert options contain
    `maxTurns: 3`, `allowedTools: ['Read','Grep']`, permission mode mapped
    via `PERMISSION_MODE_MAP['bypass']`.
  - `opts-undefined-noop`: omit all three, assert SDK options do not
    contain those keys.
  - `opts-empty-tools-textonly`: pass `allowedTools: []`, assert SDK
    receives empty array (text-only mode).
  - `opts-max-turns-subtype`: mock SDK to simulate turn-cap exit, assert
    adapter emits `type:'result'` with `subtype !== 'success'`.
- **Source:** `packages/session-runner/src/adapters/claude.ts` (post-#30
  P1; pre-P1 equivalent: `packages/session-runner/src/claude-runner.ts` —
  the `query()` options assembly block)

#### API Layer
N/A — no new endpoints. The adapter-to-SDK plumbing is internal.

#### Data Layer
N/A — no schema changes beyond B1's capability additions.

---

### B3: Kata convergence call pattern documented in code

**Core:**
- **ID:** kata-convergence-docs
- **Trigger:** A developer reads `AdapterStartOptions` while planning kata's
  step-runner migration.
- **Expected:** A JSDoc block on `AdapterStartOptions` describes the
  canonical single-turn kata pattern:
  1. Construct `AdapterStartOptions` with `maxTurns` set (typically 3-10
     for judge/review steps), `allowedTools` set (typically `['Read',
     'Grep']` for read-only, or `['all']` for implementation), and
     `permissionMode: 'bypass'`.
  2. Call `adapter.run(opts)` once.
  3. Collect `type:'assistant'` events from `onEvent` to accumulate the
     text response.
  4. On `type:'result'` event, the step is complete — extract the final
     text, call `adapter.dispose()`.
  5. Never call `adapter.streamInput()` — single-turn means no follow-up
     messages.
  6. Timeout (if needed) is a caller concern:
     `const ac = new AbortController(); setTimeout(() => ac.abort(), 300_000); adapter.run({ signal: ac.signal, ... })`.
- **Verify:** `grep -A 20 'Kata convergence' packages/shared-types/src/runner-adapter.ts`
  shows the JSDoc block with the 6-step pattern.
- **Source:** `packages/shared-types/src/runner-adapter.ts` (JSDoc block
  above the `AdapterStartOptions` type definition)

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B4: Follow-up issue tracks kata provider migration

**Core:**
- **ID:** kata-migration-follow-up
- **Trigger:** P2 close of this spec.
- **Expected:** A GitHub issue exists titled
  `feat(kata): migrate kata/providers onto @duraclaw/shared-types RunnerAdapter`
  with body that:
  - Links to GH#85 (this spec) and GH#30 (pluggable adapter spec).
  - States scope: replace `packages/kata/src/providers/{claude,codex,gemini,cli-provider}.ts`
    and `packages/kata/src/providers/types.ts::AgentProvider` with imports
    from `@duraclaw/shared-types/runner-adapter`.
  - States `step-runner.ts` adopts the single-turn pattern from B3's
    documentation.
  - Notes `cwd` → `project`/`worktree` mapping decision is within scope of
    the follow-up issue, not prescribed here.
  - Lists files to retire: `packages/kata/src/providers/types.ts` (the
    `AgentProvider` interface), `packages/kata/src/providers/claude.ts`,
    `codex.ts`, `gemini.ts`, `cli-provider.ts`. `step-runner.ts` is
    refactored (not deleted). `retry.ts`, `prompt.ts`, `index.ts` are
    updated to use the shared interface.
- **Verify:** `gh issue list --search "migrate kata/providers"` returns
  exactly one issue in state `open`.

---

## Non-Goals

- **Kata step-runner refactor** — the actual migration of
  `packages/kata/src/providers/*.ts` onto `RunnerAdapter` is tracked in the
  follow-up issue (B4), not this spec.
- **Deletion of `packages/kata/src/providers/*.ts`** — same; follow-up.
- **New interface types** — no `OneShotProvider`, `StreamingRunnerAdapter`,
  or any other interface. Kata converges onto the single `RunnerAdapter`
  from #30.
- **Changes to #30's housing decision** — `RunnerAdapter` stays in
  `packages/shared-types/src/runner-adapter.ts`. No package extraction.
- **Changes to #30's phase plan** — P2/P3/P4/P5 adapter authors must honor
  the extended `AdapterStartOptions` fields from this spec, but that's an
  additive interface contract, not a scope change to #30.
- **`timeoutMs` on AdapterStartOptions** — removed from scope. Timeout is a
  caller-side concern; callers wire `AbortController` + `setTimeout` against
  `opts.signal`. See B3 step 6 for the documented pattern.
- **cwd mapping** — how kata's `cwd` maps to #30's `project`/`worktree`
  fields is a migration-time decision, deferred to the follow-up issue.
- **New GatewayCommand / GatewayEvent types** — no wire-protocol changes.
  The three fields are consumed exclusively by the adapter implementation.
- **Per-user API key storage, model-picker UX** — out of scope per #30.

## Implementation Phases

See frontmatter `phases` for task lists and test cases.

### P1: Extend AdapterStartOptions + ClaudeAdapter honor

**Prereq:** #30 P1 must be merged. `RunnerAdapter`, `AdapterCapabilities`,
`AdapterStartOptions`, `ClaudeAdapter`, and the adapter registry must exist
in their #30 P1 locations.

**Tasks:**
1. Add the three optional fields to `AdapterStartOptions` in
   `packages/shared-types/src/runner-adapter.ts` (see B1 API Layer for
   exact shape).
2. Add `supportsMaxTurns: boolean` and `supportsAllowedTools: boolean` to
   `AdapterCapabilities` (see B1 Data Layer).
3. Update `ClaudeAdapter` in
   `packages/session-runner/src/adapters/claude.ts`:
   - In `run(opts)`, read `opts.maxTurns`, `opts.allowedTools`,
     `opts.permissionMode`.
   - Pass them through to the SDK `query()` call options when present.
   - When absent (`undefined`), omit the keys from the options object.
   - Set `capabilities.supportsMaxTurns = true` and
     `capabilities.supportsAllowedTools = true`.
4. Export `isAllTools(tools?: ReadonlyArray<string>): boolean` from
   `packages/shared-types/src/runner-adapter.ts`.
5. Write unit tests (see test cases `opts-passthrough-claude`,
   `opts-undefined-noop`, `opts-empty-tools-textonly`, and
   `opts-max-turns-subtype`).
6. `pnpm typecheck` and `pnpm test` pass across the workspace.

**Done state:** `pnpm typecheck` green, unit tests green, `session.init`
events for Claude sessions include the two new capability bits.

### P2: Document kata convergence + file follow-up issue

**Tasks:**
1. Add JSDoc block above `AdapterStartOptions` type definition (see B3 for
   the 6-step pattern).
2. Update `planning/specs/30-runner-adapter-pluggable.md` non-goals section
   to add: `- **Kata provider convergence** — tracked separately in GH#85 +
   follow-up migration issue.`
3. File the follow-up GH issue per B4.

**Done state:** JSDoc present, spec #30 updated, follow-up issue filed and
linked.

## Verification Plan

### VP-1: TypeScript compilation

```bash
cd /data/projects/duraclaw-dev3
pnpm typecheck
```

**Expected:** Exit 0. No type errors related to `AdapterStartOptions`,
`AdapterCapabilities`, or `ClaudeAdapter`.

### VP-2: Unit test — opts passthrough

```bash
cd /data/projects/duraclaw-dev3
pnpm --filter @duraclaw/session-runner test -- -t "opts-passthrough"
```

**Expected:** Test passes. Mock SDK `query()` receives `maxTurns: 3`,
`allowedTools: ['Read','Grep']`, and the mapped permission mode
(`'bypassPermissions'` for input `'bypass'`) in its options argument.

### VP-3: Unit test — opts undefined is no-op

```bash
cd /data/projects/duraclaw-dev3
pnpm --filter @duraclaw/session-runner test -- -t "opts-undefined-noop"
```

**Expected:** Test passes. Mock SDK `query()` options do NOT contain
`maxTurns`, `allowedTools`, or `permissionMode` keys.

### VP-4: Capability bitmap includes new bits

```bash
cd /data/projects/duraclaw-dev3
grep -n 'supportsMaxTurns\|supportsAllowedTools' packages/shared-types/src/runner-adapter.ts
```

**Expected:** Two lines — one for each new capability field in
`AdapterCapabilities`.

### VP-5: JSDoc present on AdapterStartOptions

```bash
cd /data/projects/duraclaw-dev3
grep -A 5 'Kata convergence' packages/shared-types/src/runner-adapter.ts
```

**Expected:** JSDoc block with the single-turn pattern description.

### VP-6: Follow-up issue exists

```bash
cd /data/projects/duraclaw-dev3
~/.npm-global/bin/gh-axi issue list --search "migrate kata/providers"
```

**Expected:** Exactly one open issue titled
`feat(kata): migrate kata/providers onto @duraclaw/shared-types RunnerAdapter`.

### VP-7: Spec #30 updated

```bash
cd /data/projects/duraclaw-dev3
grep -n 'GH#85\|kata.*convergence' planning/specs/30-runner-adapter-pluggable.md
```

**Expected:** At least one line in the non-goals section referencing GH#85.

## Implementation Hints

### Key imports

```ts
// From shared-types (post-#30 P1):
import type {
  RunnerAdapter,
  AdapterCapabilities,
  AdapterStartOptions,
  PermissionMode,
  NotSupported,
  GatewayEvent,
  GatewayCommand,
} from '@duraclaw/shared-types/runner-adapter'

// From Claude Agent SDK (inside ClaudeAdapter only):
import { query } from '@anthropic-ai/claude-agent-sdk'
```

### Code patterns

**Pattern 1 — Conditional options passthrough (ClaudeAdapter):**

The existing `claude-runner.ts` already passes `permissionMode` to the SDK
at `claude-runner.ts:410-415`. The same pattern applies to `maxTurns` and
`allowedTools`:

```ts
const sdkOptions = {
  ...baseOptions,
  ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
  ...(opts.allowedTools !== undefined && !isAllTools(opts.allowedTools) && {
    allowedTools: opts.allowedTools as string[],
  }),
  ...(opts.permissionMode !== undefined && {
    permissionMode: PERMISSION_MODE_MAP[opts.permissionMode],
  }),
}
```

**Pattern 2 — Kata single-turn invocation (future consumer reference):**

```ts
// This is the pattern kata's step-runner will use after migration.
// Included here for documentation purposes only — not built in this spec.
async function runOneShot(
  adapter: RunnerAdapter,
  prompt: string,
  project: string,
  opts?: { maxTurns?: number; allowedTools?: string[]; budgetMs?: number }
): Promise<string> {
  const chunks: string[] = []
  const ac = new AbortController()
  const timer = opts?.budgetMs
    ? setTimeout(() => ac.abort(), opts.budgetMs)
    : undefined

  await adapter.run({
    sessionId: crypto.randomUUID(),
    project,
    prompt,
    env: process.env as Record<string, string>,
    signal: ac.signal,
    onEvent: (event) => {
      if (event.type === 'assistant') chunks.push(event.content)
    },
    onCommand: () => () => {},   // no-op — single turn, no commands
    maxTurns: opts?.maxTurns,
    allowedTools: opts?.allowedTools,
    permissionMode: 'bypass',
  })

  clearTimeout(timer)
  await adapter.dispose()
  return chunks.join('\n')
}
```

### Gotchas

1. **`isAllTools` helper** — kata's convention `['all']` means "all tools."
   Kata has `isAllTools()` at `packages/kata/src/providers/types.ts:121`.
   For the shared interface, add an `isAllTools(tools?: ReadonlyArray<string>): boolean`
   export to `packages/shared-types/src/runner-adapter.ts`:
   `return !tools || (tools.length === 1 && tools[0] === 'all')`.
   Note: `[]` (empty array) is NOT "all tools" — it means text-only
   mode (no tools offered). Only `undefined` and `['all']` mean
   unrestricted. ClaudeAdapter uses this to decide whether to omit the
   SDK's `allowedTools` param. Kata's own `isAllTools` is retired in
   the follow-up migration.

2. **`permissionMode` type alignment** — #30 defines `PermissionMode` as
   `'plan' | 'auto' | 'approve' | 'bypass'`. The SDK's actual type is
   `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.
   The concrete `PERMISSION_MODE_MAP` is specified in B2 Expected:
   `approve → 'default'`, `bypass → 'bypassPermissions'`, `plan → 'plan'`,
   `auto → 'auto'`. The map is verified against the SDK version installed
   in this monorepo (`@anthropic-ai/claude-agent-sdk`). If the SDK changes
   its literals in a future version, the map is the single update point.

3. **Capability bitmap is additive** — #30 P2/P3/P4 adapter authors
   (Codex, Gemini, pi-mono) must set `supportsMaxTurns` and
   `supportsAllowedTools` on their adapters. Codex doesn't support
   per-tool filtering → `supportsAllowedTools: false`. Gemini CLI doesn't
   support turn limits → `supportsMaxTurns: false`. These are the correct
   "silently ignore" behaviors already designed into the capability model.

4. **No wire-protocol impact** — these three fields are consumed by the
   adapter implementation inside session-runner. They do NOT appear in
   `GatewayCommand` or `GatewayEvent`. The DO/UI never see them — the
   adapter translates them into SDK-level options.

### Reference docs

- **Spec #30** — `planning/specs/30-runner-adapter-pluggable.md` (canonical
  RunnerAdapter interface, lifecycle contract, adapter error semantics)
- **Research** — `planning/research/2026-04-24-kata-runner-convergence.md`
  (gap analysis, interface comparison, recommendations)
- **Kata providers** — `packages/kata/src/providers/types.ts` (current
  `AgentProvider` + `AgentRunOptions` + `ProviderCapabilities`)
- **Claude Agent SDK** — `@anthropic-ai/claude-agent-sdk` `query()` options
  for `maxTurns`, `allowedTools`, `permissionMode` parameters
