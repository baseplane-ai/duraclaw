# Kata

Source package: `packages/kata/`.

Workspace-local CLI that wraps Claude Code projects with structured session modes, phase task enforcement, and a stop hook that blocks exit until the phase contract is satisfied. Runs straight off TypeScript via Bun — no build step, not published to npm.

## Module Test

- **Nav entry / surface:** the workspace CLI at `packages/kata/`. A symlink at `~/.local/bin/kata` (installed by `scripts/link-kata.sh`) points at the main worktree's `src/index.ts`, which has a `#!/usr/bin/env bun` shebang. Operators run `kata enter <mode>`, `kata exit`, `kata setup`.
- **Owns:** the workflow / mode state machine (planning, implementation, research, task, debug, verify, freeform, onboard); the per-session task list with dependency chains; the prompts / templates / ceremony directory; the SessionStart / UserPromptSubmit / PreToolUse / Stop hook handlers.
- **Domain question:** How is in-flight feature work paced through phases with hard stops between them?

## Owns

- Kata sessions in `.kata/sessions/{sessionId}/state.json` (Zod-validated `SessionState`)
- Kata templates and overrides — package-level `batteries/templates/` with optional project-level `.kata/templates/` overrides; runtime dual resolution
- `.kata/kata.yaml` — project mode config (per-mode `issue_handling`, `stop_conditions`, `rules`, `deliverable_path`)
- `.kata/ceremony.md` — shared workflow instructions (commit, PR, branch, env-check, tests)
- `.kata/prompts/` (review prompt templates) and `.kata/verification-evidence/` (verify-phase output)
- The hook handlers themselves: `kata hook session-start | user-prompt | pre-tool-use | stop-conditions`

## Consumes

- [`docs/theory/dynamics.md`] — kata phases (planning → implementation → review → close) align with the DO state transitions for kata-driven sessions; the stop-hook gate maps onto the session lifecycle's "session can't complete until contract is satisfied" invariant

## Theory references

- [`docs/theory/dynamics.md`] — the phase-to-state-transition mapping above
- [`docs/theory/domains.md`] — kata sessions are themselves a session-shaped entity with a well-defined lifecycle

## How it works

Three invariants hold the whole thing together:

1. **The session can't end until the phase contract is satisfied.** The `Stop` hook intercepts every exit attempt and runs the mode's `stop_conditions` (e.g. `tasks_complete`, `committed`, `pushed`, `tests_pass`, `feature_tests_added`, `doc_created`, `spec_valid`). Unmet conditions block the exit with a clear list of what's left.
2. **Context is re-injected at every `SessionStart`, not chat history.** The `SessionStart` hook calls `kata prime`, which injects the active mode's instructions, the current phase, and the pending task list — so context compaction does not erase the plan.
3. **Tasks are native, with dependency chains.** Phase tasks are written to `~/.claude/tasks/{sessionId}/`; Claude sees them via `TaskList` and must complete them in order.

## Eight built-in modes

`planning`, `implementation`, `research`, `task`, `debug`, `verify`, `freeform`, `onboard`. Mode behaviour is **data-driven** — adding a new per-mode behaviour means adding a field to `kata.yaml` mode config + `ModeConfigSchema`, never hardcoding mode names in TypeScript.

## Key files

- `packages/kata/src/index.ts` — CLI dispatcher (with the bun shebang); maps `kata <command>` to handlers and re-exports the programmatic API
- `packages/kata/src/commands/enter/` — sub-modules for `enter`: `task-factory.ts`, `guidance.ts`, `template.ts`, `spec.ts`
- `packages/kata/src/state/` — Zod schema, reader, writer for `SessionState`
- `packages/kata/src/config/kata-config.ts` — loads `.kata/kata.yaml`
- `packages/kata/batteries/` — package-level templates, prompts, ceremony, skills (the fallback when the project has no `.kata/templates/`)

## Project-root resolution

`findProjectDir()` walks up from cwd looking for `.kata/`. It **stops at `.git` boundaries** to prevent escaping into a parent project (e.g. eval projects nested under this repo). If cwd has `.git` but no `.kata/`, it is treated as a fresh project — the walk stops there.

## Dependencies

`zod` for schema validation, `js-yaml` for template frontmatter and `kata.yaml`, `bun` for execution. Tests run via `bun test src/` directly from TypeScript source.
