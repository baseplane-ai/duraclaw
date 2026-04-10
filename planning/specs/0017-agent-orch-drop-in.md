---
initiative: feat-agent-orch-drop-in
type: project
issue_type: feature
status: approved
priority: high
github_issue: 17
created: 2026-04-10
updated: 2026-04-10
phases:
  - id: p1
    name: "App shell — shadcn-admin scaffold"
    tasks:
      - "Clone satnaing/shadcn-admin into apps/orchestrator/src/ as the new app shell"
      - "Strip Clerk auth — replace with existing Better Auth integration"
      - "Configure TanStack Router routes: / (dashboard), /session/$id (chat), /settings"
      - "Wire sidebar navigation: Sessions, Dashboard, Settings"
      - "Verify dark/light theme toggle works"
      - "Verify command palette (Cmd+K) works"
      - "Verify responsive mobile layout with hamburger menu"
      - "Delete old layout components (__root.tsx shell, bottom-tabs, mobile-drawer)"
    test_cases:
      - id: "shell-renders"
        description: "App shell renders with sidebar, theme toggle, and command palette"
        type: "integration"
      - id: "shell-responsive"
        description: "Mobile layout collapses sidebar to hamburger menu"
        type: "integration"
      - id: "shell-auth"
        description: "Unauthenticated users redirect to /login, authenticated users see dashboard"
        type: "integration"
  - id: p2
    name: "Extract ai-elements package"
    tasks:
      - "Create packages/ai-elements/ with package.json and tsconfig"
      - "Copy 32 components from baseplane apps/web/src/shared/components/ai-elements/"
      - "Copy required utilities (cn, tool-display, use-controllable-state)"
      - "Copy generic UI primitives (button, badge, collapsible, dialog, etc.)"
      - "Add external deps (streamdown, shiki, lucide-react, @base-ui/react, use-stick-to-bottom, motion)"
      - "Configure tsup build with React externalized"
      - "Verify package builds and exports resolve"
    test_cases:
      - id: "ai-elements-builds"
        description: "pnpm build in packages/ai-elements succeeds with no errors"
        type: "build"
      - id: "ai-elements-imports"
        description: "Orchestrator can import Conversation, Message, ToolCallList, Reasoning, PromptInput from @duraclaw/ai-elements"
        type: "integration"
      - id: "ai-elements-render"
        description: "Key components (Conversation, Message, ToolCallList) render without crashing in isolation"
        type: "unit"
  - id: p3
    name: "Migrate SessionDO to AIChatAgent + raw event relay"
    tasks:
      - "Add @cloudflare/ai-chat dependency to orchestrator"
      - "Refactor SessionDO to extend AIChatAgent"
      - "Override onChatMessage() to relay to cc-gateway and broadcast raw GatewayEvents"
      - "Remove custom message persistence SQL (use AIChatAgent built-in)"
      - "Remove custom WsChatTransport"
      - "Remove custom broadcast logic"
      - "Remove /tool-approval and /answers HTTP endpoints (use @callable RPC)"
      - "Unify gate handling into single resolveGate() method"
      - "Normalize status enum: waiting_input + waiting_permission -> waiting_gate"
      - "Update ProjectRegistry DO for new state shape"
      - "Add new_sqlite_classes entry for SessionDO in wrangler.toml (AIChatAgent requires its own SQLite schema)"
      - "Update SessionState in @duraclaw/shared-types — replace pending_question + pending_permission with unified gate, keep stopped status as alias for completed, add gate field"
    test_cases:
      - id: "session-creates"
        description: "Creating a session via RPC connects to gateway and streams GatewayEvents to client"
        type: "integration"
      - id: "gate-resolution"
        description: "Permission request pauses in waiting_gate state, resolveGate resumes to running"
        type: "integration"
      - id: "reconnect-resume"
        description: "Disconnected client reconnects and receives buffered events"
        type: "integration"
  - id: p4
    name: "Port agent-orch UI components into shell"
    tasks:
      - "Delete existing chat-view.tsx, dashboard.tsx, project-sidebar.tsx, message-parts/"
      - "Copy GREEN components: GateResolver, ChatThread, KataStatePanel, SessionMetadataHeader, SessionListItem, StreamingText"
      - "Copy YELLOW components: MessageInput, AgentDetailView, SpawnAgentForm, SessionSidebar"
      - "Update imports to use @duraclaw/ai-elements"
      - "Replace /api/cc-gateway/projects fetch with duraclaw gateway endpoint in SpawnAgentForm"
      - "Wire useCodingAgent hook to SessionDO DO via agents/react useAgent"
      - "Update router: mount agent-orch components at / and /session/$id"
      - "Remove old WsChatTransport and storedToUIMessages code"
    test_cases:
      - id: "chat-renders"
        description: "ChatThread renders assistant messages with text, tool calls, and reasoning blocks"
        type: "integration"
      - id: "gate-ui"
        description: "GateResolver shows approve/deny buttons for permission_request and text input for ask_user"
        type: "integration"
      - id: "spawn-form"
        description: "SpawnAgentForm lists projects from gateway and creates a session"
        type: "integration"
  - id: p5
    name: "Rewrite data hooks for duraclaw"
    tasks:
      - "Implement useAgentOrchSessions hook backed by ProjectRegistry DO"
      - "Replace DataForge entity CRUD with ProjectRegistry RPC calls"
      - "Implement session list with search, archive, status filter"
      - "Wire AgentOrchPage to duraclaw's TanStack Router"
      - "Implement session persistence (create/update/archive) via ProjectRegistry"
      - "Add session grouping by project"
    test_cases:
      - id: "session-list"
        description: "Session sidebar shows active and archived sessions grouped by project"
        type: "integration"
      - id: "session-persistence"
        description: "Session state persists across page refresh and reconnect"
        type: "integration"
      - id: "search-filter"
        description: "Search filters sessions by prompt text and project name"
        type: "integration"
---

# Agent-Orch Drop-In

> GitHub Issue: [#17](https://github.com/codevibesmatter/duraclaw/issues/17)

## Overview

Duraclaw's orchestrator UI has been frozen since Phase 0 while the cc-gateway evolved. Baseplane built a working agent orchestration UI (2,028 lines) consuming the same gateway. Rather than building Phases 1-3 from scratch, this epic ports baseplane's agent-orch feature into duraclaw as a dual-target package — replacing the existing orchestrator UI and designing for baseplane adoption with minimal rework.

The work breaks into four phases: extract the ai-elements component library as a shared package, migrate SessionDO from base Agent to AIChatAgent with raw GatewayEvent relay, port the UI components, and rewrite the data hooks for duraclaw's session management.

## Feature Behaviors

### B0: shadcn-admin App Shell

**Core:**
- **ID:** app-shell
- **Trigger:** User navigates to any route in the orchestrator
- **Expected:** The app renders inside a shadcn-admin shell with: collapsible sidebar navigation (Sessions, Dashboard, Settings), dark/light/system theme toggle, command palette (Cmd+K) for quick actions, responsive mobile layout with hamburger menu, and auth-gated routes. The existing Better Auth integration handles login/logout. The shell replaces duraclaw's current hand-rolled layout (`__root.tsx`, `AppLayout`, `BottomTabs`, mobile drawer).
- **Verify:** Open the app. See sidebar with navigation. Toggle theme. Press Cmd+K — command palette opens. Resize to mobile — sidebar collapses to hamburger. Navigate to `/login` when unauthenticated — sign-in page renders.
- **Source:** [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)

#### UI Layer

Shell provides:

| Component | Purpose | Roadmap Phase |
|-----------|---------|---------------|
| Sidebar | Collapsible navigation with session list | Phase 2.1 |
| Theme toggle | Dark/light/system | Phase 6.3 |
| Command palette | Cmd+K quick actions | Phase 7.4 |
| Settings page | Tabbed layout skeleton | Phase 6.1 |
| Auth pages | Sign-in/sign-up forms | Phase 6.2 |
| Error pages | 404, 500 | Phase 1.4 |
| Responsive layout | Mobile hamburger, desktop sidebar | Phase 0.3 (done, but better) |

#### API Layer

N/A — shell is layout only. Routes wire to existing auth + session APIs.

#### Data Layer

N/A.

---

### B1: ai-elements Shared Package

**Core:**
- **ID:** ai-elements-package
- **Trigger:** Any UI component needs to render chat messages, tool calls, reasoning blocks, or prompt input
- **Expected:** `packages/ai-elements/` exports 32 React components (Conversation, Message, ToolCallList, Reasoning, PromptInput, CodeBlock, etc.) plus required utilities. The package builds with tsup, externalizes React, and is consumed by the orchestrator via workspace dependency `@duraclaw/ai-elements`.
- **Verify:** `cd packages/ai-elements && pnpm build` succeeds. `import { Conversation, Message } from '@duraclaw/ai-elements'` resolves in the orchestrator.
- **Source:** Baseplane `apps/web/src/shared/components/ai-elements/` (5,238 lines, 32 files). Source: baseplane-dev1 at commit to be pinned at implementation time.

#### UI Layer

Components are presentational — they render based on props, no data fetching. Key exports:

| Component | Purpose |
|-----------|---------|
| `Conversation`, `ConversationContent` | Scroll-to-bottom chat container |
| `Message`, `MessageContent`, `MessageResponse` | Message layout + markdown rendering (streamdown) |
| `ToolCallList`, `ToolCallItem` | Collapsible tool call chips with status |
| `Reasoning`, `ReasoningTrigger`, `ReasoningContent` | Collapsible thinking blocks |
| `PromptInput`, `PromptInputTextarea`, `PromptInputActions` | Textarea + image paste/upload + submit |
| `CodeBlock` | Syntax highlighting (shiki) with line numbers |
| `ModelSelector` | Model picker dropdown |

#### API Layer

N/A — pure UI package.

#### Data Layer

N/A — no data fetching or persistence.

---

### B2: SessionDO AIChatAgent Migration

**Core:**
- **ID:** session-agent-migration
- **Trigger:** Client connects to SessionDO DO via WebSocket
- **Expected:** SessionDO extends `AIChatAgent` from `@cloudflare/ai-chat`. `spawn()` is used for the initial session creation (connects to the gateway WebSocket and sends `ExecuteCommand`). `onChatMessage()` from AIChatAgent is used for follow-up messages sent via `sendMessage()` from the client. The initial prompt goes through `spawn()`, not `onChatMessage()`. Raw `GatewayEvent` objects are broadcast to all connected clients wrapped as `{ type: 'gateway_event', event }`. Message persistence is handled by AIChatAgent automatically. Gate state (permission_request, ask_user) is tracked in `this.state.gate` as a single unified object. The status enum uses `waiting_gate` instead of the current `waiting_input` / `waiting_permission` split. If the gateway WebSocket disconnects mid-session, SessionDO transitions to `failed` state with an error message. Auto-reconnect is deferred to A.6 (durable fibers). If `spawn()` is called while status is `running` or `waiting_gate`, it returns `{ ok: false, error: 'Session already active' }`.
- **Verify:** Connect to SessionDO via WebSocket, send a prompt. Receive `gateway_event` messages with `session.init`, `partial_assistant`, `assistant`, `tool_result`, and `result` event types. Disconnect and reconnect — buffered events are replayed.
- **Source:** Duraclaw `apps/orchestrator/src/agents/session-do.ts` (current), Baseplane `apps/agents/src/agents/CodingAgent.ts` (reference)

#### UI Layer

N/A — backend only.

#### API Layer

SessionDO RPC methods (via `@callable`):

```typescript
// New unified interface (replaces current create/abort/stop/submitToolApproval/submitAnswers)
spawn(config: SpawnConfig): Promise<{ ok: boolean; session_id?: string; error?: string }>
stop(reason?: string): Promise<{ ok: boolean; error?: string }>
abort(reason?: string): Promise<{ ok: boolean; error?: string }>
resolveGate(gateId: string, response: GateResponse): Promise<{ ok: boolean; error?: string }>
sendMessage(content: string | ContentBlock[]): Promise<{ ok: boolean; error?: string }>
rewind(turnIndex: number): Promise<{ ok: boolean; error?: string }>  // Backend method only. UI for rewind deferred until #13 ships the gateway rewind command.
getMessages(opts?: { offset?: number; limit?: number }): Promise<ChatMessage[]>
getStatus(): Promise<{ state: SessionState; recent_events: Event[] }>
getKataStatus(): Promise<KataSessionState | null>
```

State shape (broadcast to clients via AIChatAgent state sync):

```typescript
interface SessionState {
  status: 'idle' | 'running' | 'waiting_gate' | 'completed' | 'stopped' | 'failed' | 'aborted'
  session_id: string | null
  project: string
  project_path: string
  model: string | null
  prompt: string
  userId: string | null
  started_at: string | null
  completed_at: string | null
  num_turns: number
  total_cost_usd: number | null
  duration_ms: number | null
  gate: {
    id: string
    type: 'permission_request' | 'ask_user'
    detail: unknown
  } | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  sdk_session_id: string | null
}
```

> **Note:** `stopped` is equivalent to `completed` but initiated by the user (matches current behavior in shared-types). `waiting_gate` replaces the current `waiting_input` / `waiting_permission` split.

Auth: extracted from `X-User-Id` and `X-Organization-Id` headers on WebSocket upgrade. Headers are trusted -- upstream middleware (API routes) validates Better Auth session and sets headers before the WebSocket upgrade reaches the DO.

#### Data Layer

AIChatAgent handles message persistence in DO SQLite automatically. Custom tables retained for:
- `events` — raw GatewayEvent audit log
- `kv` — kata state and session metadata

Removed: custom `messages` table (replaced by AIChatAgent's built-in message store).

---

### B3: Agent-Orch UI Components

**Core:**
- **ID:** agent-orch-ui
- **Trigger:** User navigates to `/` (dashboard) or `/session/$id` (chat view)
- **Expected:** The existing orchestrator UI (chat-view.tsx, dashboard.tsx, project-sidebar.tsx, message-parts/) is replaced by ported agent-orch components from baseplane. ChatThread renders messages with ai-elements components. GateResolver shows approve/deny inline. SpawnAgentForm lists projects from the gateway's `/projects` endpoint. SessionSidebar groups sessions by project with search and archive.
- **Verify:** Navigate to `/`. See project list and session sidebar. Click "New Session", fill form, submit. Session starts streaming. If a gate appears, approve it. Session completes with cost and duration displayed.
- **Source:** Baseplane `apps/web/src/features/agent-orch/` (2,028 lines, 13 files)

#### UI Layer

Components ported from baseplane (import paths updated to `@duraclaw/ai-elements`):

| Component | Lines | Status | Changes |
|-----------|-------|--------|---------|
| GateResolver | 120 | GREEN | Import path swap only |
| ChatThread | 268 | GREEN | Import path swap only |
| KataStatePanel | 88 | GREEN | Import path swap only |
| SessionMetadataHeader | 113 | GREEN | Import path swap only |
| SessionListItem | 78 | GREEN | Import path swap only |
| StreamingText | 34 | GREEN | Import path swap only |
| MessageInput | 137 | YELLOW | Replace PromptInput wrapper |
| AgentDetailView | 48 | YELLOW | None (composition only) |
| SpawnAgentForm | 190 | YELLOW | Replace `/api/cc-gateway/projects` with duraclaw endpoint |
| SessionSidebar | 243 | YELLOW | Minor component swaps |
| AgentOrchPage | 190 | RED | Rewrite data layer (see B4) |

#### API Layer

N/A — components consume the `useCodingAgent` hook, which talks to the DO via `agents/react`.

#### Data Layer

N/A — rendering only.

---

### B4: Data Hooks for Duraclaw

**Core:**
- **ID:** data-hooks
- **Trigger:** UI needs session list, session creation, or session state updates
- **Expected:** `useAgentOrchSessions` hook is rewritten to use duraclaw's ProjectRegistry DO instead of baseplane's DataForge. Session records are stored in ProjectRegistry's DO SQLite. The hook provides reactive session list (active, archived), search, create, update, and archive operations. AgentOrchPage is rewired to duraclaw's TanStack Router with route `/` for dashboard and `/session/$id` for chat.
- **Verify:** Create 3 sessions across 2 projects. Session sidebar shows them grouped by project. Archive one. It moves to archived section. Search by prompt text — results filter correctly. Refresh page — all state persists.
- **Source:** Baseplane `use-agent-orch-sessions.ts` (148 lines — rewritten), `AgentOrchPage.tsx` (190 lines — rewritten)

#### UI Layer

AgentOrchPage rewritten to:
- Use `useAgentOrchSessions()` backed by ProjectRegistry
- Navigate via TanStack Router `useSearch` / `useNavigate`
- Track selected session via URL search param `?session=<doName>`

#### API Layer

ProjectRegistry DO gains new RPC methods:

```typescript
// Existing
listSessions(userId: string): Promise<SessionRecord[]>
registerSession(record: SessionRecord): Promise<void>

// New
updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void>
archiveSession(sessionId: string): Promise<void>
searchSessions(userId: string, query: string): Promise<SessionRecord[]>
```

#### Data Layer

ProjectRegistry DO SQLite gains columns:

```sql
ALTER TABLE sessions ADD COLUMN archived BOOLEAN DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN prompt TEXT;
ALTER TABLE sessions ADD COLUMN total_cost_usd REAL;
ALTER TABLE sessions ADD COLUMN duration_ms INTEGER;
ALTER TABLE sessions ADD COLUMN num_turns INTEGER;
ALTER TABLE sessions ADD COLUMN model TEXT;
```

---

### B5: Deleted Code

**Core:**
- **ID:** deleted-code
- **Trigger:** Implementation of phases P1-P4
- **Expected:** The following files are deleted from the orchestrator:
  - `src/lib/components/chat-view.tsx` — replaced by ChatThread + AgentDetailView
  - `src/lib/components/dashboard.tsx` — replaced by AgentOrchPage
  - `src/lib/components/project-sidebar.tsx` — replaced by SessionSidebar
  - `src/lib/components/message-parts/` — replaced by ai-elements
  - `src/lib/ws-chat-transport.ts` — replaced by AIChatAgent built-in streaming
  - `src/lib/stored-to-ui-messages.ts` — replaced by AIChatAgent message persistence
  - HTTP endpoints: `/tool-approval`, `/answers` — replaced by `resolveGate()` RPC
- **Verify:** `grep -r "ws-chat-transport\|storedToUIMessages\|chat-view\|dashboard" apps/orchestrator/src/` returns no results. `pnpm typecheck` passes.

#### UI Layer

N/A — deletion only.

#### API Layer

Removed HTTP endpoints (replaced by RPC):
- `POST /api/sessions/:id/tool-approval` → `sessionAgent.resolveGate(gateId, { approved })`
- `POST /api/sessions/:id/answers` → `sessionAgent.resolveGate(gateId, { answer })`

#### Data Layer

N/A.

---

## Non-Goals

- Voice input (A.5) — separate spec, uses `withVoiceInput` mixin
- Durable fibers for crash recovery (A.6) — separate spec
- Pluggable gateway (#16) — ships independently
- SDK expansion (#13) — dependency, ships first
- Baseplane-side adoption PR — separate work in baseplane repo
- Customizing shadcn-admin beyond auth swap and route wiring — use the template as-is for the shell
- Multi-session live streaming dashboard (Phase 2 tiles) — this ports the sidebar + single-session view, not the full grid dashboard
- Session rollback/rewind UI — depends on #13 shipping the rewind command
- Push notifications — Phase 4, separate spec
- Offline support — Phase 8, separate spec

## Implementation Phases

See YAML frontmatter `phases:` above. Phases are sequential — each depends on the previous.

**Phase 1 (P1): App shell — shadcn-admin scaffold** — Clone shadcn-admin into the orchestrator. Strip Clerk auth, wire Better Auth. Configure TanStack Router routes. Verify sidebar, theme toggle, command palette, responsive layout. Delete old layout components. This gives us Phase 6.1 (settings), 6.3 (theming), 7.4 (command palette) essentially for free.

**Phase 2 (P2): Extract ai-elements package** — Create `packages/ai-elements/` in the duraclaw monorepo. Copy 32 components + utilities from baseplane. Add package.json with external deps. Configure tsup build. Verify all exports resolve from the orchestrator.

**Phase 3 (P3): Migrate SessionDO to AIChatAgent** — Add `@cloudflare/ai-chat` to orchestrator. Refactor SessionDO to extend AIChatAgent. Override `onChatMessage()` for gateway relay with raw GatewayEvent broadcast. Remove custom message persistence, broadcast, and transport code. Unify gate handling. Normalize status enum.

**Phase 4 (P4): Port agent-orch UI components into shell** — Delete existing chat-view, dashboard, message-parts. Copy 11 agent-orch components from baseplane. Update imports to `@duraclaw/ai-elements`. Wire `useCodingAgent` hook to SessionDO. Mount components inside the shadcn-admin shell routes.

**Phase 5 (P5): Rewrite data hooks** — Implement `useAgentOrchSessions` backed by ProjectRegistry DO. Add search, archive, session record columns. Rewrite AgentOrchPage for duraclaw's router and data layer.

## Test Infrastructure

**Existing:** Vitest configured at `apps/orchestrator/vitest.config.ts`. Unit tests exist for `storedToUIMessages`.

**New:** Integration tests for:
- SessionDO DO: spawn, gate resolution, message persistence, reconnect
- useCodingAgent hook: event parsing, state transitions, RPC calls
- UI components: render tests with mocked hook data

**Build command:** `pnpm typecheck && pnpm build`

## Verification Plan

### VP1: ai-elements Package Builds

Steps:
1. `cd packages/ai-elements && pnpm build`
   Expected: Build succeeds, `dist/` contains JS + type declarations
2. `cd apps/orchestrator && pnpm typecheck`
   Expected: No errors — orchestrator can import from `@duraclaw/ai-elements`

### VP2: SessionDO Relay

Steps:
1. Start gateway: `cd packages/cc-gateway && bun run src/server.ts &`
   Expected: `[cc-gateway] Listening on http://127.0.0.1:9877`
2. Deploy orchestrator locally: `cd apps/orchestrator && pnpm dev &`
   Expected: Dev server starts
3. Connect WebSocket to SessionDO and spawn session:
   ```bash
   wscat -c "ws://localhost:8787/parties/session-agent/test-session" \
     -H "X-User-Id: test-user" \
     -x '{"type":"rpc","method":"spawn","args":[{"project":"duraclaw","prompt":"List files in root directory","model":"claude-sonnet-4-6"}]}'
   ```
   Expected: Receive `gateway_event` messages with `session.init`, then streaming events, then `result`

### VP3: Gate Resolution

Steps:
1. Spawn a session that triggers a tool approval (e.g., file edit)
2. Observe `gateway_event` with `type: "permission_request"` and `tool_call_id`
3. Send: `{"type":"rpc","method":"resolveGate","args":["<tool_call_id>",{"approved":true}]}`
   Expected: Session resumes streaming. State transitions: `waiting_gate` → `running`

### VP4: UI Renders

Steps:
1. Open `http://localhost:5173/` in browser
   Expected: Dashboard with project list and session sidebar
2. Click "New Session", select project, enter prompt, submit
   Expected: Session starts, ChatThread shows streaming assistant messages
3. If gate appears, click "Allow"
   Expected: Session continues
4. Session completes
   Expected: SessionMetadataHeader shows cost, duration, turn count

### VP5: Session Persistence

Steps:
1. Create 3 sessions across 2 different projects
   Expected: Sidebar shows sessions grouped by project
2. Archive one session via dropdown menu
   Expected: Session moves to archived section
3. Search for a session by prompt text
   Expected: Results filter correctly
4. Refresh the page
   Expected: All sessions, including archived state, persist

### VP6: Reconnect Resilience

Steps:
1. Start a long-running session
2. Close browser tab while session is streaming
3. Reopen tab, navigate to the session
   Expected: Session state is current. If session completed while tab was closed, result is shown. If still running, streaming resumes.

### VP7: Deleted Code Verification

Steps:
1. `ls apps/orchestrator/src/lib/components/chat-view.tsx 2>&1`
   Expected: `No such file or directory`
2. `ls apps/orchestrator/src/lib/ws-chat-transport.ts 2>&1`
   Expected: `No such file or directory`
3. `ls apps/orchestrator/src/lib/components/message-parts/ 2>&1`
   Expected: `No such file or directory`
4. `pnpm typecheck`
   Expected: Exit code 0, no errors

## Implementation Hints

### Dependencies

```bash
# P1: ai-elements package
cd packages/ai-elements
pnpm add react react-dom streamdown shiki lucide-react @base-ui/react use-stick-to-bottom motion nanoid clsx tailwind-merge tokenlens

# P2: AIChatAgent
cd apps/orchestrator
pnpm add @cloudflare/ai-chat@^0.4.0

# P3: agents/react for client hook
cd apps/orchestrator
pnpm add agents  # already installed, verify ^0.10.0
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@cloudflare/ai-chat` | `AIChatAgent` | SessionDO base class |
| `agents/react` | `useAgent` | Client-side DO connection + state sync |
| `@duraclaw/ai-elements` | `Conversation, Message, ToolCallList, Reasoning, PromptInput` | Chat UI components |
| `streamdown` | `Markdown` | Streaming markdown renderer in Message |
| `shiki` | `createHighlighter` | Syntax highlighting in CodeBlock |

### Code Patterns

**SessionDO relay override:**

```typescript
import { AIChatAgent } from '@cloudflare/ai-chat'

export class SessionDO extends AIChatAgent<Env, SessionState> {
  initialState: SessionState = { status: 'idle', gate: null, /* ... */ }

  @callable()
  async spawn(config: SpawnConfig) {
    this.setState({ ...this.state, status: 'running', project: config.project, prompt: config.prompt })
    const ws = new WebSocket(this.env.CC_GATEWAY_URL + '?project=' + config.project)
    ws.send(JSON.stringify({ type: 'execute', project: config.project, prompt: config.prompt }))
    
    ws.onmessage = (event) => {
      const gatewayEvent = JSON.parse(event.data)
      // Persist event
      this.sql`INSERT INTO events (type, data, ts) VALUES (${gatewayEvent.type}, ${event.data}, ${Date.now()})`
      // Broadcast raw event to all clients
      this.broadcast(JSON.stringify({ type: 'gateway_event', event: gatewayEvent }))
      // Update state based on event type
      this.handleGatewayEvent(gatewayEvent)
    }
  }

  @callable()
  async resolveGate(gateId: string, response: GateResponse) {
    if (response.approved !== undefined) {
      this.sendToGateway({ type: 'permission-response', tool_call_id: gateId, approved: response.approved })
    } else if (response.answer !== undefined) {
      this.sendToGateway({ type: 'answer', tool_call_id: gateId, answer: response.answer })
    }
    this.setState({ ...this.state, status: 'running', gate: null })
  }
}
```

**useCodingAgent hook pattern:**

```typescript
import { useAgent } from 'agents/react'

export function useCodingAgent(sessionId: string | null) {
  const { state, connection } = useAgent<SessionState>({
    agent: 'session-agent',
    name: sessionId ?? '',
    enabled: !!sessionId,
  })

  const spawn = useCallback((config: SpawnConfig) => connection?.call('spawn', config), [connection])
  const resolveGate = useCallback((id: string, r: GateResponse) => connection?.call('resolveGate', id, r), [connection])
  // ... other RPC wrappers

  // Parse gateway_event messages into chat messages
  useEffect(() => {
    if (!connection) return
    connection.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'gateway_event') handleGatewayEvent(msg.event)
    })
  }, [connection])

  return { state, messages, streamingContent, spawn, resolveGate, /* ... */ }
}
```

### Gotchas

- **AIChatAgent requires `onChatMessage()` override.** Without it, the DO won't process incoming messages. `onChatMessage()` handles follow-up messages sent via `sendMessage()` from the client -- it does NOT handle the initial prompt. The initial prompt goes through `spawn()`, which opens the gateway WS and sends `ExecuteCommand`. `onChatMessage()` is for subsequent user messages during an active session (e.g., `stream-input` to the gateway). Neither method calls `streamText()` — the VPS runs inference, not the DO.
- **`agents/react` useAgent needs the DO name.** The session ID is the DO name. Pass it as the `name` parameter. If no session is selected, disable the hook with `enabled: false`.
- **ai-elements depends on Tailwind v4.** Duraclaw's orchestrator must use Tailwind v4 (already does via Vite 7 + `@tailwindcss/vite`). The ai-elements components use Tailwind's CSS-first configuration.
- **streamdown vs react-markdown.** Baseplane uses `streamdown` for streaming markdown. Duraclaw currently uses `react-markdown`. The migration replaces react-markdown with streamdown (included in ai-elements).
- **shiki lazy loading.** CodeBlock lazy-loads shiki highlighter on first render. The WASM bundle is ~2MB. Consider preloading or chunking via Vite's dynamic import.
- **Gateway URL for SpawnAgentForm.** Baseplane fetches project list from `/api/cc-gateway/projects`. Duraclaw proxies this differently — check the gateway health/projects endpoint configuration in `wrangler.toml`.
- **ProjectRegistry schema migration.** Adding columns to the `sessions` table requires a new migration in the ProjectRegistry DO's `onStart()`. Use the existing sequential migration pattern from Phase 0.1e.
- **`@base-ui/react` vs `@radix-ui/react`.** ai-elements uses `@base-ui/react` (Base UI) for primitives, not Radix directly. This is a separate package — don't confuse with Radix. Both can coexist.

### Reference Docs

- [Cloudflare AIChatAgent docs](https://developers.cloudflare.com/agents/api-reference/chat-agents/) — onChatMessage, message persistence, resumable streaming
- [agents/react useAgent](https://developers.cloudflare.com/agents/api-reference/agents-api/#client-integration) — DO connection, state sync, RPC
- [streamdown](https://github.com/nichochar/streamdown) — streaming markdown renderer
- [Duraclaw cc-gateway protocol](../specs/remote-workbench.md) — GatewayCommand/GatewayEvent types
- [Baseplane CodingAgent](file:///data/projects/baseplane-dev1/apps/agents/src/agents/CodingAgent.ts) — reference relay implementation
- [Baseplane agent-orch UI](file:///data/projects/baseplane-dev1/apps/web/src/features/agent-orch/) — source components to port
