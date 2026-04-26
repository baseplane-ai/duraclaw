---
initiative: 109-kata-codex-driver-coexistence
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 109
created: 2026-04-26
updated: 2026-04-26
phases:
  - id: p1
    name: "Foundation: Driver abstraction + free-win parameterization"
    tasks:
      - "Create packages/kata/src/drivers/{types,detect,index}.ts with Driver interface and registry"
      - "Replace hardcoded 'claude' default provider with config.default_provider lookup in step-runner.ts, agent-run.ts, providers.ts"
      - "Build driver-keyed env-var lookup table at tasks-check.ts and providers/claude.ts"
      - "Extract getSettingsPath(driver) helper centralizing user-level config paths"
      - "Build per-driver hook event-name table (canonical → native, identical for now but explicit)"
      - "Define canonical tool-name set; stub toolNameMap on Driver interface"
    test_cases:
      - "Existing kata test suite passes unchanged after refactors (no behavior change in P1)"
      - "Driver registry round-trips: getDriver('claude').name === 'claude'"
      - "default_provider absent from kata.yaml falls back to 'claude' (regression test)"
      - "getSettingsPath('claude') === '~/.claude/settings.json' on POSIX"
  - id: p2
    name: "Driver implementations + setup multiplex + skill dual-install"
    tasks:
      - "Implement packages/kata/src/drivers/claude.ts: writeHookRegistration writes ~/.claude/settings.json (user-level), parseHookInput, formatHookOutput, toolNameMap pass-through"
      - "Implement packages/kata/src/drivers/codex.ts: writeHookRegistration writes ~/.codex/hooks.json with merge-not-clobber, parseHookInput translates codex stdin shape, formatHookOutput translates to codex stdout shape, toolNameMap with apply_patch and Bash mappings"
      - "Refactor setup.ts:applySetup to iterate detected drivers; write hooks via driver.writeHookRegistration"
      - "Refactor scaffold-batteries.ts:installUserSkills to dual-install to ~/.claude/skills/ and ~/.agents/skills/"
      - "Add 'driver' field to session-state zod schema (B26): optional with .default('claude') for backwards compat; SessionStart hook writes the actual driver from --driver flag"
    test_cases:
      - "kata setup on a clean checkout with both drivers installed writes ~/.claude/settings.json AND ~/.codex/hooks.json kata-managed entries"
      - "kata setup with only claude installed writes only ~/.claude/settings.json; emits 'codex not installed' summary"
      - "Re-running kata setup is idempotent (no duplicate entries)"
      - "Skills appear in both ~/.claude/skills/kata-research/ and ~/.agents/skills/kata-research/ after setup"
      - "SessionStart hook with --driver=codex updates state.json driver field; pre-existing sessions without driver field load successfully (backwards compat)"
  - id: p3
    name: "Hook adapter: per-driver entry points + no-op gate"
    tasks:
      - "Add --driver={claude,codex} flag to kata hook command; route stdin parsing through driver.parseHookInput, stdout through driver.formatHookOutput"
      - "Refactor hook handlers (handleSessionStart, handleUserPrompt, handleModeGate, handlePreToolUse, handlePostToolUse) to consume CanonicalHookInput and emit CanonicalHookOutput; per-driver translation only at entry/exit"
      - "Implement walk-up-from-cwd gate: hook exits 0 with empty stdout if no .kata/kata.yaml found in cwd or ancestors"
      - "Replace hardcoded tool-name string checks (Edit, Write, Bash, TaskUpdate, etc.) with driver.toolNameMap-resolved canonical comparisons in hook.ts"
      - "Move stop-hook-feedback string detection to driver.detectStopHookFeedback (Claude string + codex string TBD via spike)"
      - "Add codexDriver.hasActiveBackgroundAgents() returning false (graceful degrade for transcript reading)"
    test_cases:
      - "kata hook --driver=claude session-start with claude stdin shape produces claude stdout shape; canonical handler invoked"
      - "kata hook --driver=codex session-start with codex stdin shape produces codex stdout shape; same canonical handler invoked"
      - "kata hook --driver=codex pre-tool-use fired from cwd outside any .kata/ project exits 0 with empty stdout"
      - "kata hook --driver=claude pre-tool-use with tool_name='Edit' (Claude native) and --driver=codex with tool_name='apply_patch' both block on the same canonical mode-gate condition"
  - id: p4
    name: "Native task store: canonical + claude mirror + codex render + kata task CLI"
    tasks:
      - "Create canonical NativeTaskStore at .kata/sessions/{sessionId}/native-tasks/{taskId}.json; refactor task-factory.ts read/write to use it as source of truth"
      - "Implement claudeDriver.nativeTaskStore: mirrors canonical writes to ~/.claude/tasks/{sessionId}/{taskId}.json on every create/update"
      - "Implement codexDriver.nativeTaskStore: renders canonical task list as markdown into .codex/config.toml developer_instructions field, between # kata-managed:start / # kata-managed:end markers; refresh on every state change"
      - "Add kata task <update|list|get> CLI subcommands; share canonical store with hook handlers; idempotent writes"
      - "Create batteries/skills/kata-task/SKILL.md instructing agent to use Bash → kata task update for state changes; install to both skill dirs"
      - "Extend hook.ts:handlePreToolUse Bash routing to recognize 'kata task <op>' invocations and dispatch through canonical task-state logic (mirror of TaskUpdate handler path)"
      - "Update task-factory.ts:174,281,307 skill-invocation rendering to use driver.skillInvocationPrefix (/ for claude, $ for codex)"
    test_cases:
      - "Writing a task via TaskUpdate (Claude session) and via kata task update (codex session) produces identical state in canonical store"
      - "Codex .codex/config.toml developer_instructions reflects current task list within the kata-managed marker block; refreshes on TaskUpdate"
      - "Hand-edited content outside kata-managed markers in .codex/config.toml is preserved across kata updates"
      - "B15 edge cases: (a) config.toml file does not exist — kata creates it with developer_instructions field containing only the marker block; (b) developer_instructions field absent in existing config.toml — kata appends triple-quoted field with marker block, preserving all other fields/comments; (c) single-line vs triple-quoted developer_instructions — both forms detected and updated; (d) zero-task session — marker block contains a placeholder line ('No active kata tasks.') rather than empty content"
      - "kata task list outputs in_progress and pending tasks for the active session"
      - "PreToolUse(Bash) with command 'kata task update 3 --status=completed' in a kata-managed cwd routes through canonical handler and triggers stop-condition recheck"
      - "task instructions render 'Invoke /kata-research' under claude and 'Invoke $kata-research' under codex"
  - id: p5
    name: "Migration + teardown + diagnostics + parameterized fixtures + verification + docs"
    tasks:
      - "Add migration step (B9): detect kata-managed entries in project-level .claude/settings.json; remove them; emit one-line summary; idempotent"
      - "Mirror cleanup in teardown.ts: removeHookRegistration for each driver (B27)"
      - "Extend kata doctor: per-driver checks for hook registration, codex_hooks feature flag, codex --version >= 0.124, AGENTS.md presence warning under codex, CLAUDE.md presence warning under claude (existing)"
      - "Refactor packages/kata/src/testing/{mock-hooks,test-fixtures}.ts to setupDriverFixture(driver) helper; conditionally skip codex tests when 'which codex' fails"
      - "Update batteries/kata.yaml task_rules to reference canonical task ops generically (avoid driver-specific tool names)"
      - "Update packages/kata/CLAUDE.md to document the new Driver abstraction + dual-driver UX"
      - "Run full Verification Plan against this checkout: claude session and codex session each completing a kata task-mode round trip"
      - "Open follow-up issue stub for codex transcript adapter (deferred per interview decision)"
    test_cases:
      - "Migration: a checkout with stale project-level .claude/settings.json kata entries gets them removed; non-kata entries preserved"
      - "kata teardown removes kata-managed entries from both user-level configs"
      - "kata doctor on a checkout with claude+codex both installed reports green for both; on missing codex reports yellow for codex section only"
      - "Vitest pass on full kata test suite under both 'codex available' and 'codex not on PATH' conditions"
      - "Verification Plan steps 1-10 all pass"
      - "Follow-up issue exists with title containing 'codex transcript' and references GH#109"
---

# Spec: kata codex driver coexistence (GH#109)

## Overview

`packages/kata/` today is a Claude-Code-only session-driver shim:
hook registration, native task files, skill loading, and ceremony all
assume Claude. This spec adds OpenAI Codex CLI as a co-equal session
driver. A developer can run a kata session under Claude in one terminal
and codex in another against the same checkout, sharing canonical
`.kata/` state, with neither driver aware of the other. Both drivers
register hooks at user-level (`~/.claude/settings.json`,
`~/.codex/hooks.json`) and a kata-introduced no-op gate keeps hooks
silent outside kata-managed projects.

## Feature Behaviors

### B1: Driver abstraction

**Core:**
- **ID:** driver-abstraction
- **Trigger:** Any kata command that needs to know about session-driver
  identity (setup, doctor, hook handlers, task-factory, scaffold).
- **Expected:** A `Driver` interface in `packages/kata/src/drivers/`
  encapsulates per-driver behavior; a registry maps `'claude' | 'codex'`
  to implementations; `detect()` returns the set of installed drivers.
- **Verify:** `import { getDriver, listDrivers, detectInstalled } from
  '~/drivers'`; `getDriver('claude').name === 'claude'`;
  `listDrivers().length === 2`; `detectInstalled()` returns array
  matching `which claude` / `which codex` results.
**Source:** new files at `packages/kata/src/drivers/{types,detect,index,claude,codex}.ts`.

#### Code Layer

```ts
// packages/kata/src/drivers/types.ts
export interface CanonicalHookInput {
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'
  sessionId: string
  cwd: string
  toolName?: string         // canonical
  toolInput?: unknown
  // ... plus event-specific fields
}
export interface CanonicalHookOutput {
  decision?: 'block' | 'allow' | 'ask'
  reason?: string
  systemMessage?: string
  additionalContext?: string
}
export interface NativeTaskStore {
  read(taskId: string): Promise<NativeTask | null>
  write(task: NativeTask): Promise<void>
  list(): Promise<NativeTask[]>
  refreshDriverState(sessionId: string): Promise<void>  // codex: render to config.toml; claude: mirror
}
export interface Driver {
  name: 'claude' | 'codex'
  isInstalled(): boolean
  writeHookRegistration(hookCommand: string): Promise<void>
  removeHookRegistration(): Promise<void>
  parseHookInput(stdin: string, event: string): CanonicalHookInput
  formatHookOutput(out: CanonicalHookOutput, event: string): { stdout: string; exitCode: 0 | 2 }
  hookEventName(canonical: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'): string  // see B5
  toolNameMap(): Record<string, string>
  nativeTaskStore: NativeTaskStore
  skillsDir(scope: 'user' | 'project', cwd?: string): string
  skillInvocationPrefix(): '/' | '$'
  ceremonyFileName(): 'CLAUDE.md' | 'AGENTS.md'
  detectStopHookFeedback(text: string): boolean
  hasActiveBackgroundAgents(sessionId: string): Promise<boolean>
}
```

---

### B2: Default-provider parameterization (free win)

**Core:**
- **ID:** default-provider-config
- **Trigger:** Any code path falling back to the default agent provider
  (currently hardcoded `'claude'`).
- **Expected:** Reads `default_provider` from `kata.yaml`; falls back
  to `'claude'` only when unset (preserves existing behavior).
- **Verify:** `kata.yaml` containing `default_provider: codex` makes
  `getProvider('default').name === 'codex'`;
  removing the field falls back to `'claude'`.
**Source:** `src/providers/step-runner.ts:68,71,72`,
`src/commands/agent-run.ts:53`, `src/commands/providers.ts:138`.

---

### B3: Env-var lookup table per driver (free win)

**Core:**
- **ID:** env-var-lookup
- **Trigger:** Code that checks `CLAUDE_CODE_ENABLE_TASKS` (or similar
  driver-specific env vars) to gate behavior.
- **Expected:** A driver-keyed table (`{ claude: 'CLAUDE_CODE_ENABLE_TASKS',
  codex: <equivalent if any, else null> }`) replaces hardcoded strings;
  consumers look up by current driver.
- **Verify:** Under claude session, `isNativeTasksEnabled()` consults
  `CLAUDE_CODE_ENABLE_TASKS`; under codex session, consults the codex
  equivalent (or returns true if codex has no equivalent gate).
**Source:** `src/utils/tasks-check.ts:14,22-24`,
`src/commands/doctor.ts:266`, `src/providers/claude.ts:149`
(nested-session detection).

---

### B4: User-level settings-path helper (free win)

**Core:**
- **ID:** user-settings-path-helper
- **Trigger:** Any code that needs the path to a driver's user-level
  hook config file.
- **Expected:** `getUserSettingsPath(driver: Driver): string` returns
  `~/.claude/settings.json` for claude and `~/.codex/hooks.json` for
  codex (or `~/.codex/config.toml` if user has hooks inline there;
  detect at write time).
- **Verify:** unit test verifies path resolution per driver and homedir
  expansion.
**Source:** new helper in `src/drivers/paths.ts`; consumers refactored
from hardcoded `.claude/settings.json` references at
`setup.ts:174-195`, `teardown.ts:128`, `doctor.ts:63`.

---

### B5: Per-driver hook event-name table (free win)

**Core:**
- **ID:** hook-event-name-table
- **Trigger:** kata setup registering hook entries per event; canonical
  hook handler dispatch.
- **Expected:** `driver.hookEventName(canonical)` returns the native
  event name. For both drivers in scope, names are identical (e.g.
  `'SessionStart' → 'SessionStart'`); the table is explicit anyway so
  later drivers (gemini-cli, etc.) can override.
- **Verify:** `claudeDriver.hookEventName('PreToolUse') === 'PreToolUse'`;
  `codexDriver.hookEventName('PreToolUse') === 'PreToolUse'`.
**Source:** new method on Driver interface; consumed by
`setup.ts:buildHookEntries`.

---

### B6: Claude driver implementation

**Core:**
- **ID:** claude-driver
- **Trigger:** Any kata operation under a claude-driven session.
- **Expected:** `claudeDriver` implements `Driver` such that all
  existing kata behavior is preserved bit-for-bit (no functional
  change), but every coupling point now goes through the abstraction.
- **Verify:** Existing kata test suite (28 `.test.ts` files mocking
  `.claude/`) passes after the refactor with no behavioral assertions
  changed; only fixture-helper paths updated.
**Source:** new file `packages/kata/src/drivers/claude.ts`. Refactors
of `setup.ts:101-195`, `hook.ts:36-1391` route through this driver.

#### Code Layer

- `writeHookRegistration` writes `~/.claude/settings.json` (was
  `.claude/settings.json` project-level). Uses
  `mergeHooksIntoSettings()` (existing pattern) to preserve non-kata
  entries.
- `parseHookInput`: pass-through (Claude shape is canonical baseline).
- `formatHookOutput`: emits Claude's `{decision, hookSpecificOutput}`.
- `toolNameMap`: identity map (Claude tool names ARE canonical).
- `nativeTaskStore`: mirror to `~/.claude/tasks/{sessionId}/{id}.json`
  on every canonical write.
- `skillsDir('user')`: `~/.claude/skills/`. `skillsDir('project',
  cwd)`: `<cwd>/.claude/skills/`.
- `skillInvocationPrefix()`: `'/'`.
- `ceremonyFileName()`: `'CLAUDE.md'`.
- `detectStopHookFeedback`: existing logic at `hook.ts:677-697`.
- `hasActiveBackgroundAgents`: existing logic at `hook.ts:613-632`
  reading `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.

---

### B7: Codex driver implementation

**Core:**
- **ID:** codex-driver
- **Trigger:** Any kata operation under a codex-driven session.
- **Expected:** `codexDriver` implements `Driver` for codex CLI
  semantics: user-level hook registration in `~/.codex/hooks.json`,
  per-driver hook input/output translation, native task store renders
  into `.codex/config.toml`, codex skill dir at `~/.agents/skills/`.
- **Verify:** Codex agent in a kata session can: receive a
  SessionStart hook fire, see canonical task list in its
  `developer_instructions`, run `kata task update 1 --status=completed`
  via Bash, see PreToolUse-routed stop-condition recheck.
**Source:** new file `packages/kata/src/drivers/codex.ts`.

#### Code Layer

- `writeHookRegistration` writes user-level `~/.codex/hooks.json` (or
  appends to `~/.codex/config.toml [hooks]` if that's where existing
  user entries live; detect by reading both, prefer the file the user
  is already using). Merge-not-clobber by command-string match against
  a kata-managed marker (e.g. `kata hook --driver=codex` substring is
  the marker).
- `parseHookInput`: translate codex stdin into CanonicalHookInput.
  Concrete shapes per event (verified against codex 0.124 docs;
  re-verify in impl spike against the installed binary):

  **SessionStart stdin:**
  ```json
  {
    "session_id": "abc-123",
    "transcript_path": "/Users/x/.codex/sessions/abc-123.jsonl",
    "cwd": "/data/projects/duraclaw-dev3",
    "hook_event_name": "SessionStart",
    "model": "gpt-5-codex",
    "source": "startup"
  }
  ```

  **PreToolUse stdin (apply_patch example):**
  ```json
  {
    "session_id": "abc-123",
    "transcript_path": "/Users/x/.codex/sessions/abc-123.jsonl",
    "cwd": "/data/projects/duraclaw-dev3",
    "hook_event_name": "PreToolUse",
    "model": "gpt-5-codex",
    "tool_name": "apply_patch",
    "tool_input": { "path": "src/foo.ts", "patch": "@@ ..." }
  }
  ```

  **PostToolUse stdin:**
  ```json
  {
    "session_id": "abc-123",
    "transcript_path": "/Users/x/.codex/sessions/abc-123.jsonl",
    "cwd": "/data/projects/duraclaw-dev3",
    "hook_event_name": "PostToolUse",
    "model": "gpt-5-codex",
    "tool_name": "apply_patch",
    "tool_input": { "path": "src/foo.ts", "patch": "@@ ..." },
    "tool_response": { "success": true, "output": "..." }
  }
  ```
  (Same shape as PreToolUse plus a `tool_response` field carrying
  the tool's exit status / output text.)

  **UserPromptSubmit stdin:**
  ```json
  {
    "session_id": "abc-123",
    "cwd": "...",
    "hook_event_name": "UserPromptSubmit",
    "prompt": "<user message text>"
  }
  ```

  **Stop stdin:** same envelope as SessionStart, `hook_event_name:
  "Stop"`, plus `stop_hook_active: bool`.

  Translation rules: copy `session_id → sessionId`, `cwd → cwd`,
  `hook_event_name → event`. For PreToolUse/PostToolUse, run
  `tool_name` through reverse `toolNameMap()` to canonical. **Reverse
  lookup contract:** when multiple canonical names map to the same
  driver-native name (e.g. `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
  all → `apply_patch`), the reverse lookup returns the FIRST canonical
  key in declaration order — for the codex map, this is `'Edit'`. Mode
  gate logic (B12, B18) treats all four edit-family canonicals
  uniformly via a `EDIT_FAMILY` set, so the chosen representative
  doesn't affect gate decisions. (See B19 gotcha for assertion-test
  guidance.) Pass `tool_input` and `tool_response` through verbatim.

- `formatHookOutput`: emit codex stdout shape per event. Concrete
  contracts (verified against codex 0.124 docs):

  **PreToolUse output (decision: 'block' → deny):**
  ```json
  {
    "permissionDecision": "deny",
    "stopReason": "<reason text>"
  }
  ```
  Returned as `{ stdout: '<json above>', exitCode: 2 }` from
  `formatHookOutput`. The hook command dispatcher writes `stdout` to
  process stdout then calls `process.exit(exitCode)`. Exit 2 plus the
  JSON body is defensive: codex docs accept either mechanism, so kata
  emits both.

  **PreToolUse output (decision: 'allow' or undefined):**
  `{ stdout: '', exitCode: 0 }`.

  **SessionStart / UserPromptSubmit output (additionalContext):**
  ```json
  {
    "systemMessage": "<additionalContext text>",
    "continue": true
  }
  ```

  **Stop output (decision: 'block' → keep going):**
  ```json
  {
    "continue": true,
    "stopReason": "<reason text from canonical handler>"
  }
  ```

  **PostToolUse output:** `{ stdout: '', exitCode: 0 }` always —
  PostToolUse is observe-only; codex doesn't act on its output. The
  canonical handler may emit `additionalContext` for transcript
  enrichment, but codex 0.124-0.125 ignores it on PostToolUse.

  **Default (no-op):** `{ stdout: '', exitCode: 0 }`.

All non-block events return `exitCode: 0`. Only PreToolUse with
`decision: 'block'` returns `exitCode: 2`. Claude driver always
returns `exitCode: 0` (Claude reads `decision` from JSON body).
- `toolNameMap`: minimum viable mapping table:
  `{Edit: 'apply_patch', Write: 'apply_patch', MultiEdit: 'apply_patch',
  NotebookEdit: 'apply_patch', Bash: 'Bash'}`. Refined during impl
  spike.
- `nativeTaskStore`: see B15.
- `skillsDir('user')`: `~/.agents/skills/`. `skillsDir('project',
  cwd)`: `<cwd>/.agents/skills/` (note: `.agents/`, not `.codex/`).
- `skillInvocationPrefix()`: `'$'`.
- `ceremonyFileName()`: `'AGENTS.md'`.
- `detectStopHookFeedback`: codex-specific string TBD; impl spike must
  determine codex's actual stop-feedback prefix and add a unit test.
- `hasActiveBackgroundAgents`: returns `false` (graceful degrade per
  interview decision).

---

### B8: kata setup multiplexes both drivers

**Core:**
- **ID:** setup-multiplex
- **Trigger:** `kata setup` (and `kata setup --rerun`) invocation.
- **Expected:** Detects installed drivers; for each, calls
  `driver.writeHookRegistration(kataHookCommand)`. Writes to user-level
  config files only. Skill dual-install runs unconditionally (skills
  are useful regardless of which drivers are installed). Output ends
  with one-line summary listing drivers configured.
- **Verify:** On a checkout with both drivers installed, after
  `kata setup`, both `~/.claude/settings.json` and `~/.codex/hooks.json`
  contain kata-managed entries with `--driver=claude` /
  `--driver=codex` flags respectively. Output line:
  `kata setup: registered hooks for: claude, codex`.
**Source:** refactor `setup.ts:applySetup` (lines 351-377).

#### Code Layer

```ts
// rough shape
async function applySetup(opts) {
  // ... existing kata.yaml + .kata/ scaffolding ...
  const installed = detectInstalled()
  for (const driver of installed) {
    await driver.writeHookRegistration(resolveWmBin())
  }
  await scaffoldBatteries()
  await installUserSkills()  // dual-install, see B10
  await migrateStaleProjectLevelClaudeHooks(opts.cwd)  // see B9
  console.log(`kata setup: registered hooks for: ${installed.map(d => d.name).join(', ')}`)
  if (installed.length < 2) {
    const missing = ['claude', 'codex'].filter(n => !installed.find(d => d.name === n))
    console.log(`  (${missing.join(', ')} not installed; run kata setup again after install)`)
  }
}
```

---

### B9: Migrate stale project-level Claude hook entries

**Core:**
- **ID:** migrate-stale-claude-hooks
- **Trigger:** `kata setup` (or `kata setup --rerun`) on a checkout
  that has pre-existing project-level kata entries in
  `<cwd>/.claude/settings.json`.
- **Expected:** kata-managed entries (identified by command string
  matching `kata hook` substring) are removed from project-level
  `.claude/settings.json`. Non-kata entries preserved unchanged. If
  the file becomes empty after removal, delete the file. Emit a
  one-line status: `kata setup: migrated stale .claude/settings.json
  hooks → user-level (3 entries removed)`.
- **Verify:** Test fixture: a `.claude/settings.json` with 2 kata
  entries + 1 user entry. After `kata setup`: kata entries gone, user
  entry preserved.
**Source:** new function in `src/commands/setup.ts`. Triggered once
per setup run; idempotent (no-op when no stale entries present).

---

### B10: Skill dual-install

**Core:**
- **ID:** skill-dual-install
- **Trigger:** `kata setup` invocation; also `kata scaffold-batteries`.
- **Expected:** For every skill in `batteries/skills/`, install to
  both `~/.claude/skills/{name}/` and `~/.agents/skills/{name}/`. Same
  content. Existing `installUserSkills()` (`scaffold-batteries.ts:311-350`)
  becomes a loop over driver `skillsDir('user')` paths.
- **Verify:** After `kata setup`, both `~/.claude/skills/kata-research/SKILL.md`
  and `~/.agents/skills/kata-research/SKILL.md` exist with identical
  contents.
**Source:** `src/commands/scaffold-batteries.ts:311-350`.

---

### B11: Per-driver hook entry point with `--driver` flag

**Core:**
- **ID:** hook-entry-per-driver
- **Trigger:** Hook registration writes
  `kata hook --driver=<name> <event> --session=<id>` as the hook
  command. When the driver fires the hook, this command runs.
- **Expected:** `kata hook` parses `--driver` flag, looks up the
  matching `Driver`, calls `driver.parseHookInput(stdin, event)` to
  produce CanonicalHookInput, dispatches to the canonical handler
  (existing logic), then runs the result through `driver.formatHookOutput`
  to emit the driver's native stdout shape.
- **Verify:** `echo '<claude-stdin-json>' | kata hook --driver=claude
  pre-tool-use --session=<id>` produces claude stdout shape;
  `echo '<codex-stdin-json>' | kata hook --driver=codex pre-tool-use
  --session=<id>` produces codex stdout shape; both invoke the same
  canonical handler logic.
**Source:** refactor `src/commands/hook.ts` entry point (currently
~36 lines of arg parsing + dispatch). Existing handler bodies
(`handleSessionStart` etc., lines 154-1391) become canonical; only the
top-of-file shim changes per driver.

---

### B12: No-op gate via walk-up `.kata/`

**Core:**
- **ID:** hook-cwd-gate
- **Trigger:** Every hook fire (any event, any driver).
- **Expected:** Before any handler logic, walk parent dirs from
  `input.cwd` looking for a `.kata/` directory containing `kata.yaml`.
  If not found, exit 0 with empty stdout (no-op). If found, proceed.
- **Verify:** `cd /tmp && echo '{...}' | kata hook --driver=codex
  pre-tool-use` exits 0 with empty stdout.
  `cd /data/projects/duraclaw-dev3 && echo '{...}' | kata hook
  --driver=codex session-start` returns expected SessionStart output.
**Source:** new top-of-file check in `hook.ts` after `parseHookInput`
populates `cwd`. Reuses existing `findProjectRoot()` logic.

---

### B13: Canonical native-task store

**Core:**
- **ID:** canonical-native-tasks
- **Trigger:** Any kata code path that today writes to or reads from
  `~/.claude/tasks/{sessionId}/{taskId}.json` — `kata enter`, the
  TaskUpdate hook handler, the `kata task` CLI (B16), stop-condition
  checks, can-exit, etc.
- **Expected:** Source of truth lives at
  `.kata/sessions/{sessionId}/native-tasks/{taskId}.json`. Schema:
  `{id, subject, description, activeForm, status, blocks[], blockedBy[],
  metadata}` (matches existing native-task shape). Every read goes
  through canonical store; every write goes through canonical store
  AND triggers `driver.nativeTaskStore.refreshDriverState(sessionId)`
  to sync the driver's native view (Claude mirror, codex render).
- **Verify:** After `kata enter task`, files exist at
  `.kata/sessions/<id>/native-tasks/{1..5}.json` matching the 5
  pre-created phase tasks. Updating one via either driver path produces
  identical canonical content.
**Source:** new module `src/native-tasks/canonical-store.ts`.
Refactors of `src/commands/enter/task-factory.ts:357-358, 430-503,
568-599` and hook handlers reading native tasks (e.g.
`src/commands/hook.ts:379`).

---

### B14: Claude native-task mirror

**Core:**
- **ID:** claude-native-task-mirror
- **Trigger:** `claudeDriver.nativeTaskStore.refreshDriverState(sessionId)`
  is invoked on every canonical task write under a Claude session.
- **Expected:** Mirror canonical files into
  `~/.claude/tasks/{sessionId}/{taskId}.json` (existing path Claude
  Code's native Task tool reads). Removed canonical files are removed
  from the mirror. Idempotent.
- **Verify:** Write a task via `kata task update 3 --status=completed`
  in a Claude-driven kata session; both
  `.kata/sessions/<id>/native-tasks/3.json` and
  `~/.claude/tasks/<id>/3.json` reflect status=completed within
  100ms.
**Source:** `src/drivers/claude.ts` `nativeTaskStore` impl.

---

### B15: Codex native-task render into `developer_instructions`

**Core:**
- **ID:** codex-native-task-render
- **Trigger:** `codexDriver.nativeTaskStore.refreshDriverState(sessionId)`
  is invoked on every canonical task write under a Codex session.
- **Expected:** Render canonical task list as markdown into the
  project-local `.codex/config.toml` `developer_instructions` field,
  bracketed by `# kata-managed:start` and `# kata-managed:end` marker
  comments. Outside the marker block: untouched. Format inside the
  block:

  ```markdown
  ## Active kata tasks
  - [ ] #1 P0: Setup - research codebase (in_progress)
  - [x] #2 P1: Setup - gather requirements (completed)
  - [ ] #3 P2: Work - write feature spec (pending, blocked by #2)
  ...
  ```

- **Verify:** After `kata enter task`, `.codex/config.toml` contains
  the marker block with one line per pre-created task. Calling
  `kata task update 1 --status=completed` re-renders the block;
  user-edited content outside the markers is preserved verbatim.
**Source:** `src/drivers/codex.ts` `nativeTaskStore` impl.

**Implementation approach: regex-based marker-block replacement on the
raw file string** (no TOML library dependency added — kata stays on
`js-yaml` + `zod`). Rationale: `@iarna/toml` and `smol-toml` both
discard comments on parse, so a parse→stringify round-trip would
silently delete user TOML comments. Instead:

1. Read `.codex/config.toml` as a raw string.
2. Locate the `developer_instructions` field assignment via regex
   (handle both single-line `developer_instructions = "..."` and
   triple-quoted multi-line `developer_instructions = """..."""`
   forms).
3. If the field doesn't exist: append a new triple-quoted block at
   end of file containing only the kata-managed marker block.
4. If the field exists: locate `# kata-managed:start` /
   `# kata-managed:end` markers within the field's string value.
   Replace content between markers (preserving leading/trailing
   newlines). Preserve everything else byte-for-byte.
5. If the field exists but markers don't: append the marker block
   to the existing string content (preserving user content above).
6. Write the file atomically (temp file + rename).

This approach preserves all user TOML comments and formatting outside
the marker block. Inside the marker block, kata fully owns the
content — users are warned via inline comment not to hand-edit.

#### Open Risks Tracked
- Render size — if `developer_instructions` exceeds codex's
  `project_doc_max_bytes`, paginate or summarize. Detection: warn in
  output if rendered length > 16KB.

---

### B16: kata task CLI subcommands

**Core:**
- **ID:** kata-task-cli
- **Trigger:** Agent (or human) runs `kata task <subcommand>` from
  inside a kata-managed checkout.
- **Expected:** Three subcommands:
  - `kata task list [--status=...]` — JSON or markdown output of
    current session's tasks.
  - `kata task get <id>` — full detail of one task.
  - `kata task update <id> --status=<pending|in_progress|completed>
    [--description=...] [--add-blocked-by=...]` — updates canonical
    store, fans out to `driver.nativeTaskStore.refreshDriverState`.
  Implicit session resolution via `--session=<id>` flag (set by
  PreToolUse Bash hook auto-injection at `hook.ts:1108-1131`) or via
  current-session lookup.
- **Verify:** `kata task list` in this session lists 5 phase tasks.
  `kata task update 3 --status=completed` returns exit 0 and writes
  canonical store.

**Error contract:**
- Unknown task id (`kata task update 99 --status=completed`): exit 1,
  stderr `kata task: unknown task id: 99 (valid ids: 1, 2, 3, 4, 5)`.
- Invalid status value (`--status=banana`): exit 2 (usage error),
  stderr lists allowed values (`pending|in_progress|completed`).
- No active session resolvable: exit 3, stderr `kata task: no active
  session in cwd (run kata enter <mode> first)`.
- Malformed canonical store (corrupt JSON): exit 4, stderr `kata task:
  session state corrupt at <path>`.
- Success: exit 0, stdout one line summary (`kata task: updated #3 →
  completed`); machine-readable JSON via `--json` flag.

**Source:** new `src/commands/task.ts`. Wired in
`src/index.ts:command dispatch`.

---

### B17: kata-task skill (codex-side wrapper)

**Core:**
- **ID:** kata-task-skill
- **Trigger:** Codex agent encounters a task-state-management need
  (matching skill description) or explicit `$kata-task` invocation.
- **Expected:** A `batteries/skills/kata-task/SKILL.md` defines a
  skill whose body instructs the agent to use the Bash tool to run
  `kata task list` / `kata task update` / `kata task get` for state
  management. Installed to both `~/.claude/skills/kata-task/` and
  `~/.agents/skills/kata-task/` by B10. Under Claude, the skill is
  invokable as `/kata-task` but Claude sessions primarily use native
  TaskUpdate; the skill exists for symmetry.
- **Verify:** After `kata setup`, both skill dirs contain
  `kata-task/SKILL.md`. Codex session with explicit `$kata-task`
  expansion sees the SKILL.md content; canonical state updates after
  the agent runs the suggested Bash command.
**Source:** new `packages/kata/batteries/skills/kata-task/SKILL.md`.

---

### B18: PreToolUse(Bash) routing for `kata task`

**Core:**
- **ID:** kata-task-bash-routing
- **Trigger:** PreToolUse hook fires with `tool_name='Bash'` (or
  codex equivalent) and `tool_input.command` matching `kata task <op>`.
- **Expected:** Hook handler detects `kata task <op>` invocation;
  after the agent's Bash actually runs the command (which mutates
  canonical store), trigger the same canonical task-state recheck
  logic that today runs after Claude's TaskUpdate (stop-condition
  recheck, dependency unblocks, evidence collection).
- **Verify:** Agent runs `kata task update 4 --status=completed` via
  Bash; subsequent stop-condition check finds task #4 done; if no
  pending tasks remain, can-exit returns true.
**Source:** extend `hook.ts:1077-1325` (existing
`handlePreToolUse`).

---

### B19: Tool-name translation table (codex)

**Core:**
- **ID:** codex-tool-name-map
- **Trigger:** PreToolUse / PostToolUse hook fires under codex with
  codex-native tool names.
- **Expected:** `codexDriver.toolNameMap()` returns a mapping table.
  `parseHookInput` resolves incoming `tool_name` to canonical via
  reverse lookup. Subsequent canonical handler logic uses canonical
  names exclusively.
- **Verify:** PreToolUse from codex with `tool_name='apply_patch'`
  triggers the canonical "edit" code path (was matching `Edit` /
  `Write`); kata's mode-gate denies it under planning mode.
**Source:** `src/drivers/codex.ts:toolNameMap`. Mapping table refined
during impl spike (1-2h dedicated work to confirm exact codex names).

#### Initial mapping (subject to spike confirmation)
| Canonical | Codex |
|---|---|
| Edit | apply_patch |
| Write | apply_patch |
| MultiEdit | apply_patch |
| NotebookEdit | (degrade — codex has no equivalent; canonical handler treats absence as no-op) |
| Bash | Bash |
| TaskUpdate | (N/A — see B18; via `kata task update` Bash invocation instead) |

---

### B20: Skill invocation prefix per driver

**Core:**
- **ID:** skill-invocation-prefix
- **Trigger:** `task-factory.ts` generates phase task instructions that
  reference methodology skills.
- **Expected:** Render `Invoke {prefix}{name}` where `prefix` comes
  from the active driver's `skillInvocationPrefix()`. Currently
  hardcoded `Invoke /${skill}` at
  `src/commands/enter/task-factory.ts:174,281,307`. The active driver
  is read from `.kata/sessions/{id}/state.json` `driver` field
  (written by B26 on SessionStart).

  **Initial render and re-render contract:** at `kata enter` time,
  `state.driver` is unset — `task-factory.ts` renders the initial
  `.kata/sessions/{id}/native-tasks/{i}.json` instructions with the
  CLAUDE prefix (`/`) as the safe default. After SessionStart writes
  `state.driver = 'codex'`, the SessionStart hook handler iterates
  the session's native-task files and rewrites the `instructions`
  field, swapping `/<skill-name>` for `$<skill-name>` (regex-targeted
  replacement on the rendered string, NOT a full re-template — only
  the prefix character changes).

  **Race window:** if the codex agent reads task #1 between `kata
  enter` and SessionStart firing, it sees `Invoke /kata-research`
  (Claude form). This window is on the order of milliseconds in
  practice. Mitigation: the re-rewritten `instructions` field
  becomes the source of truth for any subsequent task reads (e.g.
  TaskGet); only the very first read in the SessionStart-pending
  window can be stale. Documented as a known minor UX papercut, not
  a correctness bug.
- **Verify:** After `kata enter task` in a Claude session, native
  task #1 instruction contains `Invoke /kata-research`. Same flow in
  a codex session contains `Invoke $kata-research`.
**Source:** `src/commands/enter/task-factory.ts:174,281,307`. Driver
field on session state is owned by B26.

---

### B21: Stop-hook feedback detector per driver

**Core:**
- **ID:** stop-hook-feedback-detector
- **Trigger:** Transcript-replay paths that filter out synthetic stop
  hook feedback messages (existing logic at `hook.ts:677-697`).
- **Expected:** Move detection logic to
  `driver.detectStopHookFeedback(text)`.
  - **Claude impl:** preserve existing string match
    (`'Stop hook feedback:'` OR `'Session has incomplete work:'`).
  - **Codex impl — default that ships:** `return false` (always).
    This is the safe fallback and IS what gets merged in P3. Worst
    case under this stub: stop-hook synthetic text leaks into
    transcript replay under codex (a UX papercut, not a correctness
    issue).
  - **Codex impl — spike-improved (≤30 min, follow-up commit OK):**
    a 30-minute impl spike runs codex with a `stopReason` output and
    greps the resulting transcript JSONL for the synthetic message
    envelope. If the spike identifies a stable prefix, replace the
    `false`-always stub with a regex match (e.g. `/^Stop hook:/` —
    exact pattern determined by spike) and commit a fixture-based
    unit test pinning it. If the spike is inconclusive after 30 min,
    keep the `false`-always stub and open a follow-up issue. **Do
    NOT block the PR on the spike outcome.**
- **Verify:** Unit test per driver. Claude: `detectStopHookFeedback(
  'Stop hook feedback: foo')` returns true. Codex: fixture file at
  `src/drivers/__fixtures__/codex-stop-feedback.jsonl` (recorded by
  the spike) — detector returns true on lines tagged synthetic,
  false on user-authored lines.
**Source:** `src/commands/hook.ts:677-697` + new fixture file.

---

### B22: kata doctor codex parity

**Core:**
- **ID:** doctor-codex-parity
- **Trigger:** `kata doctor` invocation.
- **Expected:** For each installed driver, run a checks block:
  - **Claude (existing checks unchanged)**: `~/.claude/settings.json`
    has kata hooks; `CLAUDE_CODE_ENABLE_TASKS` env enabled; `CLAUDE.md`
    present at project root.
  - **Codex (new)**: `~/.codex/hooks.json` (or
    `~/.codex/config.toml [hooks]`) has kata hooks;
    `features.codex_hooks = true`; `codex --version` returns ≥ 0.124;
    `AGENTS.md` present at project root.
- **Verify:** Run `kata doctor` on this checkout; output shows green
  for both drivers; remove `~/.codex/hooks.json` kata entries and
  re-run; codex section reports yellow with a remediation hint
  pointing at `kata setup`.
**Source:** extend `src/commands/doctor.ts:57-298`.

---

### B23: AGENTS.md missing warning under codex

**Core:**
- **ID:** agents-md-warning
- **Trigger:** `kata doctor` (and `kata setup` summary) under a codex-
  enabled project.
- **Expected:** If codex is installed and project root lacks
  `AGENTS.md`, emit a yellow warning recommending the user create one.
  Mirror existing CLAUDE.md warning behavior.
- **Verify:** On a checkout with no `AGENTS.md`, `kata doctor` codex
  section shows yellow `AGENTS.md missing — codex won't auto-load
  project context`.
**Source:** `src/commands/doctor.ts` (new check); `src/commands/setup.ts`
(summary line).

---

### B24: Transcript graceful-degrade for codex

**Core:**
- **ID:** codex-transcript-degrade
- **Trigger:** `hasActiveBackgroundAgents(sessionId)` called from a
  codex hook context (today: `hook.ts:613-632` reads
  `~/.claude/projects/.../*.jsonl`).
- **Expected:** Codex driver returns `false` always. Worst case: one
  extra prompt cycle when a background-agent check would have prevented
  stop. Acceptable.
- **Verify:** Unit test: `codexDriver.hasActiveBackgroundAgents('any')
  === false`. Integration: codex session with a background agent in
  flight does not auto-block stop (regression vs Claude is documented,
  not bug).
**Source:** `src/drivers/codex.ts`. New deferred B-ID for future codex
transcript adapter (tracked in followup issue, not this spec).

---

### B25: Test fixtures driver-parameterized

**Core:**
- **ID:** test-fixtures-parameterized
- **Trigger:** Vitest run.
- **Expected:** Helper `setupDriverFixture(driver: 'claude' | 'codex')`
  in `src/testing/test-fixtures.ts` returns the per-driver fixture
  context. Existing 28 `.test.ts` files refactored to call this helper
  rather than mocking `.claude/` paths directly. Codex tests
  conditionally skipped when `which codex` fails (CI without codex
  installed).
- **Verify:** Full vitest pass on a runner with codex installed.
  Vitest run on a runner without codex skips the codex-tagged tests
  but passes the claude tests.
**Source:** refactor `src/testing/{mock-hooks,test-fixtures}.ts`,
`src/commands/hook.test.ts`, `src/commands/scaffold-batteries.test.ts`,
and the remaining 26 `.test.ts` files (as needed).

---

### B26: Session-state `driver` field

**Core:**
- **ID:** session-state-driver-field
- **Trigger:** SessionStart hook fires from claude or codex. The hook
  command line is `kata hook --driver=<name> session-start --session=<id>`,
  so `--driver` is always present at hook invocation time.
- **Expected:** `state.json` schema gains an OPTIONAL field `driver:
  'claude' | 'codex'` with zod `.default('claude')` (preserves
  backwards compatibility — pre-existing sessions without the field
  load as `driver: 'claude'`). Source-of-truth flow:
  1. `kata enter <mode>` creates `state.json` WITHOUT a driver field.
     The session is "driver-pending" until a hook touches it.
  2. The first SessionStart hook fire writes
     `state.driver = <flag value from --driver>`. Subsequent
     SessionStart hooks no-op (idempotent — value never changes once
     written).
  3. All consumers (B14, B15, B20, B16's refreshDriverState fan-out)
     read `state.driver`; if absent (legacy session), zod default
     gives them `'claude'`.

  This avoids any env-var propagation dance: the SessionStart hook IS
  the canonical place where driver identity is known, and it runs in
  the SAME kata process as state.json mutations (no IPC needed).
- **Verify:**
  - Fresh `kata enter task` followed by SessionStart hook with
    `--driver=codex` produces `state.json` containing
    `"driver": "codex"`.
  - Same flow with `--driver=claude` produces `"driver": "claude"`.
  - Pre-existing `state.json` without the field loads (zod parse
    succeeds) and `state.driver === 'claude'` (the schema default).
  - SessionStart firing twice with different `--driver` values:
    first write wins (warning logged, second is no-op).
**Source:** new optional field in `src/state/session-state.ts` zod
schema; new logic block in `hook.ts:handleSessionStart` to write
`state.driver` from the parsed `--driver` flag (idempotently).
No env-var injection. No `kata enter --driver` flag needed.

---

### B27: Teardown removes user-level kata entries

**Core:**
- **ID:** teardown-user-level
- **Trigger:** `kata teardown` invocation.
- **Expected:** For each driver, call `driver.removeHookRegistration()`
  which removes kata-managed entries from the user-level config files
  while preserving non-kata entries. Project-level cleanup
  (`.kata/sessions/`, `.kata/kata.yaml`) unchanged.
- **Verify:** After `kata teardown`, `~/.claude/settings.json` and
  `~/.codex/hooks.json` no longer contain kata-managed entries; any
  user entries the file had before remain.
**Source:** `src/commands/teardown.ts:128`.

---

## Non-Goals

- **Multi-driver-per-session.** A session has exactly one driver. No
  mid-session driver swap. (Sessions don't migrate between drivers.)
- **PermissionRequest event support.** Codex's PermissionRequest event
  is not added to canonical hook vocab in this iteration. Future epic
  if a use-case appears.
- **Codex transcript adapter.** No reading from codex's transcript
  files (location TBD; format may be unstable in 0.124-0.125). A
  follow-up issue is opened to track.
- **AGENTS.md content management.** kata does not write or maintain
  `AGENTS.md`; just warns when missing under codex.
- **Mobile / runner-side codex.** Out of scope; covered by GH#107 /
  PR#108 in `packages/session-runner`.
- **Other driver backends.** Gemini-cli, etc. — design must leave the
  abstraction extensible but not implement them.
- **Auto-migrating native-task data on upgrade.** Existing
  `~/.claude/tasks/<existing-sessions>/` files keep working as-is;
  only net-new sessions use the canonical store + mirror pattern.
- **Layered phasing across multiple PRs.** All phases land in one PR
  (interview decision; user accepted larger diff).
- **CI gating on codex tests.** Codex tests run when `codex` binary
  present; CI does not require codex.

---

## Verification Plan

Each step is a literal command or observation. Run from
`/data/projects/duraclaw-dev3` unless noted.

### Setup precheck

```bash
which claude && claude --version       # claude installed
which codex && codex --version         # codex installed (>= 0.124)
test -f ~/.codex/hooks.json && echo "user hooks exist" || true
test -f ~/.claude/settings.json && echo "user settings exist" || true
```

Expected: both binaries print versions; pre-existing user-level config
files (if any) are noted for the merge-not-clobber test.

### Step 1 — fresh setup multiplexes both drivers

```bash
# In a fresh tmpdir checkout (avoid touching this repo for setup test)
cd $(mktemp -d) && git clone /data/projects/duraclaw-dev3 .
pnpm install
pnpm --filter @duraclaw/kata build
node packages/kata/dist/index.js setup --yes
```

**Expected output (final line):**

```
kata setup: registered hooks for: claude, codex
```

**Verify** `~/.claude/settings.json` contains kata hook entries with
`--driver=claude` flag; `~/.codex/hooks.json` contains entries with
`--driver=codex` flag. Pre-existing non-kata entries in those files are
preserved.

### Step 2 — re-run is idempotent

```bash
kata setup --yes        # second invocation
```

**Expected:** No duplicate hook entries. Same final summary line.

### Step 3 — single-driver-installed UX

```bash
PATH=$(echo $PATH | sed 's|/home/ubuntu/.bun/bin||') kata setup --yes
```

**Expected output:** `kata setup: registered hooks for: claude`
followed by `(codex not installed; run kata setup again after install)`.

### Step 4 — no-op gate outside kata projects

```bash
cd /tmp
echo '{"session_id":"test","cwd":"/tmp","tool_name":"Edit","hook_event_name":"PreToolUse"}' \
  | kata hook --driver=codex pre-tool-use
echo "exit: $?"
```

**Expected:** empty stdout, `exit: 0`.

### Step 5 — claude session round-trip

In a Claude Code session inside this repo:
1. `kata enter task` (creates 5 pre-created tasks).
2. Verify `.kata/sessions/<new>/native-tasks/{1..5}.json` exist with
   matching content in `~/.claude/tasks/<new>/{1..5}.json`.
3. Mark each task in_progress → completed via `TaskUpdate(taskId,
   status: 'completed')`.
4. After all 5 done: `kata can-exit` returns success.
5. `kata close` exits cleanly.

**Expected:** all 5 native-task JSON files in canonical store match
status `completed`; `~/.claude/tasks/` mirror matches; close emits
success.

### Step 6 — codex session round-trip (same checkout)

In a codex session (`codex` invoked inside this repo):
1. Run `kata enter task`.
2. Verify `.kata/sessions/<new>/native-tasks/{1..5}.json` exist.
3. Verify `.codex/config.toml` `developer_instructions` contains a
   `# kata-managed:start` ... `# kata-managed:end` block listing the
   5 tasks.
4. Inside codex, instruct the agent to update tasks via
   `kata task update <id> --status=completed` (Bash tool).
5. After each update: re-read `.codex/config.toml`; the marker block
   reflects the new state.
6. After all 5 done: `kata can-exit` returns success; `kata close`
   exits cleanly.

**Expected:** canonical store matches; codex's developer_instructions
reflects current state; close emits success. No interaction with
Claude session's state.

### Step 7 — concurrent dual-driver, same checkout

Two terminals, same repo:
- Terminal A: Claude session, `kata enter task`. Note new session ID.
- Terminal B: codex session, `kata enter task`. Note new session ID
  (different from A's).
- Update tasks in both sessions concurrently.

**Expected:** Two distinct sessions in `.kata/sessions/`. Each driver's
native view (`~/.claude/tasks/<A>/` and `.codex/config.toml`) reflects
only its own session's tasks. No cross-contamination.

### Step 8 — diagnostics

```bash
kata doctor
```

**Expected output (final summary):**

```
✓ kata config valid
✓ claude: hooks registered, CLAUDE_CODE_ENABLE_TASKS=1, CLAUDE.md present
✓ codex: hooks registered, codex_hooks=true, codex 0.125.0, AGENTS.md present
```

(Or yellow lines with remediation hints if any check fails.)

### Step 9 — migration of stale project-level Claude hooks

```bash
# Setup: pre-seed a stale project-level entry
mkdir -p .claude
echo '{"hooks":{"SessionStart":[{"command":"kata hook session-start --session=stale"}]}}' > .claude/settings.json
kata setup --yes
cat .claude/settings.json   # should be empty or have no kata entries
cat ~/.claude/settings.json | jq '.hooks.SessionStart'   # should have user-level kata entry
```

**Expected:** project-level `.claude/settings.json` no longer contains
kata-managed entries (file deleted if it was empty afterwards);
user-level entry is present.

### Step 10 — teardown reverses both

```bash
kata teardown --yes
test ! "$(jq '.hooks.SessionStart[]?.command | select(test("kata hook"))' ~/.claude/settings.json)"
test ! "$(jq '.SessionStart[]?.command | select(test("kata hook"))' ~/.codex/hooks.json)"
```

**Expected:** both grep-equivalents return empty; non-kata entries in
both files preserved.

---

## Implementation Hints

### Key imports

- `import { getDriver, listDrivers, detectInstalled } from '~/drivers'`
- `import type { Driver, CanonicalHookInput, CanonicalHookOutput,
  NativeTaskStore } from '~/drivers/types'`
- `import { canonicalNativeTaskStore } from '~/native-tasks/canonical-store'`
- `import { findProjectRoot } from '~/utils/project-root'` (existing
  helper to reuse for B12 walk-up gate)
- TOML editing for codex config: **regex-based marker-block replacement
  on the raw file string** (see B15 "Implementation approach"). Do
  NOT add a TOML parser dependency — both `@iarna/toml` and
  `smol-toml` drop comments on parse, which would silently delete
  user TOML comments outside the marker block.

### Code patterns to mirror

**Existing `mergeHooksIntoSettings` in `setup.ts:201`:** the
merge-not-clobber pattern for `.claude/settings.json`. Generalize to
accept a `(parsed: T) => T` mutator and reuse for both driver-level
files. Codex side parses TOML; same merge contract.

**Existing `readNativeTaskFiles` / `writeNativeTaskFiles` in
`task-factory.ts:430-503, 568-599`:** keep the same JSON schema for
canonical store; only the directory path changes. The mirror writer
(B14) is a thin wrapper that copies canonical → `~/.claude/tasks/`.

**Existing `handleModeGate` in `hook.ts:285-353`:** the canonical
handler pattern. Don't refactor the body; only change the entry-point
shim that calls it. Pass the `Driver` instance explicitly so handlers
can call `driver.toolNameMap()` to translate tool names without a
global.

**Existing `--session=<id>` injection at `hook.ts:1108-1131`:** mirror
pattern for `kata task` Bash detection. Match command prefix; route
through canonical task-state logic identical to Claude TaskUpdate.

### Gotchas

- **Codex TOML rewriting must preserve user content.** Use raw-string
  regex replacement between marker comments — do NOT parse the TOML
  (parsers drop comments). Test with a `.codex/config.toml`
  containing user-edited fields (e.g. `model = "..."`,
  `[mcp_servers.foo]`) and standalone TOML comments above and below
  the `developer_instructions` field — all must round-trip
  byte-identical except inside the marker block.
- **Hook firing during setup itself.** `kata setup` shouldn't trigger
  hook fires. The walk-up gate (B12) protects against this in the
  general case, but be careful that setup doesn't change cwd into a
  kata-managed dir mid-flight.
- **Skill content drift.** Dual-install means two copies of every
  SKILL.md. `kata setup --rerun` always overwrites both (no merge —
  the source of truth is `batteries/skills/`). Document this so users
  know not to hand-edit installed skills.
- **`apply_patch` is a single tool name in codex** that covers Edit,
  Write, MultiEdit, NotebookEdit. The mapping is many-to-one. Reverse
  resolution (codex → canonical) loses fidelity — tests should not
  assert on a specific canonical name when the source was
  `apply_patch`; assert on the gate behavior instead.
- **`hasActiveBackgroundAgents` returning false** under codex means
  Stop hook will let codex stop even if it spawned a background helper.
  The deferred transcript-adapter follow-up tracks this. Real-world
  impact: if a codex session uses background agents (rare today), the
  Stop gate may fire prematurely. Document in B24.
- **Codex `developer_instructions` size budget.** `project_doc_max_bytes`
  defaults to 32KB. With 50+ tasks, the marker block can approach
  this. Add a length check + warning in B15.
- **Test parameterization order.** Several existing tests assume
  module-level state (`mockHomeDir`, `tmpdir`). Refactor in dependency
  order: `mock-hooks.ts` → `test-fixtures.ts` → `hook.test.ts` →
  others. Land each as a separate commit inside the PR for bisect-
  ability.

### Reference docs

- [Hooks – Codex | OpenAI Developers](https://developers.openai.com/codex/hooks)
  — exact stdin/stdout JSON shape per event; reference for
  `parseHookInput` / `formatHookOutput` impl.
- [Configuration Reference – Codex | OpenAI Developers](https://developers.openai.com/codex/config-reference)
  — full schema for `~/.codex/config.toml`; relevant for B15
  (developer_instructions field) and B22 (codex_hooks feature flag).
- [Custom instructions with AGENTS.md – Codex | OpenAI Developers](https://developers.openai.com/codex/guides/agents-md)
  — for B23 warning content.
- [Agent Skills – Codex | OpenAI Developers](https://developers.openai.com/codex/skills)
  — for B17 (kata-task SKILL.md format) and B10 (~/.agents/skills/
  install path).
- `planning/research/2026-04-26-kata-codex-driver-coexistence.md` —
  the P0 research doc; full coupling audit and prior-art comparison.
- `.kata/sessions/<this-session>/interview-decisions.md` — the P1
  interview output; verbatim source of every decision in this spec.
- `planning/research/2026-04-25-acp-codex-runner.md` (R7) — adjacent
  forge architecture deep-dive; useful context for "why we don't go
  ACP at this layer".
