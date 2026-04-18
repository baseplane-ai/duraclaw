# Verify Infra — Dual Browsers + Reliable Local Gateway Loop

_2026-04-18 · GH#8_

Root-cause analysis and documented long-term design for the two verify-mode
blockers called out in issue #8. Paired with minimal-patch automation landing
in this same change so debug-mode closes with the infra usable, not just
planned.

## 1. Background / symptom

Verify-mode reports from PR #4 (VP2.4-5 multi-user; VP4.1-2 distinct-user
presence) all hedged as _"env limited"_. The verify agent cannot:

1. Drive **two signed-in users** through `chrome-devtools-axi` — the tool
   wraps a single persistent Chrome and a second invocation's
   `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` is ignored because the profile lock is
   held by the first Chrome.
2. Close a **local `sendMessage → execute` loop** — the user message lands in
   chat history but the session stays `running / 0 turns`. No assistant
   turn arrives.

Both failures are _silent_: nothing surfaces in the UI to distinguish
"agent is thinking" from "dispatch never happened".

## 2. Root causes

### 2.1 Dual browsers: the profile lock, not the CLI

`chrome-devtools-axi` already has the escape hatch — `CHROME_DEVTOOLS_AXI_BROWSER_URL`
lets it attach to an existing Chrome over CDP instead of launching one. The
missing piece is a **pair of pre-launched Chrome processes** with distinct
`--user-data-dir`s on distinct `--remote-debugging-port`s, plus thin
wrappers so verify-mode agents can target A or B without ceremony.

Evidence: on the current host, `/tmp/chrome-profile-userb` Chrome is already
live (seen in `ps`) but nothing documents how to drive it, so verify-mode
keeps defaulting to the single default browser.

### 2.2 Silent gateway loop: four compounding failure modes

Fire-and-forget `void this.triggerGatewayDial(...)` at `session-do.ts:1229`
hides _every_ downstream failure. The user-message persist at
`session-do.ts:1201-1215` happens **before** dispatch is attempted, so the
message appears in history regardless of what follows.

Four things fail silently from verify-mode's local stack:

| # | Failure | Where it dies | What the user sees |
|---|---|---|---|
| A | `WORKER_PUBLIC_URL` unset in `.dev.vars` | `session-do.ts:315-318` — returns, flips to `idle`, error banner only | message in history, `status=idle`, subtle error banner |
| B | `CC_GATEWAY_URL` points at prod (`wss://dura.baseplane.ai`) instead of local `ws://127.0.0.1:9877` — prod gateway accepts POST, spawns runner, runner dials back to `WORKER_PUBLIC_URL` that doesn't route to localhost | runner exits with dial-back failure; DO never polls exit-file because gateway is remote | message in history, `status=running`, no assistant turn |
| C | `resolveProject(cmd.project)` returns `null` inside session-runner (`claude-runner.ts:245-259`) — e.g. `WORKTREE_PATTERNS=baseplane` on a gateway fielding a `duraclaw-dev2` dispatch | runner sends one `error` event, exits | `status=failed` with error, no assistant turn |
| D | POST `/sessions/start` 4xx/5xx — logged on DO (`session-do.ts:382`) but no toast / UI signal | DO flips to `idle` with `error` in state | message in history, error banner |

The operator experience is identical for all four — "I sent a message, nothing
happened". Diagnosis requires cross-referencing the orchestrator log, the
gateway journal, and `/run/duraclaw/sessions/*.exit`.

### 2.3 The specific failure on dev2

`.dev.vars` in `duraclaw-dev2` sets:

```
CC_GATEWAY_URL=ws://127.0.0.1:9877
# WORKER_PUBLIC_URL not set
```

That is mode **(A)** above. `triggerGatewayDial` bails at line 315-318 and
never calls POST `/sessions/start`. The message persists, the DO flips to
`idle` with `Gateway URL or Worker URL not configured` as the state error,
but verify-mode agents report it as "agent-execute step doesn't fire"
because the error banner is easy to miss when you're looking for an
assistant turn.

The deployed prod gateway has **no** `WORKTREE_PATTERNS` set (confirmed via
`systemctl show` — only `NODE_ENV`, `CC_GATEWAY_PORT`, `CLAUDE_CODE_ENABLE_TASKS`,
`PATH`, `HOME` are exposed), which means `PROJECT_PREFIXES = []` and
`resolveProject()` accepts every directory under `/data/projects/` that has a
`.git` entry. So (C) is _not_ currently firing — it's a landmine for future
operators who'd intuitively "lock down" the gateway.

## 3. Long-term design

### 3.1 Kill the four silent failures

All four failure modes share one defect: `sendMessage` persists the user
message _before_ confirming dispatch is reachable. The fix is a
**preflight check** + **loud surfacing**, not a re-architecture:

1. **Preflight** in `sendMessage`: before `appendMessage`, assert that
   `CC_GATEWAY_URL` + `WORKER_PUBLIC_URL` are both set. If not, return
   `{ok: false, error: 'Gateway not configured for this worker'}` so the
   client sees a proper error, not a message-in-limbo. (Minimal patch.)
2. **Await-with-timeout** on `triggerGatewayDial` from `sendMessage` so POST
   failures fail loudly. The other call sites (`session-do.ts:938`, `1008`,
   `1321`, `1461`) can remain fire-and-forget because they're driven by
   session-create / recovery paths where we don't have a user request to
   respond to. (Minimal patch.)
3. **Assistant-visible error** for runner `type: 'error'` events during
   startup — append a synthetic assistant message with the error text so
   verify-mode can see "project X not found" in the transcript, not just a
   state-level banner. (Post-debug; needs UI spec.)
4. **Gateway health ping** at verify-mode boot — `scripts/verify/dev-up.sh`
   already hits `/health`, but the CLAUDE.md Local Dev section should
   document the full four-variable contract so misconfig is caught before
   the first `sendMessage`.

### 3.2 Dual browser profiles — minimal patch, no new infra

`chrome-devtools-axi` already supports `CHROME_DEVTOOLS_AXI_BROWSER_URL`.
The long-term solution is **not** a portless-style URL-mapping proxy; it's
two wrapper scripts plus documentation:

```
scripts/verify/browser-dual-up.sh   # launch Chrome A (9222) + B (9223)
scripts/verify/browser-dual-down.sh # teardown
scripts/verify/axi-a                # shim: CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222 chrome-devtools-axi "$@"
scripts/verify/axi-b                # shim: CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 chrome-devtools-axi "$@"
```

CLAUDE.md under a new **"Dual browser profiles"** subsection teaches verify
mode: _"If your VP has two distinct users, run `scripts/verify/browser-dual-up.sh`
then drive each browser via `scripts/verify/axi-a` / `axi-b`."_

This sidesteps portless entirely for the per-user cookie problem because
cookie isolation lives in Chrome's profile directory, not in the URL path.
A proxy that rewrites URLs wouldn't separate cookies.

### 3.3 Where portless _does_ fit — the multi-worktree orchestrator case

The case portless solves is distinct and arises for the **parallel worktree
development** workflow: when three verify sessions run simultaneously in
`duraclaw-dev1 / dev2 / dev3`, each worktree wants its own orchestrator
(otherwise they share the same Durable Object namespace via miniflare's
local state). Today the verify script assigns port `43173` unconditionally,
so only one worktree can run at a time.

Portless fits here by:
- Auto-assigning ephemeral ports (4000-4999) per worktree-run
- Mapping `dev1.duraclaw.localhost → 4123`, `dev2.duraclaw.localhost → 4456`,
  `dev3.duraclaw.localhost → 4789` with `/etc/hosts` sync
- Providing stable callback URLs for `WORKER_PUBLIC_URL` (Chrome follows
  `*.localhost` without hosts rewriting; Safari and some Linux configs need
  portless' `/etc/hosts` sync)

**This is deferred to its own spec.** Scope-wise it's a planning-mode
feature (multi-worktree dev ergonomics), not a verify-infra blocker. The
current verify-mode stack is single-worktree and `127.0.0.1:43173` is
good enough for one agent at a time.

The portless-shaped replacement would live at:

```
scripts/local-dev/portless.config.ts
scripts/local-dev/up-worktree.sh   # one per worktree, auto-ports
```

...and change the verify `common.sh` contract to read the portless runtime
file (`VERIFY_ORCH_RUNTIME_URL` already exists as an escape hatch) instead
of hard-coding `43173`. Tracked in a follow-up issue, not this one.

### 3.4 Multi-worktree gateway

The gateway is _intentionally_ single-instance on the VPS — every worktree
shares `/data/projects/` and the gateway resolves by name. For **local**
verify, the gateway bound to `127.0.0.1:9877` from this worktree is fine;
`CC_GATEWAY_URL=ws://127.0.0.1:9877` in `.dev.vars` is correct.

If two verify sessions ever run at once on the same machine, the second
would need its own gateway on 9878 with `WORKTREE_PATTERNS` scoped to its
worktree. That's also deferred to the portless follow-up — it's the same
shape problem (parallel-worktree ergonomics).

## 4. Implementation phases

### Phase 1 — landed in this debug session (GH#8)

- `session-do.ts` preflight for `CC_GATEWAY_URL` + `WORKER_PUBLIC_URL` in
  `sendMessage` (returns error before persisting the user message)
- `claude-runner.ts` loud `console.error` with projects-dir listing when
  `resolveProject` misses
- `scripts/verify/browser-dual-up.sh` + `browser-dual-down.sh` +
  `axi-a` + `axi-b`
- CLAUDE.md: **Dual browser profiles** + **Verify-mode local stack** sections
- Repro test: `packages/session-runner/src/project-resolver.test.ts` for
  the miss path (ensures the logging never regresses)

### Phase 2 — follow-up issue (multi-worktree ergonomics)

- Portless-shaped multi-worktree URL routing
- Per-worktree gateway on alternate ports with scoped `WORKTREE_PATTERNS`
- `VERIFY_ORCH_RUNTIME_URL` auto-populated from portless runtime state

### Phase 3 — follow-up issue (assistant-visible runner errors)

- Synthetic assistant-message on runner startup `error` events (UI spec
  needed — how should they render vs real assistant turns?)

## 5. References

- `apps/orchestrator/src/agents/session-do.ts:312-399` — `triggerGatewayDial`
- `apps/orchestrator/src/agents/session-do.ts:1140-1238` — `sendMessage`
- `packages/agent-gateway/src/handlers.ts:128-205` — `handleStartSession`
- `packages/agent-gateway/src/projects.ts:10-11, 199-213` — worktree pattern + resolution
- `packages/session-runner/src/project-resolver.ts` — runner-side resolver (same patterns)
- `packages/session-runner/src/claude-runner.ts:235-259` — `resolveProject` call
- `packages/session-runner/src/main.ts` — runner lifecycle
- `scripts/verify/dev-up.sh` + `common.sh` — existing single-browser verify stack
- https://github.com/vercel-labs/portless — reference for Phase 2
- `/etc/systemd/system/duraclaw-agent-gateway.service` — prod gateway unit
