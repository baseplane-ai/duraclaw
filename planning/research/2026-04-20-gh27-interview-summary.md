---
date: 2026-04-20
topic: "GH#27 / spec 0018 \u2014 P1 interview summary"
type: interview
status: complete
github_issue: 27
inputs:
  - planning/specs/0018-docs-as-yjs-dialback-runners.md
  - planning/research/2026-04-20-gh27-spec-0018-preflight.md
  - planning/research/2026-04-19-mdsync-research-alignment.md
---

# Interview summary \u2014 GH#27 / docs-runner + RepoDocumentDO

Produced by P1 interview on 2026-04-20. Every decision below is locked
and maps to at least one behaviour in the revised spec. Open risks are
called out in the final section.

## Decisions (grouped by category)

### A. Runner scope & lifecycle

| # | Decision | Reasoning |
|---|---|---|
| A1 | **Per-project** docs-runner (one daemon per repo) | Matches B-RUNNER-0's "spawns exactly one docs-runner per project"; clean trust boundary; per-project restart blast radius; gateway owns lifecycle uniformly (same pattern as session-runner). |
| A2 | **Lazy spawn** on first browser dial-in to a RepoDocumentDO | DO notices no runner is connected for this project, POSTs to agent-gateway. Mirrors the session "orphan" path. Cheap at rest \u2014 0 runners until someone opens a doc. First-open latency ~2-5s is acceptable. |
| A3 | **New `POST /docs-runners/start`** endpoint on agent-gateway | Separate from `/sessions/start`; different argv shape (no sdk_session_id, takes `docsWorktreePath`); parallel reaper; parallel status. Clean control-plane separation. |
| A4 | **Cmd-file + positional argv** contract, mirroring session-runner | Gateway writes `/run/duraclaw/docs-runners/{projectId}.cmd` with `{docsWorktreePath, orchestratorUrl, bearer, configPath}`. Argv: `docs-runner <projectId> <cmdFile> <pidFile> <exitFile> <metaFile>`. Reuses `/run/duraclaw/` tmpfs + reaper idioms verbatim. |

### B. Identity

| # | Decision | Reasoning |
|---|---|---|
| B1 | **projectId = `sha256(git remote get-url origin)`** at discovery time | Stable across machines, renames, and worktree moves. Two clones of the same repo converge on the same DO. Derivable without stored state. |
| B2 | **Fallback**: UUID persisted to `.duraclaw/project-id` for repos without a remote | Covers solo/local repos. Written once at first discovery, never mutated. |
| B3 | **entityId = `sha256(projectId + ':' + relPath).slice(0, 16)`** \u2014 unchanged from spec B-SERVER-2 | Now rests on a stable projectId (B1/B2). Relpath is the markdown file's path relative to the docs worktree root. |

### C. File lifecycle

| # | Decision | Reasoning |
|---|---|---|
| C1 | **Grace-period tombstone** for file deletion | Runner sees unlink \u2192 marks file `pending_delete` on DO \u2192 DO refuses new writes, serves reads, schedules hard-delete alarm in **7 days**. Survives `git stash`, branch-switches (via pull), accidental `rm`. Recoverable by re-creating the file within grace window. |
| C2 | Grace window is **configurable** per project (default 7d) | `duraclaw-docs.yaml` field `tombstone_grace_days: <n>`. |
| C3 | **File discovery via per-project `duraclaw-docs.yaml`** at docsWorktreePath root | `watch: [planning/**/*.md, docs/**/*.md]`, `exclude: [...]`, `tombstone_grace_days: 7`. In-repo, versioned, reviewable. Ship a sensible default template via an `init` subcommand. |

### D. Robustness

| # | Decision | Reasoning |
|---|---|---|
| D1 | **Per-file error isolation** on `reconnect_exhausted` | One file's DialBackDocClient hits the 20-failure cap \u2192 log + close that WS + mark `disconnected` in `/health`. Other files unaffected. Recovery: next chokidar event on the file re-opens its WS. |
| D2 | **Runner-wide re-dial on 4410 `token_rotated`** | Shared-bearer semantics: any 4410 means the env var has rotated; runner re-reads env + force-reconnects all N WSs with the new value. Accept the fan-out storm on rotation. |
| D3 | **systemd restart is the v1 rotation mechanism** for `DOCS_RUNNER_SECRET` | Operator updates wrangler secret + VPS `.env` \u2192 `systemctl restart duraclaw-docs-runner@*` \u2192 runners re-dial. Documented in spec operational section. No hot-SIGHUP in v1. |
| D4 | **SIGTERM watchdog = 2s** (correcting spec B-RUNNER-6's erroneous 5s) | Match session-runner's `SIGTERM_GRACE_MS = 2_000` exactly. Sequence: abort pending writes \u2192 close WSs \u2192 exit within 2s. |

### E. Transport / shared-transport refactor

| # | Decision | Reasoning |
|---|---|---|
| E1 | **New `DialBackDocClient` subclass** in shared-transport | Overrides `onmessage` to skip JSON.parse, sets `binaryType = 'arraybuffer'`, hands raw `Uint8Array` to `onCommand`. Reconnect / close-code logic inherited unchanged. Rejects spec 0018's false "payload is opaque" framing. |
| E2 | BufferedChannel remains a constructor dep but can be a no-op stub for docs | Yjs's local Y.Doc is the buffer. Optional: refactor BufferedChannel to optional; defer to v2. |

### F. Auth

| # | Decision | Reasoning |
|---|---|---|
| F1 | **Dual-auth onConnect on RepoDocumentDO** (new code, not cloned) | Closest existing pattern: `UserSettingsDO.onConnect:162\u2013174`. **Not** a clone of SessionCollabDO (which has no onConnect \u2014 its cookie auth is upstream in server.ts). Cookie (Better Auth) OR `role=docs-runner&token=<bearer>` timing-safe-compared against `DOCS_RUNNER_SECRET`. |
| F2 | **No per-user API tokens in v1** (explicit non-goal, deferred to future B-AUTH-2) | Runner is trusted infra; one-tenant blast radius acceptable. |

### G. UI scope (v1 EXPANDED from spec's original non-goal)

| # | Decision | Reasoning |
|---|---|---|
| G1 | **Ship a real BlockNote editor** in orchestrator UI as part of v1 | Diverges from spec's stated non-goal. Justification: without a UI, nothing to dogfood; feature's value is invisible. Adds a new UI phase to the plan. |
| G2 | **New `/projects/:id/docs` route** with file tree + editor pane | VS-Code-shaped UX. Left: tracked `.md` files. Right: BlockNote editor. Clear home for docs separate from session chat. Promotes spec's "Browsing markdown via orchestrator UI" from non-goal to goal. |
| G3 | **Default BlockNote block palette** \u2014 headings, lists, code, quote, table | Round-trips cleanly to GFM. No custom schema. Matches spec "Standard GFM only" constraint. |
| G4 | **Full awareness UI** \u2014 named cursors + colour, runner shown as peer with identity `{kind: 'docs-runner', host, version}` | Multiplayer "wow" + reuses session-collab's awareness plumbing. |
| G5 | **Dogfooding target**: `planning/specs/` + `planning/research/` in THIS repo | Honest eat-our-dog-food + real stress test. Acceptable risk of self-pwning spec work if Yjs drops a character (the spike gate in I1 below catches the worst case first). |

### H. Fallback commitment

| # | Decision | Reasoning |
|---|---|---|
| H1 | **If BlockNote+Bun+jsdom spike fails**: commit to remark + manual Y.XmlFragment path (~3-4 days added) | Feature still ships. Spec Risks table already names this fallback; H1 locks it in. |
| H2 | Fallback schema explicitly minimal \u2014 just enough to round-trip the decided block palette (G3) | Avoids unbounded bridge work. Maps GFM primitives to Y.XmlElement directly. |

### I. Phase structure

| # | Decision | Reasoning |
|---|---|---|
| I1 | **P0 BlockNote spike FIRST**, in a throwaway branch, BEFORE any foundation work | Honour issue #27's "P2 spike FIRST". If RED, triggers H1 decision before any merged code. If GREEN, proceeds with confidence. ~4-6h effort, highest EV move in the plan. |
| I2 | **New P0 foundations phase** prepended to spec 0018 (shifts existing P1\u2192P2 etc) | Covers: (a) `projectMetadata` D1 table, (b) stable projectId minting (B1/B2), (c) PATCH `/api/projects/:id` for docsWorktreePath, (d) `DialBackDocClient` subclass (E1), (e) CLAUDE.md ProjectRegistry-drift fix, (f) port derivation for `CC_DOCS_RUNNER_PORT` (see J1). |
| I3 | **New phase for editor UI** \u2014 inserted after current P3 (multi-file lifecycle) as P4 | Delivers G1\u2013G5. Uses y-partyserver provider + BlockNote React editor. Awareness wired via existing `useSessionCollab` pattern. |
| I4 | **Health / systemd / tray** phase becomes P5 (was P4); **polish** becomes P6 (was P5) | Maintains existing P4/P5 content, just renumbered. |

### J. Operational

| # | Decision | Reasoning |
|---|---|---|
| J1 | **`CC_DOCS_RUNNER_PORT` worktree-derived** via `cksum(path) % 800`, range 9878\u201310677 | Consistent with orch/gateway/bridge pattern. Parallel worktrees don't collide on health-check port. Add to `scripts/verify/common.sh` and CLAUDE.md port table. |
| J2 | **All 6 verification-plan cases** in spec 0018 are v1 requirements | vp-round-trip, vp-offline-reconnect, vp-cold-start, vp-concurrent-offline, vp-runner-crash, vp-redeploy. Each implemented as a `scripts/verify/*.sh` runnable. |
| J3 | **Ship gate**: 2 axi-browsers + local docs-runner co-editing `planning/specs/0018.md` for 3 minutes with no data loss + file on disk matches | End-to-end proof: transport + CRDT merge + BlockNote bridge + file write-back + awareness all exercised. |

## Architectural bets (hard to reverse)

| Bet | Rollback cost if wrong |
|---|---|
| **Yjs / y-partyserver** as the CRDT + WS protocol | High \u2014 would require ripping out the entire sync layer. Mitigated: session-collab already in production on the same stack. |
| **BlockNote** as the block model | Medium \u2014 fallback (H1) is 3-4 days. Spike gate (I1) catches this cheaply. |
| **projectId = sha256(origin url)** | Medium \u2014 changing schemes migrates every DO's entity-ID binding. Once files are synced, renaming forces re-hydration. Locked by B1/B2. |
| **Permanent docs worktree pinned to `main`** | Low \u2014 this is just user discipline + a `projectMetadata.docsWorktreePath` field. Re-pointing doesn't lose CRDT data. |
| **Per-project (not per-machine) runner** | Medium \u2014 gateway control-plane shape assumes it. Changing would fold runners into a single daemon + rewrite spawn logic. |
| **V1 ships an editor UI** | High for scope creep, low for UX tech \u2014 react + BlockNote in an existing TanStack Start shell is additive work, not a rewrite. |

## Open risks

| Risk | Mitigation in the plan |
|---|---|
| BlockNote+Bun+jsdom unproven in this exact combo | **I1** \u2014 spike FIRST in throwaway branch, fail fast, fall back via H1 if needed. |
| `duraclaw-docs.yaml` authoring tax (users need to opt in) | Ship default template via `docs-runner init` subcommand; document in README. First-time UX: `git worktree add ../foo-docs main && docs-runner init`. |
| DO GC for long-lived `RepoDocumentDO` at scale (100+ files) | Tracked as cross-cutting debt (unchanged from spec open question \#1). Tombstone GC (C1) covers one axis but not cold-never-edited docs. Revisit when >500 docs observed. |
| Fan-out storm on bearer rotation (D2) | Acceptable for systemd-restart-only rotation. Bound = N files per project; small-double-digit in practice. |
| Editor UI dogfooding target is our own planning/ \u2014 self-pwning risk during dev | Covered by the spike gate (I1) + VP cases (J2). First week of editor use happens while parallel markdown writes are minimised. |
| Feature-branch session edits to `.md` landing via `git pull` on docs worktree mid-edit | vp-round-trip / E2E test case in spec's test plan. Yjs merges cleanly if the patch applies; if it doesn't, user-visible conflict surfaces via awareness. |

## Codebase findings (from P0 research)

- `SessionCollabDO` at `apps/orchestrator/src/agents/session-collab-do.ts:12` \u2014 extends YServer, `hibernate: true`, `y_state` BLOB with 2s/10s debounce. `onLoad`/`onSave` are cloneable; **`onConnect` is NOT** (cookie auth is upstream in `server.ts:54`).
- `UserSettingsDO.onConnect:162\u2013174` \u2014 closest existing dual-auth-shaped precedent for RepoDocumentDO.
- `DialBackClient` at `packages/shared-transport/src/dial-back-client.ts:185` hardcodes `JSON.parse(e.data)`. `binaryType` not set. Needs `DialBackDocClient` subclass (E1).
- Close codes: 4401/4410/4411 defined at `dial-back-client.ts:41\u201343`; spec's 4401/4410 claims verified. 4411 (`mode_transition`) also terminal.
- `ProjectRegistry` DO was deleted in `wrangler.toml:60\u201366` migration **v5**. CLAUDE.md is stale. All per-project metadata now in D1 (`apps/orchestrator/src/db/schema.ts`). No `projectMetadata` table exists \u2014 must be created in P0.
- Session-runner SIGTERM watchdog: `packages/session-runner/src/main.ts:35` = **2s**, not 5s.
- y-partyserver version: `^2.1.4` (`package.json:87`). `y-protocols` `^1.0.7`.
- Gateway spawn pattern: `packages/agent-gateway/src/handlers.ts:192` constructs 7-argv array; `POST /sessions/start` detaches via `spawn()`. Reuse verbatim for `/docs-runners/start`.
- `@blocknote/core` NOT installed. Adds to orchestrator + new `packages/docs-runner`.

## Non-goals (v1) \u2014 confirmed

- Git integration beyond normal user `git commit`/`git pull`. Runner never touches git.
- Per-user API tokens (deferred to B-AUTH-2).
- Binary / non-markdown file sync.
- Custom BlockNote blocks beyond GFM primitives.
- Conflict UI (CRDT eliminates, surface nothing).
- Multi-tenant / SaaS exposure.
- Hot bearer rotation via SIGHUP.
- DO GC for cold never-edited docs (tracked debt).

## What feeds P2 (spec-writing)

The revised spec 0018 must include:

1. **Corrections** to existing wording (auth-cloning claim, 2s watchdog, registry-entry wording).
2. **New B-behaviours**: multi-WS error isolation (D1); shared-bearer rotation semantics (D3); docs-runner-wide re-dial on 4410 (D2); grace-period tombstone with DO alarm (C1\u2013C2); `duraclaw-docs.yaml` config schema (C3); `DialBackDocClient` subclass contract (E1); UI-surface behaviours for G1\u2013G5.
3. **New phases**: P0 spike (I1); P0 foundations (I2); editor UI P4 (I3); renumbering of existing phases (I4).
4. **Revised Layout section**: new file tree including `apps/orchestrator/src/routes/projects/[id]/docs.tsx`, `apps/orchestrator/src/components/docs/*`, `packages/docs-runner/src/init.ts`, etc.
5. **Revised Risks table** with H1\u2013H2 fallback cost line-item.
6. **Revised Verification Plan**: all 6 VPs + the ship-gate integration test (J3) as a distinct "release gate."
