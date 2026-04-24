---
initiative: haiku-session-titler
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 86
created: 2026-04-24
updated: 2026-04-24
phases:
  - id: p1
    name: "Types + GatewayEvent + session_meta migration"
    tasks:
      - "Add `TitleUpdateEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts:142-166`. Shape: `{ type: 'title_update', session_id: string, title: string, confidence: number, did_pivot: boolean, turn_stamp: number }`. Also add `titler_enabled?: boolean` to the `GatewayCommand` execute/resume payload types in the same file."
      - "Add `title_source` field (`'user' | 'haiku' | null`) to `SessionMeta` interface in `apps/orchestrator/src/agents/session-do.ts:80-109`."
      - "Add `title_confidence` (REAL), `title_set_at_turn` (INTEGER), `title_source` (TEXT) columns to `session_meta` via migration v16 in `apps/orchestrator/src/agents/session-do-migrations.ts`. Add entries to `META_COLUMN_MAP` at :136-156."
      - "Extend `SESSION_PATCH_KEYS` handler at `apps/orchestrator/src/api/index.ts:2006-2037` — when a user PATCHes `title`, also write `title_source='user'` to D1 `agent_sessions` column and `session_meta` via `persistMetaPatch`. Add `title_source TEXT` column to D1 `agent_sessions` via a new Drizzle migration: run `pnpm --filter @duraclaw/orchestrator drizzle-kit generate` after adding the column to `apps/orchestrator/src/db/schema.ts` (adjacent to the existing `title` column at :145). Apply with `pnpm --filter @duraclaw/orchestrator drizzle-kit migrate`."
    test_cases:
      - "`pnpm typecheck` clean across all packages."
      - "Manually verify migration v16 applies in a fresh DO by checking `PRAGMA table_info(session_meta)` includes `title_confidence`, `title_set_at_turn`, `title_source`."
  - id: p2
    name: "Feature flag + admin toggle"
    tasks:
      - "Create D1 table `feature_flags` (`id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL`). Drizzle schema in `apps/orchestrator/src/db/schema.ts`."
      - "Add `GET /api/admin/feature-flags` route (admin-guarded via `c.get('role') !== 'admin'` check, matching pattern at `api/index.ts:1634`). Returns all rows."
      - "Add `PATCH /api/admin/feature-flags/:id` route (admin-guarded). Upserts `{id, enabled, updated_at}`. Broadcasts nothing — flags are read at spawn-time, not reactively."
      - "Add admin UI toggle in the settings panel. Simple switch component for `haiku_titler` flag. Use existing admin-settings patterns."
      - "In `triggerGatewayDial` at `apps/orchestrator/src/agents/session-do.ts`, read `feature_flags` row `haiku_titler` from D1 before building the spawn payload. On D1 read failure (network error, missing table mid-deploy), default to `titler_enabled = true` — fail-open so the titler works out of the box; admins who disable it do so explicitly. Add `titler_enabled: boolean` to the `GatewayCommand` execute/resume payload (the gateway serializes the full payload into the `.cmd` file; the runner deserializes it at startup). Cache the flag read in the DO for 5 min to avoid D1 round-trips on every spawn."
    test_cases:
      - "Admin user can toggle `haiku_titler` flag via `PATCH /api/admin/feature-flags/haiku_titler` and read it back via `GET /api/admin/feature-flags`."
      - "Non-admin user gets 403 on both endpoints."
      - "`pnpm typecheck` clean."
  - id: p3
    name: "Runner-side titler module"
    tasks:
      - "Create `packages/session-runner/src/titler.ts` — exports `SessionTitler` class."
      - "Constructor takes: `{ channel: BufferedChannel, sessionContext: RunnerSessionContext, enabled: boolean }`. If `!enabled`, all methods are no-ops."
      - "Implement `estimateTokens(text: string): number` — `Math.ceil(text.length / 4)` heuristic."
      - "Implement `buildTranscript(messages: Message[]): string` — last 8 turns, head-truncated to ~5K tokens. Strip tool-call bodies, keep tool names + user/assistant text."
      - "Implement `maybeInitialTitle(messages: Message[]): Promise<void>` — checks `estimateTokens(buildTranscript(messages)) >= 1500`, has not already titled, then calls Haiku and emits `title_update` event via `send(channel, event, ctx)`."
      - "Implement `maybePivotRetitle(messages: Message[], newUserMessage: string): Promise<void>` — checks: title exists AND `title_source !== 'user'` AND cooldown expired (5 min since last retitle, tracked via `lastRetitleTs` instance field). Calls Haiku with pivot-gate prompt. If `did_pivot && confidence >= 0.7`, emits `title_update` event."
      - "Haiku call: use the plain `@anthropic-ai/sdk` (transitive dep of `@anthropic-ai/claude-agent-sdk`, already in runner's node_modules) via `new Anthropic().messages.create({ model: 'claude-haiku-4-5-20251014', max_tokens: 100, system: TITLER_SYSTEM_PROMPT, messages: [{ role: 'user', content: transcript }] })`. The runner inherits `ANTHROPIC_API_KEY` from the gateway process via `buildCleanEnv()` at `packages/agent-gateway/src/handlers.ts:62-71` — no new secrets needed. System prompt uses few-shot examples ('Verify 2128', 'Researching Scroll', 'Fix Auth Bug'). Assistant response text is stripped of optional code fences then parsed as JSON `{ title, confidence }` (initial) or `{ did_pivot, confidence, proposed_new_title }` (pivot). On parse failure: log warn, return without emitting."
      - "Single-flight guard: `titleInFlight: Promise<void> | null` instance field. If non-null, skip the call. Reset to null in `.finally()`."
    test_cases:
      - "Unit test: `estimateTokens('hello')` returns 2."
      - "Unit test: `buildTranscript` with 12 turns returns only the last 8, total estimated tokens ≤ 5000."
      - "Unit test: `maybeInitialTitle` does NOT fire when transcript < 1500 tokens."
      - "Unit test: `maybeInitialTitle` fires and emits `title_update` event when transcript >= 1500 tokens."
      - "Unit test: `maybePivotRetitle` respects 5-min cooldown — second call within 5 min is a no-op."
      - "Unit test: `maybePivotRetitle` emits `title_update` only when `did_pivot=true` AND `confidence >= 0.7`."
      - "Unit test: single-flight guard — concurrent calls are deduplicated."
      - "Unit test: when `enabled=false`, all methods are no-ops (zero channel sends)."
  - id: p4
    name: "Wire runner hooks + DO handler"
    tasks:
      - "In `packages/session-runner/src/claude-runner.ts`, instantiate `SessionTitler` at runner startup using `titler_enabled` from the `.cmd` payload."
      - "After each `type=result` event (turn-complete), call `titler.maybeInitialTitle(messages)` — fire-and-forget (no await, catch errors)."
      - "On each incoming `stream-input` command (new user message), call `titler.maybePivotRetitle(messages, newUserMessage)` in parallel with the main `query()` — fire-and-forget, do NOT block the main SDK turn."
      - "In `apps/orchestrator/src/agents/session-do.ts`, add `case 'title_update':` to `handleGatewayEvent` switch at :4248. Handler: (a) check `this.state.title_source !== 'user'` — if user-set, discard event; (b) update `this.state.title`, `this.state.title_confidence`, `this.state.title_set_at_turn`; (c) `persistMetaPatch({ title, titleConfidence, titleSetAtTurn, titleSource: 'haiku' })`; (d) update D1 `agent_sessions.title` + `title_source`; (e) `broadcastSessionRow(env, ctx, sessionId, 'update')` via `ctx.waitUntil`."
    test_cases:
      - "Integration: start a session, send a prompt long enough to exceed 1500 tokens in 1-2 turns. Verify `title_update` event is emitted by the runner and the DO persists the title to D1."
      - "Integration: after initial title, send a message that pivots topic. Verify pivot-gate fires and title updates if confidence >= 0.7."
      - "Integration: PATCH title manually, then send a pivot message. Verify `title_source='user'` blocks the Haiku retitle."
      - "Integration: verify 5-min cooldown — send two pivot messages within 5 min, only the first retitles."
      - "Unit test (DO): `handleGatewayEvent` with `title_update` updates state and calls `broadcastSessionRow`."
      - "Unit test (DO): `handleGatewayEvent` with `title_update` is a no-op when `title_source='user'`."
  - id: p5
    name: "Verification + polish"
    tasks:
      - "Run full VP (see Verification Plan below)."
      - "Confirm all UI surfaces (tab bar, status bar, command menu) reactively update when title is set by Haiku."
      - "Confirm `pnpm typecheck` and `pnpm test` pass."
      - "Confirm feature-flag admin toggle disables titler — start a session with flag off, verify no `title_update` events emitted."
    test_cases:
      - "All VP steps pass."
      - "`pnpm typecheck` clean."
      - "`pnpm test` passes."
---

## Overview

Add a Haiku-based session titler that automatically generates 2-3 word
session titles (e.g., "Verify 2128", "Researching Scroll") after enough
conversation has accumulated. The titler lives in the session-runner,
reuses the existing Claude Code auth, and fires a pivot-detection gate on
each new user message to retitle mid-session when the topic changes.
Replaces the noisy first-prompt-preview fallback in the tab bar, status
bar, and command menu with a concise, model-generated label.

## Feature Behaviors

### B1: Initial title generation after token threshold

**Core:**
- **ID:** initial-title-generation
- **Trigger:** Runner processes a `result` event (turn complete) and the accumulated transcript exceeds ~1500 estimated tokens for the first time.
- **Expected:** Runner calls Haiku with the last 8 turns (≤ 5K tokens) and a few-shot titling prompt. On success, emits a `title_update` GatewayEvent to the DO. DO persists `title`, `title_confidence`, `title_set_at_turn`, `title_source='haiku'` to both `session_meta` (DO SQLite) and D1 `agent_sessions`. Broadcasts via `broadcastSessionRow`.
- **Verify:** Start a session, send a prompt that produces > 1500 tokens of transcript within 1-2 exchanges. Within ~2s of the first `result` event, the tab bar and status bar display a 2-3 word title instead of the prompt preview.
**Source:** `packages/session-runner/src/claude-runner.ts` (new hook after `case 'result':`), `apps/orchestrator/src/agents/session-do.ts:4248` (new `case 'title_update':`)

#### Data Layer
- New `TitleUpdateEvent` in `GatewayEvent` union (`packages/shared-types/src/index.ts:142-166`).
- `session_meta` migration v16: `title_confidence REAL`, `title_set_at_turn INTEGER`, `title_source TEXT`.
- D1 `agent_sessions`: add `title_source TEXT` column.

### B2: Pivot-gated retitle on new user messages

**Core:**
- **ID:** pivot-gated-retitle
- **Trigger:** Runner receives a `stream-input` command (new user message) while a Haiku-generated title already exists.
- **Expected:** Runner fires a Haiku pivot-check call **in parallel** with the main `query()` (zero added latency). Prompt includes the current title + new user message. If `did_pivot=true` AND `confidence >= 0.7`, the response includes `proposed_new_title`. Runner emits `title_update` with the new title. DO persists and broadcasts as in B1.
- **Verify:** Start a session about topic A, let it title. Send a message pivoting to topic B. Within ~1s of the pivot message, the tab bar updates to reflect topic B.
**Source:** `packages/session-runner/src/claude-runner.ts` (hook in `stream-input` handler), `packages/session-runner/src/titler.ts:maybePivotRetitle`

### B3: 5-minute retitle cooldown

**Core:**
- **ID:** retitle-cooldown
- **Trigger:** A `title_update` event was emitted less than 5 minutes ago.
- **Expected:** `maybePivotRetitle` checks `Date.now() - lastRetitleTs < 300_000` and returns immediately without calling Haiku. The cooldown is per-runner-instance (in-memory), reset on runner restart.
- **Verify:** Send two pivot messages within 3 minutes. Only the first triggers a title update; the second is silently skipped (no `title_update` event, no Haiku call logged).
**Source:** `packages/session-runner/src/titler.ts`

### B4: User-edit freeze (never-clobber invariant)

**Core:**
- **ID:** user-edit-freeze
- **Trigger:** User sets a title via `PATCH /api/sessions/:id` with `{title: "My Title"}`.
- **Expected:** The PATCH handler writes `title_source='user'` to both D1 and `session_meta`. All subsequent `title_update` events from the runner are discarded by the DO's `handleGatewayEvent` — it checks `this.state.title_source !== 'user'` before applying. Haiku never overwrites a user-set title.
- **Verify:** Manually set a session title. Send a clearly pivoting message. Verify the title remains the user-set value; `title_source` stays `'user'` in D1.
**Source:** `apps/orchestrator/src/api/index.ts:2006-2037` (PATCH handler), `apps/orchestrator/src/agents/session-do.ts` (new guard in `case 'title_update':`)

#### API Layer
- `PATCH /api/sessions/:id` — existing endpoint. New behavior: also writes `title_source='user'` alongside `title`.

### B5: Single-flight guard

**Core:**
- **ID:** single-flight-guard
- **Trigger:** A Haiku titler call is already in-flight when a second trigger fires (e.g., rapid turn completion + pivot check).
- **Expected:** The second call is silently skipped. `titleInFlight` instance field (a `Promise | null`) gates entry. Reset to `null` in `.finally()`.
- **Verify:** Unit test: fire `maybeInitialTitle` twice concurrently. Only one Haiku call is made (mock SDK, assert call count = 1).
**Source:** `packages/session-runner/src/titler.ts`

### B6: Admin feature-flag toggle

**Core:**
- **ID:** admin-feature-flag
- **Trigger:** Admin user toggles `haiku_titler` flag in the settings UI, or via `PATCH /api/admin/feature-flags/haiku_titler`.
- **Expected:** D1 `feature_flags` row is upserted. Next session spawn reads the flag and passes `titler_enabled` in the runner's `.cmd` payload. Runner constructs `SessionTitler` with `enabled: false` — all methods become no-ops.
- **Verify:** Toggle flag off. Start a new session with a long prompt. Verify no `title_update` events are emitted and title remains null (fallback display in UI).
**Source:** `apps/orchestrator/src/api/index.ts` (new admin routes), `apps/orchestrator/src/agents/session-do.ts` (flag read in `triggerGatewayDial`), `packages/session-runner/src/titler.ts` (constructor `enabled` check)

#### API Layer
- `GET /api/admin/feature-flags` — returns `{ flags: [{ id, enabled, updated_at }] }`. 403 for non-admin.
- `PATCH /api/admin/feature-flags/:id` — body `{ enabled: boolean }`. Upserts row. 403 for non-admin.

#### Data Layer
- New D1 table `feature_flags` (`id TEXT PK`, `enabled INTEGER NOT NULL DEFAULT 0`, `updated_at TEXT NOT NULL`).

### B7: Graceful degradation on Haiku failure

**Core:**
- **ID:** graceful-degradation
- **Trigger:** Haiku call returns a non-200 status (429/5xx), times out (>5s), or returns unparseable JSON.
- **Expected:** Runner logs a warning with session ID + error details. No `title_update` event is emitted. Existing title (if any) is preserved. No retry on the same trigger — next trigger (next turn-complete or next user message) will attempt again naturally. `titleInFlight` is cleared in `.finally()` so future calls aren't blocked.
- **Verify:** Mock Haiku to return 500. Send a message that would trigger initial title. Verify: warn log emitted, no title_update event, session renders with fallback title, next turn-complete re-attempts successfully when mock is restored.
**Source:** `packages/session-runner/src/titler.ts`

### B8: Title prompt design

**Core:**
- **ID:** title-prompt-design
- **Trigger:** Any Haiku titler call (initial or pivot-retitle).
- **Expected:** System prompt uses few-shot examples and instructs Haiku to output JSON-only. No hard validation rules — model freestyles within the example vibe. Assistant response parsed as `{ title: string, confidence: number, did_pivot?: boolean, proposed_new_title?: string }`.
- **Verify:** Review the system prompt in `titler.ts`. Confirm it includes at least 3 few-shot examples matching the style "Verify 2128", "Researching Scroll", "Fix Auth Bug". Confirm the user prompt is the built transcript (last 8 turns). Confirm the pivot prompt includes the current title + new user message.

**System prompt (initial title):**
```
You name work sessions. Emit ONLY a JSON object — no prose, no code fences.

Style: 2-3 words, sentence case, no articles. Examples:
- "Verify 2128"
- "Researching Scroll"
- "Fix Auth Bug"
- "Debug Memory Leak"
- "Refactor Gateway"

Prefer the user's most recent intent over older context.

Output: {"title": "...", "confidence": 0.0-1.0}
```

**System prompt (pivot gate):**
```
Detect whether the user pivoted to a new task. A pivot is a change in primary goal, technical domain, or problem statement. Elaboration and follow-ups are NOT pivots. If a pivot occurred, propose a new 2-3 word title in the same style as above.

Respond ONLY as JSON — no prose, no code fences.

Output: {"did_pivot": true/false, "confidence": 0.0-1.0, "proposed_new_title": "..." or null}
```

**User prompt (pivot gate):**
```
Current session title: "{current_title}"

New user message:
{new_user_message_text}
```

Note: the pivot prompt intentionally omits the full transcript — the current title already summarises prior context, and the new user message is the signal. This keeps input tokens minimal (~200 tokens) for the cheapest possible gate.

**Source:** `packages/session-runner/src/titler.ts`

## Non-Goals

- **No PII/sensitive-content guard** in the system prompt. The 2-3 word output surface is trusted to not leak meaningful secrets. Revisit if public-session title broadcasting surfaces complaints.
- **No embedding-based pivot detection.** Direct Haiku call is cheap enough (~$0.0003/check); embeddings would add a second vendor dependency for marginal savings.
- **No `/rename auto` UI command** to reset `title_source` from `'user'` back to `null`. Scope for a future issue.
- **No chain-aware titling.** When a session is part of a chain, the chain title does not influence the session title prompt.
- **No per-user opt-out.** The admin toggle is global. Per-user preferences are out of scope.
- **No title in the message transcript.** Title changes are metadata broadcast via `sessionsCollection`, not rendered as messages in the chat thread.
- **Feature-flag infra is intentionally generic.** P2 builds a reusable `feature_flags` D1 table + admin CRUD, not a one-off env var. This is deliberate scope investment — future features (e.g., experimental UI flags, model-rollout canaries) will reuse the same table and admin panel. If this scope feels too large, the implementer can stub the admin UI and seed the flag via D1 SQL directly.

## Verification Plan

All steps assume a local dev stack running via `scripts/verify/dev-up.sh` with the `haiku_titler` feature flag enabled in D1.

### VP1: Initial title fires after token threshold

1. `scripts/axi open http://localhost:$VERIFY_ORCH_PORT/login` — log in as test user.
2. Create a new session with a long, descriptive prompt (> 400 words / ~1500 tokens).
3. Wait for the first assistant response to complete.
4. `scripts/axi snapshot` — inspect the tab bar. The session tab should display a 2-3 word title, NOT the raw prompt preview.
5. Verify D1: `SELECT title, title_source, title_confidence FROM agent_sessions WHERE id = '<session_id>'` — `title` is non-null, `title_source = 'haiku'`, `title_confidence` is a float between 0 and 1.

### VP2: Short session does NOT auto-title

1. Create a new session with a very short prompt ("hi").
2. Wait for the assistant response.
3. `scripts/axi snapshot` — tab bar should show the fallback (project name or session ID prefix), NOT a Haiku-generated title.
4. Verify D1: `SELECT title FROM agent_sessions WHERE id = '<session_id>'` — `title` is NULL.

### VP3: Pivot-gate retitle

1. Continue the session from VP1. Record the current title from VP1 step 5.
2. Send a message that clearly changes the topic (e.g., "Actually, let's switch to debugging the mobile app's push notifications").
3. Wait for the assistant response to complete (not just begin streaming — the pivot Haiku call runs in parallel and may land after the main response starts).
4. Deterministic check (D1 query): poll `SELECT title, title_set_at_turn FROM agent_sessions WHERE id = '<session_id>'` up to 3 times with 2s intervals until `title` differs from VP1's value. This is the primary assertion — it's immune to UI render timing.
5. Visual confirmation: `scripts/axi snapshot` — inspect the tab bar for a title different from the VP1 title.
6. Verify D1: `title_set_at_turn` is greater than the VP1 value.

### VP4: Cooldown prevents rapid retitle

1. Immediately after VP3 (within 5 minutes), send another pivot message.
2. Verify: title does NOT change. `title_set_at_turn` in D1 remains the same as after VP3.

### VP5: User-edit freeze

1. Use `scripts/axi` or curl to PATCH the session title: `curl -X PATCH http://localhost:$VERIFY_ORCH_PORT/api/sessions/<id> -H 'Content-Type: application/json' -d '{"title":"My Custom Title"}'` (with auth cookie).
2. `scripts/axi snapshot` — tab bar shows "My Custom Title".
3. Send a clearly pivoting message.
4. `scripts/axi snapshot` — tab bar STILL shows "My Custom Title".
5. Verify D1: `title_source = 'user'`, `title = 'My Custom Title'`.

### VP6: Admin toggle disables titler

1. Toggle `haiku_titler` flag off: `curl -X PATCH http://localhost:$VERIFY_ORCH_PORT/api/admin/feature-flags/haiku_titler -H 'Content-Type: application/json' -d '{"enabled":false}'` (with admin auth cookie).
2. Create a new session with a long prompt.
3. Wait for first assistant response.
4. Verify D1: `title` is NULL. No `title_update` events in runner logs.
5. Toggle flag back on.

### VP7: Typecheck + tests

1. `pnpm typecheck` — all packages pass.
2. `pnpm test` — all test suites pass.

## Implementation Hints

### Key Imports
- `@anthropic-ai/sdk` (plain SDK) — transitive dep of `@anthropic-ai/claude-agent-sdk`, already resolved in runner's `node_modules`. Import as `import Anthropic from '@anthropic-ai/sdk'`. Uses `ANTHROPIC_API_KEY` env var automatically. No new dep needed in `package.json`.
- `BufferedChannel.send()` — `packages/shared-transport/src/index.ts`. The `send(ch, event, ctx)` helper at `packages/session-runner/src/claude-runner.ts:164-169` stamps `seq` and `last_activity_ts`.
- `broadcastSessionRow` — `apps/orchestrator/src/lib/broadcast-session.ts:24-63`. One call fans out to all clients.

### Code Patterns

**Emitting a new GatewayEvent from the runner** (copy the `kata_state` pattern):
```typescript
// packages/session-runner/src/claude-runner.ts:109
send(ch, {
  type: 'title_update',
  session_id: ctx.sessionId,
  title: result.title,
  confidence: result.confidence,
  did_pivot: result.did_pivot ?? false,
  turn_stamp: ctx.meta.num_turns,
}, ctx)
```

**Handling a new event type in the DO** (copy the `kata_state` pattern):
```typescript
// apps/orchestrator/src/agents/session-do.ts, inside handleGatewayEvent switch
case 'title_update': {
  if (this.state.title_source === 'user') break // B4: never clobber
  this.updateState({
    title: event.title,
    title_confidence: event.confidence,
    title_set_at_turn: event.turn_stamp,
    title_source: 'haiku',
  })
  this.persistMetaPatch({ title: event.title, titleConfidence: event.confidence, titleSetAtTurn: event.turn_stamp, titleSource: 'haiku' })
  // IMPORTANT: await D1 write, THEN broadcast — broadcast reads D1 row
  this.ctx.waitUntil(
    this.syncResultToD1(new Date().toISOString())
      .then(() => broadcastSessionRow(this.env, this.ctx, this.state.session_id, 'update'))
  )
  break
}
```

**Admin guard pattern** (existing at `api/index.ts:1634`):
```typescript
if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
```

**session_meta migration addCol** (copy pattern from existing migrations):
```typescript
// session-do-migrations.ts, migration v16
(db) => {
  addCol(db, 'title_confidence', 'REAL')
  addCol(db, 'title_set_at_turn', 'INTEGER')
  addCol(db, 'title_source', 'TEXT')
}
```

### Gotchas

1. **Use the plain SDK, not the Agent SDK** — the titler calls `new Anthropic().messages.create(...)` from `@anthropic-ai/sdk` (the plain SDK, a transitive dep). Do NOT use the Agent SDK's `query()` — it is session-bound and does not support one-shot Haiku calls with a different model. The plain SDK picks up `ANTHROPIC_API_KEY` from the runner's env (inherited via `buildCleanEnv()` at `packages/agent-gateway/src/handlers.ts:62-71`).
2. **Model string as named constant** — extract `'claude-haiku-4-5-20251014'` into `const TITLER_MODEL = '...'` at the top of `titler.ts`. Model strings rotate; a named constant makes the update a one-line diff.
3. **JSON parsing from Haiku** — Haiku generally respects "respond ONLY as JSON" but occasionally wraps in code fences. Strip `\`\`\`json\n` and `\n\`\`\`` before `JSON.parse()`. Handle gracefully.
4. **Runner lifecycle** — the titler instance dies with the runner. On runner restart (resume), `lastRetitleTs` resets to 0, so the first pivot-check after resume is always eligible. This is acceptable — stale titles after a 30-min idle are worth re-evaluating.
5. **D1 `title_source` column** — requires a Drizzle migration for the D1 schema, separate from the DO SQLite migration. Both must land in P1.
6. **`broadcastSessionRow` timing** — the broadcast reads the D1 row, so the D1 write MUST complete before the broadcast fires. Chain both inside a single `ctx.waitUntil`: `this.ctx.waitUntil(this.syncResultToD1(...).then(() => broadcastSessionRow(...)))`. Do NOT `await syncResultToD1` then separately `ctx.waitUntil(broadcastSessionRow)` — that blocks the event handler on the D1 write. The chained form is non-blocking and ordered.

### Reference Docs
- [Anthropic SDK `messages.create()` API](https://docs.anthropic.com/en/api/messages) — model param, system prompt, max_tokens. The titler uses the plain SDK, not the Agent SDK.
- [Anthropic structured output best practices](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — JSON-only prompting patterns.
- [Claude Code's own session titler prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-session-title-and-branch-generation.md) — prior art for style.
