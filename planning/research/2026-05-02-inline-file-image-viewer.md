---
date: 2026-05-02
topic: Inline file/image viewer in session chat
type: feature
status: complete
github_issue: null
items_researched: 5
---

# Research: Inline file/image viewer in session chat

## Context

User-uploaded images render inline today, but the **paths emitted by tools**
(Read/Write/Edit/Glob/Grep/Notebook*/Bash) appear as plain JSON text in tool
input/output blocks. Users can't preview an image referenced by a Read call,
can't open the file Edit just touched, and can't quickly inspect a file
listed by Glob — they have to switch to a separate editor or terminal.

The ask is: detect file paths inside tool blocks and render them as
clickable chips that open an inline viewer (image / text-with-syntax / pdf)
sourced from the session's worktree on the VPS.

## Scope

**Items researched (5):**
1. Gateway HTTP API surface + auth pattern
2. Session ↔ worktree path mapping (D1 schema, resolution chain)
3. `/api/sessions/media/*` precedent + R2 streaming patterns
4. Tool input/output path field inventory (Claude Agent SDK)
5. `ai-elements/attachments.tsx` + Streamdown plugin landscape

**Sources:** codebase (`packages/agent-gateway/`, `apps/orchestrator/src/`,
`packages/ai-elements/`, `apps/orchestrator/src/db/schema.ts`),
`docs/modules/agent-gateway.md`, recent git log.

## Findings

### 1. Gateway HTTP API surface + auth

**The gateway already exposes the file-read primitive we need.**

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/projects/:name/files?path=&depth=1-5` | Directory listing |
| `GET` | `/projects/:name/files/*path` | Raw file bytes, MIME-typed, **1 MB cap** |
| `GET` | `/projects/:name/git-status` | Porcelain status |

- **Auth:** `Authorization: Bearer <CC_GATEWAY_API_TOKEN>` (timing-safe compare,
  `packages/agent-gateway/src/auth.ts:1-37`). Open mode if env unset.
- **Path safety:** `safePath()` rejects `..` and resolves under project root
  (`packages/agent-gateway/src/files.ts:36-42`).
- **Error shape:** `{ ok: false, error: '<code>', detail?: '<msg>' }`.
- **No D1 access** in the gateway — it only knows projects via `/data/projects/*`
  filesystem discovery.
- **No streaming**: responses are buffered (1 MB cap is the safety valve).
- **Pattern for new routes**: inline `path.match()` blocks in
  `server.ts:fetch()` (lines 85-391), no separate router file.

**Implication:** No new gateway endpoint needed for v1. The Worker proxies to
the existing `/projects/:name/files/*path`.

### 2. Session ↔ worktree path mapping

**Schema chain (D1):**
```
agent_sessions.worktreeId  →  worktrees.id  →  worktrees.path  (absolute)
agent_sessions.project     →  project name (already a column)
```

Relevant tables in `apps/orchestrator/src/db/schema.ts`:
- `agent_sessions` (lines 148-247): `id`, `userId`, `arcId`, `project`,
  `worktreeId` (nullable for read-only modes), `runnerSessionId`, …
- `arcs` (lines 268-305): `id`, `userId`, `worktreeId` (nullable),
  `externalRef`, `parentArcId`
- `worktrees` (lines 351-372): `id`, `path` (UNIQUE, NOT NULL), `branch`,
  `status`, `reservedBy`, `ownerId`

**Resolution query:**
```sql
SELECT w.path, s.project
  FROM agent_sessions s
  JOIN worktrees w ON s.worktreeId = w.id
 WHERE s.id = ?
```

**Gateway has zero D1 access** (confirmed: no Drizzle imports in
`packages/agent-gateway/src/`). The Worker must do the lookup and pass the
project name to the gateway.

**Reusable path-safety utility:**
`packages/docs-runner/src/path-safety.ts:assertWithinRoot()` — handles
`path.sep` correctly, exact-root case included.

**Edge cases:**
- `worktreeId` is **NULL** for read-only modes (research, planning, freeform)
  → viewer must handle gracefully ("not available for this session").
- Session can outlive its worktree row (admin hard-delete) — query returns 0
  rows, viewer 404s cleanly.
- Two sessions can share a worktree (intentional, via arc inheritance) —
  no special handling needed.
- `worktrees.path` is immutable once inserted (the gateway sweep upsert
  touches `branch` + `lastTouchedAt`, never `path`) — safe to cache.

### 3. `/api/sessions/media/*` precedent + R2 streaming

**Route**: `apps/orchestrator/src/api/index.ts:1275-1288`. Mounted **before**
`authMiddleware` so `<img>` tags work during cookie refresh.

**Auth model**: NONE on the route — relies on **unguessable R2 keys**
(`session-media/<sessionId>/<messageId>/<index>.<ext>`). Other session routes
use `getAccessibleSession()` (`api/index.ts:263-283`) which validates
owner / public / admin.

**R2 streaming pattern:**
```typescript
const obj = await c.env.SESSION_MEDIA.get(key)
const headers = new Headers()
obj.writeHttpMetadata(headers)            // MIME from R2 metadata
headers.set('ETag', obj.httpEtag)
headers.set('Cache-Control', 'public, max-age=31536000, immutable')
return new Response(obj.body, { headers })
```

**Upload offload threshold**: 1 MiB (`message-parts.ts:38`,
`MAX_PARTS_JSON_BYTES`). DO SQLite caps TEXT/BLOB ~2 MB per row.

**MIME detection**: explicit (provided by SDK ContentBlock `media_type`),
stored in R2 metadata. **No magic-byte sniffing.**

**Reusability for worktree file viewer:**
| Component | Reuse? | Why |
|-----------|--------|-----|
| Auth model | ❌ | Worktree files aren't content-addressed; need `getAccessibleSession` |
| R2 streaming | ⚠️ partial | Pattern works but file bytes come from gateway-proxy, not R2 |
| Cache headers | ❌ | Worktree files mutate; use ETag + conditional, not 1y immutable |
| MIME detection | ❌ | Whitelist is image-only; need extension-based mapping (e.g. `mime-db` slice) |
| Route registration | ✓ | But mount **after** `authMiddleware` |

### 4. Tool input/output path field inventory

**Structured path fields (safe to detect):**

| Tool | Input | Output |
|------|-------|--------|
| Read | `file_path` | `filePath` |
| Write | `file_path` | `filePath` |
| Edit | `file_path` | `filePath` |
| NotebookEdit | `notebook_path` | `notebook_path` |
| Glob | `path` (optional) | `filenames[]` |
| Grep | `path` (optional) | `filenames[]` |
| Bash | (free-text in `command`) | `rawOutputPath`, `persistedOutputPath` (when present) |

**Free-text paths** in Bash `command` and stdout/stderr exist but have high
false-positive rate — **defer to v2** (or a regex pass with strict allowlist).

**MCP tools**: zero custom MCP tool registrations in this codebase
(searched `apps/orchestrator/`, `packages/`).

**Path conventions in the wild**: always **absolute**, never relative.
SDK file tools enforce absolute-only. Glob `pattern` field carries glob
syntax (`**/*.tsx`) — exclude from detector.

**Existing partial detector**: `ChatThread.tsx:71-76` already has
`getFilePath(part)` extracting `file_path`/`notebook_path`. Currently unused
for rendering. Extending this is the natural starting point.

**Detector strategy**: structured-field-only for v1. Bulletproof.

### 5. `ai-elements/Attachments` + Streamdown plugins

**`Attachments` component family** (`packages/ai-elements/src/components/attachments.tsx`):
- `Attachments`, `Attachment`, `AttachmentPreview`, `AttachmentInfo`,
  `AttachmentRemove`, `AttachmentHoverCard*`, `AttachmentEmpty`.
- 5 MIME categories (image / video / audio / document / source-doc).
- `AttachmentPreview` accepts a URL (✓) — not just base64.
- **Critical limitation**: previews are `<img>` / `<video>` only. PDF, text,
  code → icon + label fallback.

**`Image` component** (`ai-elements/src/components/image.tsx`): base64-only.
**Don't use** for URL-served files.

**`CodeBlock`** (`ai-elements/src/components/code-block.tsx`): Shiki-based,
~200 languages, github-light/dark themes. Caller must pass `language` (no
auto-detect). Async token caching — fine for large blocks.

**PDF**: nothing in tree. Options: `react-pdf` (~60 KB gz, viewer controls)
or `<iframe>` fallback.

**Streamdown plugins** (`message.tsx:270`): `cjk, code, math, mermaid`
shipped. **No image-rendering hook visible** — markdown `![](path)`
customization would require either a custom remark plugin (research needed
into Streamdown's hook API) or a parallel renderer wrapper. **Defer to v2.**

**Drawer/Sheet**: `apps/orchestrator/src/components/ui/sheet.tsx` (Radix
Dialog under the hood, slide animations, customizable sides). Import path
is in the orchestrator app, not `ai-elements`.

**`media-chrome` ^4.19.0** is already a dep — covers audio/video viewers
if we ever extend.

## Comparison

### v1 architecture options

| Option | Files touched | New deps | Risk |
|--------|---------------|----------|------|
| **A. Worker proxies to existing gateway endpoint** | Worker route (~80 LOC) + frontend viewer | none required (PDF optional) | low — reuses safePath, existing endpoint, existing auth |
| B. New gateway endpoint `/sessions/:id/file` | Gateway handler + Worker route + frontend | none | medium — gateway needs session→worktree map (it currently has none) |
| C. Have the runner serve files via dial-back WS | Runner + transport + Worker + frontend | none | high — viewer breaks for terminated sessions; couples to runner liveness |

**Recommended: A.** B forces gateway changes for no real benefit; C breaks
the "view files of a finished session" UX.

### MIME → renderer dispatch (v1)

| MIME | Renderer | Notes |
|------|----------|-------|
| `image/*` | `AttachmentPreview` w/ URL | reuse existing |
| `text/plain`, `text/markdown` | `CodeBlock` lang=text/markdown | Shiki |
| `text/x-*` source code | `CodeBlock` w/ ext→lang map | small mapping table |
| `application/json` | `CodeBlock` lang=json | |
| `application/pdf` | `<iframe>` (v1) or `react-pdf` (v1.5) | iframe is zero-dep |
| anything else | "Download" link + size + mime | bail-out |

## Recommendations

### Architecture (recommended: Option A)

```
Browser
  │  GET /api/sessions/:id/file?path=<absolute>
  ▼
Worker (Hono, behind authMiddleware)
  │  1. getAccessibleSession(id, user) → 401/404
  │  2. SELECT w.path, s.project FROM agent_sessions s
  │       JOIN worktrees w ON s.worktreeId = w.id WHERE s.id = ?
  │  3. assertWithinRoot(w.path, requestedPath)  ← Worker-side safety
  │  4. relPath = path.relative(w.path, requestedPath)
  ▼
Gateway (existing route, no code change)
  │  GET /projects/:project/files/<relPath>  Bearer <CC_GATEWAY_API_TOKEN>
  │  safePath() second line of defense
  ▼  Raw bytes + Content-Type, 1 MB cap
Worker streams response to browser with sane caching headers
```

**Net new code:**
- **Worker**: 1 route (~80 LOC) — auth check, D1 join, path safety, gateway proxy
- **Frontend**: extend `getFilePath()` detector to cover all SDK tools' input
  + output fields, render path chips inside `ToolInput`/`ToolOutput`, add
  Sheet-based viewer with MIME→renderer dispatch
- **Optional**: `react-pdf` dep if PDF in v1
- **Defer**: Streamdown image plugin (no clean hook), free-text Bash path
  detection, file editing, diff view

**Sketch sizes:**
- Worker route + tests: ~½ day
- Frontend detector + chip + Sheet viewer + MIME dispatch: ~1.5 days
- PDF support (if in v1): ~½ day
- Total: ~2-3 days

### Out of scope for v1
- File editing (read-only)
- Diff view (file-at-time-A vs file-at-time-B)
- Mobile-expo client (Capacitor sunsetting)
- Vision-tool image content blocks (tools emit paths, not embedded images)
- Free-text path detection in Bash output
- Markdown `![](path)` rendering (requires Streamdown hook research)

## Open Questions

1. **Sessions without worktreeId** (research/planning/freeform modes have
   NULL): hide chips entirely, or show with "viewer unavailable" tooltip?
2. **Out-of-worktree paths** (e.g. tool reads `/etc/hosts`, paths in
   sibling projects): reject (recommended) vs allow with allowlist?
3. **PDF in v1**: ship with `react-pdf` (60 KB gz) or `<iframe>` fallback,
   or defer to v2?
4. **Viewer surface**: side Sheet (recommended), centered Dialog, or
   inline expand-in-place?
5. **Size cap**: keep gateway's 1 MB or raise for text-only files (large
   logs)?
6. **Cache headers**: short TTL with ETag (recommended), no-cache, or
   match the immutable pattern (wrong for mutable files)?
7. **Click-from-Bash-stdout**: defer to v2 (recommended) or scope in?

## Next Steps

1. Run interview phase (P1) to lock answers to the 7 open questions.
2. Write spec (P2) anchored to:
   - B-IDs for: detect-paths, render-chip, gate-by-session-ownership,
     resolve-worktree, path-safety, render-by-mime, handle-no-worktree.
   - Phases: Worker route → frontend detector + chip → viewer Sheet →
     MIME renderers → telemetry/error states.
3. Spec review (P3) → close (P4).
