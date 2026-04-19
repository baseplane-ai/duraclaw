---
date: 2026-04-19
topic: Kata Mode Chain UX — grouping, auto-advance, context reset
type: brainstorm
status: draft
github_issue: null
related:
  - packages/kata/batteries/templates/research.md
  - packages/kata/batteries/templates/planning.md
  - packages/kata/src/commands/link.ts
  - apps/orchestrator/src/hooks/use-tab-sync.ts
  - apps/orchestrator/src/features/agent-orch/SessionCardList.tsx
---

# Kata Mode Chain UX — grouping, auto-advance, context reset

## 1. Problem statement

A kata workflow in Duraclaw is really a **chain of mode sessions** against
a single piece of work: `research → planning → implementation → verify →
close`. Today that chain is only implicit.

Three concrete pains:

1. **The chain key doesn't exist until planning.**
   `workflowId = GH#<n>` is our natural grouping key, but the GitHub issue
   is created in `planning` mode's `link-github-issue` step. Research,
   debug, freeform, task all run **before the key exists**, so they float
   as orphaned sessions with no way to roll them up.
2. **One long SDK session bloats context.**
   `kata enter <next>` inside an existing session keeps the same
   `sdk_session_id` — the Claude Agent SDK transcript just keeps growing
   across research → spec → impl. By verify mode, the context window is
   full of stale research chat the verifier doesn't need.
3. **The UI has no "chain" surface.**
   Tabs cluster by *project*, not by issue. `SessionCardList` shows
   `kataMode + kataIssue + kataPhase` per card, but there is no view that
   says "here are the four sessions that belong to issue #42 and this is
   where in the pipeline we are."

The user-visible symptom: "I just spent a research session writing a great
doc. Now I want to plan. I lose the thread, my context window is full, and
I can't find my way back to the research from the sidebar."

## 2. Current state (grounded)

| Piece | Where | Reality |
|---|---|---|
| Mode order | `packages/kata/kata.yaml` + `src/config/kata-config.ts:16` | Modes have `issue_handling: required \| none` |
| Chain key | `packages/kata/src/utils/workflow-id.ts:7` | `GH#<n>` if linked, ephemeral `<MODE>-<slug>-<date>` otherwise |
| Cross-mode state | `.kata/sessions/<id>/state.json` (`schema.ts:37–90`) | `modeHistory[]`, `previousMode`, `issueNumber`, `issueTitle` persist across `kata enter` calls |
| Issue creation | `planning.md:498–521` | `gh issue create` only in planning P2; research close never prompts for issue |
| Retroactive link | `commands/link.ts:161–206` | `kata link <n>` works post-hoc, one issue at a time |
| SDK session | `session-runner` + `SessionDO` | One `sdk_session_id` per runner process; kata state changes don't restart the runner |
| D1 surface | `apps/orchestrator/src/lib/types.ts:87–89` | `kataMode`, `kataIssue`, `kataPhase` columns already exist on agent sessions |
| Tab clustering | `hooks/use-tab-sync.ts:130–167` | Yjs `Y.Map<string>('tabs')`; cluster key is `project`, one-tab-per-project, fractional order for same-project grouping |
| Chain view | _nowhere_ | Sessions are solo in the sidebar; no "all sessions for #42" route |
| Handoff | _none_ | Next mode rediscovers prior artifacts via GitHub issue / filesystem |

So: the **data is all there**. What's missing is (a) a chain key at
research-close time, (b) a tab/route that treats the chain as a
first-class entity, and (c) a mode-entry flow that trades transcript
continuity for context budget.

## 3. Design proposal

Three composable moves. Each is usable on its own; together they enable
auto-advance.

### 3A. Promote to issue at research close — **kata-layer feature**

Add a step to `research.md` P5 `present-and-decide` (after the doc is
committed, before the mode exits):

```
Promote these findings to a GitHub issue?
  [Y] Create issue #___  (default)
  [n] Not yet — leave unlinked
  [e] Edit title/labels first
```

On Y:

- `gh issue create --title "<topic>" --body "<summary + relative link to committed research doc>" --label "status:researched,type:<feature|bug|refactor>"`
- Write back `github_issue: <n>` to the research doc frontmatter and
  commit the single-line update
- `kata link <n>` to set `issueNumber` / `workflowId=GH#<n>` on the current
  session state

Why at research close, not planning P2:

- **The chain is born when the finding is born.** Planning, debug, task
  modes can all now attach to the same issue without the awkward "we have
  a spec but no issue yet" gap.
- Research is already interactive (the "Plan the feature / More research /
  Done" prompt in P5) — adding one more question is free UX.
- Fallback to `n` preserves the "I'm exploring, don't nail me down" case
  — workflowId stays ephemeral, chain just isn't visible yet; `kata link`
  later still works.

Non-goals: replace planning's issue creation. When research skipped the
promote, planning P2 still creates the issue as today.

### 3B. Chain = first-class tab/route — **Duraclaw-layer feature**

Introduce `TabKind = 'session' | 'chain'` on the Yjs tab record.

**Chain tab record** (superset of current schema):

```ts
{
  id, order, userId, createdAt,      // unchanged
  kind: 'chain',
  issueNumber: 42,                   // cluster key
  project: 'duraclaw-dev1',          // for secondary sort
  activeSessionId: 'sess_...'        // which mode is currently "live"
}
```

Cluster key becomes **`issueNumber ?? project`**: all chain tabs for
issue #42 collapse into one tab; unlinked sessions still cluster by
project as today. One-chain-per-issue-per-user enforced the same way
one-tab-per-project is today (`use-tab-sync.ts:327`).

**Route:** `/chain/:issueNumber` renders:

```
┌──────────────────────────────────────────────────────────┐
│ #42 · Pluggable agent gateway     [in-progress] [feature]│
├──────────────────────────────────────────────────────────┤
│ ◉ research   ✓ done   2h ago   📄 research/...-gw.md    │
│ │                                                        │
│ ◉ planning   ✓ done   1h ago   📋 specs/42-gateway.md   │
│ │                                                        │
│ ◉ impl       ● live   now      🔧 sess_xyz  → PR #77    │
│ │                                                        │
│ ○ verify     pending                                     │
│ ○ close      pending                                     │
│                                                          │
│ [Continue to verify →]                                   │
└──────────────────────────────────────────────────────────┘
```

Each row is a session card. The active row expands to the live transcript
(reusing `SessionCardList` internals); completed rows collapse to a
one-liner with artifact chips. Crashed rows go red with a "resume" action.

Query side: `GET /api/sessions?issue=42` already works given the
`kataIssue` column — just need a router/page. Live updates come through
the existing `sessionLiveStateCollection` TanStack DB pipeline (issue #12
unblocks the clean version of this).

### 3C. Session reset on mode enter — **Duraclaw-layer feature, not kata**

**Layer attribution matters here.** Kata is a CLI that runs *inside* a
Claude Code conversation. It can record state, emit hook output, invoke
skills — but it **cannot** kill its host process, respawn a runner, or
rotate the `sdk_session_id`. Process lifecycle lives one layer up, in
Duraclaw: `SessionDO` → `agent-gateway` → `session-runner` owns the
Claude Agent SDK `query()`.

So 3C is a **Duraclaw meta feature**. Kata's only role is to *signal*
the mode transition — and that signal already flows today:

```
kata enter <mode>   (inside the CC conversation)
  └─ writes .kata/sessions/<id>/state.json
  └─ emits kata_state via the CC hook → runner → WS
     └─ SessionDO.onMessage('kata_state')
        └─ syncKataToRegistry()  (existing, session-do.ts:694)
           └─ D1 agentSessions.{kataMode, kataIssue, kataPhase}
```

The new move is to add a watcher in `SessionDO` that, when it sees a
`currentMode` change inside an issue-linked chain, performs the
session-reset dance:

1. Flush `BufferedChannel`; wait for in-flight `result` + any dirty
   artifacts to persist
2. `SessionDO.closeRunner({reason: 'mode_transition', code: 4411})` —
   clean WS shutdown; runner exits via its existing terminal-close path
   (same family as `4401` / `4410`)
3. DO persists `modeHistory[last].exitedAt` on the chain record
4. DO spawns a **new** runner via the existing
   `triggerGatewayDial({type:'execute', …})` — fresh `sdk_session_id`,
   fresh PID
5. The new runner's first prompt is a DO-generated **artifact-pointer
   preamble** (not a transcript copy):

```text
You are entering {mode} mode for issue #42 ("{title}").

Prior artifacts in this chain:
- Research: planning/research/2026-04-19-gateway.md
- Spec:     planning/specs/42-gateway.md
- Previous PR: #77

Read the relevant artifacts before acting. Your kata state is already
linked: workflowId=GH#42, mode={mode}, phase=p0.
```

The hand-off is **artifact-pointer, not transcript-copy**. The new SDK
reads the files it needs on its first tool call; context stays lean.
This is the same trick the orphan case in `sendMessage` already uses
(`<prior_conversation>…</prior_conversation>` preamble) but one level up
— mode transitions instead of runner orphan recovery.

What kata does *not* need to change for 3C:
- `kata enter` still just mutates `.kata` state + prints guidance
- No new kata flag required for the reset itself — the DO watches mode
  transitions and decides

What kata *could* gain as an optional ergonomic:
- A `--continue-sdk` hint in the kata state payload that asks the DO to
  skip the reset (for short mode hops where the transcript matters, e.g.
  `verify` → `debug` → back). The DO treats it as advisory.

UX cue in the chain timeline: a subtle `──✂──` divider between rows
marks the runner boundary, so users trust that entering a new mode
won't blow their context budget.

**Dependencies:**
- GH#12 (TanStack DB unification) should land first so the UI has a
  single truth source for "mode changed, old runner gone, new runner
  warming up" state transitions without races between the 4 channels
  that carry session state today.
- GH#14 (message transport on TanStack DB) makes the transcript
  boundary cleanly renderable — messages from the new runner carry a
  different `sdk_session_id` and collect under the new row.

## 4. Auto-advance — the payoff once 3A+3B+3C ship

With the chain as a first-class surface and mode-entry as a known-safe
context reset, we can add an inline "next step" action per row:

| After | Suggest | Preconditions |
|---|---|---|
| research close | `Continue to planning →` | research doc committed, issue linked |
| planning approved | `Continue to implementation →` | spec exists + `status:approved` |
| impl build green | `Continue to verify →` | tests pass on last turn |
| verify plan green | `Continue to close →` | VP evidence recorded |

The button runs `kata exit && kata enter <next> --issue=<n>` under the
hood, which already does the right thing given 3C. Keyboard: `→` focuses
next action, `⌘↵` confirms. User can always decline and stay in mode.

Stretch: a chain-level "run the rest" toggle that auto-advances when
phase gates go green. Off by default — auto-advance without a human in
the loop is how you merge bad specs. But the plumbing is the same.

## 5. Trade-offs & open questions

1. **Modes that never get an issue (debug, freeform).** Keep an "Unlinked"
   cluster in the sidebar; add "Attach to chain" (`kata link`) on any
   orphan tab, mirroring Linear's "link to issue".
2. **Who creates the issue in 3A.** Local `gh` is simplest but needs CLI
   auth on the runner host. Cleaner: orchestrator exposes `POST
   /api/chain/promote` that uses the user's stored GitHub token. Start
   with local `gh` (matches current planning P2), migrate later.
3. **Research-findings-in-context loss on 3C reset.** Mitigated by the
   artifact-pointer preamble, but the planner may need the *reasoning*,
   not just the conclusions. If that's a recurring pain, add a "pin
   excerpts to chain" action in the research row that seeds the preamble
   with quoted passages.
4. **Concurrent chains on one issue (two agents working in parallel).**
   Allow, don't lock. Chain view shows both; tab cluster dedupes per
   user, not globally. Useful for dual-browser verify flows
   (`axi-dual-login`).
5. **Back-compat.** Existing sessions with no `kataIssue` stay as solo
   session tabs; they get the "Attach to chain" affordance but nothing
   breaks. Tab-cluster refactor is additive: `kind: 'chain' | 'session'`
   defaults to `'session'` when absent.
6. **Which modes qualify as chain steps?** Research, planning, impl,
   verify, close clearly do. Task is ambiguous — it's "small combined
   planning+impl"; probably render as a single row. Debug attaches but
   doesn't advance (it's a side-quest). Freeform never attaches.
7. **Chain ordering vs. modeHistory.** `modeHistory` is linear; chains in
   practice branch (impl → debug → impl). Render as timeline with
   branches collapsed by default; expand on click. Data model stays
   linear because `previousMode` is linear — branches are just repeated
   entries.
8. **When does a chain end?** `close` mode's exit, or PR merge, or issue
   close. Probably: issue close (via GitHub webhook → DO → tab record
   `archivedAt`). Archived chains drop out of the sidebar but remain
   routable.

## 6. Minimal shipping sequence — split by layer

| # | Spec | Layer | Surface area | Rough |
|---|---|---|---|---|
| A | Research promote-to-issue | **kata** (CC-layer) | `research.md` P5, `commands/link.ts`, small `gh issue create` wrapper | ~1 day |
| B | Chain tab surface | **Duraclaw orchestrator** (UI) | `use-tab-sync.ts` (kind field, new cluster key), new `/chain/:issueNumber` route, `SessionCardList` grouping variant, `GET /api/sessions?issue=<n>` already works | ~3 days |
| C | Mode-enter session reset | **Duraclaw runtime** (DO + runner) | New `SessionDO` watcher on `kata_state.currentMode` transitions, clean-close via new `4411 mode_transition` close code, preamble template, advisory `--continue-sdk` hint in kata payload | ~4 days |
| D | Auto-advance affordances | **Duraclaw UI** | Inline "Continue to <next> →" actions on chain rows, preconditions table, keyboard bindings | ~1 day |

**The kata / Duraclaw split is load-bearing:**
- A is the only kata-side change. It's a CLI prompt + a `gh` shell-out.
  No Duraclaw changes required.
- B, C, D are all Duraclaw. Kata contributes zero new behaviour beyond
  what `syncKataToRegistry()` already emits today.
- Interface contract between the two layers stays narrow: kata writes
  `{mode, issueNumber, phase}` to state, the runner pipes it to the DO,
  the DO does everything else.

Total ~9 days to get from "four unrelated sessions" to "one chain tab
that walks itself through the kata pipeline with a human confirm at each
mode gate."

## 7. Recommendation

Ship **3A alone first** — it's the cheapest change and the only one
that touches kata. It unblocks the chain key and immediately makes
`kata link` rarely needed. Then 3B for the visible payoff (Duraclaw UI
only). 3C last because it's the Duraclaw-runtime change — touches DO
lifecycle and runner close codes, and wants GH#12's single-channel
state to land first. Auto-advance (3D) falls out naturally on top.

The mental model worth keeping straight: **kata signals, Duraclaw
acts.** Anything that involves killing processes, rotating
`sdk_session_id`, or rendering UI is a Duraclaw feature. Kata just
writes `{mode, issueNumber, phase}` and asks nicely.

The user's instinct in the prompt is right: **promote at research close,
chain is the tab, reset at mode enter**. Nothing in the current code
fights this — the kata state model already tracks `modeHistory` and
`issueNumber`, the D1 schema already has `kataIssue`, and the tab system
already supports fractional-order clustering. The features are
shaped-shaped for what exists.
