---
type: research
classification: alignment-review
status: draft
created: 2026-04-19
workflow: RE-4ed3-0419
reviews:
  - planning/specs/0008-yjs-blocknote-realtime-docs-sync.md  # "Research Findings (2026-04-10)"
related:
  - planning/specs/0015-unified-tray-packaging.md
  - planning/research/2026-04-18-ionic-mobile-and-electron-build-targets.md
  - planning/research/2026-04-10-unified-packaging-tray-app.md
supersedes_context:
  - planning/research/2026-04-19-doc-sync-research-alignment.md  # same-day draft on the wrong "doc sync" (tab/draft Yjs, not mdsync)
---

# mdsync Research — Alignment with Latest Code State

## Prompt

> "Review doc sync research and align with latest code state."
> Clarification: the **document sync engine** — local file watcher
> converting to Yjs "actors" — i.e. spec 0008's mdsync, not the
> per-session chat-draft Yjs work that shipped for tabs.

The research lives inline in `planning/specs/0008-yjs-blocknote-realtime-docs-sync.md`
under "Runtime Decision" and "Research Findings (2026-04-10)". No
standalone `planning/research/*mdsync*.md` file exists; the runtime
feasibility and Yjs-Node-client claims are baked into the spec itself.
This doc treats those sections as the research under review.

## TL;DR

1. **The spec is stale: it references files that do not exist in this
   monorepo.** Every "Existing Code to Reuse" row and every "Phase 7 /
   Delete …" target is under `apps/collab/`, `apps/web/`, or
   `packages/deploy/` — all baseplane-infra paths. Duraclaw's
   `apps/` only contains `orchestrator/`; `packages/` has no `deploy`,
   no `collab`, no `web`. Spec 0008 was written when duraclaw and
   baseplane shared a monorepo (or was written assuming baseplane's
   infrastructure). That assumption no longer holds.
2. **The closest in-repo analogue to `DocumentDO` is `SessionCollabDO`,
   but it is not a drop-in.** `SessionCollabDO` is a per-session
   `YServer` for chat drafts, keyed by `sessionId`. Spec 0008 wants a
   per-file YServer with a field-mode route
   `/api/collab/:entityType/:entityId/:fieldName/sync`. The orchestrator's
   WS routing only knows `/api/collab/:sessionId/ws` today. A new
   `RepoDocumentDO` (or a generalisation of `SessionCollabDO`) is a
   prerequisite the spec doesn't call out.
3. **Zero phases are implemented.** No `packages/mdsync` exists. None
   of the mdsync dependency set (`@blocknote/core`, `chokidar`,
   `gray-matter`, `simple-git` / `isomorphic-git`, `ws` standalone,
   `notify-rust`) is installed. `jsdom@^29.0.1` IS installed, but as a
   Vitest devDependency — not yet proven against BlockNote's global-DOM
   patch.
4. **The "Yjs Node client is ~50 lines" claim assumed DocumentDO's
   simplified framing (0x00/0x01 byte prefix).** Duraclaw's YServers
   use standard y-protocols via `y-partyserver`. Targeting a
   duraclaw-hosted room means `y-websocket`-compatible handshake + sync
   step 1 / step 2, not the simplified protocol. Still ~50 lines, but
   a different 50 lines.
5. **Spec 0015 (unified tray packaging) has moved ahead of spec 0008**
   on the packaging surface. Spec 0015 commits to a mdsync sidecar with
   a `/health` endpoint on port 9878, consumed by the Tauri tray. Spec
   0008's own §p6 "Tray UI (Tauri v2)" now conflicts with 0015's
   unified tray. The tray responsibility should move to 0015 and be
   removed from 0008.
6. **The p7 "Baseplane Deploy Server Integration" phase is orphaned**
   in the duraclaw repo — there is no deploy server to spawn mdsync
   from. That phase only makes sense in baseplane-infra.

## Section-by-section delta

### "Runtime Decision" (spec lines 101–131)

| Claim | Status (2026-04-19) |
|---|---|
| BlockNote's Yjs converters are DOM-free | **Still presumed true.** Not independently verified in this repo. |
| `blocksToMarkdown` / `markdownToBlocks` need `globalThis.document = JSDOM().window.document` | Untested in duraclaw. `jsdom@29.0.1` is installed as a devDep for Vitest, so the shim is trivially available in a test spike. A Bun-runtime PoC has not been attempted. |
| Recommendation: Bun, `bun build --compile` single binary | Consistent with the rest of the duraclaw stack (`packages/agent-gateway` and `packages/session-runner` are both Bun). No change. |
| BlockNote v0.42.3 specifics (line refs to `externalHTMLExporter.ts:54`, etc.) | **Pin drift risk.** The spec cites 0.42.3 source offsets; BlockNote has had releases since 2026-04-10. The jsdom-patch approach is likely still correct, but the line numbers are almost certainly stale. A PoC should re-verify against whatever version gets installed, not take the offsets on faith. |
| "Yjs Node.js client is trivial: ~50 lines using `ws` + `yjs` + `y-protocols` — all already installed" | **Half true.** `yjs` and `y-protocols` are installed in `apps/orchestrator`; `ws` (the standalone Node WS lib) is not. Neither lib is installed at the monorepo-root level or in a hypothetical `packages/mdsync`. The 50-line sketch also assumed baseplane DocumentDO's simplified protocol; duraclaw uses standard y-partyserver sync. |

### "Architecture" (spec lines 135–191)

- The ASCII diagram assumes the Yjs server is external ("collab worker,
  hocuspocus, or any"). That's still viable as a pattern. What has
  changed: duraclaw orchestrator is now itself a Yjs server (for
  `SessionCollabDO` per-session drafts and `UserSettingsDO` per-user
  tabs). Either:
  - **Route A — mdsync talks to baseplane** (external collab worker).
    The spec works as written; duraclaw isn't in the loop.
  - **Route B — mdsync talks to duraclaw orchestrator** (new
    `RepoDocumentDO`). Requires new DO class, new binding in
    `wrangler.toml`, new WS route. Not in scope of 0008 as currently
    written.
  - **Route C — mdsync runs a local Yjs server** (y-websocket Node
    process) and treats git as the hub. Lowest coupling, no platform
    dependency, but loses the "shared with browser BlockNote editor"
    benefit. The spec does not discuss this option.

  The spec needs a decision on A / B / C before any code moves.

### "Configuration" (spec lines 193–225)

- `yjs.ws_url: wss://dev.baseplane.ai/api/collab` is a concrete
  baseplane URL. If Route B (duraclaw-hosted) wins, the default would
  be something like `wss://duraclaw.workers.dev/api/collab/RepoDocument/…`.
- `organization_id` + `entity_type` + `field_name` are baseplane-isms.
  Duraclaw has no org-id concept; it has user-id from Better Auth. If
  Route B wins, these keys should become `user_id` / `repo_id` or be
  dropped.

### "Key Design Decisions" (§1–§7)

| # | Decision | Delta |
|---|---|---|
| 1 | md ↔ Blocks ↔ YXmlFragment, gray-matter for frontmatter | **No change needed.** Still sound. |
| 2 | Deterministic entity-ID from path | **Still sound**, but see §3 in "Architecture" — it only resolves to a URL once Route A/B/C is picked. |
| 3 | v1 content-hash gate, v2 block-level diff | **No change.** Hash gate should ship first; block diff is a future optimisation. |
| 4 | Write-back loop suppression via `suppressedPaths` TTL map | **No change.** Standard pattern. |
| 5 | Scribe mode writes git snapshots | **Gotcha the spec undersells:** only the *local* mdsync node can run git (clone, commit, push). Orchestrator (CF Workers) cannot. If Route B is picked, the "Yjs is the hub" mode requires at least one always-on mdsync node to act as scribe. Otherwise git history falls behind unboundedly while the web users edit. |
| 6 | Auth: service identity / long-lived API token | Baseplane-specific as written. For duraclaw, the equivalent is a Better Auth service token or the existing `CC_GATEWAY_SECRET` pattern. Undefined. |
| 7 | CRDT eliminates conflicts at doc level | **No change.** |

### "Inherited from Spec 0007" (B1–B12)

- Spec 0007 does not exist in `planning/specs/` in this repo. The
  "inherited" behaviours are referenced as verbatim imports from a
  document that is not here to import them. Every B1–B12 item needs
  to be either inlined into 0008 or traced back to where 0007 lives
  (likely baseplane's planning dir pre-split).
- `docs-sync.ts` in `packages/deploy/src/serve/` — referenced as the
  reference implementation — also not in this repo.

### "New Behaviors (Yjs Layer)" — B13–B17

- B13 (WS connection), B14 (file → Yjs push), B15 (Yjs → file write),
  B16 (scribe → git), B17 (fallback) are still the right behaviour
  list. None implemented.
- B16 scribe-quiescence detection is reasonable; 30s is fine as a
  default.
- B17 fallback semantics need a state machine (connecting / connected
  / degraded / git-only) that the spec hand-waves. In practice this is
  a few dozen lines but worth pinning down before implementation.

### "Existing Code to Reuse" table

All 7 rows are baseplane paths that don't exist here. A rewritten
table targeting duraclaw would read:

| Component | Location (duraclaw) | What it provides |
|---|---|---|
| `SessionCollabDO` (pattern) | `apps/orchestrator/src/agents/session-collab-do.ts` | YServer on DO SQLite — template to clone for `RepoDocumentDO` |
| `UserSettingsDO` (pattern) | `apps/orchestrator/src/agents/user-settings-do.ts` | YServer with `onLoad` → `seedFromD1` — template for seed/migrate flows |
| WS routing | `apps/orchestrator/src/server.ts` (the `/api/collab/` route) | Needs extension to `:entityType/:entityId/:fieldName/sync` |
| Better Auth | `@auth-session` helpers | Cookie-scoped auth (replacement for baseplane's header auth) |
| Yjs deps | orchestrator `package.json`: `yjs@13.6.30`, `y-protocols@1.0.7`, `y-partyserver@2.1.4` | Already installed |
| `jsdom@29.0.1` | orchestrator `devDependencies` | Available for PoC, not yet used for BlockNote |
| BlockNote | **Not installed** | Phase-1 add |

### "Resolved Questions" (research §1–§5)

| # | Research answer | Still resolved? |
|---|---|---|
| 1 | BlockNote headless viable with jsdom global patch | Not re-verified. Likely still true, but BlockNote has shipped releases since 2026-04-10 — re-verify on Phase 1. |
| 2 | gray-matter frontmatter strip/restore | Still fine. "Sync to entity fields" leg assumes baseplane entity system → scope question. |
| 3 | Binary files are a non-issue | Still fine. |
| 4 | Yjs Node client ~50 lines | **Assumption-dependent.** Simplified 0x00/0x01 protocol was DocumentDO-specific. Against duraclaw's YServer or standard y-websocket, client is still small but uses standard y-protocols framing. |
| 5 | Worktree-agnostic entity ID from relative path | Still fine. |

### "Remaining Open Questions" (research §1–§4)

| # | Question | Status |
|---|---|---|
| 1 | Initial hydration: bulk push vs lazy create? | Still open. Lazy-on-edit is clearly simpler for v1; no reason to front-load the thundering-herd question. |
| 2 | Entity lifecycle on file delete | Still open. Reference-counting across worktrees is a real problem; spec should pick a simple answer (e.g., "entity persists; scribe treats missing files as tombstones after grace period"). |
| 3 | Frontmatter conflict resolution | Moot until platform integration scope is decided. |
| 4 | DO GC strategy for 100+ long-lived RepoDocument DOs | Still open. Duraclaw has no DO-GC policy either — this applies equally to `SessionDO`, `SessionCollabDO`, `UserSettingsDO`. |

## Phase-by-phase status

| Phase | Title | Status |
|---|---|---|
| p1 | Headless BlockNote PoC + runtime decision | **Not started.** Deps not installed. |
| p2 | Core sync engine (config, hash store, watcher, git ops) | Not started. |
| p3 | CLI (init / watch / status / sync / resolve) | Not started. |
| p4 | Yjs real-time layer | Not started. |
| p5 | Baseplane platform integration | **Conditional on Route A.** If duraclaw-hosted (Route B) or local-y-websocket (Route C), this phase is replaced. |
| p6 | Tray UI (Tauri v2) | **Superseded by spec 0015.** The tray is now unified across cc-gateway + mdsync. Remove from 0008. |
| p7 | Baseplane deploy server integration | **Orphaned in duraclaw.** No deploy server here. Either park, or replace with "systemd unit on the duraclaw VPS" analogous to `duraclaw-agent-gateway.service`. |

## Spec 0015 coupling (new since 2026-04-10)

Spec 0015 "Unified Tray Packaging" (draft) was filed after spec 0008
and imposes external contracts on mdsync:

- **mdsync must bind to port 9878** (configurable via
  `duraclaw.yaml` → `mdsync.port`).
- **mdsync must expose `GET /health`** returning
  `{ status: "ok", syncing: number, errors: number }`.
- **mdsync must ship as a single `bun build --compile` binary** with
  the target-triple suffix, laid out in
  `apps/duraclaw-tray/src-tauri/binaries/`.
- **mdsync must be launchable via Tauri sidecar supervision** (no
  interactive TTY; logs to stdout).

None of these are in spec 0008. They need to be back-ported into B1
(config parsing) and the CLI surface in p3 as required behaviours
before 0015's p2 can ship.

## Recommended next actions (not research, just flagging)

1. **Route A/B/C decision.** The spec's biggest unknown is whether
   duraclaw hosts the Yjs server or continues to depend on baseplane
   for it. Every other open question downstream of this.
2. **Delete or rewrite spec 0008's "Existing Code to Reuse" table** so
   it points at in-repo paths and does not mislead a future
   implementer into searching for `apps/collab/`.
3. **Delete §p6 (Tray UI) from spec 0008.** Spec 0015 owns the tray.
4. **Replace §p7** with "mdsync systemd unit + /health + logging",
   mirroring the `duraclaw-agent-gateway.service` shape from
   `packages/agent-gateway/systemd/`. Or mark as N/A if the tray
   (0015) is the supervisor.
5. **Back-port 0015's port/health/binary layout** requirements into
   0008's B-level behaviour list.
6. **Spike Phase 1 (~1 day)** — install `@blocknote/core` and `ws` in a
   throwaway `packages/mdsync` scaffold, set up the jsdom global
   patch, prove the round-trip `md → Blocks → Y.Doc → Blocks → md` in
   Bun. This is the single highest-risk claim in the research and has
   been untouched for nine days.
7. **Write the spec inherited from 0007 back into 0008** (or import
   0007 into this repo), so B1–B12 are readable in-place.

## Open questions unique to the duraclaw context

1. Do we even want mdsync in this repo, or does it belong in a
   standalone sibling repo (`baseplane-ai/mdsync`) that duraclaw
   optionally installs as a sidecar? Spec 0015 says "second sidecar
   binary", which is agnostic to repo location.
2. If Route B (duraclaw-hosted Yjs server for docs), should `RepoDocumentDO`
   be **per-repo** (one DO owns all files in a repo) or **per-file**
   (one DO per markdown file)? The spec implicitly assumes per-file
   via `idFromName()`. Per-repo would reduce DO count by ~100× for a
   typical monorepo but complicates concurrent editing hot-spots.
3. How does mdsync authenticate to the duraclaw orchestrator? Reuse
   `CC_GATEWAY_SECRET` pattern, or a new `MDSYNC_SECRET`, or per-user
   Better Auth session cookie (clumsy for a headless daemon)?

## Sources

- `planning/specs/0008-yjs-blocknote-realtime-docs-sync.md` (spec under review)
- `planning/specs/0015-unified-tray-packaging.md` (newer external contract)
- `apps/orchestrator/package.json` (dep inventory)
- `apps/orchestrator/src/server.ts` (WS routing — `/api/collab/:sessionId/ws` only)
- `apps/orchestrator/src/agents/session-collab-do.ts` (YServer template)
- `apps/orchestrator/src/agents/user-settings-do.ts` (YServer + D1 seed pattern)
- Repo inventory: `apps/` = `orchestrator/` only; `packages/` = `agent-gateway`, `ai-elements`, `kata`, `session-runner`, `shared-transport`, `shared-types`
- Absent: `apps/collab/`, `apps/web/`, `packages/deploy/`, `packages/mdsync/`, spec 0007
