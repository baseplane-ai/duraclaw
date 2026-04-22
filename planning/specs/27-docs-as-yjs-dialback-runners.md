---
initiative: docs-sync
type: project
issue_type: feature
status: approved
priority: high
github_issue: 27
created: 2026-04-19
updated: 2026-04-20
supersedes: "0008-yjs-blocknote-realtime-docs-sync"
research:
  - planning/research/2026-04-19-mdsync-research-alignment.md
  - planning/research/2026-04-20-gh27-spec-0018-preflight.md
  - planning/research/2026-04-20-gh27-interview-summary.md
pre_phase_gate:
  id: p0-spike
  name: "BlockNote + Bun + jsdom feasibility spike (throwaway branch, no merge)"
  tasks:
    - "Branch `spike/gh27-blocknote-bun` from main; do NOT merge"
    - "Scaffold a minimal Bun project with @blocknote/core (latest, ~v0.48.x), @blocknote/server-util, jsdom, yjs"
    - "Write jsdom-bootstrap.ts: `globalThis.document = new JSDOM().window.document` + `globalThis.window = jsdomWindow` BEFORE any @blocknote import"
    - "Round-trip a real .md file: read → gray-matter.strip → markdownToBlocks → blocksToYXmlFragment → (apply to fresh Y.Doc) → yXmlFragmentToBlocks → blocksToMarkdown → gray-matter.stringify → diff vs original"
    - "Test the default GFM block palette only: headings, paragraphs, lists (ordered/unordered), code blocks, quotes, tables, inline code, links, bold/italic"
    - "Record result in a throwaway PoC doc: GREEN (works) / YELLOW (works with patches) / RED (broken, fallback required)"
  gate_decision:
    - "GREEN → proceed to P1 foundations with BlockNote path"
    - "YELLOW → document the patches in P3a notes; proceed with BlockNote"
    - "RED → activate fallback H1: remark + manual Y.XmlFragment bridge. Add ~3–4 days to P3a and revise the `blocknote-bridge.ts` task accordingly before starting"
  budget: "4–6h of spike effort. Decision before any code lands on main."
phases:
  - id: p1
    name: "Foundations (projectMetadata, DialBackDocClient, port derivation)"
    tasks:
      - "Create `projectMetadata` D1 table in apps/orchestrator/src/db/schema.ts: { projectId TEXT PK, projectName TEXT, originUrl TEXT?, docsWorktreePath TEXT?, tombstoneGraceDays INTEGER DEFAULT 7, createdAt TEXT, updatedAt TEXT }"
      - "Write the Drizzle migration + regenerate migration SQL"
      - "On project discovery (packages/agent-gateway/src/projects.ts): call `git remote get-url origin`; compute `projectId = sha256(originUrl).slice(0,16)`; if no origin, mint UUID and persist to `.duraclaw/project-id` at repo root"
      - "On project discovery, gateway calls `PATCH /api/projects/:projectId` against the orchestrator with `{ projectName, originUrl }` (NO docsWorktreePath — that's user-supplied via the modal). This creates the initial projectMetadata row in D1 so downstream DO lazy-spawn lookups (B12) always find a record. Bearer auth via DOCS_RUNNER_SECRET for this call. Idempotent — second discovery of the same projectId just updates `updatedAt`."
      - "Add `PATCH /api/projects/:projectId` handler in apps/orchestrator/src/api/index.ts that accepts partial `{ projectName?, originUrl?, docsWorktreePath?, tombstoneGraceDays? }` and UPSERTs projectMetadata (create-if-missing, partial-merge-if-present). `PATCH` is the only mutation verb; no separate POST. **Dual-auth** (mirrors B3 WS pattern): accept EITHER a valid Better Auth session cookie (browser UI from B19 modal) OR `Authorization: Bearer <DOCS_RUNNER_SECRET>` (gateway at project-discovery time). Reject both-absent with 401."
      - "Add `GET /api/projects/:projectId` returning projectMetadata"
      - "Create `DialBackDocClient` in packages/shared-transport/src/dial-back-doc-client.ts — extends DialBackClient, sets `binaryType = 'arraybuffer'`, overrides `onmessage` to hand raw `Uint8Array` to `onCommand` (no JSON.parse). Add `send(update: Uint8Array)` that forwards via the existing send path with binary framing"
      - "Export DialBackDocClient from packages/shared-transport/src/index.ts"
      - "Add `CC_DOCS_RUNNER_PORT` to scripts/verify/common.sh worktree-derivation: `DOCS_RUNNER_PORT=$((9878 + cksum_offset))` within range 9878–10677"
      - "Update CLAUDE.md: remove the 'ProjectRegistry (singleton, worktree locks + session index)' bullet (DO was dropped in migration v5); add projectMetadata + CC_DOCS_RUNNER_PORT entries to the port table"
    test_cases:
      - "`pnpm --filter orchestrator test` passes with new schema + PATCH endpoint coverage"
      - "`pnpm --filter @duraclaw/shared-transport test` passes with a DialBackDocClient binary-frame roundtrip test"
      - "Fresh worktree: `scripts/verify/dev-up.sh` derives a unique CC_DOCS_RUNNER_PORT that doesn't collide with peer worktrees"
      - "curl `PATCH /api/projects/:projectId -d '{\"docsWorktreePath\":\"/tmp/foo-docs\"}'` persists + `GET` returns the same"
  - id: p2
    name: "RepoDocumentDO + WS routing + dual auth (orchestrator)"
    tasks:
      - "Create apps/orchestrator/src/agents/repo-document-do.ts — class RepoDocumentDO extends YServer with `static options = { hibernate: true }`"
      - "Clone SessionCollabDO's y_state BLOB schema (id PK, data BLOB, updated_at) + onLoad/onSave hooks with debounceWait=2000, debounceMaxWait=10000, timeout=5000 — effective max staleness is 5s"
      - "Add DO state: `{ tombstoneAt: number | null, projectId: string, relPath: string }` persisted via DO alarm API"
      - "Implement onConnect override for dual-auth (NEW code — NOT cloned from SessionCollabDO): (a) cookie path via Better Auth session, (b) bearer path if `role=docs-runner` query param present, compare `token` timing-safe against `env.DOCS_RUNNER_SECRET`, (c) else close 4401. Pattern reference: UserSettingsDO.onConnect:162–174"
      - "Implement `onRequest(request)` for HTTP control messages: `POST /tombstone` (starts 7d grace timer), `POST /cancel-tombstone` (runner saw the file reappear), `GET /tombstone-status`"
      - "Schedule tombstone alarm via `ctx.storage.setAlarm(tombstoneAt)`; `alarm()` handler performs hard-delete of y_state and closes all peers with close code 4412 `document_deleted`"
      - "Wire DO binding REPO_DOCUMENT in apps/orchestrator/wrangler.toml + new migration tag `v6` with `new_sqlite_classes = ['RepoDocumentDO']`"
      - "Extend apps/orchestrator/src/server.ts WS routing: handler at `/api/collab/repo-document/:entityId/ws` and `/parties/repo-document/:entityId`, extracting entityId, delegating to RepoDocumentDO stub via `env.REPO_DOCUMENT.idFromName(entityId)`"
      - "Export RepoDocumentDO from apps/orchestrator/src/server.ts DO registry"
      - "Add `DOCS_RUNNER_SECRET` as a wrangler secret (and to apps/orchestrator/.dev.vars.example). scripts/verify/dev-up.sh regenerates .dev.vars with it from .env"
      - "Add close code 4412 `document_deleted` to packages/shared-transport/src/dial-back-client.ts terminal-code list; wire onTerminate reason"
    test_cases:
      - "wscat as cookie-authed browser peer round-trips a Yjs update through sync step 1/2"
      - "wscat with `?role=docs-runner&token=<bearer>` is accepted with matching DOCS_RUNNER_SECRET; wrong bearer → 4401"
      - "DO hibernates after last client disconnects; reconnecting a new peer restores the Y.Doc from y_state BLOB"
      - "POST /tombstone → `GET /tombstone-status` returns the alarm timestamp; waiting past the alarm closes peers with 4412"
  - id: p3a
    name: "docs-runner package + bridge + single-file dial-back (runner-side only)"
    tasks:
      - "Scaffold packages/docs-runner (Bun runtime, tsup build config, `bun build --compile` target)"
      - "Add deps: yjs, y-protocols, ws, jsdom, @blocknote/core, @blocknote/server-util, gray-matter, chokidar; workspace deps @duraclaw/shared-transport, @duraclaw/shared-types"
      - "Write packages/docs-runner/src/jsdom-bootstrap.ts — MUST be imported before @blocknote/core anywhere"
      - "Write packages/docs-runner/src/blocknote-bridge.ts: md↔YXmlFragment round-trip using the pattern validated by the P0 spike. If P0 was RED, swap BlockNote for remark + manual Y.XmlElement construction"
      - "Write packages/docs-runner/src/reconcile.ts: implements the B7 runner-startup reconciliation rule (Case A/B/C). Called after each DialBackDocClient completes sync step 1/2. Logs `reconciliation_merge` WARN when Case C fires."
      - "Write packages/docs-runner/src/content-hash.ts: SHA-256 per file, persisted to `{docsWorktreePath}/.duraclaw-docs/hashes.json`"
      - "Write packages/docs-runner/src/writer.ts: atomic fs.writeFile (via temp + rename) + `suppressedPaths: Map<string, number>` with 2000ms TTL for write-back loop suppression"
      - "Write packages/docs-runner/src/watcher.ts: chokidar watcher on a single file with debounce + content-hash gate"
      - "Write packages/docs-runner/src/main.ts: argv = `docs-runner <projectId> <cmdFile> <pidFile> <exitFile> <metaFile>`. Reads cmdFile JSON: `{ docsWorktreePath, orchestratorUrl, bearer, configPath }`. Opens ONE DialBackDocClient for a single tracked file. Dump meta every 10s (last_activity_ts, syncing, errors)"
      - "SIGTERM handler with **2s watchdog** (mirrors session-runner): abort pending writes → close WS → exit within 2s"
      - "Write packages/docs-runner/src/health-server.ts: minimal Bun HTTP server on `CC_DOCS_RUNNER_PORT` exposing `GET /health` per B14 schema (status/version/uptime/files/syncing/disconnected/tombstoned/errors/reconnects/per_file). This lands in P3a (not P6) so downstream P5a `DocsFileTree` state polling has a real data source from day one. P6 later adds systemd + tray consumer; the endpoint itself ships here."
    test_cases:
      - "Manual-launch: hand-craft a cmd file, `bun run src/main.ts` against a local RepoDocumentDO → dial-back succeeds, sync step 1/2 completes"
      - "`curl :$CC_DOCS_RUNNER_PORT/health | jq` returns valid JSON with `status:'ok'` + `syncing:1` after the single tracked file connects"
      - "Edit file on disk → DO Y.Doc content matches after ≤2s debounce"
      - "Inject Y.Doc update via wscat browser peer → file on disk matches"
      - "Edit + save + edit-back + save rapidly → only one round-trip to the DO (content-hash gate)"
      - "Write-back from DO update does NOT trigger re-push (suppressedPaths map works)"
      - "`kill -TERM <pid>` → runner exits within 2s, no partial file on disk"
  - id: p3b
    name: "Gateway `/docs-runners/start` + reaper + DO lazy-spawn trigger"
    tasks:
      - "Add `POST /docs-runners/start` handler in packages/agent-gateway/src/handlers.ts: accept `{ projectId, docsWorktreePath, bearer }` IN THE BODY (gateway is VPS-local and has NO direct D1 access — DO is the caller and reads projectMetadata itself before POSTing). Validate docsWorktreePath exists as a directory and passes PROJECT_PATTERNS/WORKTREE_PATTERNS filters; on failure return 400 with `{ error: 'docs_worktree_invalid' }`. On success, write cmd file to `/run/duraclaw/docs-runners/{projectId}.cmd`, spawn detached with the 5-argv contract. Return 202 Accepted with pidFile path. Enforce idempotency: if a live PID exists for projectId, return 200 `{ already_running: true, pid }` without re-spawning."
      - "Add `GET /docs-runners` and `GET /docs-runners/:projectId/status` endpoints — list / status parallel to session ones"
      - "Add `GET /docs-runners/:projectId/files` endpoint: gateway reads projectMetadata.docsWorktreePath from a local cache it populates from the DO on request (or from a small on-disk `$SESSIONS_DIR/projects.json` keyed by projectId). Gateway walks `docsWorktreePath` applying watch/exclude globs from `duraclaw-docs.yaml`; returns `[{ relPath, state, lastModified }]`. `state` is joined from the live runner's in-memory per-file map if a runner is connected via `GET :CC_DOCS_RUNNER_PORT/health` (localhost loopback); else defaults to `'unknown'`. The walk works even if the runner is dead — gateway always has fs access. This is the upstream data source proxied by the orchestrator's `GET /api/projects/:projectId/docs-files` in P5a."
      - "Add docs-runner entries to agent-gateway reaper: idle >30min → SIGTERM → 10s grace → SIGKILL; orphan .cmd files >5min unlinked"
      - "Trigger spawn from RepoDocumentDO.onConnect: when a browser peer connects and no docs-runner peer is present for this projectId after a 2s grace window, the DO reads projectMetadata from D1. If `docsWorktreePath` is null → skip spawn, emit awareness hint `{ kind: 'setup-required' }` so the browser UI surfaces the DocsWorktreeSetup modal (B19). If set → DO POSTs `{ projectId, docsWorktreePath, bearer: env.DOCS_RUNNER_SECRET }` to gateway `/docs-runners/start`. If gateway returns 400 `docs_worktree_invalid`, DO clears `docsWorktreePath` in projectMetadata and emits `setup-required` (modal re-prompts)."
    test_cases:
      - "`curl -X POST gateway/docs-runners/start -d '{…}'` → runner spawned detached → dials back → DO accepts"
      - "Second POST for same projectId (runner still alive) → 200 `already_running: true`, no second PID"
      - "Path fails filter → 400 `docs_worktree_invalid`; no process started"
      - "Browser opens a doc with no runner live + `docsWorktreePath` set → lazy-spawn fires; runner joins awareness within ≤5s"
      - "Browser opens a doc with `docsWorktreePath = null` → DO emits `setup-required`; gateway log is silent; no runner spawned"
      - "Runner idle >30min → reaper SIGTERMs; `GET /docs-runners/:projectId/status` reports dead"
  - id: p4
    name: "Multi-file discovery, lifecycle, per-file error isolation"
    tasks:
      - "Add packages/docs-runner/src/config.ts: parse `{docsWorktreePath}/duraclaw-docs.yaml` with fields `{ watch: string[], exclude: string[], tombstone_grace_days: number }`. Default template: `watch: ['**/*.md']`, `exclude: ['node_modules/**', '.git/**', 'dist/**', 'build/**']`, `tombstone_grace_days: 7`"
      - "Add `docs-runner init` subcommand that writes a default `duraclaw-docs.yaml` + bootstraps the docs worktree if missing (`git worktree add $PATH main`)"
      - "On startup: enumerate files matching watch/exclude globs; open one DialBackDocClient per file; concurrency-cap at 8 parallel connects (configurable via DOCS_RUNNER_CONNECT_CONCURRENCY env var)"
      - "Chokidar live discovery: add (new .md matching globs → open new DialBackDocClient), unlink (file deleted → runner POSTs `/tombstone` to its DO + closes the WS)"
      - "Per-file error isolation on `reconnect_exhausted` from DialBackDocClient.onTerminate: log, close that one WS, mark file `disconnected` in health state, DO NOT propagate to other files. Next chokidar event on that file re-opens the connection"
      - "On `token_rotated` (4410) from any WS: re-read DOCS_RUNNER_SECRET from env, force-reconnect ALL WSs with the new bearer (shared-bearer rotation semantics)"
      - "Reap hash-store + connection-state on process exit"
      - "Update health endpoint state to include per-file status: `{ path, state: 'syncing'|'disconnected'|'tombstoned', last_sync_ts, error_count }[]`"
    test_cases:
      - "`touch new-file.md` while runner is live → runner opens a new DialBackDocClient and syncs within ≤3s"
      - "`rm tracked-file.md` → runner POSTs /tombstone to DO + closes WS; DO enters tombstone state"
      - "100 tracked files: runner stabilises under 200MB memory, all 100 WSs connected"
      - "Simulate 20 reconnect failures for one file → that file's WS terminates; other 99 files stay connected (per-file isolation holds)"
      - "Simulate 4410 on one WS → all N runner WSs re-dial with the new bearer"
  - id: p5a
    name: "Editor UI baseline — route + file tree + BlockNote editor"
    tasks:
      - "Add @blocknote/react, @blocknote/mantine (or @blocknote/shadcn if available), y-partyserver/react to apps/orchestrator deps"
      - "New route apps/orchestrator/src/routes/projects/$projectId/docs.tsx — TanStack Start file-based route"
      - "Add `GET /api/projects/:projectId/docs-files` handler in orchestrator that proxies to gateway `GET /docs-runners/:projectId/files` (the gateway endpoint added in P3b). Orchestrator is a CF Worker with no filesystem access — proxying to the gateway is the ONLY path. If the gateway responds 502 or the runner is absent, the gateway does the directory walk itself (it's VPS-local and always has fs access, independent of whether a runner is live for that projectId). If the gateway itself is unreachable, return `503 gateway_unavailable`; UI renders a retry chip, NOT an empty state."
      - "Add apps/orchestrator/src/components/docs/DocsFileTree.tsx: renders `[{ relPath, state, lastModified }]` as a left-pane tree, click to select"
      - "Add apps/orchestrator/src/components/docs/DocsEditor.tsx: right-pane BlockNote editor with YPartyKitProvider wired to `/parties/repo-document/:entityId`. Uses Better Auth cookie for auth (NOT the docs-runner bearer). Computes entityId client-side via `sha256(projectId + ':' + relPath).slice(0,16)`"
      - "Block palette restricted to default GFM blocks: headings (h1-h3), paragraph, bulleted/ordered list, code block, inline code, quote, table, link, bold, italic. Configure via BlockNote's `blockSpecs` / `schema` API to exclude custom blocks"
      - "Navigation: add a 'Docs' entry to the main project navigation component"
    test_cases:
      - "Log in → visit `/projects/<projectId>/docs` → file tree lists matching .md files under docsWorktreePath"
      - "Click a file → BlockNote editor loads content from the DO (sync step 1/2 via y-partyserver)"
      - "Type in the editor → file on disk updates within ≤2s (via docs-runner)"
      - "Two browsers on the same file → edits propagate live between them"
  - id: p5b
    name: "Editor UI polish — awareness, first-run modal, per-file indicators"
    tasks:
      - "Wire awareness: BlockNote's collaborative cursor extension + `awareness.setLocalStateField('user', { name, color })` from the logged-in Better Auth session. Filter out peers where `awareness.user.kind === 'docs-runner'` from the cursor overlay BUT show them in a 'Connected peers' chip row (with hostname)"
      - "Add apps/orchestrator/src/components/docs/DocsWorktreeSetup.tsx: first-run modal prompting user to configure docsWorktreePath if projectMetadata.docsWorktreePath is null. Also triggered when the DO emits `{ kind: 'setup-required' }` awareness from B12. Instructions + copyable `git worktree add ../<name>-docs main` shell snippet + form field to PATCH /api/projects/:projectId"
      - "Add state indicators: per-file connection status (syncing / disconnected / tombstoned) in the file tree via `GET /api/docs-runners/:projectId/health` (orchestrator endpoint that proxies to gateway's `GET /docs-runners/:projectId/health`, which in turn calls the runner's `/health` endpoint shipped in P3a)"
      - "Listen for custom awareness records `{ kind: 'tombstone-pending' | 'tombstone-cancelled' | 'setup-required' }` from B10/B12; update UI accordingly (strikethrough row, modal open, warning chip)"
      - "Add a 'Create docs config' nudge banner in the docs route that surfaces when `GET /api/docs-runners/:projectId/health` reports the runner has logged `config_missing` (health endpoint includes a `config_present: boolean` field for this). Banner CTA copies a `docs-runner init` shell snippet. Dismissible per-session via localStorage."
    test_cases:
      - "Two browsers + runner editing same file → each browser sees the other's cursor + own avatar; docs-runner appears in chip row with hostname"
      - "Kill the docs-runner mid-edit → file row flips to grey (disconnected) within 5s; browser keeps editing against the DO"
      - "Restart docs-runner → file row flips back to green; disk reconciles (B7 Case C) with no lost edits"
      - "Fresh project (no docsWorktreePath) → visit /docs → DocsWorktreeSetup modal appears; PATCH submits → modal dismisses"
      - "Delete tracked file on disk → row shows tombstone-pending with strikethrough; `touch` file back before 7d → state resumes"
  - id: p6
    name: "systemd + tray integration (spec 0015 contract) — health endpoint ships in P3a"
    tasks:
      - "Harden health-server status logic: implement the ok/degraded/down threshold tree from B14; add `X-Docs-Runner-Version` header for tray probe identification"
      - "Add packages/docs-runner/systemd/duraclaw-docs-runner@.service (systemd template unit, %i = projectId) — cloning agent-gateway's KillMode=process + SendSIGKILL=no + RuntimeDirectoryPreserve=yes flags"
      - "Write packages/docs-runner/systemd/install.sh mirroring the agent-gateway installer"
      - "Verify spec 0015's tray picks up the sidecar under externalBin (bun-compile output) and can stop/restart per projectId"
    test_cases:
      - "`curl :<CC_DOCS_RUNNER_PORT>/health | jq` returns ok with `syncing >= 1` after files are discovered"
      - "`systemctl restart duraclaw-docs-runner@<projectId>` → all WSs reconnect within the [1,3,9,27,30] backoff envelope; no data loss"
      - "Tray (spec 0015 p2) shows docs-runner per project with health indicator"
  - id: p7
    name: "Frontmatter + awareness identity + polish"
    tasks:
      - "Extend blocknote-bridge: frontmatter → Y.Map('meta'). gray-matter.strip before markdownToBlocks; restore via gray-matter.stringify on write"
      - "Publish runner identity on provider.awareness: `{ kind: 'docs-runner', host: os.hostname(), version: pkg.version, projectId }`"
      - "Structured logging: JSON-lines to stdout (systemd-friendly), fields `{ ts, level, event, file?, sessionId?, err? }`"
      - "Metrics counters: syncs_ok, syncs_err, reconnects, tombstones_started, tombstones_cancelled"
      - "Graceful shutdown hardening: SIGTERM → stop chokidar → flush pending writes → close WSs → exit within the 2s watchdog"
      - "Add ship-gate verification script scripts/verify/gh27-ship-gate.sh: two axi-browsers + local docs-runner co-edit planning/specs/0018.md for 3min + assert final file content matches browser DOM + zero data loss (hash before = hash after modulo expected changes)"
    test_cases:
      - "Change frontmatter via browser → YAML at top of file updates on disk"
      - "Runner shows in browser awareness chip with `{ kind, host, version }` fields"
      - "`kill -TERM <runner-pid>` under load → all in-flight writes flush before exit (no partial files)"
      - "`scripts/verify/gh27-ship-gate.sh` passes — THIS IS THE v1 RELEASE GATE"
verification_plan:
  - id: vp-round-trip
    script: scripts/verify/gh27-vp-round-trip.sh
    description: "Edit in browser BlockNote → file on disk updates; edit in vim → browser updates"
  - id: vp-offline-reconnect
    script: scripts/verify/gh27-vp-offline-reconnect.sh
    description: "Kill orchestrator mid-edit; runner buffers via local Y.Doc, reconnects on redeploy, CRDT-merges cleanly"
  - id: vp-cold-start
    script: scripts/verify/gh27-vp-cold-start.sh
    description: "Fresh runner startup with existing files → content-hash prevents churn; new files seed the DO"
  - id: vp-concurrent-offline
    script: scripts/verify/gh27-vp-concurrent-offline.sh
    description: "Browser (open tab, cached Y.Doc) and the local docs-runner both accept edits while the orchestrator is unreachable (simulated redeploy / network partition). On reconnect, both peers exchange sync step 1/2 with the DO and CRDT-merge cleanly — no lost edits, no duplicated lines. (Two concurrent runners on the same projectId is architecturally precluded by the gateway's one-runner-per-projectId PID guard, so that variant is not tested here.)"
  - id: vp-runner-crash
    script: scripts/verify/gh27-vp-runner-crash.sh
    description: "kill -9 the runner while browser actively edits, THEN vim-edit the same file on disk before restarting the runner → on runner restart, B7 Case C fires; merged result contains BOTH the browser's block (added after runner death) AND the disk's block (added before runner startup), in Yjs insertion-order. Concrete test: browser adds paragraph P_browser at line 5; disk adds paragraph P_disk at line 5; post-merge file contains BOTH P_browser and P_disk (one of them at line 5, the other at line 6 — specific order decided by Yjs client ID clock; the test asserts both strings are present in the final file, not their exact order)."
  - id: vp-redeploy
    script: scripts/verify/gh27-vp-redeploy.sh
    description: "Orchestrator redeploy — runners reconnect with [1s,3s,9s,27s,30s×] backoff, no manual intervention"
  - id: vp-ship-gate
    script: scripts/verify/gh27-ship-gate.sh
    description: "Release gate — two axi-browsers + local docs-runner co-edit planning/specs/0018.md for 3 minutes; assert no data loss, converged content, file matches"
---

# Docs as Yjs Participants via Dial-Back Runners

> **Supersedes** spec 0008 (mdsync). Route B decision (duraclaw-hosted
> Yjs) locked by `planning/research/2026-04-19-mdsync-research-alignment.md`.
> **Pre-flight codebase audit** (`planning/research/2026-04-20-gh27-spec-0018-preflight.md`)
> corrected four load-bearing claims in the original draft; this spec
> incorporates those fixes. **Interview** (`planning/research/2026-04-20-gh27-interview-summary.md`)
> locked 26 open decisions; they appear here as B-behaviours.

## Overview

Every tracked markdown file in a project becomes a Yjs room on a new
`RepoDocumentDO`. A local per-project daemon — **`docs-runner`** —
watches the file system, round-trips between markdown on disk and
Y.Docs in memory, and dials back to the orchestrator over WebSockets
in the same shape `session-runner` already does for Claude Agent SDK
sessions. A new `/projects/:projectId/docs` route in the orchestrator
UI hosts a BlockNote editor that is also a live Yjs peer.

The result: `vim`, `code`, agent sessions, and multi-browser users
all see each other's markdown edits in real time, with CRDT merge
semantics and no manual sync UI.

**Root decision — permanent docs worktree.** Every duraclaw-managed
project gets a dedicated `git worktree` pinned to `main`
(conventionally `foo-docs/` sibling to `foo/`). The docs-runner
watches only this worktree. CRDTs live in one canonical place per
project and never move with feature branches — eliminates per-branch
DO keying, `.git/HEAD` machinery, and branch-switch view-yank in one
stroke. Feature-branch worktrees can still edit `.md` via normal
filesystem tools; those edits merge through git on the user's cadence,
and the docs-runner picks them up when they land on `main`.

## Architectural parallel

```
╔══════════════════════════ sessions (shipped, #1) ══════════════════════╗
║ agent-gateway       session-runner (N)        SessionDO       Browser  ║
║     │                    │                       ▲              ▲     ║
║     │ POST /sessions/    │ dial-back WS          │              │     ║
║     │  start             │                       │              │     ║
║     ├───────────────────►│ role=gateway, token  │              │     ║
║     │                    │   GatewayEvent JSON   │──broadcast──┤     ║
║     │                    │                       │              │     ║
╚════════════════════════════════════════════════════════════════════════╝

╔══════════════════════════ docs (this spec) ════════════════════════════╗
║ agent-gateway      docs-runner (1 per project) RepoDocumentDO  Browser ║
║     │              │─ N DialBackDocClients       (1 per file)    ▲    ║
║     │ POST /docs-  │  one per .md file             ▲             │    ║
║     │  runners/    │◄──y-protocols sync(binary)───►│◄── y-party ─┤    ║
║     │  start       │      bearer auth              │   cookie    │    ║
║     ├─────────────►│                               │             │    ║
║     │              │  chokidar + md↔BlockNote↔Y.Doc               │    ║
╚════════════════════════════════════════════════════════════════════════╝
```

**Key correspondences (from P0 audit):**

| Sessions (actual) | Docs (this spec) |
|---|---|
| `SessionDO` (one per session) | `RepoDocumentDO` (one per file) |
| `session-runner` binary (one per session) | `docs-runner` binary (one per project, N WSs) |
| `agent-gateway` `POST /sessions/start` | `agent-gateway` `POST /docs-runners/start` (NEW) |
| `DialBackClient` + `BufferedChannel` (JSON) | `DialBackDocClient` (NEW subclass) — binary y-protocols frames, no BufferedChannel |
| Per-session `active_callback_token` rotation | Shared `DOCS_RUNNER_SECRET` (v1) — no rotation in v1, systemd restart is the procedure |
| Reconnect backoff `[1s,3s,9s,27s,30s×]`, 10s stable reset, 20-fail cap | Same (inherited from DialBackClient) |
| Close codes 4401/4410/4411 | Same + NEW 4412 `document_deleted` |
| SIGTERM 2s watchdog | Same 2s watchdog (spec 0018's original "5s" was a factual error) |

## Feature Behaviors

### B1: `RepoDocumentDO` as YServer

**Core:**
- **ID:** repo-document-do-yserver
- **Trigger:** Any peer (browser or docs-runner) upgrades to WS at `/api/collab/repo-document/:entityId/ws` or `/parties/repo-document/:entityId`.
- **Expected:** DO extends `YServer` with `static options = { hibernate: true }`; accepts y-protocols sync step 1/2 + awareness frames; persists state to `y_state` BLOB debounced 2s / max 10s / hard-flush 5s (effective max staleness is 5s).
- **Verify:** wscat round-trip through sync 1/2 as a browser peer; disconnect all peers; reconnect fresh; receive full y_state back.
- **Source:** apps/orchestrator/src/agents/repo-document-do.ts (new file); clones `session-collab-do.ts:12–55` for state shape.

**Data Layer:**
- New wrangler migration `v6`: `new_sqlite_classes = ["RepoDocumentDO"]`
- `y_state` table identical to SessionCollabDO's (id PK, data BLOB, updated_at INTEGER)
- New state columns for tombstone: `tombstoneAt INTEGER NULL`, `projectId TEXT`, `relPath TEXT`

### B2: Entity-ID derivation with stable projectId

**Core:**
- **ID:** entity-id-derivation
- **Trigger:** Any peer addresses a specific file.
- **Expected:** `entityId = sha256(projectId + ':' + relPath).slice(0, 16)`, where `projectId = sha256(git remote get-url origin).slice(0,16)` at project discovery time (persisted to `projectMetadata.projectId` in D1). For repos without a remote, a UUID is minted at first discovery and persisted to `{projectRoot}/.duraclaw/project-id`.
- **Initial projectMetadata row creation:** Gateway PATCHes `/api/projects/:projectId { projectName, originUrl }` at project discovery time (on the gateway's first scan of a matching repo). The DO's B12 lazy-spawn code therefore ALWAYS finds a row on read — if it doesn't, that's a gateway bug, not a race, and the DO returns `setup-required` as a safe default.
- **Verify:** Two clones of the same remote repo compute identical entityIds for the same file. Rename the working directory (`mv foo foo2`) → projectId unchanged. Fresh clone: `ls` the gateway log → shows one PATCH per discovered project on startup; `GET /api/projects/:projectId` returns the row before any user interaction.
- **Source:** Hashing logic in a shared workspace helper `packages/shared-types/src/entity-id.ts` (new) so the browser bundle (P5a DocsEditor), the orchestrator Worker (DO routing), and the docs-runner (Bun runtime) all compute IDs identically from the same code. Uses `crypto.subtle.digest('SHA-256', …)` (WebCrypto — available in all three runtimes). Project-id derivation + initial PATCH in `packages/agent-gateway/src/projects.ts`. The route param `:projectId` IS the 16-char SHA-based ID (not a human-readable slug).

**Data Layer:**
- New D1 table `projectMetadata`: `{ projectId TEXT PK, projectName TEXT, originUrl TEXT NULL, docsWorktreePath TEXT NULL, tombstoneGraceDays INTEGER NOT NULL DEFAULT 7, createdAt TEXT, updatedAt TEXT }`

### B3: Dual-auth onConnect (NEW code, not cloned)

**Core:**
- **ID:** repo-document-do-dual-auth
- **Trigger:** Peer opens WS to the DO route.
- **Expected:** DO's `onConnect(conn, ctx)` override:
  1. If a Better Auth session cookie is present and valid → accept (browser peer).
  2. Else if `role=docs-runner` query param is present AND `token` timing-safe-equals `env.DOCS_RUNNER_SECRET` → accept (runner peer), tag conn with `{ kind: 'docs-runner' }`.
  3. Else close 4401.
- **Verify:** wscat with valid cookie → accepted. wscat with `?role=docs-runner&token=<correct>` → accepted. wscat with wrong bearer → 4401.
- **Source:** This is NEW code. SessionCollabDO has no onConnect — its cookie auth is upstream in `apps/orchestrator/src/server.ts:54–57`. Closest existing pattern: `UserSettingsDO.onConnect:162–174`.

**API Layer:**
- WS route `GET /api/collab/repo-document/:entityId/ws?role=docs-runner&token=<bearer>`
- Partykit alias `GET /parties/repo-document/:entityId?role=docs-runner&token=<bearer>`
- Both accept cookie without query params for browser peers.

### B4: Shared-bearer auth, no rotation in v1

**Core:**
- **ID:** shared-bearer-auth
- **Trigger:** docs-runner reads `DOCS_RUNNER_SECRET` at process start.
- **Expected:** Same bearer used for every DialBackDocClient. Orchestrator holds the matching secret as a wrangler secret; timing-safe compared on every WS connect. **No hot rotation.** Rotation procedure: operator updates wrangler secret + VPS `.env` → `systemctl restart duraclaw-docs-runner@*` → runners reconnect with new bearer.
- **Verify:** Change `DOCS_RUNNER_SECRET` in .env + wrangler → systemctl restart the units → all WSs reconnect within one backoff cycle.
- **Source:** packages/docs-runner/src/main.ts env read; close-code 4410 handling in packages/docs-runner/src/dial-back-doc-client-pool.ts.

### B5: Runner-wide re-dial on 4410

**Core:**
- **ID:** token-rotated-runner-wide
- **Trigger:** Any DialBackDocClient in the pool receives close code 4410 `token_rotated` from the DO.
- **Expected:** Runner re-reads `DOCS_RUNNER_SECRET` from env and force-reconnects ALL N WSs with the new bearer. Fan-out storm is accepted (bound N = file count per project, typically small-double-digit). **v1 rationale (pairs with B4):** 4410 does fire in v1 — during the transient window between the orchestrator receiving the new `DOCS_RUNNER_SECRET` wrangler secret (post-deploy) and the systemd restart landing the new value in the runner's env. For this ~60s window, old-bearer connections get 4410 on reconnect attempts. B5 handles that by re-reading env after systemd restart completes. This is NOT dead code in v1.
- **Verify:** Simulate 4410 on one WS by rotating the DO's expected secret mid-run → all runner WSs re-dial with the new value.
- **Source:** packages/docs-runner/src/dial-back-doc-client-pool.ts `onTerminate` handler (new file).

### B6: Per-file error isolation on `reconnect_exhausted`

**Core:**
- **ID:** per-file-error-isolation
- **Trigger:** One DialBackDocClient in the pool terminates with reason `reconnect_exhausted` (20 post-connect failures without stability).
- **Expected:** Log the error; close that one WS; mark the file `disconnected` in the runner's health state. Other files' connections are UNAFFECTED. Recovery: the next chokidar event on the affected file re-opens its DialBackDocClient fresh.
- **Verify:** Simulate 20 WS drops for one file while 99 others sync normally → only the affected file terminates; the other 99 stay connected; `/health` shows 99 syncing / 1 disconnected.
- **Source:** packages/docs-runner/src/dial-back-doc-client-pool.ts per-file `onTerminate` handler.

### B7: Markdown ↔ Yjs bridge (headless BlockNote)

**Core:**
- **ID:** md-yjs-bridge
- **Trigger:** Local file-change (after debounce + content-hash), or remote Yjs update observed on the local Y.Doc, or runner startup for each tracked file.
- **Expected:**
  - Bootstrap once, before importing `@blocknote/core`: `globalThis.document = new JSDOM().window.document`, `globalThis.window = jsdomWindow`.
  - **File → Y.Doc (steady state, after debounce):** `read → gray-matter.strip (frontmatter→Y.Map('meta')) → markdownToBlocks → blocksToYXmlFragment → Y.applyUpdate` as an incremental update on top of the existing Y.Doc (not a replace).
  - **Y.Doc → file:** `yXmlFragmentToBlocks → blocksToMarkdown → gray-matter.stringify (restore frontmatter) → atomic fs.writeFile`
  - **Runner-startup reconciliation (EXPLICIT rule — a freshly-converted-from-MD Y.Doc shares no CRDT history with the DO's doc, so naive sync 1/2 is NOT enough):**
    1. Open DialBackDocClient → complete sync step 1/2 with the DO so the local Y.Doc now equals the DO's last-persisted state.
    2. Serialise the DO's current Y.Doc via `yXmlFragmentToBlocks → blocksToMarkdown → gray-matter.stringify` → `docText`.
    3. Compute `diskHash = sha256(fileOnDisk)`; load `lastCommittedHash` from `{docsWorktreePath}/.duraclaw-docs/hashes.json`.
    4. **Case A — `diskHash == lastCommittedHash`:** disk is in sync with the last seen version; DO is authoritative → write `docText` to disk via the suppressed-writer (no re-push), update hash.
    5. **Case B — `diskHash != lastCommittedHash` AND DO Y.Doc is empty (never-edited entity):** disk has content, DO is blank → push disk → Y.Doc as initial seed; update hash.
    6. **Case C — `diskHash != lastCommittedHash` AND DO has content:** both sides diverged while runner was dead. Resolution: apply the disk content as a new Y.Doc update on top of the DO state (Yjs will CRDT-merge block-level inserts/deletes; overlapping edits to the same block resolve by Yjs insertion semantics — last-writer-wins per character position by clock). Log a WARN-level event `reconciliation_merge` with both hashes so operators can audit. Update hash to the post-merge disk-serialised hash.
  - The same reconciliation flow runs on reconnect after a long disconnect (>10 min or explicit `reconnect_exhausted` recovery), not just process startup.
- **Verify:** vp-round-trip (steady state); vp-cold-start (runner startup with matching hash — Case A no-op); vp-runner-crash (disk edited while runner dead + DO state exists — Case C merges cleanly, both sides of edits survive).
- **Source:** packages/docs-runner/src/blocknote-bridge.ts (new file) + reconciliation logic in packages/docs-runner/src/reconcile.ts (new file). Pre-phase gate P0-spike validates the exact combo.
- **Fallback (if P0 spike is RED):** Swap BlockNote for `remark` + manual `Y.XmlElement` construction against a minimal GFM schema. Adds ~3–4 days. Same interface shape + same reconciliation rule.

### B8: Content-hash gate

**Core:**
- **ID:** content-hash-gate
- **Trigger:** Every file-change event after chokidar debounce. **Debounce constant: `WATCHER_DEBOUNCE_MS = 500`** (chokidar `awaitWriteFinish.stabilityThreshold`). This is distinct from — and must NOT overlap semantically with — the B9 `SUPPRESS_TTL_MS = 2000` write-back window. Rationale: 500ms is long enough for atomic-save file writes (vim swap dance) to settle and short enough that user edits feel live; 2000ms for suppression covers the round-trip latency for the DO to broadcast a remote update back through the runner's watcher.
- **Expected:** Compute `sha256(file)`; compare against `{docsWorktreePath}/.duraclaw-docs/hashes.json`. If unchanged, skip. If changed, persist new hash BEFORE the Yjs push so crash-restart doesn't re-push.
- **Verify:** Edit + save + immediately edit-back + save → only one round-trip to the DO.
- **Source:** packages/docs-runner/src/content-hash.ts (new); debounce constant in packages/docs-runner/src/watcher.ts.

### B9: Write-back loop suppression

**Core:**
- **ID:** write-back-suppression
- **Trigger:** Runner writes a file because a remote Yjs update rendered differently than what's on disk.
- **Expected:** Add path to `suppressedPaths: Map<string, number>` with `Date.now()` BEFORE `fs.writeFile`. chokidar's subsequent change event checks the map; within 2000ms, the event is ignored and the entry removed.
- **Verify:** Remote update → file write → no re-push to DO (observed via gateway logs).
- **Source:** packages/docs-runner/src/writer.ts (new).

### B10: Grace-period tombstone on delete

**Core:**
- **ID:** grace-period-tombstone
- **Trigger:** Runner observes `unlink` event for a tracked file.
- **Expected:**
  1. Runner POSTs to DO `POST /tombstone`.
  2. DO sets `tombstoneAt = Date.now() + (tombstoneGraceDays * 86400_000)` (default 7d, configurable per project via `duraclaw-docs.yaml` and `projectMetadata.tombstoneGraceDays`).
  3. **Entering `pending_delete` state (concrete mechanism — YServer has no built-in write-rejection hook, so we enforce at the connection boundary rather than per-update):**
     - DO persists `tombstoneAt` to SQLite and schedules `ctx.storage.setAlarm(tombstoneAt)`.
     - DO broadcasts a custom awareness record `{ kind: 'tombstone-pending', tombstoneAt }` to all currently connected peers so the UI (B20) flips to strikethrough + warning chip.
     - New `onConnect` calls check `tombstoneAt != null`: if set, the DO immediately closes the new WS with code 4412 `document_deleted` (no data is served during pending_delete — the file is considered gone).
     - Existing peers are NOT force-closed at tombstone start — they stay connected so users can finish in-flight reads and potentially resurrect via `POST /cancel-tombstone`. Their Y.Doc updates during the grace window still flow (this is acceptable because the file is either about to be permanently deleted — writes are moot — or is about to be resurrected — writes are preserved). The alarm fire IS the hard cut.
     - Trade-off noted: writes from already-connected peers during the grace period are not rejected mid-stream. If the alarm fires, they are lost with the y_state hard-delete. If `cancel-tombstone` fires first, they survive. This is intentional — the alternative (force-closing peers on tombstone) breaks resurrection UX.
  4. If the file reappears (runner observes `add` on the same path before the alarm fires) → runner POSTs `POST /cancel-tombstone` → DO cancels alarm, clears `tombstoneAt`, broadcasts `{ kind: 'tombstone-cancelled' }` awareness record; new connections are accepted again.
  5. Alarm fires → DO hard-deletes y_state row, closes ALL peers with code 4412 `document_deleted`, refuses all future `onConnect` with 4412 until D1 / DO is deprovisioned.
- **Verify:** `rm tracked.md` → `curl DO /tombstone-status` returns alarm ts + new connection to the DO is refused with 4412. `touch tracked.md` before alarm → `cancel-tombstone` accepted, new connections succeed again. Let alarm fire → all peers close with 4412, entityId returns no data on reconnect.
- **Source:** apps/orchestrator/src/agents/repo-document-do.ts `onConnect` guard + `onRequest` + `alarm()` handlers.

**API Layer:**
- HTTP control endpoints are routed through the DO at URL pattern `/api/collab/repo-document/:entityId/<action>` (same prefix as the WS route; non-upgrade requests flow to `onRequest` via standard CF DO dispatch):
  - `POST /api/collab/repo-document/:entityId/tombstone` body: `{ relPath }` — idempotent, returns `{ tombstoneAt }`
  - `POST /api/collab/repo-document/:entityId/cancel-tombstone` body: `{ relPath }` — 200 if cancelled, 404 if no tombstone
  - `GET /api/collab/repo-document/:entityId/tombstone-status` → `{ tombstoneAt: number | null }`
- Auth for HTTP control: bearer `DOCS_RUNNER_SECRET` required (runner-only call; not exposed to browsers).
- Close code `4412 document_deleted` added to packages/shared-transport/src/dial-back-client.ts.

### B11: DialBackDocClient (transport layer refactor)

**Core:**
- **ID:** dial-back-doc-client
- **Trigger:** docs-runner needs to dial a DO with y-protocols binary frames.
- **Expected:** New subclass in `packages/shared-transport/src/dial-back-doc-client.ts` that:
  - Sets `binaryType = 'arraybuffer'` on the underlying WebSocket.
  - Overrides `onmessage` to skip `JSON.parse`; passes `new Uint8Array(e.data)` directly to `onCommand`.
  - Adds `send(update: Uint8Array)` that serialises through the existing send path with binary framing (no JSON wrapping).
  - Inherits reconnect backoff `[1s,3s,9s,27s,30s×]`, 10s stable reset, 20-fail cap, close codes 4401/4410/4411/4412 all unchanged.
- **Verify:** Unit test round-trips a Uint8Array payload over a mock WS; terminates cleanly on 4401.
- **Source:** packages/shared-transport/src/dial-back-doc-client.ts (new). Rejects spec 0018's original false "payload is opaque" claim.

### B12: Lazy spawn via agent-gateway

**Core:**
- **ID:** lazy-spawn
- **Trigger:** A browser peer opens WS to `RepoDocumentDO` for a projectId that has NO connected docs-runner peer.
- **Expected:**
  1. DO waits a 2s grace window (in case a runner is mid-reconnect).
  2. DO reads `projectMetadata` for `projectId` from D1 (via Drizzle, same binding the HTTP API uses).
  3. **Guard — if `docsWorktreePath` is null:** skip the gateway call; broadcast a synthetic awareness record `{ kind: 'setup-required', projectId }` so the browser UI renders the DocsWorktreeSetup modal (B19). No runner is started until the user PATCHes the path.
  4. **Happy path — path is set:** DO POSTs to `${CC_GATEWAY_URL}/docs-runners/start` with body `{ projectId, docsWorktreePath, bearer: env.DOCS_RUNNER_SECRET }`. The gateway is VPS-local and has NO D1 access — the DO is the authoritative reader of projectMetadata. The bearer is passed so the runner can auth back against the DO WS without the gateway knowing the secret beyond transient forwarding.
  5. Gateway validates `docsWorktreePath` exists and matches PROJECT_PATTERNS/WORKTREE_PATTERNS. On failure (400 `docs_worktree_invalid`) the DO clears `docsWorktreePath` in D1 and emits `setup-required`.
  6. On success: gateway writes `/run/duraclaw/docs-runners/{projectId}.cmd`, spawns `docs-runner` detached with argv `docs-runner <projectId> <cmdFile> <pidFile> <exitFile> <metaFile>`. If a live PID already exists, gateway returns 200 `{ already_running: true }` without re-spawning.
  7. Runner dials back; browser sees the peer appear via awareness within ~2–5s.
  8. **Rate limit (flap protection):** DO persists `lastSpawnAttempt: number` per projectId in storage. Skip the POST (no-op) if `Date.now() - lastSpawnAttempt < 30_000`. This bounds gateway POST volume under browser reconnect flap.
  9. **Gateway unreachable:** If the POST to `/docs-runners/start` fails with a network error (fetch throws, no HTTP response), the DO emits `{ kind: 'spawn-failed', reason: 'gateway_unreachable' }` awareness so the browser shows a "Runner unavailable — retry" chip. On next browser reconnect (or 60s later), the 30s rate-limit has expired and the spawn retries.
- **Verify:**
  - Happy path: Cold state + path set. Browser opens a doc → gateway log shows `/docs-runners/start projectId=…` → runner appears in awareness chip.
  - Null guard: projectMetadata has `docsWorktreePath=null`. Browser opens a doc → gateway log is silent; browser receives `setup-required` awareness → modal opens.
  - Idempotency: Runner already live; DO POSTs again → gateway returns 200 `already_running:true`, no second process spawned.
- **Source:** Gateway handler in `packages/agent-gateway/src/handlers.ts` (new endpoint). DO spawn trigger in `apps/orchestrator/src/agents/repo-document-do.ts`.

**API Layer:**
- `POST /docs-runners/start` body: `{ projectId, docsWorktreePath, bearer }` → 202 Accepted `{ pidFile }` | 200 `{ already_running: true, pid }` | 400 `{ error: 'docs_worktree_invalid' }`
- `GET /docs-runners` → list all known (pattern: `GET /sessions`)
- `GET /docs-runners/:projectId/status` → exit > pid+live > pid+dead > 404

### B13: Graceful shutdown (2s watchdog)

**Core:**
- **ID:** graceful-shutdown
- **Trigger:** SIGTERM received (systemd stop, tray quit).
- **Expected:** Stop chokidar; drain pending writes; send WS close frames to all DOs; exit within **2s** (matches session-runner `SIGTERM_GRACE_MS = 2_000`; the original spec 0018's "5s" was a factual error).
- **Verify:** `kill -TERM <pid>` under load → no partial files, no WS connection leaks in orchestrator logs, process exits within 2s.
- **Source:** packages/docs-runner/src/main.ts SIGTERM handler.

### B14: `/health` for tray supervision

**Core:**
- **ID:** health-endpoint
- **Trigger:** HTTP `GET /health` on `CC_DOCS_RUNNER_PORT` (worktree-derived, range 9878–10677).
- **Expected:** JSON body (tombstoned files are EXCLUDED from the ok/degraded ratio — they are expected-dead, not unhealthy):
  ```json
  {
    "status": "ok" | "degraded" | "down",
    "version": "0.1.0",
    "uptime_ms": number,
    "files": number,
    "syncing": number,
    "disconnected": number,
    "tombstoned": number,
    "errors": number,
    "reconnects": number,
    "per_file": [{ "path": string, "state": "syncing"|"disconnected"|"tombstoned", "last_sync_ts": number, "error_count": number }]
  }
  ```
  Status thresholds (evaluate in order; first match wins):
  - `down` — process is unable to serve: chokidar watcher is dead OR the runner hasn't completed initial file enumeration yet OR `files == 0 && uptime_ms > 30_000` (empty config after startup grace).
  - `degraded` — at least one file is disconnected: `disconnected > 0`. Rationale: per-file isolation (B6) means one stuck WS doesn't kill the process, but tray/UI must surface partial-outage so users notice.
  - `ok` — watcher live, initial enumeration complete, and `disconnected == 0` (all non-tombstoned files are `syncing`).
- **Verify:**
  - Happy path: `curl :<CC_DOCS_RUNNER_PORT>/health | jq -r .status` → `"ok"`; `syncing >= 1`.
  - Degraded: simulate one WS termination → `.status == "degraded"`, `.disconnected == 1`, other files still `syncing`.
  - Down: kill chokidar internally (test-only hook) → `.status == "down"`.
  - Tombstone neutrality: delete a file so it tombstones → `.tombstoned == 1`, but status stays `ok` (tombstone doesn't degrade).
- **Source:** packages/docs-runner/src/health-server.ts (new). Tray consumes via spec 0015 B-TRAY-2.

### B15: File discovery via `duraclaw-docs.yaml`

**Core:**
- **ID:** file-discovery-config
- **Trigger:** docs-runner startup OR config file change.
- **Expected:** Runner reads `{docsWorktreePath}/duraclaw-docs.yaml` with shape:
  ```yaml
  watch:
    - "planning/**/*.md"
    - "docs/**/*.md"
    - "README.md"
  exclude:
    - "node_modules/**"
    - ".git/**"
    - "dist/**"
  tombstone_grace_days: 7
  ```
  Runner enumerates files matching `watch` AND NOT matching `exclude`; opens one DialBackDocClient per file; concurrency-cap 8 parallel connects. `docs-runner init` subcommand writes a default template if the file doesn't exist.
  **Missing-config behaviour:** If `duraclaw-docs.yaml` is absent when the runner starts (common case — gateway lazy-spawn fires before the user has run `docs-runner init`), runner applies the default template **in-memory only** (no file written, to avoid polluting the worktree with an unsolicited commit-worthy artifact) and logs WARN `config_missing path=<docsWorktreePath>`. It does NOT refuse to start — v1 `.md`-everywhere watching is a sensible default that matches the B19 setup flow. The UI's "Create docs config" nudge (P5b) encourages the user to run `docs-runner init` so the defaults are persisted and customisable.
- **Verify:** Fresh docs worktree with NO yaml → runner spawns, logs `config_missing`, watches all `**/*.md` with defaults, health shows `files>0`. Then `docs-runner init` → yaml written → `kill -HUP` or next startup picks it up from disk.
- **Source:** packages/docs-runner/src/config.ts (new).

### B16: Editor UI — `/projects/:projectId/docs` route

**Core:**
- **ID:** editor-route
- **Trigger:** User navigates to `/projects/<projectId>/docs`.
- **Expected:** Two-pane layout: left = file tree of tracked `.md` files (from `GET /api/projects/:projectId/docs-files`); right = BlockNote editor wired to the RepoDocumentDO via y-partyserver provider using Better Auth cookie.
- **Verify:** Login → navigate → file tree populated → click file → editor loads with live sync.
- **Source:** apps/orchestrator/src/routes/projects/$projectId/docs.tsx (new TanStack Start route).

**UI Layer:**
- Route: TanStack Start file-based, path `/projects/$projectId/docs`.
- Component tree: `<DocsPage>` → `<DocsFileTree>` + `<DocsEditor>` + `<DocsWorktreeSetup>` (modal when docsWorktreePath is null).
- States: loading (skeleton file tree), empty (no config / no .md files found — prompt `docs-runner init`), editing (BlockNote mounted), error (per-file disconnect indicator + retry).

**API Layer:**
- `GET /api/projects/:projectId/docs-files` → `[{ relPath, state, lastModified }]` — proxies to gateway's filesystem walk.
- `GET /api/docs-runners/:projectId/health` → proxies to gateway's runner health.

### B17: BlockNote block palette — GFM-only

**Core:**
- **ID:** blocknote-gfm-palette
- **Trigger:** BlockNote editor mount.
- **Expected:** Block schema restricted to: headings (h1–h3), paragraph, bulleted/ordered list, code block (fenced), inline code, blockquote, table, link, bold, italic. No custom blocks in v1.
- **Verify:** Try to insert a custom/callout block → slash menu does not offer it.
- **Source:** apps/orchestrator/src/components/docs/DocsEditor.tsx `blockSpecs` config.

**UI Layer:**
- BlockNote editor initialised with custom `schema` that whitelists only the GFM blocks above.

### B18: Awareness UI — cursors + docs-runner peer chip

**Core:**
- **ID:** awareness-ui
- **Trigger:** Peer joins a document's awareness map.
- **Expected:**
  - Browser peers render as named cursors + colour chips in the BlockNote editor (BlockNote's collab cursor extension).
  - Each browser's local awareness state is `{ user: { name, color, kind: 'browser' } }` from Better Auth session.
  - docs-runner peers publish `{ user: { name: 'docs-runner', color: '#9ca3af', kind: 'docs-runner', host, version } }` on their awareness.
  - Editor FILTERS OUT docs-runner peers from the cursor overlay (no cursor for the daemon — it has no selection) but SHOWS them in a "Connected peers" chip row above the editor with their hostname.
- **Verify:** Two browsers + one runner all editing the same file. Each browser sees the other's cursor + own avatar chip; both browsers show a single docs-runner chip with the host name.
- **Source:** apps/orchestrator/src/components/docs/DocsEditor.tsx awareness wiring.

### B19: DocsWorktreeSetup first-run modal

**Core:**
- **ID:** worktree-setup-modal
- **Trigger:** User opens `/projects/:projectId/docs` and `projectMetadata.docsWorktreePath` is null.
- **Expected:** Modal appears with:
  - Explanation of permanent docs worktree + why it's needed
  - Copyable shell snippet: `git worktree add ../$(basename $PWD)-docs main`
  - Form field for the path → submits `PATCH /api/projects/:projectId { docsWorktreePath }`
  - On success, dismisses modal + refreshes file tree.
- **Verify:** New project with no metadata → modal appears → fill path → submit → file tree loads.
- **Source:** apps/orchestrator/src/components/docs/DocsWorktreeSetup.tsx (new).

### B20: Per-file state indicators in file tree

**Core:**
- **ID:** file-state-indicators
- **Trigger:** File tree polls `GET /api/docs-runners/:projectId/health` every 5s.
- **Expected:** Each file row shows an icon based on state: green dot (syncing), grey dot (disconnected), strikethrough + skull (tombstoned).
- **Verify:** Kill runner → all files flip to grey within 5s. Delete a file on disk → flips to strikethrough.
- **Source:** apps/orchestrator/src/components/docs/DocsFileTree.tsx.

### B21: Ship-gate verification

**Core:**
- **ID:** ship-gate
- **Trigger:** Manual run of `scripts/verify/gh27-ship-gate.sh`, or CI invocation.
- **Expected:** Script:
  1. Starts `docs-runner` pointed at `$VERIFY_ROOT` (this repo's docs worktree).
  2. Starts two axi-browsers via `scripts/verify/axi-dual-login.sh`.
  3. Both navigate to `/projects/<this-project>/docs`, open `planning/specs/0018.md`.
  4. Runs a 3-minute script that types alternating content into each browser at ~1 keystroke/s.
  5. After the 3 minutes: closes both browsers; reads the file on disk; asserts it matches the final BlockNote DOM from browser A (serialised through the same bridge); asserts no gap-sentinels in runner logs; asserts no 4401/4410/4412 terminal events.
  6. Prints PASS / FAIL.
- **Verify:** This IS the verification. Gate for v1 release.
- **Source:** scripts/verify/gh27-ship-gate.sh (new).

## Non-goals (v1)

- **Git integration beyond normal `git commit` / `git pull`** — runner never touches git; versioning stays in user's hands.
- **Per-user API tokens** — shared `DOCS_RUNNER_SECRET` only. Deferred to future `B-AUTH-2`.
- **Hot bearer rotation via SIGHUP** — v1 rotation is systemd restart.
- **Binary / non-markdown file sync** — `.md` only; `.mdx`/`.yaml` may be added in v1.1 if trivial.
- **Custom BlockNote blocks** (callouts, embeds, diagrams) — default GFM palette only.
- **Conflict UI** — CRDT eliminates conflicts; surface nothing.
- **Multi-tenant / SaaS exposure** — shared-bearer auth implies one trust boundary per runner.
- **DO GC for cold never-edited docs** — tombstone handles active deletion; cold-forever state is tracked debt (see Open Risks in interview summary).
- **Feature-branch-scoped collab** — permanent docs worktree on `main` is the only live-collab surface; feature-branch edits flow through git.

## Pre-phase gate: P0 spike

**Before any foundation code lands on main, run the BlockNote + Bun + jsdom round-trip spike** (see `pre_phase_gate` in frontmatter). Decision tree:

- **GREEN** → proceed with BlockNote path as specified in B7.
- **YELLOW** → document patches; proceed with BlockNote + explicit notes in P3a tasks.
- **RED** → activate fallback: replace `@blocknote/core` in B7 with `remark` + manual `Y.XmlElement` construction against the B17 GFM schema. Add ~3–4 days to the P3a `blocknote-bridge.ts` task. No other B-behaviours change.

Budget: 4–6h of spike effort in a throwaway branch. Never merged.

## Phase gates

- **P1 gate:** `POST /api/projects/:projectId` persists. `projectId` derivation stable across rename. `DialBackDocClient` unit test round-trips Uint8Array.
- **P2 gate:** `wscat` to `/api/collab/repo-document/foo/ws` with a cookie round-trips sync 1/2 + awareness. Same with `role=docs-runner&token=…`. Wrong token → 4401. DO hibernates + restores.
- **P3a gate:** Runner package builds; manually launched single-file runner dial-backs to a local DO; vim edit → browser visible, browser edit → file on disk; SIGTERM exits ≤2s. Gateway NOT yet wired — launch is hand-craft.
- **P3b gate:** Gateway `POST /docs-runners/start` spawns detached; idempotency + 400 failure modes covered; DO lazy-spawn triggers on cold browser open; `setup-required` awareness fires when `docsWorktreePath` is null.
- **P4 gate:** 100 files under watch; memory <200MB; one simulated file-level termination does NOT affect other files; 4410 triggers runner-wide re-dial.
- **P5a gate:** `/projects/:projectId/docs` renders file tree + editor; two-browser live collab visible; edits round-trip to disk.
- **P5b gate:** docs-runner peer shown as chip; first-run modal fires for new projects; per-file indicators flip correctly (syncing/disconnected/tombstoned).
- **P6 gate:** Tray (spec 0015) picks up docs-runner per project via the health endpoint (already shipped in P3a); systemctl restart cycles all runners cleanly.
- **P7 gate (RELEASE):** `scripts/verify/gh27-ship-gate.sh` passes. All 7 `verification_plan` cases have runnable scripts.

## Risks

| Risk | Mitigation |
|---|---|
| BlockNote markdown serialiser has a regression under Bun/jsdom | P0 spike is a mandatory pre-phase gate. Fall back to remark + manual Y.XmlFragment (~3–4 days, same interface) if RED. |
| y-partyserver WS framing rejects vanilla y-protocols from Node | P1 DialBackDocClient unit test uses raw `ws` + y-protocols directly (NOT y-partyserver client) to confirm. |
| Per-file DO count explodes at scale | Per-project DO variant revisited when >500 docs. Tombstone GC covers active deletion; cold never-edited is tracked debt. |
| Shared-bearer auth leaks blast-radius | v1 is trusted-infra only. Per-user API tokens (B-AUTH-2) before any SaaS exposure. |
| Two runners on the same project race the write-back suppression map | Gateway enforces one-runner-per-projectId (PID file, same pattern as session-runner). POST /docs-runners/start is idempotent on live PID. |
| Git working-tree churn from runner writes | Docs worktree pinned to `main`; content-hash gate prevents no-op pushes. Users commit on their own cadence. |
| Feature-branch worktrees have stale `.md` copies | Accepted. Sessions on feature branches see branch snapshot; live collab in the docs worktree. Merging reunifies. |
| BlockNote awareness extension mismatch with y-partyserver | Validated in P5 by two-browser test. If mismatch, fall back to presence-dots-only (still covers the B18 peer chip requirement). |
| First-open latency for lazy spawn (~2–5s) feels slow | Acceptable for v1. If users complain, add eager-on-project-registration mode gated by a projectMetadata flag. |

## Migration / rollback

- **From spec 0008:** no code to migrate — nothing shipped.
- **From current state:** projectMetadata table + DialBackDocClient are additive. ProjectRegistry DO was already dropped in migration v5 (not this spec). CLAUDE.md drift-fix is docs-only.
- **Rollback:** Disable `REPO_DOCUMENT` DO binding in wrangler.toml + stop all `docs-runner` systemd units. Reverts to "markdown is just files in git" with no user-visible data loss — DO's Yjs state is the same content the files already hold.

## Considered and rejected

| Approach | Why rejected |
|---|---|
| Sub-repo / git submodule for docs | User-hostile, breaks PR review coupling, per-worktree init gymnastics. Permanent worktree achieves same branch-independence with zero new mechanisms. |
| Shadow directory (canonical files live in `.duraclaw-docs/`) | Breaks agent's filesystem mental model. Write/Bash tools expect canonical paths; symlinks/tool-shims fragile. |
| Per-branch CRDT keying (DO ID includes branch name) | Permanent worktree makes this unnecessary. No `.git/HEAD` watcher, no per-branch namespaces. |
| Cloudflare Artifacts as backing store | Git-commit granularity wrong for CRDT flushes. Different problem (versioned storage vs live collab). |
| Session-side tool-use shim (intercept Write/Edit on `.md` paths) | Requires sessions to know about sync; fails for Bash-level ops. |
| CLI/MCP-based doc writes from sessions | Prompt-adoption tax; silent failure when agent forgets; misses human-editor case. |
| Auto-commit on doc edit (old baseplane behaviour) | Conflates live-sync with versioning. Messy commit history. Users commit on their own cadence. |
| **Per-machine docs-runner** (spec's p2 original wording) | Fate-sharing (one crashed file kills all); no per-project security boundary; gateway has no spawn role. Rejected in favour of per-project (locked by interview decision A1). |
| **Eager spawn on project registration** | N always-on processes for projects with no editing. Lazy costs ~2–5s first-open only (A2). |
| **Extend `POST /sessions/start` with `{type: 'docs-runner'}`** | Mixes two very different lifetimes under one reaper. Separate endpoint cleaner (A3). |
| **Server-minted UUID projectId** | Unstable across different duraclaw installs; team members see different projectIds for the same repo; DOs don't converge. Origin-URL SHA is install-independent (B1). |
| **Immediate tombstone on file delete** | `git pull` landing a branch where the file was deleted is indistinguishable from intentional delete → nukes live browser edits. Grace period (B10) protects against this. |
| **SIGHUP hot-rotation of DOCS_RUNNER_SECRET** | Requires coordination with orchestrator secret deploy; meaningful code for a rare op. systemd-restart covers v1 needs (B4). |
| **Editor UI as non-goal** (spec's original v1 non-goal) | No dogfooding surface; feature's value invisible. Locked in-scope by interview G1. |

## Companions

- Spec 0015 consumes the `/health` endpoint (B14).
- Spec 3 (`yjs-multiplayer-draft-collab`) established the YServer pattern; this spec clones it at a new entity type.
- Spec 1 (`session-runner-decoupling`) established the dial-back pattern; this spec clones it at a new transport payload.

## User setup (once per project)

```bash
# In the user's project repo
cd /data/projects/foo
git worktree add ../foo-docs main
cd ../foo-docs
docs-runner init        # writes duraclaw-docs.yaml default

# In duraclaw UI: /projects/foo/docs → first-run modal prompts for path
# (Or: PATCH /api/projects/foo { docsWorktreePath: "/data/projects/foo-docs" })
```

After that, forever untouched. Feature worktrees come and go on their own paths; `foo-docs/` stays on `main` and docs-runner stays rooted there.

## Implementation Hints

### Key imports

```ts
// RepoDocumentDO
import { YServer } from 'y-partyserver'           // ^2.1.4
import * as Y from 'yjs'                          // ^13.x
// pattern reference for onConnect: apps/orchestrator/src/agents/user-settings-do.ts:162-174

// DialBackDocClient
import { DialBackClient } from './dial-back-client'  // local subclass target

// docs-runner bridge
import './jsdom-bootstrap'  // MUST be first import
import { JSDOM } from 'jsdom'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import matter from 'gray-matter'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import { encoding, decoding } from 'lib0'

// editor UI
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { YPartyKitProvider } from 'y-partykit/provider'   // y-partyserver includes this
```

### Code patterns (copy-paste targets)

**SessionCollabDO y_state schema (clone for RepoDocumentDO):**
`apps/orchestrator/src/agents/session-collab-do.ts:24-55`

**UserSettingsDO onConnect dual-auth (adapt for RepoDocumentDO.onConnect):**
`apps/orchestrator/src/agents/user-settings-do.ts:162-174`

**DialBackClient reconnect + terminal handling (extend in DialBackDocClient):**
`packages/shared-transport/src/dial-back-client.ts:32-43, 136-172, 211`

**session-runner argv + SIGTERM watchdog (mirror for docs-runner):**
`packages/session-runner/src/main.ts:6-7, 35, 396-425`

**Gateway spawn pattern (clone for /docs-runners/start):**
`packages/agent-gateway/src/handlers.ts:192` — 7-argv detached spawn

**y-partyserver routing + stub fetch (extend for /parties/repo-document/:id):**
`apps/orchestrator/src/server.ts:47-64`

### Gotchas

- **jsdom global patch MUST happen before any @blocknote/core import.** Create `jsdom-bootstrap.ts` as the very first import in `main.ts`. Side-effect order matters — `import './jsdom-bootstrap'` on line 1, then the rest.
- **DialBackClient hardcodes `JSON.parse(e.data)` at `dial-back-client.ts:185`.** Your subclass MUST override `onmessage` entirely, not just `onCommand`.
- **`binaryType` defaults to `'blob'` in browsers, `'nodebuffer'` in Node.** Set `'arraybuffer'` explicitly in the subclass constructor; convert incoming data via `new Uint8Array(e.data)`.
- **y-partyserver's `callbackOptions.timeout: 5000` fires BEFORE `debounceMaxWait: 10000`.** Effective max staleness is 5s, not 10s. Don't document "10s" to users.
- **CC_DOCS_RUNNER_PORT must be worktree-derived.** Don't hardcode 9878 in tests — use `$CC_DOCS_RUNNER_PORT` from `scripts/verify/common.sh`.
- **CLAUDE.md has a stale `ProjectRegistry` line** — part of P1 task list is fixing this.
- **Lazy spawn has a 2s grace** to avoid double-spawning when a runner is mid-reconnect. Don't shorten this without measuring dial-back jitter first.
- **`docs-runner init` must NOT overwrite an existing `duraclaw-docs.yaml`** — check `fs.existsSync` and no-op if present.

### Reference docs

- BlockNote server-side: https://www.blocknotejs.org/docs/features/server-processing — confirms `@blocknote/server-util` exists for headless use.
- BlockNote issue #942: https://github.com/TypeCellOS/BlockNote/issues/942 — Next.js SSR caveat; informs why Bun+jsdom is its own risk (different runtime, same DOM-shim class of problems).
- y-protocols README: https://github.com/yjs/y-protocols — sync step 1/2 + awareness frame structure.
- y-partyserver: https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver — YServer + YPartyKitProvider source.
- Cloudflare DO alarm API: https://developers.cloudflare.com/durable-objects/api/alarms/ — backs the tombstone grace period.
- gray-matter: https://www.npmjs.com/package/gray-matter — frontmatter strip/stringify.
- chokidar v4 (ESM): https://github.com/paulmillr/chokidar — watcher options, `ignoreInitial` for startup discovery.
- Git worktree: https://git-scm.com/docs/git-worktree — `git worktree add <path> main` is the only git primitive this spec requires from users.
