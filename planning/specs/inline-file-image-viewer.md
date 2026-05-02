---
initiative: inline-file-image-viewer
type: project
issue_type: feature
status: approved
priority: medium
github_issue: null
created: 2026-05-02
updated: 2026-05-02
phases:
  - id: p1
    name: "Backend: Worker file-read route + gateway 5MB text bump"
    tasks:
      - "Bump gateway text-MIME size cap to 5 MB while keeping binary at 1 MB (packages/agent-gateway/src/files.ts)"
      - "Add Worker route GET /api/sessions/:id/file?path= with auth, /data/projects/* safety check, .. rejection, gateway proxy"
      - "Wire Vitest coverage for the route — auth gate, path-safety (incl. ..), success body, 400, 404, 413, 502"
    test_cases:
      - "GET /api/sessions/<id>/file?path=/data/projects/<proj>/README.md returns 200 + text body with correct Content-Type"
      - "Same call with no auth cookie returns 401"
      - "Same call with path=/etc/hosts returns 400 'path outside /data/projects/'"
      - "Same call with path=/data/projects/foo/../../etc/passwd returns 400 'path traversal not allowed' (Worker rejects, never reaches gateway)"
      - "Text file >1MB but <5MB returns 200; binary file >1MB returns 413"
      - "Gateway down → 502 with {ok:false, error:'gateway unreachable'}"
  - id: p2
    name: "Frontend: viewer Sheet + MIME→renderer dispatch"
    tasks:
      - "Add FileViewerSheet component (right-side Sheet, opened by setActiveFilePath in store)"
      - "Add MIME→renderer dispatch: image / text+code (CodeBlock) / pdf (iframe) / fallback (download + 'view as text')"
      - "Add ext→Shiki language map for CodeBlock"
      - "Add path→FileViewer store (Zustand or signal): activePath, open, close, history"
    test_cases:
      - "Manually call openFile('/data/projects/duraclaw-dev4/README.md') from devtools — Sheet opens with Shiki-rendered markdown"
      - "openFile with image path renders <img>"
      - "openFile with PDF renders <iframe>"
      - "openFile with binary .so renders error card + Download button"
  - id: p3
    name: "Frontend: chip detection in assistant prose (Streamdown components.inlineCode)"
    tasks:
      - "Add SessionIdContext + provider; wrap VirtualizedMessageList with it"
      - "Add PathChip component: detects path-shape in inline code content, renders chip (icon + filename), otherwise <code>"
      - "Wire components={{ inlineCode: PathChip }} in MessageResponse for assistant messages only"
      - "Add isPathLike(text) heuristic: contains '/' OR matches /\\.(tsx?|jsx?|py|rs|go|java|md|json|ya?ml|toml|css|scss|html|sql|sh|env)$/"
    test_cases:
      - "Render an assistant message containing 'See `apps/orchestrator/src/foo.tsx`' — backticked path is a chip; clicking opens viewer"
      - "Render an assistant message containing '`useState` hook' — `useState` stays as plain inline code (no slash, no extension)"
  - id: p4
    name: "Frontend: chips in tool panel (ToolInput / ToolOutput)"
    tasks:
      - "Modify ToolInput to parse JSON, swap known path fields (file_path, notebook_path, path) for PathChip components"
      - "Modify ToolOutput similarly: filenames[] → list of chips; filePath echo → chip"
      - "Apply to all path-bearing tools (Read, Write, Edit, NotebookEdit, Glob, Grep)"
    test_cases:
      - "Read tool block: file_path field renders as a chip instead of JSON value; clicking opens viewer"
      - "Glob tool result with 25 filenames renders 25 chips inside the existing tool result panel"
      - "Bash tool block renders unchanged (no chip injection in v1)"
  - id: p5
    name: "Polish: thumbnails, copy-path menu, error UX, telemetry, verification"
    tasks:
      - "IntersectionObserver lazy-load for image thumbnails (image-MIME chips)"
      - "Right-click / ellipsis chip menu: 'Copy path' (B10)"
      - "Cache headers on file route: Cache-Control no-cache, ETag passthrough"
      - "Error card UX: 502 retry, 404 refresh, 413 download, binary 'view as text' override"
      - "Telemetry log: chip click events with mime, size, hit/miss"
      - "Run full Verification Plan (see below)"
    test_cases:
      - "Image-MIME path renders a thumbnail in the chip; thumbnail only fetches when scrolled into viewport"
      - "Copy path action puts the absolute path on the clipboard"
      - "All Verification Plan steps pass"
      - "Lighthouse audit on a session page with 50+ chips shows no significant regression"
---

# Inline File / Image Viewer in Session Chat

## Overview

When the assistant references a file path in its messages — e.g. ``"I've updated `apps/orchestrator/src/foo.tsx`"`` — that path becomes a clickable chip that opens an inline viewer (image preview / syntax-highlighted code / PDF / download fallback) sourced live from the session's worktree on the VPS. The same chip component is used inside tool input/output panels for `Read`/`Write`/`Edit`/`Glob`/`Grep`/`NotebookEdit` structured path fields. This closes the "I can't see the file the assistant is talking about without leaving the chat" gap that exists today, while reusing existing primitives (`AttachmentPreview`, `CodeBlock`, `Sheet`, the gateway's `/projects/:name/files/*path` endpoint).

## Feature Behaviors

### B1: Detect backticked path tokens in assistant prose

**Core:**
- **ID:** detect-path-in-prose
- **Trigger:** Streamdown renders an assistant message containing inline code spans (``` `foo` ```).
- **Expected:** Inline code whose content matches `isPathLike` (contains `/` OR ends with a known source/asset extension) renders as a `PathChip` component. Non-matching inline code renders as the default `<code>` element.
- **Verify:** Render the assistant message ``See `src/foo.tsx` and the `useState` hook.``. The first inline-code becomes a chip; the second stays plain `<code>`.
**Source:** new file `packages/ai-elements/src/components/path-chip.tsx`; modify `packages/ai-elements/src/components/message.tsx:268-282` to add `components.inlineCode`.

#### UI Layer
- `PathChip` props: `path: string`, `mime?: string`, `size?: 'sm' | 'md'`.
- Visual: pill-shaped, monospace text, file-type icon prefix (Lucide), hover highlight. Image MIME → 24×24 thumbnail prefix instead of icon (lazy-loaded).
- Right-click / kebab menu: "Copy path", "Open externally" (disabled, v2 placeholder).
- Click → calls `openFileViewer(path)` (zustand store).

#### Data Layer
- `isPathLike(text: string): boolean`:
  - `text.includes('/')` OR
  - `/\.(tsx?|jsx?|py|rs|go|java|md|json|ya?ml|toml|css|scss|html|sql|sh|env|svg|png|jpe?g|gif|webp|pdf)$/i.test(text)`.

### B2: Open file viewer in right-side Sheet

**Core:**
- **ID:** file-viewer-sheet
- **Trigger:** Any chip click, programmatic `openFileViewer(path)` call, or TanStack Router navigation with `?file=<path>` in the search params.
- **Expected:** Right-side `Sheet` opens at ~45% viewport width on viewports ≥768px, full-width on viewports <768px. Body renders via MIME-dispatch. Closing the Sheet does not reset the chat scroll position. Closing also clears the `?file=` search param via `router.navigate({ search: (s) => ({ ...s, file: undefined }) })` so back-button works as expected.
- **Verify:** Click a chip in any session — Sheet slides in from the right, chat thread remains visible in the left ~55%, scroll position unchanged. URL gains `?file=<path>` (URL-encoded). Browser back button closes the Sheet.
**Source:** new files `apps/orchestrator/src/features/file-viewer/file-viewer-sheet.tsx`, `apps/orchestrator/src/features/file-viewer/store.ts`. Modify the dashboard route's search schema in `apps/orchestrator/src/routes/index.tsx` (or wherever `?session=` is currently declared) to add `file?: string`.

#### UI Layer
- Header: filename (bold), full path (muted, with copy icon), size, mtime.
- Body: MIME dispatch (see B3-B6).
- Footer: Close button, optional "Download raw" button (always available).
- Esc key closes the Sheet.

#### Data Layer
- Zustand store `useFileViewerStore`:
  - `activePath: string | null`
  - `setActivePath(path: string | null)` — also calls `router.navigate` to sync the URL.
  - `recent: string[]` (last 10 opened paths, in-memory only).
- TanStack Router search-param schema (extend the existing route that already declares `session?: string`):
  ```typescript
  validateSearch: z.object({
    session: z.string().optional(),
    file: z.string().optional(),  // new
  })
  ```
  On mount, the dashboard route reads `search.file` and seeds `useFileViewerStore.activePath` if present.

### B3: Render image files inline

**Core:**
- **ID:** view-image
- **Trigger:** File viewer opens with a path whose Content-Type matches `image/*`.
- **Expected:** Body renders a centered `<img src="/api/sessions/:id/file?path=…">` with object-fit-contain inside the Sheet body.
- **Verify:** Open a session whose worktree has a `.png` — chip appears, click opens Sheet showing the image.
**Source:** part of `file-viewer-sheet.tsx`; reuses `AttachmentPreview` from `packages/ai-elements/src/components/attachments.tsx` for thumbnails (chip prefix only) but uses a plain `<img>` for the full-size Sheet body to avoid the AttachmentPreview hover-card overhead.

### B4: Render text/code with Shiki syntax highlighting

**Core:**
- **ID:** view-text-code
- **Trigger:** File viewer opens with Content-Type `text/*` or `application/json`/`application/xml`/`application/yaml`/`application/toml`.
- **Expected:** Body renders `<CodeBlock>` with `language={mapExtToShiki(extname(path))}`. Long files scroll inside the Sheet body (no global scroll). Tab indentation, monospace, github-light/dark theme.
- **Verify:** Open a `.tsx` file — code renders with TypeScript syntax highlighting; line wrapping disabled; horizontal scroll for long lines.
**Source:** reuses `CodeBlock` from `packages/ai-elements/src/components/code-block.tsx`; new helper `mapExtToShiki(ext: string): BundledLanguage` in `apps/orchestrator/src/features/file-viewer/lang-map.ts`.

### B5: Render PDFs in iframe fallback

**Core:**
- **ID:** view-pdf
- **Trigger:** File viewer opens with Content-Type `application/pdf`.
- **Expected:** Body renders `<iframe src="/api/sessions/:id/file?path=…" type="application/pdf">` filling the Sheet body. Browser-native PDF viewer renders.
- **Verify:** Open a session, drop a `.pdf` into the worktree, click a chip referencing it — PDF renders in-Sheet with browser controls.
**Source:** part of `file-viewer-sheet.tsx`. No new deps.

### B6: Render error card for unrenderable / missing / oversized / unreachable files

**Core:**
- **ID:** view-error-fallback
- **Trigger:** File viewer fetch returns 400, 401, 404, 413, 502, OR Content-Type cannot be matched to a renderer (B3-B5).
- **Expected:** Body renders an error card with title and message keyed to the failure mode:
  - `400 invalid path` → "Path not allowed (must be under /data/projects/)"
  - `401 unauthorized` → "Session expired — please sign in"
  - `404 file not found` → "File not found at <path>" + "Maybe it was moved or deleted since the agent saw it." + Refresh button
  - `413 file too large` → "File exceeds N MB limit" + Download Raw button
  - `502 gateway unreachable` → "Worktree unavailable — gateway is offline. Retry?" + Retry button (refetch on click)
  - Unrenderable MIME → "Cannot preview — <mime>" + Download Raw + "View as text" (if size ≤ 5 MB)
  All cards include the file metadata row (size, mtime, mime) when known from response headers.
- **Verify:**
  - Open a `.so`/`.wasm`/`.zip` — "Cannot preview — application/octet-stream" with Download + View as text.
  - Stop the gateway (`systemctl --user stop duraclaw-agent-gateway`), reopen any chip — 502 card with Retry.
  - Open a chip whose path was deleted between message and click — 404 card with Refresh.
**Source:** part of `file-viewer-sheet.tsx`.

### B7: Worker file-read route

**Core:**
- **ID:** worker-file-route
- **Trigger:** Authenticated `GET /api/sessions/:id/file?path=<absolute>` from the browser.
- **Expected:**
  1. `getAccessibleSession(id, user)` validates session access — 401 / 404 on miss.
  2. Validate `path` starts with `/data/projects/`. Reject otherwise → 400.
  3. Extract `<project>/<rest>` from the path. Compute `relPath = rest`.
  4. Proxy `GET <CC_GATEWAY_URL>/projects/<project>/files/<relPath>` with `Authorization: Bearer <CC_GATEWAY_API_TOKEN>`.
  5. Stream the gateway response back with `Content-Type` preserved, `Cache-Control: no-cache`, `ETag` derived from the gateway's response (if present) or a sha256 of the body.
- **Verify:** `curl -b cookie http://localhost:43xxx/api/sessions/<id>/file?path=/data/projects/duraclaw-dev4/README.md` returns 200 + the file body with `Content-Type: text/markdown`.
**Source:** new route in `apps/orchestrator/src/api/index.ts` (mount AFTER `authMiddleware` — distinct from `/api/sessions/media/*` which mounts before).

#### API Layer
- `GET /api/sessions/:id/file?path=<absolute-path>`
  - Auth: cookie session (Better Auth)
  - Query: `path` (required, absolute under `/data/projects/`)
  - Response success: 200 + file body, `Content-Type` from gateway, `Cache-Control: no-cache`, `ETag`
  - Response errors:
    - `400 { ok: false, error: 'invalid path', detail: 'must start with /data/projects/' }`
    - `401 { ok: false, error: 'unauthorized' }`
    - `404 { ok: false, error: 'session not found' }` or `'file not found'` (proxied from gateway)
    - `413 { ok: false, error: 'file too large', detail: 'limit: <bytes>' }`
    - `502 { ok: false, error: 'gateway unreachable' }`

### B8: Gateway 5MB text-MIME cap

**Core:**
- **ID:** gateway-text-cap-bump
- **Trigger:** `GET /projects/:name/files/*path` on the gateway returns a response whose detected MIME starts with `text/` or matches `application/json|xml|yaml|toml`.
- **Expected:** Allow up to 5 MB for those MIMEs. Binary stays at 1 MB. MIME detection uses extension first, falls back to the existing path; magic-byte sniffing is **out of scope** for v1.
- **Verify:** Place a 4 MB log file in a worktree, call `GET /projects/<name>/files/big.log` — returns 200 + body. Same with a 4 MB `.bin` returns 413.
**Source:** modify `packages/agent-gateway/src/files.ts:9` (current 1 MB constant); add `TEXT_MAX_BYTES = 5 * 1024 * 1024`, `BINARY_MAX_BYTES = 1024 * 1024`.

### B9: Tool panel chip rendering for structured path fields

**Core:**
- **ID:** tool-panel-chips
- **Trigger:** `ToolInput` or `ToolOutput` renders for any of these tools/fields:
  - Read/Write/Edit: input `file_path`, output `filePath`
  - NotebookEdit: input/output `notebook_path`
  - Glob/Grep: input `path` (optional), output `filenames[]`
- **Expected:** The matching JSON value(s) render as `PathChip` instances inline within the existing tool block. Other JSON keys render as the existing `CodeBlock`.
- **Verify:** Open a session containing a Read tool call. The `file_path` in the input panel renders as a chip; the rest (`limit`, `offset` if any) renders as JSON.
**Source:** modify `packages/ai-elements/src/components/tool.tsx:107-156` (`ToolInput` and `ToolOutput`).

#### UI Layer
- `ToolInput` parses `input` JSON, intercepts known fields, renders chip(s) above the residual JSON code block.
- `ToolOutput` similarly intercepts `filenames[]`, renders as a chip list; intercepts `filePath` echo, renders as a single chip.
- Bash tool: no interception in v1 (free-text command + stdout, deferred).

### B10: Copy-path chip action

**Core:**
- **ID:** chip-copy-path
- **Trigger:** Right-click on a `PathChip` or click on its kebab menu → "Copy path".
- **Expected:** Path is written to clipboard via `navigator.clipboard.writeText(path)`. Toast "Path copied" appears for ~1.5s.
- **Verify:** Right-click a chip → menu → click "Copy path" → paste somewhere; the absolute path is in the clipboard.
**Source:** `path-chip.tsx`; reuses existing toast primitive in `apps/orchestrator/src/components/ui/toaster.tsx`.

## Non-Goals

- **File editing in the viewer** — read-only.
- **Diff view** — no file-at-time-A vs file-at-time-B.
- **Snapshots / as-of-tool-call content** — viewer is always live.
- **Free-text path detection** in Bash command strings, stdout, or stderr — deferred to v2.
- **Bare relative paths in plain prose** (`src/foo.tsx` outside backticks) — deferred to v2.
- **Markdown link rewriting** (`[text](./path)`) — deferred to v2.
- **User-message prose chip rendering** — assistant messages only in v1.
- **Streamdown image plugin for `![](path)`** — no clean hook in current Streamdown version; deferred.
- **react-pdf** — iframe fallback is sufficient for v1.
- **Mobile-expo native client** — Capacitor sunsetting; SPA-only target.
- **File-existence pre-validation index** — speculative chip rendering, viewer 404s on miss.
- **Multi-tenant scoping** — viewer trusts any authenticated session-haver to read any file under `/data/projects/*`. Acceptable for current single-tenant deployment.
- **Streaming / chunked rendering for huge files** — 5 MB cap is the hard limit.
- **External-editor open** (`vscode://`, `cursor://`) — placeholder in chip menu, disabled in v1.

## Implementation Phases

See frontmatter. Five phases: backend route + gateway tweak → viewer Sheet + dispatch → prose chip detection → tool-panel chips → polish + verification.

**Per-phase unit-test expectation.** Vitest unit coverage is expected alongside each phase — not just the manual VP at the end. Specifically:
- P1: route handler tests (success / 400 / 401 / 404 / 413 / 502 / `..` rejection).
- P2: `mapExtToShiki` extension table; MIME→renderer dispatch returning the right component for each branch; `useFileViewerStore` actions.
- P3: `isPathLike` heuristic (positive + negative cases); `PathChip` rendering shape; `Streamdown components.inlineCode` override invocation.
- P4: `ToolInput`/`ToolOutput` JSON parse + chip swap for each path-bearing field.
- P5: thumbnail IntersectionObserver gating; copy-path action.

## Verification Plan

These steps run on a freshly deployed branch, against a logged-in browser session in `apps/orchestrator` dev mode at `http://localhost:43xxx` (the orchestrator port for this worktree, see `.claude/rules/worktree-setup.md`).

### Backend (B7, B8)

1. `pnpm --filter @duraclaw/agent-gateway build && systemctl --user restart duraclaw-agent-gateway` (or local `bun run`).
2. `cd apps/orchestrator && pnpm dev` — wait for "ready on http://localhost:43xxx".
3. Sign in via the browser, open devtools, copy the session cookie value, export as `COOKIE`.
4. Find an existing session id via the dashboard; export as `SID`.
5. **B7-success**: `curl -b "duraclaw-session=$COOKIE" "http://localhost:43xxx/api/sessions/$SID/file?path=/data/projects/duraclaw-dev4/README.md"` — expect 200 + markdown body, `Content-Type: text/markdown`.
6. **B7-401**: same call without `-b` — expect 401 + `{"ok":false,"error":"unauthorized"}`.
7. **B7-400-out-of-tree**: `?path=/etc/hosts` — expect 400 + `{"ok":false,"error":"invalid path",...}`.
8. **B7-400-traversal**: `?path=/data/projects/duraclaw-dev4/../../etc/passwd` — expect 400 + `{"ok":false,"error":"path traversal not allowed"}` from the Worker (gateway never receives the request — verify by tailing the gateway log and confirming no entry).
9. **B7-404**: `?path=/data/projects/duraclaw-dev4/does-not-exist.txt` — expect 404.
10. **B8-text-bump**: create a 4 MB text file in the worktree (`yes 'aaaa' | head -c 4194304 > /tmp/big.txt; cp /tmp/big.txt /data/projects/duraclaw-dev4/big.txt`), `?path=/data/projects/duraclaw-dev4/big.txt` — expect 200 + 4 MB body.
11. **B8-binary-cap**: copy a 4 MB binary (`dd if=/dev/urandom of=/data/projects/duraclaw-dev4/big.bin bs=1M count=4`), `?path=...big.bin` — expect 413.
12. **B7-413-text**: 6 MB text file, `?path=...` — expect 413.

### Frontend (B1-B6, B9, B10)

13. **Seed an assistant message with controlled content.** Open the SessionDO's SQLite via wrangler:
    ```bash
    wrangler d1 execute duraclaw-dev --local --command \
      "INSERT INTO messages (session_id, role, parts, created_at)
         VALUES ('$SID', 'assistant',
                 json('[{\"type\":\"text\",\"text\":\"Look at \`apps/orchestrator/src/foo.tsx\` and the \`useState\` hook.\"}]'),
                 unixepoch()*1000)"
    ```
    (For remote D1, drop `--local` and use `wrangler d1 execute duraclaw --remote`.) Refresh the session view in the browser.
14. **B1-positive**: `apps/orchestrator/src/foo.tsx` renders as a chip (pill, monospace, file-type icon).
15. **B1-negative**: `useState` renders as plain inline code (no chip).
16. **B2 + B4**: click the chip — Sheet slides in from the right, ~45% width. Chat remains visible. Body shows TSX-highlighted code. URL gains `?file=/data/projects/duraclaw-dev4/apps/orchestrator/src/foo.tsx` (URL-encoded). Browser back closes the Sheet.
17. **B6-missing**: in the URL `?file=/data/projects/duraclaw-dev4/missing.tsx` (or click a chip pointing at a non-existent file) — Sheet shows error card "File not found" + Download button.
18. **B3-image**: have a tool emit `Read({file_path: "/data/projects/duraclaw-dev4/some-image.png"})`. Chip renders with thumbnail. Click → Sheet shows full image.
19. **B5-pdf**: same with a `.pdf`. Chip renders without thumb (fallback icon). Click → iframe-rendered PDF.
20. **B6-binary**: tool emits a path to a `.so` or `.wasm`. Click chip → error card "Cannot preview — binary file". Click "View as text" → CodeBlock with garbled or readable content depending on file.
21. **B9-tool-panel**: open a session with a recent Read or Glob call. Inspect the tool block — `file_path` (Read) or `filenames[]` (Glob) render as chips inside the existing tool panel. Other fields stay as JSON.
22. **B10-copy**: right-click a chip → menu → "Copy path" → paste into the address bar; the absolute path is there.
23. **B1-thumb-lazy**: scroll a long message containing 20+ image-path chips. Open Network tab — image GETs only fire as chips scroll into the viewport.
24. **B2-deep-link**: navigate to `?session=<id>&file=/data/projects/duraclaw-dev4/README.md` — Sheet auto-opens with the file.

## Implementation Hints

### Key Imports

```typescript
// Sheet
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '~/components/ui/sheet'

// Streamdown components override
import type { Components } from 'streamdown'
import { Streamdown } from 'streamdown'

// Existing rendering primitives
import { CodeBlock, CodeBlockContent } from '@duraclaw/ai-elements'
import { AttachmentPreview } from '@duraclaw/ai-elements'

// Path-safety prior art (do NOT depend on docs-runner package; copy the function or move it to shared)
// Reference: packages/docs-runner/src/path-safety.ts:assertWithinRoot
import path from 'node:path'

// Shiki languages — keep narrow to control bundle
import type { BundledLanguage } from 'shiki/bundle/web'
```

### Code Patterns

**1. Streamdown components override (`message.tsx`)**
```tsx
const PathChipInlineCode: Components['inlineCode'] = ({ children, ...props }) => {
  const text = typeof children === 'string' ? children : String(children ?? '')
  if (isPathLike(text)) return <PathChip path={text} size="sm" />
  return <code {...props}>{children}</code>
}

const streamdownComponents: Components = { inlineCode: PathChipInlineCode }

// Only override for assistant messages — gate at MessageResponse caller, OR pass `components` conditionally:
<Streamdown
  plugins={streamdownPlugins}
  components={role === 'assistant' ? streamdownComponents : undefined}
  {...props}
/>
```

**2. Worker route skeleton (`apps/orchestrator/src/api/index.ts`)**
```typescript
app.get('/api/sessions/:id/file', authMiddleware, async (c) => {
  const sessionId = c.req.param('id')
  const path = c.req.query('path')
  if (!path?.startsWith('/data/projects/')) {
    return c.json({ ok: false, error: 'invalid path', detail: 'must start with /data/projects/' }, 400)
  }
  const session = await getAccessibleSession(c.env, sessionId, c.var.userId, c.var.role)
  if (!session.ok) return c.json({ ok: false, error: 'session not found' }, session.status as 401 | 404)

  // Extract project name and relative path
  const rest = path.slice('/data/projects/'.length)
  const slashIdx = rest.indexOf('/')
  if (slashIdx <= 0) return c.json({ ok: false, error: 'invalid path' }, 400)
  const project = rest.slice(0, slashIdx)
  const relPath = rest.slice(slashIdx + 1)

  // Proxy to gateway
  const url = `${c.env.CC_GATEWAY_URL}/projects/${encodeURIComponent(project)}/files/${relPath
    .split('/').map(encodeURIComponent).join('/')}`
  const upstream = await fetch(url, {
    headers: { authorization: `Bearer ${c.env.CC_GATEWAY_API_TOKEN}` },
  })
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '')
    return c.body(body, upstream.status as 400 | 404 | 413 | 502, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    })
  }
  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  headers.set('cache-control', 'no-cache')
  const etag = upstream.headers.get('etag')
  if (etag) headers.set('etag', etag)
  return new Response(upstream.body, { headers })
})
```

**3. Gateway 5MB text bump (`packages/agent-gateway/src/files.ts`)**
```typescript
// Replace the existing const MAX_FILE_SIZE = 1024 * 1024 (verify exact name in file before editing)
const TEXT_MAX_BYTES = 5 * 1024 * 1024
const BINARY_MAX_BYTES = 1024 * 1024

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml',
                            'application/yaml', 'application/toml',
                            'application/x-yaml', 'application/x-toml']
function isTextMime(mime: string) {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))
}

// In handleFileContents:
const stat = await fs.stat(absPath)
const mime = mimeFromPath(absPath) // existing util
const cap = isTextMime(mime) ? TEXT_MAX_BYTES : BINARY_MAX_BYTES
if (stat.size > cap) return new Response(JSON.stringify({ ok: false, error: 'file too large', detail: `limit: ${cap}` }), { status: 413 })
```

**4. PathChip with thumbnail lazy-load**

> **Session-id source.** The chip is rendered deep inside Streamdown's tree
> with no explicit prop path. The session id comes from a React context provider
> wrapped around the message list — see `apps/orchestrator/src/features/agent-orch/ChatThread.tsx`.
> Add a small `SessionIdContext` (new file `apps/orchestrator/src/features/agent-orch/session-id-context.tsx`),
> wrap the `VirtualizedMessageList` in it with the current session id, and have
> `useCurrentSessionId()` read from that context. Do NOT use Zustand for this — the
> chip needs the *containing* session, not the *active* session (consider opening
> a fork/branch session in a side panel; both render chips against their own files).

```tsx
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useFileViewerStore } from '~/features/file-viewer/store'

const SessionIdContext = createContext<string | null>(null)
export const SessionIdProvider = SessionIdContext.Provider
export function useCurrentSessionId(): string {
  const id = useContext(SessionIdContext)
  if (!id) throw new Error('PathChip must be rendered inside <SessionIdProvider>')
  return id
}

export function PathChip({ path, size = 'md' }: { path: string; size?: 'sm' | 'md' }) {
  const open = useFileViewerStore((s) => s.setActivePath)
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(path)
  const sessionId = useCurrentSessionId()
  const ref = useRef<HTMLSpanElement | null>(null)
  const [showThumb, setShowThumb] = useState(false)

  useEffect(() => {
    if (!isImage || !ref.current) return
    const obs = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setShowThumb(true),
      { rootMargin: '200px' },
    )
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [isImage])

  const url = `/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`
  return (
    <span ref={ref} className="inline-flex items-center gap-1 ...">
      {isImage && showThumb ? (
        <img src={url} alt="" className="size-6 rounded object-cover" />
      ) : (
        <FileIcon path={path} className="size-3.5 text-muted-foreground" />
      )}
      <button type="button" onClick={() => open(path)} className="font-mono text-xs ...">
        {basename(path)}
      </button>
      <ChipMenu path={path} />
    </span>
  )
}
```

**5. MIME → renderer dispatch in FileViewerSheet**
```tsx
function FileViewerBody({ url, mime, path }: { url: string; mime: string; path: string }) {
  if (mime.startsWith('image/')) return <img src={url} alt={path} className="..." />
  if (mime === 'application/pdf') return <iframe src={url} title={path} className="size-full" />
  if (isTextMime(mime)) {
    return <CodeBlockFromUrl url={url} language={mapExtToShiki(extname(path))} />
  }
  return <BinaryFallback url={url} path={path} mime={mime} />
}
```

### Gotchas

- **Streamdown `inlineCode` content type** — `children` may be a string or a single-child array depending on adjacent markdown formatting. Coerce defensively.
- **Streamdown `components` prop** — verify with a quick render: `<Streamdown components={...}>...</Streamdown>` actually invokes the override. The `inlineCode` key is documented in `node_modules/streamdown/dist/index.d.ts:62` but Streamdown is a thin wrapper around `react-markdown`; if behavior differs, fall back to `components.code` and check `inline === true`.
- **CodeBlock URL fetch** — `CodeBlockContent` expects `code: string` synchronously. For files we need a small `<CodeBlockFromUrl>` wrapper that fetches and gates rendering on a Suspense boundary or a loading spinner. ETag-aware fetch is fine.
- **Auth check ordering** — mount the file route AFTER `authMiddleware`. The `/api/sessions/media/*` route is the *only* `/api/sessions/*` route that bypasses auth (api/index.ts:1275-1288 comment is explicit). Don't paste from there.
- **Encoded paths** — the user's `path` query param is URL-encoded. After decoding, encode each segment again when constructing the gateway URL (see code pattern 2). Don't `encodeURIComponent` the whole path or you'll double-escape `/`.
- **`agent_sessions.project` ↔ folder name** — schema has `project text NOT NULL` (schema.ts:167) but no FK to `worktrees`. The convention is `project = basename(worktree.path)` for worktrees under `/data/projects/`. The viewer doesn't depend on `agent_sessions.project` because the project is parsed from the request `path` itself. The session row is only an auth gate.
- **No D1 access in gateway** — never tempted to add the lookup there. The Worker is the only D1-aware tier.
- **Out-of-tree security model** — `/data/projects/foo/../etc/hosts` resolves to `/data/etc/hosts` outside `/data/projects/` but our naive `startsWith` check passes the original string. The gateway's `safePath()` at `files.ts:36-42` is the second line of defense — DO NOT remove it. The Worker should additionally reject any path containing `..`.
- **Chip rendering inside a `<p>`** — Streamdown wraps inline content in paragraph tags. `PathChip` must be an inline element (`<span>`, not `<div>`) or React will warn about invalid HTML nesting.
- **Image thumbnail cache** — browser cache handles ETag-based revalidation. Make sure the Worker route preserves the upstream ETag.
- **Mobile / narrow viewport** — Sheet at <768px should be full-width (override side prop). The orchestrator SPA is rendered inside the mobile-expo webview too (per CLAUDE.md GH#132 P3.4); test on a 360px viewport.

### Reference Docs

- `node_modules/streamdown/dist/index.d.ts` — type definitions; specifically lines 60-69 for `Components` and `inlineCode`.
- [`react-markdown` components docs](https://github.com/remarkjs/react-markdown#appendix-b-components) — Streamdown wraps `react-markdown`, so the components contract is the same.
- [Shiki bundled languages list](https://shiki.style/languages) — for the `mapExtToShiki` table.
- `packages/agent-gateway/src/files.ts` — current 1MB cap implementation; extend in B8.
- `packages/agent-gateway/src/server.ts` — existing `/projects/:name/files/*path` route; the route we proxy to.
- `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:71-76` — existing `getFilePath()` partial detector. Inspirational, not directly reused.
- `packages/ai-elements/src/components/tool.tsx:107-156` — `ToolInput` and `ToolOutput`; modify per B9.
- `apps/orchestrator/src/components/ui/sheet.tsx` — Sheet primitive; copy import path.
- `apps/orchestrator/src/api/index.ts:263-283` — `getAccessibleSession()` reuse pattern.
- `apps/orchestrator/src/api/index.ts:1275-1288` — `/api/sessions/media/*` precedent (different auth model — do NOT copy auth strategy, do reuse the streaming pattern).
