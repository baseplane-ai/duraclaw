---
date: 2026-04-24
topic: Interview decisions for caam auth rotation (GH#92)
type: interview-output
status: complete
github_issue: 92
companion_doc: 2026-04-24-caam-auth-rotation-gh92.md
---

# Interview decisions — caam rotation Phase 1

AskUserQuestion failed repeatedly with "Stream closed" and the prose
fallback got no response. Given the user's established pattern for this
issue ("research for yourself", "we just need to switch auth and
restart"), decisions below are taken by the interviewer at the
recommended-option default. All are **reversible** via env knob or a
small DO change; the spec's Architectural Bets section calls them out
explicitly so a future review can flip any of them cheaply.

## Decisions

### D1. Cooldown duration default: **derived per-event from `rate_limit_info.resetsAt`**
- **Superseded 2026-04-24.** Original decision was a 60-min fixed
  cooldown behind `DURACLAW_CLAUDE_COOLDOWN_MINUTES`. User pushback made
  the reframe explicit: "It's not a rate limit it's session limits that
  error on exhaustion you don't need cool down you don't need anything
  it's just you hit the session limit record the refresh time find open
  non-limited account rotate then restart the session that's it."
- New behavior: runner reads `rate_limit_info.resetsAt` (ms epoch) off
  the SDK event, computes `minutes = max(1, Math.ceil((resetsAt - now)
  / 60000))`, and passes that to `caam cooldown set`. No env knob.
- Fallback when `resetsAt` is missing or stale: 300 minutes (Anthropic's
  documented five-hour window), logged as a fallback once per event.
- Rationale: spec #13 B13 already types `rate_limit_info.resetsAt` as
  the authoritative reset timestamp; there's no reason to guess. The
  "rejected — derive from `rate_limit_info`" note in the prior draft
  assumed an undocumented payload; re-reading the types shows it IS
  documented.
- Reversibility: bring back the env knob in a single diff if the
  derived-cooldown path proves wrong in production — the 300m fallback
  is already the conservative ceiling.

### D2. All profiles in cooldown → **sticky "waiting" + auto-retry**
- Runner writes `.exit` with new state `rate_limited_no_profile` and
  an `error` carrying the earliest-cooldown-clear timestamp (read from
  `caam cooldown list`).
- DO sets session status to `waiting_profile`, schedules an alarm at
  that timestamp (+30s slop), and on alarm fires
  `triggerGatewayDial({type:'resume', sdk_session_id})`.
- User sees "waiting for Claude profile cooldown (N min)" in status bar
  + a system message in transcript; self-heals without intervention.
- Rejected: hard error (worst UX during wide outages); `--force`
  override (re-hits immediately, no circuit breaker value).

### D3. UX for mid-session rotation: **system message + auto-resume**
- DO inserts a system-role message into `messagesCollection`:
  `⚡ Claude profile rotated (work1 → work2), resuming…`.
- `useDerivedStatus` reads a transient `rotating` status (2–5s typical)
  during the gap between old-runner `.exit` and new-runner dial-back.
- No new UI surface; reuses the existing seq'd `{type:'messages'}`
  delta channel and `useDerivedStatus` fold.
- Rejected: silent (confusing to users); toast (loses audit trail, new
  surface); status-bar chip (defer to later profile-policy UI issue).

### D4. Peer Claude runner live at rotation time: **skip rotation, surface rate-limit**
- Runner scans sibling `.meta.json` files under `SESSIONS_DIR` at
  rotation time for any peer where `model` starts with `claude-` and
  `state === 'running'`.
- If any peer is found, skip `caam cooldown set` + `caam next`, exit
  with state `rate_limited_no_rotate`, DO surfaces the underlying
  rate-limit as an error message in transcript.
- Rationale: Phase 1 is explicitly single-active-Claude-runner; the
  peer-check is a safety net to prevent `~/.claude` swap under a live
  `query()`. Acts as an observability signal — if this fires often,
  Phase 2 (per-runner profile isolation) is needed.
- Rejected: `flock` serialization (still mutates global auth under
  peers); rotate-anyway (cascade 401s burn the pool).

### D5. Dev-box without caam binary or profiles: **warn once, rotation is a no-op**
- At runner startup, if `/home/ubuntu/bin/caam` (or `$CAAM_BIN`) is
  missing OR `caam ls claude` returns zero named profiles: log once
  `[caam] not configured on this host — rotation disabled`, treat all
  rotation calls as no-ops, still relay raw `rate_limit` events to the
  DO.
- Env override: `CAAM_BIN=/path/to/caam` (default: probe `caam` on
  `$PATH` then `/home/ubuntu/bin/caam`).
- Rationale: dev worktrees don't all have caam; fail-fast would make
  every local session unspawnable. Production VPS has caam — missing it
  there is ops-visible via the startup log line and the "rate_limit
  with no rotation" telemetry.

### D6. Feature flag default: **`DURACLAW_CLAUDE_ROTATION=auto` (on by default)**
- Gated by D5 — "on" is a no-op on a dev box without caam, so shipping
  `auto` as default is safe.
- Env values: `auto` (default) | `off`.
- Rationale: we want the feature live as soon as it lands; the single
  Phase 1 risk (global auth swap under a peer runner) is handled by D4
  and is an explicit design assumption. If prod is still
  single-active-Claude, this default is correct; if it isn't, D4's
  peer-check skips rotation and we learn from the telemetry.

### D7. Observability surface: **runner logs + `caam status` on VPS, admin dashboard added 2026-04-24 revision**
- Runner logs structured rotation events to stderr (captured into the
  per-session `.log` by the gateway):
  - `[caam] active profile=work1 at startup`
  - `[caam] rate_limit detected, cooldown=60m, next=work2 (rotated)`
  - `[caam] rate_limit detected, no peer-free profile, exiting rate_limited_no_rotate`
  - `[caam] all profiles cooling, earliest clear=<ts>`
- Rotation events also stamped into the DO's session system messages
  (D3) — auditable from the browser transcript.
- **Originally** deferred to a follow-up: `/api/admin/caam/*` endpoints,
  web UI for profile health. **Superseded 2026-04-24 revision:** user
  asked for the admin UI in-scope after all. Pulled back in as B8/B9/B10
  and P5. Read-only dashboard only — interactive controls ("clear
  cooldown", "force activate") remain deferred.

### D8. Pinned profile in cooldown at spawn (`DURACLAW_CLAUDE_PROFILE=work2` but work2 is cooling): **fail spawn with clear error**
- `caam activate claude work2` without `--force` errors out; runner
  propagates that into `.exit` with state `failed` and
  `error: "pinned profile 'work2' is in cooldown until <ts>"`.
- Rationale: pinning is an explicit operator choice, not a hint. If the
  operator wanted fallback, they wouldn't pin. Surfacing the error
  forces intent.
- Rejected: silent fallback to `next` (defeats pinning); `--force`
  activation (almost certain to re-hit).

## Architectural bets (flagged for spec)

- **A1 (D4 assumption).** Single active Claude runner per VPS. If Duraclaw
  grows to multiple concurrent Claude runners, D4's peer-check becomes
  the common case and rotation stops working. Phase 2 (per-runner
  `HOME` or `caam exec` isolation) becomes required.
- **A2 (D3 assumption).** `useDerivedStatus` can reflect a `rotating`
  status folded from messages. Confirmed in CLAUDE.md — fold includes
  `messageSeq` tiebreaker, already the canonical live-state source.
- **A3 (D2 assumption).** DO's alarm system can schedule a delayed
  resume at an arbitrary future timestamp. Confirmed — existing
  watchdog alarm uses `ALARM_INTERVAL_MS = 30s`; one-shot future alarms
  are supported by the Agents SDK alarm API.
- **A4 (D6 assumption).** Global caam activation mid-session is safe
  because it's a restart boundary (user-verified). If the SDK ever
  caches auth across `query()` calls in one process, this breaks
  non-obviously.

## Codebase findings that shape the spec

- **Rate-limit hook already exists** at
  `packages/session-runner/src/claude-runner.ts:637-646` — extend here.
- **Exit file schema** at `packages/agent-gateway/src/types.ts:18-62`
  — extend `state` union with `'rate_limited'`,
  `'rate_limited_no_profile'`, `'rate_limited_no_rotate'`.
- **Meta file** at `packages/session-runner/src/types.ts:54-62` — add
  `claude_profile?: string | null`.
- **DO rate_limit handler** at
  `apps/orchestrator/src/agents/session-do.ts:5071-5073` — today
  broadcasts only, needs respawn logic.
- **DO `triggerGatewayDial`** at lines 1420-1446 — the existing
  `resume` entry point; new auto-respawn calls into this.
- **`buildCleanEnv`** at `packages/agent-gateway/src/handlers.ts:62-71`
  + spawn env at line 196 — passthrough point for new
  `DURACLAW_CLAUDE_*` env vars.
- **Token rotation (4410)** at `session-do.ts:1420-1446` — already
  handles the race where an old runner is still connected during a new
  dial; reused verbatim for auto-respawn.

## Open risks (for review)

- **R1.** The `rate_limit_info` passthrough is `Record<string,unknown>`
  in `RateLimitEvent` — if we ever want D1 alternative "derive from
  payload", we'd need to introspect it first. Tracked, not blocking.
- **R2.** `caam status` output parsing — the installed binary's
  `--json` flag is advertised on `activate` but we haven't confirmed
  it on `next` / `status` / `ls` / `cooldown list`. The runner's caam
  wrapper needs a text-parsing fallback. Mitigation: write integration
  tests against the real binary on a dev box.
- **R3.** Session messages inserted by the DO as "system role"
  breadcrumbs must not round-trip into the SDK's transcript on resume
  (they'd confuse the model). Confirm `SessionMessage` has a role
  variant the DO can emit without it appearing in the SDK's
  reconstructed prompt. Likely `role: 'system'` or a new `role:
  'duraclaw-breadcrumb'` — resolve in spec-writing.
