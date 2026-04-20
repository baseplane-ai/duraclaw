---
date: 2026-04-20
topic: "GH#27 / spec 0018 preflight — codebase validation before formal review"
type: feature
status: complete
github_issue: 27
items_researched: 6
---

# Research: GH#27 spec 0018 preflight

Codebase validation of [`planning/specs/0018-docs-as-yjs-dialback-runners.md`](../specs/0018-docs-as-yjs-dialback-runners.md) before it enters formal spec review (P3).

## Context

Spec 0018 proposes real-time markdown collab via a `docs-runner` daemon +
`RepoDocumentDO` per file, cloning the dial-back WS pattern proven by
session-runner (#1, shipped 2026-04-17). The draft is thorough but leans
heavily on claims like "clone SessionCollabDO," "DialBackClient is
payload-agnostic," and "each project has a `docsWorktreePath` on its
registry entry." P0 asks: do those claims hold against the code as it
sits today?

Classification: **feature research**, codebase delta audit.

## Scope

| Item | Goal |
|---|---|
| 1 | Validate SessionCollabDO / YServer clone claim |
| 2 | Validate DialBackClient binary-payload reuse claim |
| 3 | Validate session-runner auth + lifecycle parallel |
| 4 | Validate ProjectRegistry + docsWorktreePath story |
| 5 | Extract alignment-doc decisions the spec inherits |
| 6 | Assess BlockNote + jsdom + Bun feasibility |

Method: one Explore agent per item, in parallel.

## Findings

### Item 1 — SessionCollabDO / YServer surface

Location: `apps/orchestrator/src/agents/session-collab-do.ts:12`

Spec-claim check:

| Claim | Verdict | Evidence |
|---|---|---|
| Clones `y_state` BLOB schema | ✅ | `session-collab-do.ts:24–29` — table with `id TEXT PK, data BLOB, updated_at INTEGER`, `y_state` name confirmed |
| `onLoad`/`onSave` debounced 2s, max 10s | ✅ | `session-collab-do.ts:16–20` — `debounceWait: 2000`, `debounceMaxWait: 10000` (plus `timeout: 5000` hard flush) |
| Extends `YServer` with `hibernate: true` | ✅ | line 12 + `static options = { hibernate: true }` line 13 |
| Accepts standard y-protocols sync step 1/2 + awareness | ✅ | Delegated to `YServer` base (y-partyserver 2.1.4, `package.json:87`) |
| "Clone onConnect auth" | **❌** | SessionCollabDO has **no onConnect override**. Auth gated upstream in `server.ts:54–57` via `getRequestSession` cookie-only. The dual-auth (cookie OR `role=docs-runner&token=…`) in spec B-SERVER-1 is **new work**, not a clone. |

**Additional gaps**

- Entity-ID derivation: spec B-SERVER-2 requires `sha256(projectId + ':' + relPath).slice(0, 16)`. SessionDO uses `idFromName(sessionId)`. No prior-art pattern for hash-derived IDs; this is new ground.
- `callbackOptions.timeout: 5000` (5s) fires BEFORE `debounceMaxWait: 10000` (10s). Effective max staleness is **5s**, not 10s. Spec should clarify.
- PartyKit routing (`/parties/repo-document/:id`) assumed to work out-of-the-box — P1 gate must verify alongside the `/api/collab/repo-document/...` route.

### Item 2 — DialBackClient payload-agnosticism

Location: `packages/shared-transport/src/dial-back-client.ts`

Spec-claim check:

| Claim | Verdict | Evidence |
|---|---|---|
| "DialBackClient treats its payload as opaque" | **❌** | Line 182–190: `onmessage` handler does `JSON.parse(e.data as string)` **hardcoded**. No abstraction to swap parsers. |
| `binaryType = 'arraybuffer'` for y-protocols | **❌ not set** | Line 121: `new WebSocket(url)` — defaults to `'blob'` (browser) / `'nodebuffer'` (Node). y-protocols needs `Uint8Array`. |
| "BufferedChannel is not needed" | ✅ semantically | But DialBackClient currently **requires** BufferedChannel as constructor dep (line 12), even if unused. |
| Reconnect `[1s, 3s, 9s, 27s, 30s×]` | ✅ | Constants at lines 32–34, tests at `dial-back-client.test.ts:98`. |
| 10s stable reset | ✅ | Lines 136–138. |
| 20 post-connect failure cap | ✅ | Lines 37–39, 211. |
| 4401 invalid_token / 4410 token_rotated terminal | ✅ | Lines 41–43, 158–172. (Bonus: 4411 mode_transition also terminal.) |

**Fix options**

- **A — binary-mode flag**: add `payloadType: 'json' \| 'binary'` constructor option; branch in `onmessage`, set `binaryType` accordingly. Backward-compatible, single class. ~½ day.
- **B — `DialBackDocClient` subclass**: override `onmessage`, set `binaryType = 'arraybuffer'`. Matches spec's naming. Cleaner separation. ~½ day.

Spec 0018 p2 already names the new client `DialBackDocClient` — option B aligns. Either way, **spec must acknowledge DialBackClient is not actually opaque today**; today's wording misleads reviewers.

### Item 3 — session-runner auth + shutdown patterns

Locations: `packages/session-runner/src/main.ts`, `packages/shared-transport/src/dial-back-client.ts`, `apps/orchestrator/src/agents/session-do.ts`.

Spec-claim check:

| Claim | Verdict | Evidence |
|---|---|---|
| `callback_url + bearer` maps cleanly to `DOCS_RUNNER_SECRET` env bearer | ✅ | Token compare at `session-do.ts:180–184` via `constantTimeEquals`; same path accepts env-sourced bearer for docs. |
| Reconnect backoff matches | ✅ | See item 2. |
| 4401 / 4410 terminal codes match | ✅ | `session-do.ts:183` emits 4401; `:361` emits 4410. |
| **"SIGTERM watchdog mirrors session-runner"** | **❌ SPEC ERROR** | `session-runner/src/main.ts:35`: `SIGTERM_GRACE_MS = 2_000`. Session-runner uses **2s, not 5s**. Spec B-RUNNER-6 must be corrected. |

**Unaddressed-in-spec design concerns**

1. **Shared-bearer rotation semantics**. Session-runner rotates per-session `active_callback_token` atomically (close old WS 4410 → persist new → spawn new). Docs-runner's shared bearer has no rotation mechanism — compromise requires systemd-wide restart. Spec should explicitly say "no rotation in v1, systemd-restart = key rotation" so reviewers don't assume otherwise.

2. **Per-file error isolation vs DialBackClient's `onTerminate`**. DialBackClient fires `onTerminate(reason)` for `invalid_token` / `token_rotated` / `reconnect_exhausted` / `mode_transition`. Session-runner treats all four as "abort the SDK query." Docs-runner has N clients — `token_rotated` affects all files (shared bearer), `reconnect_exhausted` only one. Spec must specify the multi-WS handler pattern.

3. **Concurrent-runner guard**. Session-runner has `hasLiveResume()` (`main.ts:96–140`) scanning sibling meta files to prevent two runners on the same sdk_session_id. Docs-runner has no equivalent; what happens if two systemd supervisors race to start the same project? Spec is silent.

4. **Meta-file I/O load**. Session-runner dumps meta every 10s with 5-failure abort. 100 files × 10s dump = potential I/O spike or unnecessary work (single docs-runner process vs N).

### Item 4 — ProjectRegistry / docsWorktreePath

**Critical finding**: The `ProjectRegistry` Durable Object was **DROPPED in wrangler migration v5** (post-#7 D1 migration). `wrangler.toml:60–66` shows `deleted_classes = ["ProjectRegistry"]`. CLAUDE.md's "ProjectRegistry (singleton, worktree locks + session index)" is **stale documentation**.

Current state:

- Projects are **discovered**, not registered. `packages/agent-gateway/src/projects.ts:217–246` walks `/data/projects/` and filters by `PROJECT_PATTERNS`.
- Session / project metadata lives in **D1 SQLite**: `agentSessions` table (`apps/orchestrator/src/db/schema.ts:111–148`).
- Worktree tracking: `worktreeReservations` table (`schema.ts:171–187`) — a **lock** table for GH#16 chain mode, **not per-project metadata**.
- No `POST /api/projects/:id` endpoint to update project metadata. No field named `docsWorktreePath` anywhere.

Spec impact:

- **B-RUNNER-0 assumes a registry that doesn't exist.** The spec says "each project has a `docsWorktreePath` field on its registry entry." There is no registry entry. This is load-bearing wording — the worktree-pinned-to-main design depends on per-project persistent config.
- **B-SERVER-2 entity-ID** hashes `sha256(projectId + ':' + relPath)` — but no stable `projectId` exists today. Today's de facto project-id is `projectName` (a relative path), unstable across machines and renames.

Required before P1 can start:

1. Create a `projectMetadata` D1 table: `{ projectId TEXT PK, projectName TEXT, docsWorktreePath TEXT?, createdAt, updatedAt }` with stable `projectId` minted on first discovery (recommend git-toplevel SHA).
2. Add PATCH endpoint `/api/projects/:id` (not a replacement for discovery; a complement).
3. Update CLAUDE.md to remove the `ProjectRegistry` line.

### Item 5 — alignment-doc context

Source: `planning/research/2026-04-19-mdsync-research-alignment.md`.

Routes A/B/C picked Route B (duraclaw-hosted RepoDocumentDO). Locked decisions spec 0018 inherits:

1. Per-file DO keying (hash-based entity ID)
2. Permanent docs worktree rooted on `main` (actually 0018's own elaboration, not in alignment doc)
3. Content-hash gate (v1), block-level diff (v2 future)
4. Write-back loop suppression via `suppressedPaths` TTL 2s
5. Scribe mode discarded in favour of direct DO persistence
6. Shared bearer auth (v1) → per-user tokens (future)

**Open questions spec 0018 silently punts or drops**

| Question | Status |
|---|---|
| Initial hydration: bulk vs lazy? | Carried silently; spec p3 is implicitly lazy |
| File deletion lifecycle (tombstone + GC) | **Dropped.** Alignment flagged this as "real problem"; spec mentions tombstone without grace/ref-count. |
| DO GC for 100+ long-lived DOs | Carried (spec open question #1) |
| docs-runner spawn cadence (eager / lazy / hybrid) | Spec chose lazy (open question #5) but doesn't commit |

**Latent-risk inheritance from 0008**: Spec 0018 carries 0008's "Yjs Node client is ~50 lines" estimate. Alignment doc pushed back — 0008 assumed baseplane's simplified `0x00/0x01` framing; duraclaw needs full y-protocols sync step 1/2. Still ~50 lines, but a **different** 50 lines. Spec should re-cost.

### Item 6 — BlockNote + jsdom + Bun feasibility

Verdict: **🟡 YELLOW — plausible but unproven in this exact combo.**

- BlockNote ships `@blocknote/server-util` with `ServerBlockNoteEditor` for Node server-side use. `markdownToBlocks` / `blocksToMarkdown` are documented for headless use.
- The jsdom global-patch pattern is spec-0008-documented (referencing v0.42.3). Current BlockNote is v0.48.1 — line references are stale but the *pattern* is likely still valid.
- `@blocknote/core` is **not yet installed** in this repo.
- **Bun + jsdom + BlockNote headless** is not publicly attested anywhere (GitHub issues, release notes, community posts). BlockNote maintainer confirmed `server-util` fails under Next.js App Router SSR (issue #942) — a cautionary signal that not all server contexts Just Work.
- Fallback (`remark` + manual `Y.XmlFragment` construction) is ~3–4 days of schema-mapping work; y-prosemirror tooling doesn't port directly since BlockNote has its own block schema.

**Recommendation for spec**: keep the P2 spike flagged as a **hard gate** before P1 commits. Don't invest in DO/routing until the markdown ↔ Yjs round-trip is proven in a throwaway branch. Add a clearer fallback cost to the Risks table.

## Comparison: spec claim vs reality

| Spec 0018 claim | Reality | Fix required |
|---|---|---|
| "Clone SessionCollabDO's onConnect auth" | SessionCollabDO has no onConnect; cookie auth is upstream | Rewrite B-SERVER-1 to describe dual-auth as new code, not cloned |
| "DialBackClient treats payload as opaque" | Hardcoded `JSON.parse` + no `binaryType` | Acknowledge delta; specify `DialBackDocClient` subclass (preferred) with `binaryType='arraybuffer'` + raw Uint8Array `onmessage` |
| "SIGTERM watchdog mirrors session-runner" | Session-runner is 2s, spec says 5s | Correct B-RUNNER-6 to 2s |
| "Each project has a `docsWorktreePath` field on its registry entry" | No registry. ProjectRegistry DO deleted in v5. | New `projectMetadata` D1 table + PATCH endpoint + stable `projectId` minting |
| "sha256(projectId + ':' + relPath)" | No stable `projectId` exists | Mint projectId (git-toplevel SHA recommended) before using in hash |
| "Yjs Node client is ~50 lines" (inherited from 0008) | Different 50 lines under full y-protocols framing | Re-cost P2 spike |
| "BlockNote under Bun+jsdom is the primary path" | Unproven in this combo | Keep P2 as hard gate; harden fallback cost in Risks |

## Recommendations

**For spec review (P3), require the following edits:**

1. **B-SERVER-1**: Reframe dual-auth as new logic. Cite `UserSettingsDO.onConnect` (lines 162–174) as the closest pattern, not SessionCollabDO.
2. **B-SERVER-2**: Require pre-requisite migration — new `projectMetadata` D1 table + stable `projectId`. Don't use `projectName` in the hash.
3. **B-RUNNER-0**: Rewrite assumption of a "registry entry" to match D1 reality.
4. **B-RUNNER-6**: Correct watchdog to **2s**.
5. **New behaviour B-RUNNER-7**: Multi-WS error-isolation semantics. Specify which `onTerminate` reasons tear down one WS vs the whole runner.
6. **New behaviour B-AUTH-1.5**: Shared-bearer rotation semantics — explicitly "systemd restart is the only rotation mechanism in v1."
7. **Transport-layer refactor task** in P1 (or new P0b phase): add `DialBackDocClient` subclass (or `payloadType` flag) to `shared-transport` with binary mode + arraybuffer framing. Acknowledge it's not a zero-cost reuse.
8. **Phase gates**: P2 BlockNote-under-Bun+jsdom spike is a **hard gate** — fail fast in a throwaway branch before committing to P1 wiring.
9. **Pre-P1 prep list** (new section): (a) create `projectMetadata` D1 table, (b) PATCH endpoint, (c) mint stable projectId, (d) CLAUDE.md drift fix, (e) confirm agent-gateway spawn strategy (no `/sessions/start` equivalent exists yet for docs-runner — new endpoint `/docs-runners/start` or lazy systemd only).

**For the P1 interview, these are the items that still need user decisions**, not technical research:

- Eager-spawn (systemd start on project registration) vs lazy-spawn (on first browser dial-in) vs hybrid — spec punts; needs a call.
- Stable `projectId` scheme: git-toplevel SHA vs UUID-on-first-discovery vs explicit user-supplied slug.
- File-deletion lifecycle: tombstone-immediately vs grace-period vs reference-count.
- docs-runner per-machine vs per-project. Spec contradicts itself in places (p2 says "one per machine, N WSs"; B-RUNNER-0 says "spawns exactly one docs-runner per project"). Needs a lock-in.
- Fallback commitment if BlockNote spike fails: accept 3–4 day remark-based path, or defer the whole feature?

## Open questions (for P1 interview)

See the "needs user decisions" list above.

## Next steps

1. Mark P0 complete; enter P1 (kata-interview) to resolve the user-decision list.
2. P2 (kata-spec-writing) revises spec 0018 with the fixes above.
3. P3 (kata-spec-review) passes the revised spec through external review.
