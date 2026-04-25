# caam Claude auth profile rotation — VPS prerequisites & design notes (GH#92)

Companion note to `planning/specs/92-caam-claude-auth-rotation.md` and the
feasibility research at
`planning/research/2026-04-24-caam-auth-rotation-gh92.md`. Captures the
one-time VPS setup the rotation feature assumes, the env knobs the
runtime honours, the non-obvious design decisions baked into the spec
that landed after interview/review, and how to exercise the rotation
path locally once `DURACLAW_DEBUG_ENDPOINTS=1`.

# One-time setup on the dev VPS

Before rotation can be exercised end-to-end, the currently active
`~/.claude` profile must be captured into caam under a `workN` slot —
typically `work1`. Without this, `caamActiveProfile('claude')` returns
`null`, every rotation path short-circuits to the B7 degraded-mode relay
(rate_limit events get forwarded raw to the client, no rotation, no
respawn), and you'll think the feature is broken when it's just dormant.

```bash
caam status                              # confirm claude: <current profile>
caam ls claude                           # list captured profiles
caam backup claude work1                 # if work1 is missing
caam cooldown list --json                # sanity check
```

Confirm `caam ls claude` shows at least two profiles (`work1`, `work2`,
…) before exercising VP1–VP3 — a single-profile setup will rotate to
"no profile available" on the first hit, which exercises the
`waiting_profile` path but not the happy-path rotation.

# Environment variables on the VPS

The runtime honours four env knobs, all read inside `session-runner` /
the orchestrator at session start:

- `CAAM_BIN` — path to the caam binary. Default: probe `$PATH`, fall
  back to `/home/ubuntu/bin/caam`.
- `DURACLAW_CLAUDE_PROFILE` — pin a session to a specific profile.
  Disables rotation for that session. Fails fast at runner startup if
  the pinned profile is currently cooling.
- `DURACLAW_CLAUDE_ROTATION` — `'auto'` (default) or `'off'`. With
  `'off'`, rate_limit events are relayed to the client raw, no rotation
  attempted, no respawn. Equivalent to "caam not configured" from the
  DO's perspective.
- `DURACLAW_DEBUG_ENDPOINTS` — `'1'` enables the runner's
  `{type:'synth-rate-limit'}` GatewayCommand handler AND the
  orchestrator's `POST /api/__dev__/synth-ratelimit/:sessionId` route.
  Production should leave this unset.

# Design decisions worth knowing

- **Single-active-runner assumption (D4).** Phase 1 does NOT support
  concurrent claude runners safely cycling profiles. Peer-detection via
  `scanPeerMeta` gates this: if another live claude runner is detected
  at rotation time, the current session exits `rate_limited_no_rotate`
  (B3 gate 2 / B5) instead of rotating out from under the peer.
- **Cooldown duration is derived, not configured.** Each rate_limit
  event carries `rate_limit_info.resetsAt`; the runner computes
  `minutes = ceil((resetsAt - now) / 60s)` and passes it to
  `caam cooldown set`. Fallback to 300 minutes (5 hours) if `resetsAt`
  is missing — chosen to outlast the typical Anthropic 5h window
  without permanently parking the profile.
- **Transcript breadcrumbs use `metadata.caam`, not body-text regex.**
  Shape documented on `SessionMessage.metadata`. The DO's
  `forkWithHistory` filters them out of the SDK resume-prompt
  serializer so the model never sees its own chrome replayed as
  conversation turns.
- **Alarm coalescing in the DO uses `Math.min(existing,
  pendingResume.at)`.** A far-future `waiting_profile` resume can't
  clobber a sooner stale-runner watchdog; the watchdog can't push a
  near-term rotation resume out either.
- **`rate_limited_no_rotate` terminates with `status='error'`.** No
  auto-resume — the user must send a new message to retry, which hits
  the demand-driven respawn path (sendMessage sees no live runner,
  triggers a fresh execute / resume).
- **`rate_limited_no_profile` schedules at `earliest_clear_ts + 30s`
  slop.** Survives DO eviction+rehydrate via
  `session_meta.pending_resume_json` (migration v17). The 30s slop
  absorbs caam clock skew without being long enough to feel sluggish.

# How to exercise the rotation path in dev

Once `dev-up.sh` is running with `DURACLAW_DEBUG_ENDPOINTS=1` exported,
two injection paths are available:

- **Runner-path injection** (covers VP1–VP3, the realistic path):

  ```bash
  curl -X POST \
    http://127.0.0.1:$VERIFY_ORCH_PORT/api/__dev__/synth-ratelimit/<sessionId> \
    -H 'Content-Type: application/json' \
    -d '{"target":"runner","exit_reason":"rate_limited",
         "rotation":{"from":"work1","to":"work2"}}'
  ```

  Hits the live runner's synth-rate-limit handler, runs real
  `caam cooldown set` / `caam next` calls, writes real `.exit` and
  `.meta` artifacts. End-to-end through the DO's rate_limit handler,
  breadcrumb insertion, alarm scheduling, and resume.

- **DO-path injection** (unit-test-like):

  ```bash
  curl ... -d '{"target":"do", ...}'
  ```

  Bypasses the runner and calls the DO's rate_limit handler directly.
  Useful for testing the breadcrumb / alarm / respawn path in isolation
  without needing a runner attached. Won't exercise caam itself.

# Verification plan status (as of 2026-04-24)

VP1..VP5 all require the real caam-configured VPS and cannot run in
local pnpm test harnesses — they touch `caam status` / `caam cooldown
set` / `caam next`, all of which mutate `~/.claude` and the caam state
dir on disk. Run them after deploy on the dev VPS with the one-time
setup above complete.

VP6 (admin caam dashboard) depends on P1.5 landing — pending. Track
under the GH#92 spec's Phase 5 (B8/B9/B10).
