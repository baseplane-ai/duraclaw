---
initiative: caam-rotation-narrow
type: project
issue_type: feature
status: draft
priority: medium
github_issue: 103
supersedes: planning/specs/92-caam-claude-auth-rotation.md
prior_art_revert: 735cdddbe07ecf93960f6daf7a95ad2b37b9a91f
created: 2026-04-25
updated: 2026-04-25
phases:
  - id: p1
    name: "Runner-side rotation on explicit rate-limit signal"
    tasks:
      - "Add typed caam wrappers (activate, ls, cooldown set/list) — 3 calls, JSON only"
      - "Cache last `rate_limit_event` in claude-runner loop"
      - "On `assistant` message with `error: 'rate_limit'`: pick next non-cooled profile, set cooldown on current using cached resetsAt, activate next, queue a synthetic 'continue' stream-input"
      - "If no candidate profile: emit a single info breadcrumb, do not exit, do not error session"
      - "Decide in-place vs respawn based on observed SDK behavior post-activate (see Open Questions)"
    test_cases:
      - id: "rotation-happy-path"
        description: "Cached rate_limit_info → assistant.error=rate_limit → caam.activate(next) called once → 'continue' enqueued"
        type: "unit"
      - id: "rotation-no-candidate"
        description: "All non-active profiles in cooldown list → no activate called → no continue enqueued → single breadcrumb event"
        type: "unit"
      - id: "rotation-noisy-events-ignored"
        description: "Stream of rate_limit_event with status='allowed' / 'allowed_warning' → zero caam calls"
        type: "unit"
      - id: "rotation-in-place"
        description: "After caam.activate is called, next stream-input ('continue') produces a successful assistant turn — no respawn"
        type: "integration"
  - id: p2
    name: "Admin profile dashboard"
    tasks:
      - "Gateway: GET /admin/caam/profiles — `caam ls claude --json` + `caam limits claude --format json` + `caam cooldown list --json` merged, no per-subcommand budget, single 5s shell timeout"
      - "Worker: /admin/caam route fetching gateway directly via existing CC_GATEWAY_URL+token env (no /api proxy)"
      - "React table: name | active | utilization% | resets at | cooldown until | manual Activate button"
    test_cases:
      - id: "dashboard-renders-payload"
        description: "Mocks gateway 200 response → table shows N rows with usage %"
        type: "unit"
      - id: "dashboard-degraded"
        description: "Gateway 500 → empty table + single error toast (no skeleton-loop)"
        type: "unit"
---

# CAAM Auth Rotation — Narrow Rewrite

> Supersedes the merged-then-reverted `feat(caam)` of PR #93 (revert: `735cddd`).
> Original spec: `planning/specs/92-caam-claude-auth-rotation.md` (~77KB).
> This spec: ~1/10 the surface, single-purpose.

## Overview

When a Claude session hits a hard rate limit, swap the active `caam` auth profile in the background and re-prompt the model with a single "continue". Don't touch session status. Don't migrate the DO. Don't taxonomize exit reasons. Don't alarm-coalesce. Don't peer-scan. Just: detect the explicit rejection, swap, continue.

The reverted attempt (#93) over-engineered the surface area — 3,700 LOC across 31 files, including a DO migration, two new session statuses, a 365-line dashboard, and a 5-gate decision tree — and tripped on its own complexity by acting on every `rate_limit_event` (which fires on `allowed` updates too) rather than only the explicit rejection. This rewrite uses the SDK's structured failure signal directly.

## Detection signal — picked, not text-matched

The SDK exposes three rate-limit-adjacent signals in `@anthropic-ai/claude-agent-sdk@0.2.98`:

| Signal | Shape | Why we use / don't use it |
|---|---|---|
| `rate_limit_event` | `rate_limit_info: { status: 'allowed' \| 'allowed_warning' \| 'rejected', resetsAt?: number, rateLimitType?: ... }` | **Cache the latest** for `resetsAt` extraction. Do **NOT** trigger rotation on this — it fires on every status change including `allowed`, which is what tripped #93. |
| `assistant` with `error: 'rate_limit'` | `SDKAssistantMessage` carries optional `error: SDKAssistantMessageError` | **Trigger rotation here.** This is the SDK reporting that an actual API call failed with a rate-limit response — i.e. the model could not produce a turn. This is the "explicit session limit reached" event the user wants to act on. |
| `api_retry` with `error: 'rate_limit'` | `SDKAPIRetryMessage` mid-retry-loop | Ignore. The SDK is handling its own retry; we only care once it gives up and surfaces the error on an assistant turn. |

No text-regex on assistant content. No heuristic. The runner reads `(message as SDKAssistantMessage).error === 'rate_limit'` from the SDK iterator it's already consuming.

## Feature Behaviors

### B1: Cache last rate-limit info on every event

**Core:**
- **ID:** cache-rl-info
- **Trigger:** SDK iterator yields `{ type: 'rate_limit_event', rate_limit_info }`
- **Expected:** Runner stores `lastRateLimitInfo = rate_limit_info` in loop scope. Continues forwarding the existing `rate_limit` GatewayEvent to the DO unchanged. No status branching, no acting on it.
- **Verify:** Unit test — feed three `rate_limit_event`s with `status='allowed'`, then `'allowed_warning'`, then `'rejected'` (no assistant.error after) → zero caam calls, but `lastRateLimitInfo` reflects the last one.
- **Source:** `packages/session-runner/src/claude-runner.ts:663-672`

#### UI / API / Data layer
N/A — purely in-runner state.

---

### B2: Rotate on explicit assistant rate-limit error

**Core:**
- **ID:** rotate-on-explicit
- **Trigger:** SDK iterator yields `{ type: 'assistant', error: 'rate_limit', ... }`
- **Expected (in order):**
  1. Read `resetsAt` from `lastRateLimitInfo` (fall back to `now + 5h` if missing).
  2. `caam ls claude --json` → find currently active profile name.
  3. `caam cooldown list --json` → set of profile names in cooldown.
  4. Pick first profile from `ls` where `active === false`, `system === false`, name not in cooldown set. If none → see B3.
  5. `caam cooldown set claude/<active> --until <resetsAt>` (idempotent if already set).
  6. `caam activate claude <next>`.
  7. Push synthetic command into runner's command queue: `{ type: 'stream-input', text: 'continue' }`.
  8. Emit one `system`-tagged GatewayEvent so the user sees what happened (not a status change). Format: `Switched profile to <next> (was <previous>, resets <ISO time>).`
- **Verify:** Unit test simulating the SDK iterator with a mocked caam binary; assert the order of caam invocations and the single `stream-input` command queued.
- **Source:** new code in `packages/session-runner/src/claude-runner.ts` (~30 LOC) + `packages/session-runner/src/caam.ts` (~70 LOC for the three wrappers)

#### UI Layer
- The `system` breadcrumb arrives via the existing message broadcast path (no new GatewayEvent type, no metadata.caam, no status mapping). Renders as a normal system message in the thread. No visual lozenge / spinner / clock.

#### API Layer
N/A — entirely in-runner.

#### Data Layer
- No DO migration. The breadcrumb is a regular `system` message persisted by the existing `broadcastMessage` path. No `metadata.caam`, no `pendingResume`, no new `SessionMeta` fields.

---

### B3: Graceful no-op when all profiles cooled

**Core:**
- **ID:** rotate-no-candidate
- **Trigger:** B2 step 4 finds zero candidates.
- **Expected:**
  1. `caam cooldown set claude/<active> --until <resetsAt>` (still record it).
  2. Emit one `system`-tagged GatewayEvent: `All Claude profiles in cooldown until <earliest reset>.`
  3. Do **not** queue 'continue'.
  4. Do **not** exit.
  5. Session status stays whatever it was (idle / running / etc — derived from the absence of further runner activity).
- **Verify:** Unit test mocking caam to return all profiles cooled → exactly one breadcrumb, zero activate/stream-input calls, runner remains alive.

#### UI / API / Data
N/A.

---

### B4: Admin dashboard — `/admin/caam`

**Core:**
- **ID:** caam-admin-page
- **Trigger:** Authed admin loads `/admin/caam`.
- **Expected:** Single table with one row per profile. Columns: name, active flag, last 7d utilization %, resets at, cooldown-until, [Activate] button. Manual refresh button at top. No polling.
- **Verify:** Component test renders with a canned 3-profile payload + 1-cooldown response, asserts row count and usage percentages match.
- **Source:** new files `apps/orchestrator/src/routes/_authenticated/admin.caam.tsx` and `apps/orchestrator/src/features/admin/caam-dashboard.tsx`.

#### UI Layer
~60 LOC React. No countdown-tick effect, no overlap guard, no skeleton-loop. Manual refresh on button click.

#### API Layer
- **Gateway** new path `GET /admin/caam/profiles` (existing bearer auth):
  - Single `Promise.all` over `caam ls claude --json`, `caam limits claude --format json`, `caam cooldown list --json` with one wall-clock timeout (5s for the whole bundle, abort all on overshoot, 503 on timeout).
  - Merge into `{ profiles: [{ name, active, system, plan, util_7d_pct, resets_at, cooldown_until }] }`.
  - On caam binary missing: return 503 with `{ error: 'caam_unavailable' }` — UI shows error toast.
  - **No worker proxy.** Worker route fetches gateway directly using `env.CC_GATEWAY_URL` + bearer (already in scope for other admin paths).
- **Worker:** `/admin/caam` is a TanStack route component fetching gateway in `loader`. No `/api/admin/caam/*` route added.

#### Data Layer
N/A — gateway is stateless on this path.

---

### B5: Manual activate from dashboard

**Core:**
- **ID:** caam-admin-activate
- **Trigger:** Admin clicks Activate button.
- **Expected:** `POST /admin/caam/activate` body `{ profile: string }` → gateway runs `caam activate claude <profile>` → returns updated profile list. UI re-renders.
- **Verify:** Component test mocks the POST, asserts the active flag flips to the clicked profile.

#### UI / API / Data
- UI: button + optimistic spinner.
- API: ~10 LOC handler on gateway, runs the binary, returns same shape as B4 GET.
- Data: N/A.

---

## Non-Goals

Explicitly out of scope:
- **DO migration.** No `pending_resume_json`, no `pendingResume` meta field, no v18 migration.
- **New session statuses.** No `rotating`, no `waiting_profile`. `useDerivedStatus` is untouched.
- **`metadata.caam` breadcrumbs / `forkWithHistory` filter.** System messages from rotation render as normal system messages.
- **Exit-reason taxonomy.** No `rate_limited` / `rate_limited_no_rotate` / `rate_limited_no_profile`. Runner does not exit on rate limit.
- **Peer-scan.** Single-active-runner assumption holds. If two runners on the same VPS race, last-write-wins on the active profile is fine — they're each making API calls under whichever profile is current; worst case one of them then trips B2 itself and rotates again.
- **Pinning env vars.** No `DURACLAW_CLAUDE_PROFILE`, no `DURACLAW_CLAUDE_ROTATION`. Rotation is on if caam is present, off if not. One bool: caam binary detected at startup.
- **Synth-rate-limit dev endpoint.** Test against the real provider via VP1 below; no `__dev__/synth-ratelimit` route.
- **Worker `/api/admin/caam/*` proxy.** Worker route hits gateway directly; the worker already has the gateway URL + bearer.
- **Real-time dashboard.** Manual refresh only.

## Open Questions

- [x] ~~**Q1: In-place vs respawn after `caam activate`.**~~ **Resolved:** the SDK isn't holding live process state at the rate-limit moment — the API call already failed, so the next call re-reads `~/.claude` cleanly. In-place rotation works; no respawn fallback needed.
- [x] ~~**Q2: Does `caam cooldown set` accept ISO timestamps?**~~ **Resolved:** `--minutes int` only. Runner computes `Math.ceil((resetsAt - now)/60)`.
- [ ] **Q3: What's `caam limits claude --format json` latency under concurrent dashboard loads?** It calls the provider — confirm during P2. If it's slow or self-rate-limiting, drop it from the dashboard merge and use `caam ls claude --json`'s `health.expires_at` for resets-at instead.

## Implementation Phases

See YAML frontmatter `phases:`.

- **P1** is the entire user-visible feature: rotation works.
- **P2** is the dashboard. Independent — can ship P1 alone and still get the rotation behavior; dashboard is for operator visibility.

## Verification Strategy

### Test Infrastructure
- vitest exists across the workspace (`pnpm test`, 12/12 suites today).
- New test files: `packages/session-runner/src/caam.test.ts` (~50 LOC, mocking `child_process.spawnSync`), `packages/session-runner/src/claude-runner-rotation.test.ts` (~80 LOC, simulating SDK message stream).
- Dashboard test: `apps/orchestrator/src/features/admin/caam-dashboard.test.tsx` (~40 LOC, vitest+jsdom, fetch-mocked).

### Build Verification
`pnpm typecheck && pnpm test` before push (per project standard). No new wrangler bindings, no new env vars in `.dev.vars`, no migration to apply.

## Verification Plan

### VP1: Real rotation against a multi-profile dev VPS (resolves Q1)

Steps:
1. Confirm `caam ls claude --json | jq '.profiles | map(select(.system==false)) | length' >= 2`.
   Expected: at least 2 user profiles.
2. Drain the active profile to rejection: open a fresh session, prompt with a long task that consumes tokens until the SDK actually rejects. (Or use a known low-quota profile.)
   Expected: `assistant` message with `error: 'rate_limit'` arrives in `/run/duraclaw/sessions/<id>.log`.
3. Tail runner stderr — observe single sequence of caam invocations (one `ls`, one `cooldown list`, one `cooldown set`, one `activate`).
   Expected: completes in <2s.
4. Observe next assistant turn.
   Expected: model produces a normal continuation. **If it errors with `authentication_failed` or another `rate_limit`** → Q1 resolves "creds cached", trigger fallback design (see Open Questions Q1).
5. `caam cooldown list --json`
   Expected: previous active profile is in the list with `until` ≈ `resetsAt`.

### VP2: All-profiles-cooled graceful path

Steps:
1. `caam cooldown set claude/<each user profile> --minutes 60` for every user profile.
2. Trigger a rate-limit on the (now-already-cooled) active profile via VP1's drain method.
   Expected: single system breadcrumb in the thread reading "All Claude profiles in cooldown until …". Runner stays alive (`pgrep -af session-runner` shows the process).
3. `caam cooldown clear --all`. Send a normal user message.
   Expected: session resumes normally; no leftover state.

### VP3: Dashboard happy path

Steps:
1. Visit `/admin/caam` as an admin user.
   Expected: table with one row per profile; usage % populated; manual refresh button works.
2. Click Activate on a non-active profile.
   Expected: row's "active" flag flips on next response (~500ms); `caam status` on the VPS confirms.

### VP4: Noisy-event regression guard (would have caught the #93 bug)

Steps:
1. Open a fresh session and send any normal prompt that completes successfully.
2. Inspect `/run/duraclaw/sessions/<id>.log` for `executeSession: message type=rate_limit_event` lines.
   Expected: present (SDK fires them on `allowed` updates).
3. Inspect runner stderr for any caam invocation during this normal turn.
   Expected: **zero caam invocations** — the absence of `assistant.error='rate_limit'` means B2 never fires.

## Implementation Hints

### Dependencies
None. `caam` is a binary at `/home/ubuntu/bin/caam` — runner shell-outs via `Bun.spawn` or `child_process.spawn`. No new npm packages.

### Key Imports
| Module | Import | Used For |
|---|---|---|
| `node:child_process` | `spawnSync` | Runner shells to caam (typed wrappers) |
| `@anthropic-ai/claude-agent-sdk` | `SDKAssistantMessage`, `SDKRateLimitInfo` | Type narrowing on iterator messages |

### Code Patterns

```ts
// caam.ts — three wrappers, JSON only
type Profile = { name: string; active: boolean; system: boolean; ... }
export function caamLs(): Profile[] { /* spawnSync caam ls claude --json */ }
export function caamCooldownList(): Set<string> { /* returns names */ }
export function caamCooldownSet(name: string, untilUnix: number) { /* --minutes N */ }
export function caamActivate(name: string) { /* spawnSync */ }
```

```ts
// claude-runner.ts — one new branch on the existing iterator
let lastRateLimitInfo: SDKRateLimitInfo | undefined
for await (const message of query) {
  if (message.type === 'rate_limit_event') {
    lastRateLimitInfo = message.rate_limit_info
    // existing forward-to-DO behavior unchanged
  }
  if (message.type === 'assistant' && (message as any).error === 'rate_limit') {
    await handleRotation(lastRateLimitInfo, channel, queue)
    // do NOT return — runner stays alive
  }
  // ...rest of the existing switch
}
```

```ts
// handleRotation — ~25 LOC, no decision tree
async function handleRotation(info, channel, queue) {
  const resetsAt = info?.resetsAt ?? Math.floor(Date.now()/1000) + 5*3600
  const profiles = caamLs()
  const cooled = caamCooldownList()
  const active = profiles.find(p => p.active)?.name
  const next = profiles.find(p => !p.active && !p.system && !cooled.has(p.name))?.name
  if (active) caamCooldownSet(active, resetsAt)
  if (!next) {
    emitSystemBreadcrumb(channel, `All Claude profiles in cooldown until ${new Date(resetsAt*1000).toISOString()}`)
    return
  }
  caamActivate(next)
  emitSystemBreadcrumb(channel, `Switched profile to ${next} (was ${active}, resets ${new Date(resetsAt*1000).toISOString()})`)
  queue.push({ type: 'stream-input', text: 'continue' })
}
```

### Gotchas
- The SDK `assistant` message's `error` field is **optional** — most assistant messages have no error. Cast carefully and check truthiness, don't destructure.
- `caam activate` mutates `~/.claude` synchronously. The SDK re-reads creds on the next API call (the rate-limit failure means there's no in-flight call to invalidate), so `queue.push('continue')` triggers a fresh auth read and the rotation completes in-place. No respawn needed.
- `caam cooldown set claude/<name>` namespacing: the CLI uses `claude/<profile>` separator, not whitespace. Verify with `caam cooldown set --help`.
- `Bun.spawn` vs `node:child_process`: session-runner runs under Bun. `child_process.spawnSync` works under Bun and avoids async surprises in the rotation handler. Prefer it.

### Reference Docs
- caam upstream: <https://github.com/codevibesmatter/caam>
- SDK types: `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.98_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1986-2562` (see `SDKAssistantMessage`, `SDKAssistantMessageError`, `SDKRateLimitEvent`, `SDKRateLimitInfo`).
- Revert post-mortem: `git show 735cddd` — the revert message names the exact bug class this spec avoids.

## Estimated diff vs. PR #93

| | PR #93 (reverted) | This spec |
|---|---|---|
| Files touched | 31 | ~6 |
| New LOC | ~3,700 | ~250 |
| New tests | 1,169 | ~170 |
| DO migrations | 1 | 0 |
| New session statuses | 2 | 0 |
| New env vars | 4 | 0 |
| Detection signal | `rate_limit_event` (noisy) | `assistant.error='rate_limit'` (explicit) |
| Failure mode of detection | Acts on every `allowed` event | Only acts when API actually rejects |
