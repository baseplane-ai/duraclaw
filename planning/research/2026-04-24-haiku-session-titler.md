---
date: 2026-04-24
topic: Haiku-based session titler with pivot-triggered retitle
type: feasibility
status: complete
github_issue: null
items_researched: 4
---

# Research: Haiku-based session titler

## Context

Sessions in Duraclaw currently render with `session.title || session.prompt || session.project || sessionId.slice(0, 8)` as a fallback chain. `title` is a nullable TEXT column that nothing writes automatically — it's only ever set by a user-initiated PATCH. In practice almost every session renders its raw first-prompt preview in the tab bar and status bar, which is noisy, long, and doesn't reflect mid-session pivots.

Goal: a cheap side-channel that calls Claude Haiku to produce a 2-3 word title ("Verify 2128", "Researching Scroll") after enough conversation has accumulated to be meaningful, and re-fires on new user messages only when a confidence-gated "did the topic pivot?" check agrees.

## Scope

Four parallel deep-dives:

1. **Current title surface** — data model, write path, broadcast plumbing, UI consumers.
2. **Haiku call site & SDK plumbing** — whether `@anthropic-ai/sdk` exists, where to call from, key bindings, structured output.
3. **DO trigger hooks & broadcast plumbing** — turn-complete hook, user-message intake hook, `session_meta` persistence, fire-and-forget pattern.
4. **Prompt design, pivot detection, cost/latency** — Haiku 4.5 pricing, prior art (Claude Code's own titler, DeerFlow, ChatGPT), structured-output best practice, pivot-detection options.

## Findings

### 1. Current title surface

**Already there, already broadcast, already rendered.** The retitler plugs into a fully wired surface:

- **D1 column**: `agentSessions.title TEXT` nullable (`apps/orchestrator/src/db/schema.ts:145`). Typed as `DiscoveredSession.title` + `SessionSummary.title` in `packages/shared-types/src/index.ts:481,663`.
- **Not in `session_meta` DO-SQLite** — migration v7 (`apps/orchestrator/src/agents/session-do-migrations.ts:88-119`) adds `summary` but not `title`. The `SessionMeta` in-memory type at `session-do.ts:80-109` references title, but nothing reads/writes it through DO SQLite today. For a fire-and-forget updater writing D1 directly this is fine, but it means after DO eviction+rehydrate the title briefly rides on the D1 query round-trip.
- **Write path**: user-only, via `PATCH /api/sessions/:id` handler (`api/index.ts:2006-2037`). Keys listed in `SESSION_PATCH_KEYS` at `api/index.ts:75-76`. On write, atomically UPDATEs D1 then calls `broadcastSessionRow()` immediately after.
- **Broadcast**: `broadcastSessionRow(env, ctx, sessionId, op)` in `apps/orchestrator/src/lib/broadcast-session.ts:24-63` — SELECTs the row, fans out via `broadcastSyncedDelta()` to all connected clients (public → everyone; private → owner).
- **Client reception**: `sessionsCollection` (`apps/orchestrator/src/db/sessions-collection.ts:22-33`) — TanStack DB synced collection reading WS delta frames, already reactive. Title changes propagate via `useSession(sessionId)` automatically, no new wiring.
- **UI consumers**: tab bar (`components/tab-bar.tsx:525`), status bar (`components/status-bar.tsx:281-284`), command menu (`components/command-menu.tsx:98`). All use the `session.title || session.project || sessionId.slice(0, 8)` fallback; once `title` becomes non-null, they all switch automatically.

**Adjacent work**: Spec #31 (unified sync channel) established the `session_meta` + `broadcastSessionRow` pattern we'd extend. Issue #84 (user-editable project abbrev + color) is adjacent but orthogonal — it's project-scoped labels, not session-scoped.

### 2. Haiku call site & SDK plumbing

**Net new integration, ~30 LOC of handler code.**

- **No `@anthropic-ai/sdk` dependency exists anywhere.** Only `@anthropic-ai/claude-agent-sdk` v0.2.91 in `packages/session-runner/package.json:21` and `packages/agent-gateway/package.json:21`. The orchestrator has neither.
- **No API key binding today.** `wrangler.toml:130-146` and the `Env` interface in `apps/orchestrator/src/lib/types.ts:42-93` have no `ANTHROPIC_API_KEY`. `.dev.vars` has nine secrets, none for Anthropic.
- **Egress**: CF Durable Objects can `fetch('https://api.anthropic.com/v1/messages')` — no policy blocker. The DO already makes outbound HTTPS calls (spawn requests to the gateway).

**Best call site — SessionDO (not a separate Worker route):**

The SessionDO already owns (a) the message history needed for the prompt, (b) `SessionMeta` + D1-session-row write paths, (c) `ctx.waitUntil` for fire-and-forget, and (d) per-session isolation which is exactly what we want for single-flight titling. A Worker route would have to rehydrate this state over RPC and race with the in-flight conversation. Runner-side is wrong: the runner lives on VPS, has the Agent SDK not the plain SDK, and dying on completion means no long-lived place to pin retitle state.

**Structured output**: use Anthropic's native `output_format: { type: 'json_schema', schema: … }` (GA Nov 2025). Grammar-constrained, zero parse failures, simpler than `tool_choice`. Fall back to a single-tool `tool_choice` pattern if the SDK version we pin doesn't expose it.

### 3. DO trigger hooks & broadcast plumbing

All file:line refs are `apps/orchestrator/src/agents/session-do.ts` unless noted.

**Turn-complete trigger** — `case 'result':` at **:4550**. This is strictly better than `case 'assistant':` (:4366) because `result` fires after `updateStateIdle()` (:4621-4638) has finished the broadcast phase (GH#75 ordering), so we don't contend with the per-turn fanout. `num_turns` has been incremented by the time we arrive.

**User-message pivot hook** — `sendMessage` RPC at **:3473**. The HTTP entry at `:515-558` delegates here. Message persists + broadcasts at `:3638-3648`. Run the pivot gate **before** :3638 to avoid flashing a stale title through the broadcast (or: run it after, since we're async anyway and the title update flows on its own channel — pragmatic answer, no blocking).

**Turn counter** — `this.state.num_turns` incremented at :4402 inside `case 'assistant':`. `messageSeq` at :208 (rehydrated from `session_meta.message_seq` at :257), used for broadcast frame ordering, incremented at :1968-1969 and :2027-2028.

**Fire-and-forget idiom**:
```typescript
this.ctx.waitUntil(
  (async () => {
    try { /* haiku call + state update */ } catch (e) { /* log, never throw */ }
  })()
)
```
— as used at :2460-2463 for `buildChainRow`. This is the canonical pattern in the DO.

**Adding title columns to `session_meta`** — a new migration after the current tip. Columns to add:
- `title TEXT` (mirror of D1)
- `title_confidence REAL`
- `title_set_at_turn INTEGER`
- `title_source TEXT` — `'user' | 'haiku'` — crucial, see "Never clobber" below.

Plus entries in `META_COLUMN_MAP` (session-do-migrations.ts:136-156) so `hydrateMetaFromSql()` restores them. Write via the existing `persistMetaPatch({ title, … })` (:1559).

**One-call broadcast path**:
1. `this.state.title = …; this.persistMetaPatch({ title, titleConfidence, titleSetAtTurn, titleSource })` — DO SQLite write.
2. `await this.syncResultToD1(updatedAt)` (:2262) — updates `agent_sessions.title` in D1 and internally calls `broadcastSessionRow` which fans out to all connected clients via `sessionsCollection` delta. One `await`, full propagation.

### 4. Prompt design, pivot detection, cost & latency

**Pricing & latency (Haiku 4.5, as of 2026)**:
- $1/MTok input, $5/MTok output.
- p50 TTFT ≈ 0.74s, ~97 tok/sec throughput ([artificialanalysis.ai](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)).
- Structured-extraction p50 ≈ 780ms, p95 ≈ 1.28s ([docs.claude.com reduce-latency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)).

**Cost envelope** per session (assume 20-turn session, retitle window = last 8 turns ≈ 5K tokens):
- Initial title at turn ~3: ~1.5K input → $0.002
- Pivot gate per user message (~200 tok input, 50 tok out): $0.0003 each × ~10 msgs = $0.003
- 1-2 retitles: $0.002 × 2 = $0.004
- **Total ≈ $0.009/session** (<1¢). At 500 sessions/month: **~$4.50/month**. Prompt caching on the system prompt drops this another 70-90% at scale.

**Prior art**:
- **Claude Code's own session titler** ([Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-session-title-and-branch-generation.md)): max 6 words, sentence case, JSON `{title, branch}` after first user+assistant exchange.
- **DeerFlow**: 3-8 words, cheap/fast model, fires after first exchange, fallback "Untitled Session".
- **ChatGPT** (reverse-engineered): first user msg + first assistant response truncated to ~200 tokens total — known to produce off-topic titles under weak calibration.

**Pivot-detection options evaluated**:
- (a) Direct Haiku `did_pivot` + `confidence` — what the user asked for. Costs $0.0003/check, adds ~750ms to user-turn handling if awaited (don't await).
- (b) Embedding cosine distance — faster, cheaper per call, but adds a separate embedding provider dependency and doesn't surface a human-readable "why".
- (c) Keyword Jaccard — free, brittle on synonyms. Not a primary gate.

**Recommended for MVP: (a) direct Haiku.** The cost savings of (b) are ~$3/month at our scale; not worth a second vendor integration. Revisit if Anthropic bills become material.

**Confidence calibration**: verbalized LLM confidence outperforms raw logprobs on RLHF models ([ACL 2023: Just Ask for Calibration](https://aclanthology.org/2023.emnlp-main.330/)). Gate at `confidence ≥ 0.7` for pivot; `≥ 0.6` for initial title acceptance. Log tuples for later recalibration.

## Recommendation

### Architecture

Add a `sessionTitler` module inside the SessionDO. Two entry points:

1. **`maybeInitialTitle()`** — called once from `case 'result':` (:4550) after `num_turns >= 2` (one user + one assistant turn finalized). Gated on `title_source !== 'user'` AND `title` not yet set by Haiku. Fires via `ctx.waitUntil`.
2. **`maybePivotRetitle(newUserMessage)`** — called from `sendMessage` RPC (:3473) when `title_source !== 'user'` AND a previous Haiku title exists. Single Haiku call asks `{did_pivot, confidence, proposed_new_title}`. Apply only if `did_pivot && confidence >= 0.7`.

**Single-flight guard** — a `titleInFlight: Promise | null` instance field prevents overlapping calls on rapid user messages.

**Never-clobber invariant** — if `title_source === 'user'`, we never overwrite. The existing PATCH handler sets `title_source = 'user'` on any user edit. This means the user's manual title wins forever; if they want Haiku back, a UI-level "auto-rename" affordance can reset `title_source = null`.

### Trigger policy (recommended)

| Event | Gate | Action |
|-------|------|--------|
| Turn 2 completes (`num_turns >= 2` in `case 'result':`) | `title_source !== 'user'` AND Haiku title not yet stored | Generate initial title |
| New user message (`sendMessage`) | `title_source !== 'user'` AND Haiku title exists AND `num_turns >= 2` since last retitle | Run pivot gate; retitle if `did_pivot && confidence >= 0.7` |
| Failed call (rate limit, parse fail, refusal) | — | Leave existing title; log; backoff 5 min before retry on same session |

Keep it simple — the user asked for "best guess is fine" and pivot-gated retriggering. The research confirms this is enough; additional triggers (time-based, token-threshold) are premature.

### Prompt shapes

**Initial-title prompt** — given last N turns (cap at ~5K input tokens, truncate from the head):
```
System: You name work sessions. Emit a 2-3 word title in the style of "Verify 2128", "Researching Scroll", "Fix Auth Bug". Sentence case. No articles. Prefer action + object. If the session is early / ambiguous, best-guess from intent.

User: [last N turns of session, most recent last]

→ json_schema: { title: string (≤ 40 chars), confidence: number (0..1) }
```

**Pivot-gate prompt** — given current title + new user message:
```
System: You detect whether a user's new message pivots off the current session topic. A pivot is a change in primary goal, technical domain, or problem statement. Elaboration, follow-ups, or refinements are NOT pivots.

User: Current title: "{title}"
New message: "{new_message}"

→ json_schema: { did_pivot: boolean, confidence: number (0..1), proposed_new_title: string (2-3 words) | null }
```

Returning `proposed_new_title` in the same call is free (it's just a few more output tokens) and lets us retitle in one round-trip instead of two when pivot is detected.

### Storage

New columns on `session_meta` (DO SQLite) via a new migration:
- `title TEXT` (mirror of D1 for cold-start availability)
- `title_confidence REAL`
- `title_set_at_turn INTEGER`
- `title_source TEXT CHECK(title_source IN ('user','haiku')) NULL`

D1 `agent_sessions.title` stays authoritative for cross-client render; `session_meta` mirror avoids a D1 hop during DO rehydrate.

### New config

1. `ANTHROPIC_API_KEY` secret — add to `wrangler.toml`, `apps/orchestrator/src/lib/types.ts` `Env` interface, and `.dev.vars.example`. Rotate independently of `CC_GATEWAY_SECRET` / `SYNC_BROADCAST_SECRET`.
2. Feature flag `ENABLE_HAIKU_TITLER` (optional, env) so we can kill the side-channel without a redeploy if Anthropic outages surface.
3. `@anthropic-ai/sdk` new dep in `apps/orchestrator/package.json`.

### Rollout

1. **Phase 1**: Ship the infra (SDK dep, `ANTHROPIC_API_KEY`, migration, titler module) behind `ENABLE_HAIKU_TITLER=false`. Unit test the module against a mock Anthropic client.
2. **Phase 2**: Enable in dev worktrees. Log every call with `{session_id, trigger, input_tok, output_tok, title, confidence, did_pivot, latency_ms}`. Hand-spot-check 20-50 sessions.
3. **Phase 3**: Tune the confidence threshold against observed data (start at 0.7, adjust). Enable in prod.
4. **Phase 4**: Expose a `/rename auto` client command that resets `title_source = null` so users can opt back in after a manual override.

## Comparison: call site options

| Site | State access | Cost/latency | Auth overhead | Verdict |
|------|-------------|-------------|---------------|---------|
| **SessionDO** | Native (already owns transcript + meta) | Inline waitUntil | None (already DO-internal) | ✅ Recommended |
| Worker route (`POST /api/sessions/:id/title`) | Requires DO RPC rehydrate | Extra hop | Auth middleware + DO call | Viable only if we ever want a user-triggered "retitle now" UX; even then can call into the DO. |
| Session-runner (VPS) | Has transcript via Agent SDK | No Worker cost | Already authed to DO | Wrong lifecycle — runner dies after session; no place to host retitle on new user msg while idle/cold. |

## Open questions

- **Redlines when title might embed sensitive content.** User prompts can contain secrets / paths. Haiku-generated titles are shown in the tab bar — visible to other users if the session is public (`visibility='public'`, broadcast via `broadcastSessionRow`). Low risk for 2-3 word titles, but worth a brief system-prompt clause: "Don't include file paths, credentials, or PII in the title."
- **Offline / no-key dev**. Devs without `ANTHROPIC_API_KEY` in their `.dev.vars` should degrade gracefully. Module should no-op with a one-time warning log when the key is absent.
- **User edits AFTER a Haiku title** — current PATCH handler flips `title_source='user'`, freezing the title. Confirm this is desired vs. a "last-write-wins with a ✨-auto-title toggle" UX. Recommend freeze-on-user-edit for MVP; gives users hard escape.
- **Chains** (`chains` synced collection). When a session is part of a chain, should the chain title influence the session title prompt, or vice versa? Out of scope for this doc; worth a follow-up if chains become heavily used.
- **`session_meta` title mirror** — strictly optional. Could skip the mirror and treat D1 as sole source; DO always has the D1 binding. Only matters for cold-start latency on first render after eviction. Recommend mirroring because it's three columns and costs nothing.

## Next steps

- Open GH issue: `feat(do): haiku session titler with pivot-gated retitle`.
- Create spec from this research (planning mode, issue-backed).
- Prototype the `sessionTitler` module against a mock client first; then wire into the two hooks under a feature flag.

## Sources

**Codebase** (all paths rooted at `/data/projects/duraclaw-dev1`):
- `apps/orchestrator/src/db/schema.ts:145`
- `packages/shared-types/src/index.ts:481,663`
- `apps/orchestrator/src/lib/create-session.ts:102,104`
- `apps/orchestrator/src/api/index.ts:75-76,2006-2037`
- `apps/orchestrator/src/lib/broadcast-session.ts:24-63`
- `apps/orchestrator/src/db/sessions-collection.ts:22-33`
- `apps/orchestrator/src/components/tab-bar.tsx:525`
- `apps/orchestrator/src/components/status-bar.tsx:281-284`
- `apps/orchestrator/src/components/command-menu.tsx:98`
- `apps/orchestrator/src/agents/session-do.ts:80-109,208,257,515-558,1559,1968-1969,2027-2028,2262,2460-2463,3473,3638-3648,4366,4402,4550,4621-4638`
- `apps/orchestrator/src/agents/session-do-migrations.ts:70-119,136-156`
- `apps/orchestrator/src/lib/types.ts:42-93`
- `apps/orchestrator/wrangler.toml:130-146`
- `planning/specs/31-unified-sync-channel.md`

**External**:
- [Claude Haiku 4.5 launch + pricing](https://www.anthropic.com/news/claude-haiku-4-5)
- [Anthropic Structured Outputs (Nov 2025 GA)](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic latency optimization guide](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)
- [artificialanalysis.ai — Haiku 4.5 latency benchmarks](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)
- [Claude Code's own session titler prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-session-title-and-branch-generation.md)
- [ACL 2023 — Just Ask for Calibration](https://aclanthology.org/2023.emnlp-main.330/)
