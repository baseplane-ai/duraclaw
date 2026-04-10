---
initiative: mdsync
type: project
issue_type: feature
status: draft
priority: high
github_issue: null
created: 2026-04-10
updated: 2026-04-10
supersedes: "0007-mdsync-cross-platform-docs-sync"
phases:
  - id: p1
    name: "Headless BlockNote PoC + Runtime Decision"
    tasks:
      - "Validate BlockNoteEditor.create() in Bun with jsdom global patch"
      - "Test full round-trip: markdownToBlocks → blocksToYXmlFragment → yXmlFragmentToBlocks → blocksToMarkdown"
      - "Measure fidelity on actual docs/planning markdown files from the repo"
      - "Test frontmatter strip/restore cycle via gray-matter"
      - "Document jsdom global patch workaround and any Bun-specific issues"
  - id: p2
    name: "Core Sync Engine"
    tasks:
      - "Scaffold mdsync package (Bun runtime, bun build --compile for distribution)"
      - "Implement config parsing (mdsync.yaml) with validation"
      - "Implement content hash store (SHA-256 per file, persisted to .mdsync/hashes.json)"
      - "Implement file watcher with debounce (3s default, configurable)"
      - "Implement git operations: staging, committing, branch management, push with rebase retry"
      - "Implement local-to-remote sync: watch → debounce → hash check → stage → commit → push"
      - "Implement remote-to-local sync: poll → fetch → diff → merge/ff-only → update hashes"
      - "Implement conflict handling: detect rebase failure, stash local, reset to remote, notify"
      - "Implement sync lock (serialize all git ops through single mutex)"
  - id: p3
    name: "CLI (mdsync init, watch, status, sync)"
    tasks:
      - "Implement mdsync init <repo-url>: clone, create .mdsync/, generate default config"
      - "Implement mdsync watch: file watcher + poll loop, run until Ctrl+C"
      - "Implement mdsync status: sync state, last sync, pending changes, errors"
      - "Implement mdsync sync: one-shot push + pull"
      - "Implement mdsync resolve: mark conflict resolved, cleanup stash"
      - "Graceful shutdown on SIGTERM/SIGINT"
  - id: p4
    name: "Yjs Real-Time Layer"
    tasks:
      - "Add WebSocket Yjs provider (y-websocket or custom Node.js implementation)"
      - "Implement file → Yjs push: file change → markdownToBlocks → blocksToYXmlFragment → Yjs update"
      - "Implement Yjs → file write: remote update → yXmlFragmentToBlocks → blocksToMarkdown → write"
      - "Implement write-back loop suppression (suppressed paths with TTL)"
      - "Implement content-hash check to avoid no-op Yjs updates"
      - "Wire Yjs as fast path, git sync as slow path (scribe mode)"
      - "Pluggable WebSocket URL — works with any Yjs-compatible server"
  - id: p5
    name: "Baseplane Platform Integration"
    tasks:
      - "Define RepoDocument entity type with content field"
      - "Implement deterministic file path → entity ID mapping"
      - "Connect to collab worker at /api/collab/RepoDocument/{entityId}/content/sync"
      - "Create service identity for headless auth (system user + long-lived token)"
      - "Handle initial hydration: bulk-create Yjs docs for existing files on startup"
      - "Handle file deletion lifecycle"
  - id: p6
    name: "Tray UI (Tauri v2)"
    tasks:
      - "Scaffold Tauri v2 app with system tray"
      - "Tray icon states: green (synced), yellow (syncing), red (error)"
      - "Activity log window: recent syncs, conflicts, errors"
      - "Quick actions: Pause/Resume, Sync now, Open config, Quit"
      - "System notifications: conflicts, persistent errors, recovery"
      - "Auto-start on login (launchd/systemd/registry)"
  - id: p7
    name: "Baseplane Deploy Server Integration"
    tasks:
      - "Delete packages/deploy/src/serve/docs-sync.ts"
      - "Spawn mdsync watch as child process from deploy server on boot"
      - "Monitor process health (restart on crash)"
      - "Read .mdsync/state.json for TUI status and GET /docs-sync endpoint"
      - "Install mdsync binary on VPS (bun build --compile or run from source)"
---

# mdsync — Cross-Platform Markdown Sync with Real-Time Collaboration

> **Supersedes** spec 0007 (mdsync — Cross-Platform Markdown Sync Tool). This spec inherits all cross-platform git sync behaviors from 0007 and adds Yjs/BlockNote real-time collaboration as a core feature.

## Overview

`mdsync` is an open-source, cross-platform tool (part of the **duraclaw** project) that bidirectionally syncs markdown files between local directories and a git branch, with **optional real-time collaborative editing** via Yjs CRDT. It solves the problem that coding agents, developers, and web UI users frequently edit the same documentation across multiple machines, worktrees, and interfaces.

**Repository:** `duraclaw/` monorepo → `packages/mdsync/` (core + CLI), `apps/mdsync-tray/` (Tauri)

**Two sync modes, composable:**

1. **Git sync** (always available) — File watching → debounced commit → push/pull to a dedicated branch. Works offline, provides durable history. Inherited from spec 0007.

2. **Yjs real-time sync** (opt-in) — Each mdsync node acts as a headless Yjs client connected to a WebSocket server. Edits propagate in milliseconds via CRDT. Files on disk ↔ BlockNote XmlFragment, fully bidirectional with the web editor. Git sync becomes the periodic "scribe" that snapshots converged state.

**Audience:** Developers, AI coding agents, and teams who work with markdown documentation across multiple environments and want both git-backed persistence and real-time collaboration.

**Why now:** The current `docs-sync` service in baseplane-infra proves the concept but is tightly coupled to the Baseplane VPS. Baseplane already has a production Yjs collab system (collab worker + DocumentDO + BlockNote editor). Merging these into a single open-source tool makes the sync portable and the real-time layer accessible to anyone with a Yjs-compatible server.

---

## Runtime Decision

> **Research findings (2026-04-10):** Detailed investigation of BlockNote v0.42.3 source code reveals the following:

### BlockNote Headless Feasibility — Viable with Global DOM Patch

**Yjs conversion functions are DOM-free:** `blocksToYXmlFragment()`, `yXmlFragmentToBlocks()`, `blocksToYDoc()`, `yDocToBlocks()` are pure ProseMirror ↔ Yjs conversions. No DOM needed. These are the hot-path functions for real-time sync.

**Markdown serialization needs global DOM workaround:** `blocksToMarkdown()` and `markdownToBlocks()` use `document.createElement()` via hardcoded global `document` references in several places (externalHTMLExporter.ts:54, nestedLists.ts:49,84,89, serializeBlocksExternalHTML.ts:115,130). `BlockNoteEditor.create()` does not accept a custom document. However, `blocksToMarkdown()` does accept `options.document` — it's just not consistently propagated to all internal calls.

**Workaround:** Set `globalThis.document` (and `globalThis.window`) to a jsdom instance before importing BlockNote. All the internal `document.createElement` calls just need _any_ DOM implementation. This is a well-known pattern for running browser libraries in Node.js/Bun:

```typescript
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window as any
// Now BlockNote serialization works
```

**Yjs Node.js client is trivial:** DocumentDO uses a simplified protocol (not full y-protocols handshake): `0x00` prefix = Yjs update, `0x01` = awareness. Server sends full state on connect. A headless client is ~50 lines using `ws` + `yjs` + `y-protocols` — all already installed in the monorepo.

### Runtime Options

| Option | Pros | Cons |
|--------|------|------|
| **Bun/Node.js** | Direct access to BlockNote, Yjs, y-websocket. Same ecosystem as collab worker. Single language. Zero new deps for Yjs client. | jsdom global patch for BlockNote DOM. Larger binary for cross-platform. |
| **Rust core + JS bridge** | Native perf for file watching/git. Smaller binary. Tauri tray is Rust-native. | IPC complexity. Two runtimes. BlockNote calls cross process boundary. |
| **Full Rust** | Best perf and binary size. | No BlockNote/Yjs in Rust. Would need custom XmlFragment parser — massive effort, fragile. Not viable. |

**Recommendation: Bun.** Faster runtime, lower memory footprint than Node.js. The jsdom global patch is ugly but proven. The Yjs client is trivial. Markdown serialization (the DOM-dependent path) only runs on file save boundaries — not in the hot loop. `bun build --compile` produces a single cross-platform binary. Tauri tray (Phase 6) can still be Rust with the JS engine embedded.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        mdsync node                               │
│                                                                  │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────┐  │
│  │ File Watcher │───→│ BlockNote Bridge  │───→│  Yjs Provider  │──── ws ──→ Yjs Server
│  │ (chokidar/   │    │ md ↔ XmlFragment │    │  (y-websocket) │           (collab worker,
│  │  notify)     │←───│                  │←───│                │            hocuspocus,
│  └─────────────┘    └──────────────────┘    └────────────────┘            or any)
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                                                │
│  │  Git Sync   │──── git push/pull ──→ dedicated sync branch    │
│  │  (scribe)   │                                                │
│  └─────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘

Browser (BlockNote)  ←── ws ──→  Yjs Server  ←── ws ──→  mdsync node(s)
```

### Modes of Operation

**Git-only mode** (default, no config needed for Yjs):
- File watcher detects changes → debounce → hash check → git commit → push
- Poll for remote changes → fetch → merge → write to disk → update hashes
- Conflict: stash local, reset to remote, notify user
- This is the full 0007 behavior.

**Yjs + Git mode** (when `yjs` section present in config):
- File watcher detects changes → BlockNote bridge (md → XmlFragment) → Yjs update → WebSocket
- Remote Yjs updates → BlockNote bridge (XmlFragment → md) → write to disk (with loop suppression)
- One node designated as **scribe**: periodically renders converged Yjs state → git commit → push
- Git provides durable history and offline catch-up. Yjs provides real-time propagation.

### Data Flow — File Edit on Disk (Yjs mode)

```
1. Agent/vim edits docs/specs/0005.md
2. File watcher detects change (debounced)
3. Read file → markdownToBlocks() → diff against current Y.Doc
4. If changed: blocksToYXmlFragment() → Yjs update → WebSocket → Yjs server
5. Server broadcasts to all clients (browsers, other mdsync nodes)
6. Other nodes: receive → yXmlFragmentToBlocks() → blocksToMarkdown() → write to disk
7. Browsers: BlockNote applies update automatically
```

### Data Flow — Edit in Browser (Yjs mode)

```
1. User edits in BlockNote UI → Yjs update → WebSocket → Yjs server
2. Server broadcasts to all clients
3. mdsync nodes: receive → yXmlFragmentToBlocks() → blocksToMarkdown() → write to disk
4. fs-event suppression prevents re-ingestion
```

---

## Configuration

```yaml
# mdsync.yaml
remote:
  repo: owner/repo-name           # or full HTTPS git URL
  branch: mdsync                   # dedicated sync branch (default: "mdsync")
  auth: system                     # "system" = git credential helper

watch:
  - path: docs/
    include: ["*.md", "*.mdx"]
    exclude: ["_drafts/**"]
  - path: planning/
    include: ["*.md", "*.yaml"]

sync:
  debounce_ms: 3000                # file change debounce (default: 3000)
  ref_check_interval_s: 5          # remote poll interval (default: 5)
  commit_prefix: "mdsync:"         # commit message prefix

# Optional — enables real-time Yjs collaboration
yjs:
  ws_url: wss://dev.baseplane.ai/api/collab  # any Yjs-compatible WebSocket server
  auth_token: ${MDSYNC_AUTH_TOKEN}            # headless client auth
  organization_id: org-123                     # multi-tenant isolation (platform-specific)
  entity_type: RepoDocument                    # entity type for file-backed docs (default)
  field_name: content                          # field name (default)
  scribe: true                                 # this node writes git snapshots of Yjs state
```

When `yjs` is absent, mdsync operates in git-only mode (full 0007 behavior). When present, Yjs is the fast path and git is the scribe.

---

## Key Design Decisions

### 1. Markdown ↔ BlockNote XmlFragment (Headless)

Round-trip chain using BlockNote v0.42.3:

```
file.md → gray-matter(strip frontmatter) → markdownToBlocks() → blocksToYXmlFragment() → Y.Doc
Y.Doc → yXmlFragmentToBlocks() → blocksToMarkdown() → gray-matter(restore frontmatter) → file.md
```

**Two-stage conversion with different DOM requirements:**
- **Yjs ↔ Blocks:** `blocksToYXmlFragment()` / `yXmlFragmentToBlocks()` — DOM-free, pure ProseMirror ↔ Yjs. Hot path (runs on every Yjs update).
- **Blocks ↔ Markdown:** `blocksToMarkdown()` / `markdownToBlocks()` — needs DOM via jsdom global patch. Cold path (runs only on file save boundaries).

**Fidelity:** For GFM markdown (headings, lists, tables, code blocks, links, checkboxes), round-trip is high fidelity. BlockNote-only features (colors, media embeds, underlines) have no markdown representation — lossy in that direction only, and irrelevant for docs files.

**Frontmatter → Entity Fields (optional):** All docs/planning files use YAML frontmatter (specs have rich phase/task metadata). `gray-matter` strips frontmatter before `markdownToBlocks()`. When platform integration is enabled, frontmatter keys sync bidirectionally to entity fields (e.g., `status: draft` → entity `status` field). This makes specs queryable/filterable in the web UI without opening the file. When disabled (standalone/git-only mode), frontmatter is stored in `Y.Map('meta')` on the Y.Doc and re-prepended on write-back. Frontmatter sync is opt-in per config.

### 2. Entity Identification (Convention-Based)

Each markdown file maps to a Yjs room via deterministic path-based ID:

```
docs/planning/specs/0005.md
  → Entity ID:    docs--planning--specs--0005
  → WebSocket:    /api/collab/RepoDocument/docs--planning--specs--0005/content/sync
  → DO ID:        field:RepoDocument:docs--planning--specs--0005:content
```

No explicit entity registration. The Yjs server (DocumentDO) creates state on first connection via `idFromName()`. This works for any Yjs server that supports dynamic room creation.

### 3. Diff-Based Updates (Avoid Full Replacement)

Replacing the entire XmlFragment on each file save destroys cursors and creates CRDT tombstones.

- **v1:** Content-hash gate — only push to Yjs if `hash(file)` differs from `hash(blocksToMarkdown(currentYjsState))`. Prevents no-op loops.
- **v2:** Block-level structural diff — compare new blocks against current, apply only changed blocks as targeted Yjs operations. Preserves cursor positions during concurrent editing.

### 4. Write-Back Loop Prevention

When a remote Yjs update writes to disk, suppress the resulting fs event:

```typescript
const suppressedPaths = new Map<string, number>()

function writeFromYjs(path: string, content: string) {
  suppressedPaths.set(path, Date.now())
  await fs.writeFile(path, content)
}

function onFileChange(path: string) {
  const t = suppressedPaths.get(path)
  if (t && Date.now() - t < 2000) {
    suppressedPaths.delete(path)
    return  // our own write
  }
  // genuine external change → push to Yjs
}
```

### 5. Scribe Mode (Git as Persistence Layer)

With Yjs active, git sync changes role:

- One node is the **scribe** (`scribe: true` in config)
- Scribe periodically (30s or on quiescence): renders all tracked Yjs docs → markdown → git commit → push
- Non-scribe nodes do not git-commit during Yjs mode
- On startup after offline: git pull for catch-up, then Yjs state sync fills remaining gaps
- If Yjs server is unreachable, falls back to git-only mode automatically

### 6. Authentication for Headless Nodes

For Baseplane: service identity (system user + long-lived API token). Nodes connect through Gateway with `X-User-Id` / `X-Organization-Id` headers, same as browser clients.

For generic Yjs servers: configurable auth token passed as query param or header on WebSocket upgrade. Platform-agnostic.

### 7. Conflict Handling

**Git-only mode:** Inherited from 0007 — detect rebase failure, stash local version to `.mdsync/stash/`, reset to remote, notify user. `mdsync resolve` to cleanup.

**Yjs mode:** CRDT eliminates conflicts at the document level. The only conflict scenario is a split-brain where two nodes were offline and edited the same doc independently — Yjs merge handles this automatically when they reconnect. Git conflicts are impossible because only the scribe writes to git.

---

## Inherited from Spec 0007

The following behaviors are inherited verbatim from 0007. They form the git-only sync foundation:

- **B1: Config parsing and validation** — `mdsync.yaml` with strongly-typed config, defaults, validation
- **B2: Repository initialization** — `mdsync init`, dedicated `.mdsync/repo/` clone, orphan branch
- **B3: Content hash store** — SHA-256 per file in `.mdsync/hashes.json`, atomic writes
- **B4: File watching with debounce** — configurable debounce, glob include/exclude, ignore dotfiles
- **B5: Local-to-remote sync** — stage → commit → push with rebase retry (3 attempts)
- **B6: Remote-to-local sync** — lightweight ref check (5s), fetch on change, ff-only merge
- **B7: Conflict detection and resolution** — stash local, reset to remote, notify, `mdsync resolve`
- **B8: CLI — mdsync watch** — long-running watcher with status output
- **B9: CLI — mdsync status** — show sync state, tracked files, conflicts
- **B10: CLI — mdsync sync** — one-shot push + pull
- **B11: System notifications** — conflict, persistent error, recovery (notify-rust or node equivalent)
- **B12: Tray icon and status** — green/yellow/red, tooltip, activity log

See 0007 for detailed behavior specifications, verify steps, and data layer definitions.

---

## New Behaviors (Yjs Layer)

### B13: Yjs WebSocket Connection

**Core:**
- **Trigger:** `mdsync watch` with `yjs` config present
- **Expected:** On startup, establish WebSocket connection to `yjs.ws_url` for each tracked file. Use `y-websocket` protocol (or compatible). Authenticate with `yjs.auth_token`. Reconnect with exponential backoff on disconnect. Emit awareness state (node identity, worktree name).
- **Verify:** Start mdsync with Yjs config, observe WebSocket connection established. Kill server, observe reconnect attempts with backoff.

### B14: File → Yjs Push

**Trigger:** File change detected by watcher (after debounce + hash check) while Yjs is connected.
**Expected:** Read file → `markdownToBlocks()` → compare against current `yXmlFragmentToBlocks()` state. If different: `blocksToYXmlFragment()` → send Yjs update over WebSocket. Update local hash store. If Yjs is disconnected, queue the change and push when reconnected (or fall back to git-only).

### B15: Yjs → File Write

**Trigger:** Remote Yjs update received over WebSocket.
**Expected:** Apply update to local `Y.Doc`. Render to markdown: `yXmlFragmentToBlocks()` → `blocksToMarkdown()`. If markdown differs from current file on disk: write to disk with fs-event suppression. Update hash store.

### B16: Scribe — Yjs to Git Snapshots

**Trigger:** Scribe node (`scribe: true`) detects quiescence (no Yjs updates for 30s) or periodic timer (configurable).
**Expected:** For each tracked Yjs doc: render to markdown, compare against last git-committed version. Stage changed files → commit with prefix `"mdsync(scribe):"` → push. This replaces per-node git sync when Yjs is active.

### B17: Yjs Fallback to Git-Only

**Trigger:** Yjs WebSocket connection fails and reconnection exhausted (or `yjs` config absent).
**Expected:** Seamlessly fall back to git-only sync (B5/B6). When Yjs reconnects, sync local state, resume Yjs mode. Log mode transitions.

---

## Existing Code to Reuse

| Component | Location | Provides |
|-----------|----------|----------|
| DocumentDO | `apps/collab/src/actors/DocumentDO.ts` | Yjs state, WebSocket handling, DB persistence |
| Field mode routes | `apps/collab/src/routes/document-routes.ts` | `/api/collab/:entityType/:entityId/:fieldName/sync` |
| Collaborative editor | `apps/web/src/systems/collaborative-editor/` | BlockNote + Yjs integration (browser reference impl) |
| WebSocketProvider | `apps/web/src/shared/lib/yjs/WebSocketProvider.ts` | Client Yjs provider (port to Node.js) |
| BlockNote serialization | `@blocknote/core` v0.42.3 | `markdownToBlocks`, `blocksToMarkdownLossy`, Yjs utils |
| Current docs-sync | `packages/deploy/src/serve/docs-sync.ts` | File watcher patterns, git sync logic, debouncing |
| Collab auth | `apps/collab/src/lib/document-auth.ts` | Header-based auth model |

---

## Research Findings (2026-04-10)

### Resolved Questions

1. **BlockNote headless feasibility** — **VIABLE.** Yjs conversion functions (`blocksToYXmlFragment`, `yXmlFragmentToBlocks`) are DOM-free. Markdown functions (`blocksToMarkdown`, `markdownToBlocks`) need jsdom global patch (`globalThis.document = dom.window.document`). BlockNote source has inconsistent `options.document` propagation (some internal calls ignore it), but global patch covers all paths. Recommendation: Bun/Node.js runtime.

2. **Frontmatter handling** — **RESOLVED.** Use `gray-matter` to strip/restore. With platform integration: frontmatter keys sync bidirectionally to entity fields (status, priority, phases become queryable in web UI). Without platform: stored in `Y.Map('meta')` and re-prepended on write-back. Opt-in per config.

3. **Binary/non-markdown files** — **NON-ISSUE.** docs/ and planning/ are ~95% markdown. PDFs exist only in `test-media/` (outside sync scope). No images in docs directories. Git-only fallback for binaries is prudent but low priority.

4. **Yjs Node.js client** — **TRIVIAL.** DocumentDO uses simplified protocol: `0x00` = Yjs update, `0x01` = awareness. Server sends full state on connect. ~50 lines with `ws` + `yjs` + `y-protocols` (all already installed). No new deps needed.

5. **Multi-worktree file identity** — **RESOLVED.** Entity ID derived from relative path only (worktree-agnostic). e.g., `docs/planning/specs/0005.md` → `docs--planning--specs--0005`. Multiple worktrees with same file → same Yjs room.

### Remaining Open Questions

1. **Initial hydration** — First startup with existing files: bulk-push to Yjs (could be 100+ files), or lazy-create on first edit? Bulk is simpler but creates a thundering-herd on the collab worker.

2. **Entity lifecycle** — File deleted from worktree → disconnect from Yjs room? Mark entity as deleted? If another worktree still has the file, the entity should stay alive. Need reference counting or presence-based lifecycle.

3. **Frontmatter conflicts** — When synced to entity fields, the platform handles field-level conflict resolution (LWW per field). When stored in `Y.Map('meta')`, Yjs provides LWW per key. Both are acceptable for metadata like status/priority.

4. **Yjs doc cleanup** — DocumentDO creates a new DO per file. With 100+ docs files, that's 100+ persistent DOs. Is there a garbage collection strategy for DOs that haven't been accessed in a long time?

---

## Non-Goals

- **Syncing binary files** — text files only (`.md`, `.mdx`, `.yaml`). Binary sync is a different problem.
- **Replacing git** — mdsync uses a dedicated branch, not the user's working branches.
- **SSH as default auth** — HTTPS with credential helper. SSH supported but secondary.
- **Plugin/extension runtime in v1** — hook points defined but not exposed as loadable plugins.
- **Monorepo-aware multi-branch sync** — one sync branch per config.
- **Custom BlockNote blocks** — standard GFM markdown only for file-backed docs.
