---
initiative: yjs-multiplayer-draft
type: project
issue_type: feature
status: draft
priority: high
github_issue: 3
created: 2026-04-17
updated: 2026-04-17
research: planning/research/2026-04-17-yjs-tab-and-draft-sync-feasibility.md
phases:
  - id: p1
    name: "YServer DO Infrastructure"
    tasks:
      - "Add partyserver + y-partyserver dependencies to orchestrator"
      - "Create SessionCollabDO class extending YServer with onLoad/onSave for SQLite persistence"
      - "Add SESSION_COLLAB DO binding + migration in wrangler.toml"
      - "Add WS upgrade route in server.ts with Better Auth session validation"
      - "Export SessionCollabDO from server.ts entry point"
      - "Verify: miniflare boots, WS upgrade returns 101, Y.Doc round-trips through onLoad/onSave"
    test_cases:
      - "wscat connects to /api/collab/{sessionId}/ws with valid auth cookie and receives sync step 1"
      - "Unauthenticated WS upgrade returns 401"
      - "DO hibernates after last client disconnects, draft survives reconnect"
  - id: p2a
    name: "Collaborative Draft + Submit Flow"
    tasks:
      - "Add useYProvider hook to connect browser to SessionCollabDO"
      - "Bind chat input textarea to Y.Text using diff-based binding (not delete-all/insert-all)"
      - "Implement submit flow: read Y.Text, clear optimistically, call SessionAgent sendMessage() RPC, restore on failure"
      - "Add concurrent submit guard: Y.Map meta.submitting UI flag + server-side submitId idempotency in SessionAgent"
      - "Add submit_ids table to SessionAgent SQLite + idempotency check in sendMessage()"
      - "Add __mockSendFailure dev-only test hook for failure rollback verification"
      - "Verify: two browser tabs co-edit same draft, submit clears for both, failure restores draft"
    test_cases:
      - "Tab A types 'hello', Tab B sees 'hello' appear in real time without cursor jumping"
      - "Tab A submits, both tabs see draft clear and message appear in chat history"
      - "If sendMessage RPC fails, draft text is restored for all connected clients"
      - "Two users hitting Send simultaneously: only one message sent, second user sees 'Someone else is sending...'"
      - "Page reload restores draft-in-progress from DO SQLite (not localStorage)"
  - id: p2b
    name: "Old Draft Sync Removal"
    tasks:
      - "Remove saveDraft/getDraft/draftTimerRef from use-user-settings.tsx"
      - "Remove draft field from TabItem type and TanStackDB collection schema"
      - "Remove draft column from UserSettingsDO SQL schema"
      - "Add legacy draft cleanup: on first load, console.warn + delete any localStorage draft:* keys"
      - "Verify: grep for saveDraft/getDraft returns zero results"
    test_cases:
      - "No localStorage draft:* keys exist after first page load"
      - "grep -r 'saveDraft|getDraft|draft:${' returns zero results"
      - "UserSettingsDO tab records have no draft field"
      - "Console shows legacy draft cleanup message if old keys existed"
  - id: p3a
    name: "Typing Indicators + Presence Bar"
    tasks:
      - "Set local awareness state on connect: user name, color, typing status"
      - "Build TypingIndicator component: shows 'Alice is typing...' with 2s debounce"
      - "Build PresenceBar component: avatar dots showing who is connected to this session"
      - "Wire awareness cleanup on disconnect (automatic via y-partyserver)"
      - "Verify: typing indicator and presence bar visible across two browser tabs"
    test_cases:
      - "User A types, User B sees 'User A is typing...' indicator"
      - "User A stops typing for 2s, indicator disappears"
      - "Presence bar shows both users' avatars when connected to same session"
      - "When User A disconnects, their presence avatar fades out over 5 seconds"
  - id: p3b
    name: "Cursor Overlay + Active Tab"
    tasks:
      - "Build CursorOverlay component with mirror-div technique for pixel mapping"
      - "Add ResizeObserver for auto-growing textarea, sync scrollTop"
      - "Broadcast cursor position via awareness as Y.RelativePosition"
      - "Build ActiveTabIndicator: ghost presence fade-out on tab switch"
      - "Verify: cursors visible across two browser tabs, active tab fade-out works"
    test_cases:
      - "User A's cursor position is visible in User B's textarea as a colored marker"
      - "Cursor overlay tracks correctly on multi-line auto-growing textarea"
      - "When User A switches tabs, their avatar fades out over 5 seconds in the old session"
      - "Remote cursors outside scroll viewport are hidden, reappear on scroll"
---

# Yjs Multiplayer Draft Collaboration

## Overview

Replace the broken manual draft sync (localStorage + debounced TanStackDB collection) with a Yjs CRDT-backed collaborative draft on a new per-session Durable Object using PartyKit's `y-partyserver`. Multiple users can co-edit a prompt in real time before sending it to the Claude agent, with full awareness (typing indicators, cursors, presence). This fixes the stale-draft bug and enables multiplayer chat as a first-class feature.

## Feature Behaviors

### B1: Session Collab DO Lifecycle

**Core:**
- **ID:** session-collab-do-lifecycle
- **Trigger:** First WebSocket connection to `/api/collab/{sessionId}/ws`
- **Expected:** A `SessionCollabDO` instance is created (or woken from hibernation) for the given session ID. The DO loads any persisted Y.Doc state from SQLite via `onLoad()`. When the last client disconnects, `onSave()` snapshots `Y.encodeStateAsUpdate(this.document)` to SQLite. The DO then hibernates (`static options = { hibernate: true }`).
- **Verify:** Connect via wscat, send a Y.Doc update, disconnect, reconnect — the update is present in the restored doc.
- **Source:** new file: `apps/orchestrator/src/agents/session-collab-do.ts`

#### API Layer
- **WS Upgrade Route:** `GET /api/collab/:sessionId/ws` (Upgrade: websocket)
- **Auth:** Better Auth session cookie validated server-side. `x-user-id` header injected before DO fetch (same pattern as SessionAgent at `server.ts:54-63`).
- **Error codes:** 401 (no auth), 400 (invalid session ID)

#### Data Layer
- **New DO class:** `SessionCollabDO` extending `YServer` from `y-partyserver`
- **wrangler.toml binding:** `SESSION_COLLAB` → `SessionCollabDO`
- **wrangler.toml migration:** New migration block with tag `v3`:
  ```toml
  [[migrations]]
  tag = "v3"
  new_sqlite_classes = ["SessionCollabDO"]
  ```
- **SQLite table DDL:** Created in `onStart()` (runs once per DO instantiation/wake):
  ```sql
  CREATE TABLE IF NOT EXISTS y_state (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  )
  ```
  DDL runs inside `onLoad()` via `ensureTable()` — this avoids dependency on `onStart` → `onLoad` ordering in y-partyserver's lifecycle. `CREATE TABLE IF NOT EXISTS` is idempotent and near-zero cost on subsequent calls.

---

### B2: Collaborative Draft Editing

**Core:**
- **ID:** collaborative-draft-editing
- **Trigger:** User opens a session tab in the browser
- **Expected:** A `YProvider` (from `y-partyserver/provider`) connects to the session's `SessionCollabDO`. The chat input textarea is bound to a `Y.Text` named `"draft"` in the shared Y.Doc using a **diff-based binding**: on each `onChange`, compute the minimal insert/delete operations by comparing the textarea's `selectionStart`/`selectionEnd` with the previous state and applying targeted `ytext.insert()` / `ytext.delete()` calls (not delete-all/insert-all). This preserves CRDT character-level merge and prevents cursor jumping for concurrent editors. Keystrokes from any connected user merge via CRDT — all clients see the same text in real time. The Y.Doc is the single source of truth; no localStorage or TanStackDB collection involvement.
- **Verify:** Open two browser tabs to the same session. User A types at position 0, User B types at the end simultaneously. Both edits merge correctly without cursor jumping or content loss.
- **Source:** modified: `packages/ai-elements/src/components/prompt-input.tsx`, new hook: `apps/orchestrator/src/hooks/use-session-collab.ts`

#### UI Layer
- **Component:** `PromptInput` (existing) — textarea binding changes from local React state + `saveDraft()` to Y.Text observation
- **States:**
  - Connecting: textarea disabled, placeholder "Connecting to collab..."
  - Connected: normal editing, bound to Y.Text
  - Disconnected (transient): textarea remains editable (YProvider buffers locally, reconnects automatically)
  - Auth failure (401): textarea disabled, banner "Session expired — please reload to reconnect." The server rejects the HTTP upgrade with 401 *before* the WS handshake completes, so YProvider sees a failed connection (not a WS close frame). Handle this via YProvider's `onClose`/`onDisconnect` callback: check `event.code === 1006` (abnormal closure) combined with a fetch to `/api/auth/session` to distinguish auth expiry from network error. On confirmed auth failure, set a React state flag that disables retry and shows the banner. On transient network error, let YProvider's default exponential backoff handle reconnection.
  - Error (other): textarea disabled, "Connection error — retrying..." with exponential backoff (YProvider default behavior)
- **No localStorage fallback** — YProvider handles offline buffering and reconnect natively

#### API Layer
- **Client:** `useYProvider({ host: window.location.host, room: sessionId, party: 'session-collab' })`
- **Y.Doc structure:** `{ draft: Y.Text }`

---

### B3: Submit Flow (Draft → Message)

**Core:**
- **ID:** submit-draft-as-message
- **Trigger:** User clicks Send or presses Enter in the chat input
- **Expected:** (1) Browser snapshots `const text = yDoc.getText("draft").toString()`. (2) Browser clears the draft **optimistically** in a Y.Doc transaction: `yDoc.transact(() => yDoc.getText("draft").delete(0, len))`. All connected clients see the textarea empty instantly. (3) Browser calls `SessionAgent.sendMessage(text)` via the existing agents SDK RPC (client-side bridge — the two DOs never communicate directly). (4) If `sendMessage()` succeeds: the message appears in chat history via SessionAgent's existing `broadcastToClients`. (5) If `sendMessage()` fails: the draft is **restored** by inserting the text back: `yDoc.transact(() => yDoc.getText("draft").insert(0, text))`. A toast notification shows "Failed to send — draft restored." All clients see the text reappear.
- **Verify:** Two users co-editing; User A hits send. Both see draft clear, message appears in history for both. If RPC fails, draft text is restored for both users.
- **Source:** modified: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (sendMessage handler)

#### UI Layer
- Send button disabled when `yDoc.getText("draft").length === 0`
- Send button shows spinner during RPC call
- After successful submit, textarea is empty and ready for next prompt
- On failure: textarea repopulated with original text, toast "Failed to send — draft restored"
- No confirmation dialog (sender submits, draft clears for all — decided in interview)

**Concurrent submit guard (two layers):**
1. **UI hint (Y.Map flag):** Before reading the draft, set `yDoc.getMap("meta").set("submitting", true)`. The submit handler checks this flag — if already `true`, the second sender sees "Someone else is sending..." and their click is ignored. This is a best-effort UI guard — it prevents duplicates when CRDT updates arrive before the second click (~90% of cases) but is not a mutex (CRDT `set()` is last-writer-wins, so two near-simultaneous sets both succeed).
2. **Server-side idempotency (correctness guarantee):** The submit handler generates a `submitId` (UUID v4) and passes it to `SessionAgent.sendMessage(text, { submitId })`. SessionAgent stores submitIds in its existing SQLite database in a `submit_ids(id TEXT PRIMARY KEY, created_at INTEGER)` table. If a duplicate `submitId` arrives, it returns success without creating a second message. Rows older than 60 seconds are pruned on each insert (`DELETE FROM submit_ids WHERE created_at < ?`). This handles the TOCTOU race where two clients both pass the Y.Map check.

---

### B4: Draft Persistence Across Hibernation

**Core:**
- **ID:** draft-persistence-hibernation
- **Trigger:** Last client disconnects from a SessionCollabDO (room empties)
- **Expected:** `onSave()` fires (y-partyserver built-in behavior). The handler encodes the Y.Doc state and writes it to the DO's SQLite. When a client reconnects later, `onLoad()` restores the Y.Doc from SQLite. Draft text typed but not submitted is preserved across hibernation, DO eviction, and Worker restarts.
- **Verify:** Type "hello world" in draft, close all tabs, wait 60s, reopen — draft shows "hello world".
- **Source:** `apps/orchestrator/src/agents/session-collab-do.ts` (onLoad/onSave methods)

#### Data Layer
- `onSave` callback options: `{ debounceWait: 2000, debounceMaxWait: 10000, timeout: 5000 }`
- Snapshot stored as single BLOB row in `y_state` table
- **Guarantee:** y-partyserver triggers a final `onSave()` when the room empties (last client disconnects), regardless of whether the debounce window has elapsed. No data loss on hibernation.

---

### B5: Old Draft Sync Removal

**Core:**
- **ID:** remove-old-draft-sync
- **Trigger:** P2 deployment
- **Expected:** All draft-related code is removed from UserSettingsDO and the client: `saveDraft()`, `getDraft()`, `draftTimerRef`, localStorage `draft:*` keys, the `draft` field on `TabItem` in the TanStackDB collection, and the debounced collection update path. The stale-draft bug (race between synchronous localStorage clear and 500ms debounced collection write) is eliminated by removing the code entirely, not by fixing the race. **Data migration:** Existing unsent drafts in UserSettingsDO and localStorage are silently dropped — no migration to the new Y.Doc. This is an accepted trade-off: drafts are inherently ephemeral scratch text, and the old system's stale-draft bug means they were already unreliable. A console.warn is logged on first load if a localStorage `draft:*` key exists, then it is deleted.
- **Verify:** Grep codebase for `saveDraft`, `getDraft`, `draft:${tabId}` — zero results. No `draft` field in UserSettingsDO SQL schema. Console shows `[collab] Cleared legacy draft for tab {id}` on first load if old drafts existed.
- **Source:** modified: `apps/orchestrator/src/hooks/use-user-settings.tsx` (lines 361-422 deleted), `apps/orchestrator/src/agents/user-settings-do.ts`

---

### B6: Typing Indicator

**Core:**
- **ID:** awareness-typing-indicator
- **Trigger:** User types in the shared draft textarea
- **Expected:** The typing user's awareness state is updated with `{ typing: true, user: { name, color } }`. Other connected clients render a "Alice is typing..." indicator below the chat input. When the user stops typing for 2 seconds, `typing` flips to `false` and the indicator disappears. On disconnect, awareness state is automatically cleaned up by y-partyserver.
- **Verify:** User A types — User B sees "User A is typing..." below the input. User A stops for 2s — indicator disappears.
- **Source:** new component: `apps/orchestrator/src/components/typing-indicator.tsx`, hook: `apps/orchestrator/src/hooks/use-session-collab.ts`

#### UI Layer
- **Component:** `TypingIndicator` — positioned below the chat input
- **Format:** "{Name} is typing..." for one user, "{Name} and {Name} are typing..." for two, "{N} people are typing..." for 3+
- **Animation:** Subtle pulsing dots (CSS only, no JS animation)

---

### B7: Cursor Overlay

**Core:**
- **ID:** awareness-cursor-overlay
- **Trigger:** User moves cursor or selects text in the shared draft textarea
- **Expected:** The user's cursor position (or selection range) is broadcast via awareness as Y.RelativePosition. Other clients render a colored cursor marker at the corresponding position in their textarea, with a small name label. Each user gets a deterministic color derived from their user ID.
- **Verify:** User A places cursor at position 5 in "hello world" — User B sees a colored cursor marker between "hello" and " world" with User A's name.
- **Source:** new component: `apps/orchestrator/src/components/cursor-overlay.tsx`

#### UI Layer
- **Component:** `CursorOverlay` — absolutely positioned overlay on the textarea
- **Pixel mapping strategy:** Use a **mirror div** technique: render an invisible `<div>` with identical styling (font, padding, line-height, width, white-space, word-wrap) as the textarea. Insert a `<span>` marker at the cursor's character index. Read the marker's `offsetTop`/`offsetLeft` to get pixel coordinates. Sync the mirror's scroll position with the textarea's `scrollTop`. This is the standard approach used by CodeMirror, textarea-caret-position, and similar libraries.
- **Cursor style:** 2px wide colored bar with rounded name badge above
- **Color assignment:** Deterministic hash of userId → one of 8 preset colors
- **Selection:** Highlighted range with 20% opacity fill of the user's color
- **Auto-grow handling:** The mirror div must be wrapped in a `ResizeObserver` that re-measures on textarea height changes (the chat input auto-grows). When the textarea scrolls, sync `mirrorDiv.scrollTop = textarea.scrollTop`. Remote cursors outside the visible scroll viewport are not rendered (avoid floating markers at viewport edges — too noisy). They reappear when the user scrolls them into view.
- **Implementation:** Use the mirror-div technique (not `textarea-caret` — that library doesn't handle auto-grow or scroll sync). The mirror div is ~60 lines of DOM measurement code, well-documented in the CodeMirror and ProseMirror ecosystems.

---

### B8: Online Presence Bar

**Core:**
- **ID:** awareness-presence-bar
- **Trigger:** User connects to a session's collab DO
- **Expected:** A presence bar shows avatar dots (or initials) for every user currently connected to this session. The bar updates in real time as users connect and disconnect. Clicking an avatar could show the user's name (tooltip).
- **Verify:** Two users connected to same session — both see two avatar dots. One disconnects — the other sees one dot within 2 seconds.
- **Source:** new component: `apps/orchestrator/src/components/presence-bar.tsx`

#### UI Layer
- **Component:** `PresenceBar` — horizontal row of avatar circles above the chat area
- **Avatar:** First letter of user name, colored background (same color as cursor)
- **Tooltip:** Full user name on hover
- **Count:** If > 5 users, show first 4 + "+N" overflow badge

---

### B9: Active Tab Indicator

**Core:**
- **ID:** awareness-active-tab
- **Trigger:** User switches between session tabs
- **Expected:** The user's `activeSessionId` is written to `UserSettingsDO` state via the existing `setState()` broadcast (not Yjs awareness — Yjs awareness only propagates within a single Y.Doc room, so cross-session visibility requires a separate channel). When `UserSettingsDO` broadcasts the state update, all browser tabs for the same user receive it. Additionally, each session's collab DO awareness carries `{ activeSessionId }` so users in the same room can see if a peer is focused on this session or backgrounded.
- **Verify:** User A is on session-1. User A's collab DO awareness in session-1 shows `activeSessionId: "session-1"`. User A switches to session-2 — session-1's presence bar dims User A's avatar (awareness update received by peers still in session-1). User B in session-1 sees User A's avatar dimmed with tooltip "Viewing: session-2".
- **Source:** modified: `apps/orchestrator/src/hooks/use-session-collab.ts`, `apps/orchestrator/src/hooks/use-user-settings.tsx`

#### UI Layer
- **Connection lifecycle:** YProvider connections are opened lazily on tab mount and closed on tab unmount. Only the currently visible session tab has an active YProvider connection. Background tabs disconnect (triggering `onSave` on the DO). When the user switches back to a tab, YProvider reconnects and `onLoad` restores the Y.Doc. This means at most 1 active collab WS per browser tab, avoiding connection limit issues.
- **UX model (ghost presence):** When a user navigates away from a session, their YProvider disconnects and their awareness state is removed. Peers see a **5-second fade-out animation** on the user's avatar in the presence bar (B8), then it disappears. When the user navigates back, they reconnect and reappear. There is no persistent "dimmed" state — users are either present (opaque avatar) or recently-departed (fading out) or gone (no avatar).
- **Tooltip on fading avatar:** During the 5-second fade-out, tooltip shows "Left recently"

---

## Non-Goals

1. **Agent-as-CRDT-peer** — Claude's streaming response stays on the existing `broadcastToClients` JSON path. The agent does not write into the Y.Doc. This is deferred to spec 0008 (BlockNote realtime docs) which will build the agent-as-peer pattern on top of this Yjs infrastructure.

2. **Rich text / BlockNote in chat input** — The shared draft is plain `Y.Text`, not a rich-text `Y.XmlFragment`. Users type markdown as raw text. Rich editing is spec 0008 territory.

3. **Tab list migration to Yjs** — Tab metadata (which tabs are open, their order) stays on `UserSettingsDO` via the existing `setState()` broadcast. It's single-user data that doesn't need CRDT merge semantics.

4. **Per-session access control** — Any authenticated user can connect to any session's collab room. Fine-grained ACLs (who can view vs edit a session) are a future feature. For now the auth boundary is "logged in = access."

5. **Mobile-optimized collab UX** — Cursor overlays and presence bars are designed for desktop viewports. Mobile layout adjustments are a follow-up.

6. **Rate limiting / abuse prevention on collab WS** — No rate limiting on Y.Doc update frequency or size in this spec. The Y.Doc contains only a single `Y.Text` draft (typically < 10KB) and a small `Y.Map` meta, so runaway growth is unlikely. If abuse becomes a concern, add server-side message-rate throttling and doc-size caps in a follow-up.

7. **Orphaned DO cleanup** — When a session is deleted from the app, the corresponding `SessionCollabDO` and its SQLite data persist until Cloudflare eventually evicts idle storage. This is harmless (data is < 10KB per session, no billing impact while hibernated) and not worth building a cleanup pipeline for in this spec. If it becomes a concern at scale, add an admin alarm or session-deletion webhook to purge collab DOs.

## Implementation Phases

### Phase 1: YServer DO Infrastructure (P1)

Stand up the new `SessionCollabDO` with y-partyserver, SQLite persistence, and authenticated WS routing. No UI changes — purely server-side, testable via wscat or a simple Yjs client script.

**Done when:** A browser can connect via WS, sync a Y.Doc, disconnect, reconnect, and see the doc persisted.

### Phase 2a: Collaborative Draft + Submit Flow (P2a)

Wire the client-side YProvider, bind the chat input to Y.Text using a diff-based binding, implement the submit flow with optimistic clear + failure rollback, and add a concurrent submit guard.

**Done when:** Two browser tabs can co-edit a prompt without cursor jumping, one submits, both see it clear and the message appear in chat history. Failed submits restore the draft.

### Phase 2b: Old Draft Sync Removal (P2b)

Remove all old draft infrastructure: `saveDraft()`, `getDraft()`, localStorage `draft:*` keys, the `draft` field from UserSettingsDO and TanStackDB collection. This is a **separate commit and push** from P2a. P2b ships only after P2a has been deployed to production and verified working for at least one session (manual QA: open two tabs, co-edit, submit, verify persistence). Since deploys trigger on push to main, P2a and P2b must be separate pushes.

**Done when:** Grep for `saveDraft`, `getDraft`, `draft:${tabId}` returns zero results. Legacy localStorage keys are cleaned up on first load with a console.warn.

### Phase 3a: Typing Indicators + Presence Bar (P3a)

Add typing indicators and online presence bar. These are the highest-value, lowest-complexity awareness features.

**Done when:** Two users see "X is typing..." indicators and each other's avatars in the presence bar. Avatars fade out on disconnect.

### Phase 3b: Cursor Overlay + Active Tab (P3b)

Add the cursor overlay (mirror-div technique, ResizeObserver, scroll sync) and active tab ghost presence (5-second fade-out on tab switch). These are higher-complexity features that build on P3a's awareness foundation.

**Done when:** Two users see each other's colored cursor positions in the textarea. Switching tabs triggers a 5-second fade-out of the departing user's avatar.

## Verification Plan

### VP1: Infrastructure smoke test (after P1)

```bash
# 1. Start dev server
cd apps/orchestrator && pnpm dev

# 2. Verify DO class is registered
grep -n "SessionCollabDO" src/server.ts
# Expected: export { SessionCollabDO } line present

# 3. Verify wrangler binding
grep -A2 "SESSION_COLLAB" wrangler.toml
# Expected: name = "SESSION_COLLAB", class_name = "SessionCollabDO"

# 4. Test WS upgrade (unauthenticated — should 401)
# Via chrome-devtools-axi or curl:
curl -i -H "Upgrade: websocket" -H "Connection: Upgrade" \
  http://localhost:43173/api/collab/test-session/ws
# Expected: HTTP 401 Unauthorized

# 5. Test WS upgrade (authenticated)
# Login via chrome-devtools-axi, then connect WS to /api/collab/{sessionId}/ws
# Expected: WS 101 Switching Protocols, receives Yjs sync step 1
```

### VP2: Collaborative draft (after P2)

```bash
# 1. Open two browser tabs to the same session
chrome-devtools-axi open http://localhost:43173/session/{id}
# Open second tab in incognito or different browser with same/different user

# 2. In Tab A, type into the chat input
chrome-devtools-axi fill @<input-ref> "hello from tab A"

# 3. Verify Tab B shows the text
# Switch to Tab B, snapshot the chat input
chrome-devtools-axi snapshot
# Expected: input contains "hello from tab A"

# 4. Submit from Tab A
chrome-devtools-axi click @<send-ref>

# 5. Verify both tabs
# Tab A: input is empty, chat history shows "hello from tab A"
# Tab B: input is empty, chat history shows "hello from tab A"

# 6. Test submit failure rollback
# In browser console, temporarily mock the RPC to fail:
chrome-devtools-axi eval "window.__mockSendFailure = true"
# Type a draft and submit
chrome-devtools-axi fill @<input-ref> "this should be restored"
chrome-devtools-axi click @<send-ref>
# Expected: toast "Failed to send — draft restored", textarea shows "this should be restored"
chrome-devtools-axi eval "window.__mockSendFailure = false"

# 7. Verify old draft sync removed (after P2b)
grep -r "saveDraft\|getDraft\|draft:\${" apps/orchestrator/src/
# Expected: zero results

grep -r "localStorage.*draft" apps/orchestrator/src/ packages/ai-elements/src/
# Expected: zero results
```

Note: The `__mockSendFailure` flag must be implemented in the submit handler during P2a development as a test hook (checked only in dev mode via `import.meta.env.DEV`).

### VP3: Persistence across hibernation (after P2)

```bash
# 1. Type a draft but don't submit
chrome-devtools-axi fill @<input-ref> "unsent draft"

# 2. Close all browser tabs (triggers onSave)
chrome-devtools-axi eval "window.close()"

# 3. Wait 30 seconds for DO to hibernate

# 4. Reopen the session
chrome-devtools-axi open http://localhost:43173/session/{id}

# 5. Verify draft is restored
chrome-devtools-axi snapshot
# Expected: chat input contains "unsent draft"
```

### VP4: Awareness and presence (after P3)

```bash
# 1. Open session in two browser tabs with different users
# Tab A: logged in as user-a
# Tab B: logged in as user-b

# 2. Verify presence bar shows both users
chrome-devtools-axi snapshot
# Expected: presence bar contains two avatar dots

# 3. Type in Tab A
chrome-devtools-axi fill @<input-ref> "typing..."

# 4. Check Tab B for typing indicator
chrome-devtools-axi snapshot
# Expected: "User A is typing..." visible below chat input

# 5. Stop typing in Tab A, wait 3 seconds
# Check Tab B — typing indicator should be gone

# 6. Disconnect Tab A (close tab)
# Check Tab B — presence bar shows one avatar, cursor overlay gone
```

## Implementation Hints

### Key Imports

```typescript
// Server — DO class
import { YServer } from "y-partyserver"
// or use mixin: import { Server } from "partyserver"; import { withYjs } from "y-partyserver"
import * as Y from "yjs"

// Client — provider + React hook
import { YProvider } from "y-partyserver/provider"
import { useYProvider } from "y-partyserver/react"

// Client — awareness (comes with yjs)
import { Awareness } from "y-protocols/awareness"
```

### Code Patterns

**WS upgrade route (matches existing pattern from `server.ts:16-30`):**
```typescript
// In server.ts fetch handler
if (
  url.pathname.match(/^\/api\/collab\/([^/]+)\/ws$/) &&
  request.headers.get('Upgrade') === 'websocket'
) {
  const sessionId = url.pathname.match(/^\/api\/collab\/([^/]+)\/ws$/)![1]
  const authSession = await getRequestSession(env, request)
  if (!authSession) return new Response('Unauthorized', { status: 401 })
  const doId = env.SESSION_COLLAB.idFromName(sessionId)
  const stub = env.SESSION_COLLAB.get(doId)
  const headers = new Headers(request.headers)
  headers.set('x-user-id', authSession.userId)
  return stub.fetch(new Request(request, { headers }))
}
```

**SessionCollabDO class:**
```typescript
import { YServer } from "y-partyserver"
import * as Y from "yjs"

export class SessionCollabDO extends YServer {
  static options = { hibernate: true }

  // onSave debounce: wait 2s after last edit, max 10s, 5s timeout
  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  private ensureTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS y_state (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  async onLoad() {
    // DDL in onLoad (not onStart) — guarantees table exists before first read
    // regardless of y-partyserver's internal lifecycle ordering
    this.ensureTable()
    const rows = this.ctx.storage.sql
      .exec("SELECT data FROM y_state WHERE id = 'snapshot' LIMIT 1")
      .toArray()
    if (rows.length > 0) {
      Y.applyUpdate(this.document, new Uint8Array(rows[0].data as ArrayBuffer))
    }
  }

  async onSave() {
    const update = Y.encodeStateAsUpdate(this.document)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO y_state (id, data, updated_at)
       VALUES ('snapshot', ?, ?)`,
      update, Date.now()
    )
  }
}
```

**Client-side YProvider connection:**
```typescript
const provider = useYProvider({
  host: window.location.host,
  room: sessionId,
  party: "session-collab",
  doc: yDocRef.current,
  // Auth: session cookie is sent automatically on same-origin WS
})
```

**Y.Text diff-based binding to textarea:**
```typescript
const ytext = yDoc.getText("draft")
const [value, setValue] = useState(ytext.toString())
const prevValueRef = useRef(value)

// Observe remote changes
useEffect(() => {
  const observer = () => setValue(ytext.toString())
  ytext.observe(observer)
  return () => ytext.unobserve(observer)
}, [ytext])

// Apply local changes as minimal ops (not delete-all/insert-all)
const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
  const textarea = e.currentTarget
  const newVal = textarea.value
  const cursor = textarea.selectionStart
  const prev = prevValueRef.current

  // Find the changed range using cursor position as hint
  // For single-char insert/delete this is O(1); for paste it diffs
  yDoc.transact(() => {
    // Common prefix length
    let start = 0
    while (start < prev.length && start < newVal.length && prev[start] === newVal[start]) start++
    // Common suffix length (from end, not overlapping prefix)
    let endPrev = prev.length
    let endNew = newVal.length
    while (endPrev > start && endNew > start && prev[endPrev - 1] === newVal[endNew - 1]) {
      endPrev--
      endNew--
    }
    if (endPrev > start) ytext.delete(start, endPrev - start)
    if (endNew > start) ytext.insert(start, newVal.slice(start, endNew))
  })

  prevValueRef.current = newVal
}
```
This preserves CRDT character-level merge and prevents cursor jumping for concurrent editors.

### Gotchas

1. **y-partyserver requires `partyserver` as peer dep** — install both: `pnpm add partyserver y-partyserver yjs y-protocols`

2. **DO class must be exported from the Worker entry point** (`server.ts`) — Cloudflare requires all DO classes to be top-level named exports from the `main` script.

3. **YProvider `party` param** must match the DO binding name pattern. The `routePartykitRequest` helper auto-maps, but since we're doing manual routing in `server.ts`, the `party` param is only used client-side for URL construction — ensure the route pattern matches.

4. **Textarea binding must be diff-based** — the code pattern above uses a prefix/suffix diff to compute minimal `insert`/`delete` ops. Never use delete-all/insert-all — it destroys CRDT merge semantics and causes cursor jumping. The cursor overlay (B7) uses `Y.createRelativePositionFromTypeIndex` for stable cross-client positions.

5. **`this.ctx.storage.sql`** — the YServer extends DurableObject which has access to the transactional SQL API. The `onLoad`/`onSave` pattern is the same as SessionDO's existing SQLite usage.

6. **Awareness timeout** — y-partyserver disables the built-in `_checkInterval` to prevent timers from defeating hibernation. Awareness cleanup happens on WS close, not on timeout. Client-side, the typing indicator's 2-second debounce is a local timer, not an awareness feature.

### Reference Docs

- [y-partyserver README](https://github.com/cloudflare/partykit/blob/main/packages/y-partyserver/README.md) — server API, onLoad/onSave, callbackOptions, custom messaging
- [partyserver README](https://github.com/cloudflare/partykit/blob/main/packages/partyserver/README.md) — Server base class, hibernate option, lifecycle hooks, broadcast
- [Yjs Awareness docs](https://docs.yjs.dev/getting-started/adding-awareness) — awareness protocol, setLocalStateField, ephemeral state
- [y-presence React hooks](https://github.com/nimeshnayaju/y-presence) — useSelf, useUsers for React awareness binding
- [Existing WS routing pattern](../apps/orchestrator/src/server.ts) — lines 16-68, auth + DO fetch delegation
- [Existing UserSettingsDO draft code to remove](../apps/orchestrator/src/hooks/use-user-settings.tsx) — lines 361-422
