# Runner Status Types & UI Display Surfaces — Audit

Date: 2026-04-18
Mode: research (workflow `RE-ebf9-0418`)
Related: `2026-04-17-issue-5-session-tab-state-root-cause.md`, `2026-04-12-ux-ergonomics.md`

## Problem (user-reported)

> Tab + status bar + nav bar not synced and colors and state types not particularly helpful.

Goal of this research: produce a ground-truth map of (a) every status value that describes a session runner and (b) every UI surface that shows one, so a follow-up spec can collapse the axes and pick a single coherent color/state vocabulary.

## TL;DR

- **Six orthogonal state axes** coexist in the codebase, but the UI pretends there is one. They are: DO `status`, gateway process `state`, WS `readyState`, streaming-part `state`, gate `type`, kata overlay. Some values are authoritative, some are decorative, two are dead code (`waiting_input`, `waiting_permission`, plus `SessionStateChangedEvent.requires_action`).
- **Three surfaces, two sources of truth.** Tab strip and sidebar nav share one component (`StatusDot`) and read from IndexedDB (`SessionRecord.status`, batch-flushed). Status bar reads from a Zustand store fed by the live WS (`useStatusBarStore`). The two can and routinely do disagree.
- **Three color palettes in play.** Hardcoded Tailwind dots (`green-500`/`blue-500`/`yellow-500`/`gray-400`), semantic theme tokens (`--info` / `--warning`), and a third hardcoded set for the WS ready-state dot and context-usage meter. `--success` and `--destructive` are defined in `theme.css` and never applied to session state.
- **Error/failure is invisible outside the detail view.** A crashed session and an idle session render the same gray-outline dot. `SessionState.error` / `SessionState.result` never reach the tab or the sidebar.
- **Connection health leaks only into the status bar.** Tabs show green "running" while the WS is closed — false confidence by design.
- **Spawning vs. thinking vs. streaming** collapses to one state in the status bar; only the tab dot has a pulse animation for the "no-turns-yet" case.

## A. State model inventory

### A.1 Type definitions

| # | Type / field | Location | Values |
|---|---|---|---|
| 1 | `SessionState.status` (DO) | `packages/shared-types/src/index.ts:481-523` | `idle \| running \| waiting_input \| waiting_permission \| waiting_gate` |
| 2 | `SessionState.gate` | same | `{ id, type: 'permission_request' \| 'ask_user', detail } \| null` |
| 3 | Gateway HTTP status (`/sessions/:id/status`) | `packages/agent-gateway/src/types.ts:53-62` | `state: running \| completed \| failed \| aborted \| crashed` |
| 4 | Runner meta file | `packages/session-runner/src/types.ts:44-53` | same five values as #3 |
| 5 | `DialBackClient` WS state | `packages/shared-transport/src/dial-back-client.ts:14` | `connecting \| open \| reconnecting \| closed` |
| 6 | Message part `state` | `apps/orchestrator/src/features/agent-orch/gateway-event-mapper.ts:12-102` | `streaming \| done \| input-available \| output-available \| output-error \| output-denied \| approval-requested` |
| 7 | Kata overlay | `packages/shared-types/src/index.ts:448-470` | `currentMode`, `currentPhase`, `modeState[].status` (free-form) |
| 8 | `SessionStateChangedEvent` | shared-types (legacy) | `idle \| running \| requires_action` — **never emitted, never handled** |

### A.2 Axes — what the values actually describe

| Axis | Owner | Authority for |
|---|---|---|
| **Activity** (what the DO thinks is happening) | DO `status` | turn-taking: when it is legal to `sendMessage`; whether a gate is blocking |
| **Process liveness** | gateway `state` | ground truth for "is the runner process alive"; probed on WS drop in `maybeRecoverAfterGatewayDrop` |
| **WS connection** | `DialBackClient` | whether commands can flow right now |
| **Turn granularity** | part `state` | per-message token streaming / tool round-trip |
| **Gate kind** | `gate.type` | which dialog to render (ask_user vs permission) |
| **Workflow overlay** | kata | metadata-only; does not gate anything |

The DO's `status: 'running'` and the gateway's `state: 'running'` mean different things and can drift: the DO claims `running` as soon as `triggerGatewayDial` is posted (before fork completes), while the gateway's `state` comes from the runner's own `.meta.json` heartbeat. Similarly, the DO can hold `status: 'running'` while the WS is in `reconnecting` — the session is "live" but temporarily deaf.

### A.3 Dead / redundant states

- `waiting_input` and `waiting_permission` are defined in `SessionStatus` but never assigned. They were superseded by the unified `waiting_gate` + `gate.type` pair. They clutter the enum and trip up UI authors who branch on them defensively (see tab / status-bar mapping below — both still have yellow cases for them).
- `SessionStateChangedEvent` with `requires_action` is declared in shared-types and never produced or consumed.
- `gate`, `error`, `result`, and `completed_at` are a covering tuple that the UI treats as independent fields. They mutate together on a `result` event and could be collapsed.

## B. UI surface inventory

### B.1 Tab strip + sidebar nav (same component)

- Strip: `apps/orchestrator/src/components/tab-bar.tsx:279-482` → passes `currentSession.status` + `num_turns` to `<StatusDot>` at `:375-378`.
- Sidebar: `apps/orchestrator/src/components/layout/nav-sessions.tsx:213-640` → same `<StatusDot>` at `:322-355` (Recent) and `:545-547` (Worktree).
- Component: `apps/orchestrator/src/features/agent-orch/session-utils.tsx:19-36`.
- Source of truth: **IndexedDB `SessionRecord.status`** via `useSessionsCollection()`. Batch-flushed, not live.

Mapping table:

| DO status | num_turns | Dot |
|---|---|---|
| `running` | `0` | blue, `animate-pulse` |
| `running` | `>0` | green |
| `waiting_gate` / `waiting_input` / `waiting_permission` | — | yellow |
| everything else (`idle`, implicit `failed`, etc.) | — | gray outline |

No animation on non-spawn running. No error color. No connection indicator.

### B.2 Status bar (bottom of session detail)

- File: `apps/orchestrator/src/components/status-bar.tsx:215-288`.
- Source of truth: **`useStatusBarStore` (Zustand)**, populated by `AgentDetailView.tsx:44-54` from live WS events.
- Three sub-indicators:
  - **Background tint** by DO status (`:81-93`): `running` → `bg-info/20 border-info/50`; any `waiting_*` → `bg-warning/20 border-warning/50`; else transparent.
  - **Text label**: raw enum string rendered as-is at `:243` ("running", "waiting_gate", "idle").
  - **WS dot** (`:21-31`): green (`readyState===1`), yellow (`===0` connecting), red (closed). Unique to this surface.
  - **Elapsed timer** (`:58-79`): only while `running`.
  - **Context meter** (`:33-56`): green / yellow / red at 70% / 90%.

### B.3 Other surfaces found

- No favicon, no window title, no toast hook for status. The three surfaces the user named are the three that exist.
- `packages/ai-elements` does not own a shared status pill. `StatusDot` is local to `agent-orch/session-utils.tsx`.

## C. Concrete divergences (the "not synced" evidence)

1. **Different sources.** Tab/sidebar read persisted `SessionRecord` (IndexedDB). Status bar reads live Zustand state. A WS event updates the status bar immediately; the tab dot only updates once TanStack DB flushes. Users see a stale tab dot for seconds at a time. This is the same root cause as Issue #5 (see `2026-04-17-issue-5-session-tab-state-root-cause.md`).
2. **Different palettes for the same state.** `running` is `green-500` on the tab but `oklch(0.6 0.215 260)` (cool blue) on the status bar. `waiting_*` is `yellow-500` (pure yellow) on the tab but amber (`oklch(0.72 0.18 75)`) on the status bar. They are not quite the same hue and users notice.
3. **Spawning state.** The tab pulses blue on `running + num_turns===0`. The status bar shows a steady blue — no indication that the runner has not yet produced its first turn.
4. **WS health invisible outside the detail view.** A session with a closed WS shows green in the tab, red in the status-bar corner. If the tab is not the focused one, the user has no cue to switch.
5. **Failure invisible everywhere but detail view.** `status: 'idle'` is used for three very different cases — never ran, finished cleanly (`result` set), crashed (`error` set). The tab collapses all three to gray outline.
6. **Gate type invisible.** Permission request and ask_user both paint yellow. The user has to expand the session to see which modal is waiting.
7. **Dead branches ship to production.** The `StatusDot` and status-bar mappings both include `waiting_input` and `waiting_permission` cases that will never fire. Defensive branches that fossilize a dead enum.

## D. Recommendation sketch (for the follow-up spec)

This is research, not a spec — but the fix has a clear shape and should be captured here so the spec doesn't rediscover it.

### D.1 Collapse to one display model, derive it from two axes

Replace the implicit "whatever's in `SessionRecord.status`" read with an explicit display-state derived live from two authoritative inputs:

```
Activity (from DO status + gate) × Connection (from WS readyState)
```

Produce a single enum consumed by every surface:

| Display state | Derivation | Semantic |
|---|---|---|
| `disconnected` | WS closed/reconnecting, DO says running | "we think it's alive but can't talk to it" |
| `spawning` | DO `running`, `num_turns===0`, no partials yet | "fork in progress / SDK booting" |
| `thinking` | DO `running`, last event is reasoning delta | "model is mid-turn, no user-visible text yet" |
| `streaming` | DO `running`, last event is text delta | "visible tokens flowing" |
| `tool-running` | open part with `state: input-available` | "SDK is executing a tool" |
| `waiting-permission` | `gate.type === 'permission_request'` | needs approval |
| `waiting-question` | `gate.type === 'ask_user'` | needs answer |
| `idle-clean` | DO `idle`, `error == null`, `result != null` | completed OK |
| `idle-error` | DO `idle`, `error != null` | completed with error |
| `idle-never-ran` | DO `idle`, `result == null`, `error == null` | fresh draft |

This collapses six axes to a presentation enum with defined coverage.

### D.2 Single source of truth for colors

Introduce `apps/orchestrator/src/lib/session-status-display.ts` (or similar) exporting both the display-state derivation and the token table. Use semantic tokens only (`--info`, `--warning`, `--success`, `--destructive`, plus a new `--neutral-muted`), not Tailwind color scales. Every surface imports the same map; no inline conditionals.

Concretely the sketch proposed by the UI-side exploration:

```ts
export const DISPLAY = {
  disconnected:       { dot: 'destructive',  anim: 'pulse',  label: 'Disconnected' },
  spawning:           { dot: 'info',         anim: 'pulse',  label: 'Starting…' },
  thinking:           { dot: 'info',         anim: 'pulse',  label: 'Thinking…' },
  streaming:          { dot: 'info',         anim: 'pulse',  label: 'Streaming…' },
  'tool-running':     { dot: 'info',         anim: 'pulse',  label: 'Tool…' },
  'waiting-permission': { dot: 'warning',    anim: 'glow',   label: 'Approve?' },
  'waiting-question': { dot: 'warning',      anim: 'glow',   label: 'Needs answer' },
  'idle-clean':       { dot: 'success',      anim: null,     label: 'Done' },
  'idle-error':       { dot: 'destructive',  anim: null,     label: 'Error' },
  'idle-never-ran':   { dot: 'neutral-muted',anim: null,     label: 'Idle' },
}
```

### D.3 Unify source of truth for the value

Both the Zustand status-bar store and the IndexedDB `SessionRecord` should be downstream of the same WS event stream. Either push the computed display-state into IndexedDB on each DO broadcast (so the tab updates immediately) or have the tab subscribe to the live store for the currently-broadcasting session. The simplest fix: derive display-state on render from `useSessionsCollection()` + a small live-WS overlay for the active session, and let IndexedDB hold only the last known value for offline/cold tabs.

### D.4 Delete the dead states

Remove `waiting_input` and `waiting_permission` from `SessionStatus`, and delete `SessionStateChangedEvent` + `requires_action`. Replace the fossilized UI branches accordingly. This is a small shared-types refactor with a compile-check safety net.

### D.5 Surface coverage for what currently leaks

- **Connection health** should also render in tab/sidebar — e.g., a red-ringed outline over the dot when `disconnected`.
- **Error** deserves its own color in tab/sidebar (D.1 above). A red dot with a static (non-pulsing) fill.
- **Gate kind** should differ between permission and question — two labels, same warning tone, different glyphs.

## E. Files to touch in the follow-up spec

- `packages/shared-types/src/index.ts` — prune `SessionStatus`, delete `SessionStateChangedEvent`.
- `apps/orchestrator/src/features/agent-orch/session-utils.tsx` — replace `StatusDot` with the shared display component.
- `apps/orchestrator/src/lib/session-status-display.ts` — **new** — derivation + token table.
- `apps/orchestrator/src/components/tab-bar.tsx` — consume new component.
- `apps/orchestrator/src/components/layout/nav-sessions.tsx` — consume new component.
- `apps/orchestrator/src/components/status-bar.tsx` — consume same derivation for bg tint and text; keep its WS dot + context meter as separate concerns.
- `apps/orchestrator/src/styles/theme.css` — add `--neutral-muted` if missing; leave `--success`/`--destructive` as-is.

## F. Open questions

1. Should the status bar keep its dedicated WS readiness dot, or roll connection health into the single display-state enum? The user said "not particularly helpful" which suggests one indicator is better than three.
2. Does `idle-never-ran` warrant a distinct color or is it fine to reuse `idle-clean`'s neutral?
3. For multi-turn sessions, is "streaming" visible long enough on a cold cache to be worth distinguishing from "thinking"? If not, collapse both to `busy`.
4. The kata overlay (`currentMode` / `currentPhase`) is not currently in any of the three surfaces. Is that intentional or a bug?
