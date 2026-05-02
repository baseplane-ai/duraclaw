---
date: 2026-05-01
topic: UX organization — project + arc, with global view and one-off sessions
type: brainstorm
status: complete
github_issue: 160
companion_doc: 2026-05-01-arc-project-worktree-session-tension.md
items_researched: 2
---

# Research: How to organize the UI by project + arc, while keeping global view and one-off sessions

## Context

The companion data-side doc ([`2026-05-01-arc-project-worktree-session-tension.md`](./2026-05-01-arc-project-worktree-session-tension.md)) maps the four primitives' schemas, lifecycles, and the seams between them. **It's the foundation; this is the actual question.**

The UX challenge: duraclaw needs four orthogonal access patterns —

1. **Organize by project** (group by repo)
2. **Organize by arc** (group by workflow / issue)
3. **Work across all** (global view that crosses projects and arcs)
4. **One-off sessions** (quick freeform that doesn't belong to a project workflow)

— and today's UI mashes them into a sidebar with three overlapping sections plus a flat `/projects` page. Project-first and arc-first views **duplicate** each other; one-off sessions exist as a fiction (implicit single-session arcs); the cross-all view is split between "Recent" and scattered status dots; and there's no clean quick-capture path.

## Scope

Two parallel deep-dives:

- **Walk four user jobs** through today's UI, citing file:line for friction
- **Prior art** from Linear, Cursor, JetBrains, Slack, Notion, Raycast, Obsidian on two-axis organization + global view + quick-capture

Plus synthesis into UX models with ASCII mockups.

## Findings

### Today's UX, jobs-to-be-done view

| Job | Today's path | Friction | Click count |
|-----|-------------|---------|-------------|
| **Start a one-off session** | Sidebar `+ New session` → draft tab → QuickPromptInput → pick project → submit | Mandatory project pick (auto-selects first); draft lingers in Recent; no "scratch mode" | 3 |
| **Switch project + start session** | Find project in sidebar Worktrees tree OR navigate to `/projects` → click Open Sessions → submit | No project list on `/`; arc/mode context doesn't carry; tab-per-project dedup blocks parallel sessions | 4+ |
| **Find an old session** | Sidebar Recent (last 25) OR drill Worktrees tree OR `/board` (open arcs only) | No search, no date filter, closed arcs hidden, only 25 in Recent, no `createdAt` shown | 3-5 (and often fails) |
| **See what needs my attention** | Scan StatusDots in Recent + PipelineDots on arcs in sidebar | No filter, no aggregates, no "your turn" surface, pipeline dots cryptic without legend | 1 (but incomplete) |

(Sources: `nav-sessions.tsx:481-509` for new-session button; `AgentOrchPage.tsx:504-515` for QuickPromptInput; `nav-sessions.tsx:557-560` and `nav-sessions.tsx:979-1003` for status dot patterns.)

### The four-section overlap

The sidebar's three sections + `/projects` page index the same data four different ways:

| Data | Recent | Arcs | Worktrees | `/projects` |
|------|--------|------|-----------|-------------|
| Sessions | flat, last 25 by activity | nested under multi-session arcs | nested under repo→worktree→issue chain | none |
| Arcs | not shown | open/draft only | not shown | none |
| Projects | as `session.project` label | not shown | grouped by repo | full card view |
| Status | per-session `StatusDot` | `PipelineDots` per arc | per-session in tree | none |
| Sort | `lastActivity DESC` | by title | repo → project → issue | alphabetical |

**The same session appears in three places** in the sidebar with three different sort orders. Recent is best for "what did I just work on"; Arcs is best for "what's this issue's status"; Worktrees is best for "what's in this repo"; `/projects` is best for "who owns what." But there's massive overlap and no clear authority.

### Prior art — what mature tools actually do

**Linear** (issues inside teams/projects)
- Cross-cutting: *My Issues* (relevance heuristic), *Inbox* (notification-sink)
- Quick-capture: Cmd+K (still requires team context — no scratch issue)
- Switch context: sidebar team rail
- ([My Issues](https://linear.app/docs/my-issues), [Conceptual Model](https://linear.app/docs/conceptual-model))

**Cursor** (chat threads inside workspaces)
- Cross-cutting: **none** — chat is silo'd per workspace path
- Quick-capture: Cmd+L for chat, but still inside workspace
- Failure mode: rename a folder and your history vanishes ([forum complaint](https://forum.cursor.com/t/create-a-unified-chat-history-view-across-all-projects/149955))
- **The cautionary tale duraclaw must avoid: don't bind sessions to filesystem paths.**

**JetBrains** (files inside projects + Scratch Files)
- Cross-cutting: *Recent Files* (Cmd+E)
- Quick-capture: **Cmd+Shift+N → instant scratch file, no project**, can be promoted to project later via F6
- ([Scratch Files docs](https://www.jetbrains.com/help/idea/scratches.html))
- **The gold standard for "start without committing to context."**

**Slack** (threads inside channels inside workspaces + DMs)
- Cross-cutting: *Threads* view, *All Unreads*
- Quick-capture: Cmd+Shift+N for new DM, instant
- DMs are the "no-context" tier — always available, zero commitment
- ([Threads](https://slack.com/help/articles/115000769927))

**Notion** (pages inside databases inside teamspaces)
- Cross-cutting: *Inbox* (notifications)
- Quick-capture: Cmd+N anywhere, but defaults to current page parent — friction-y
- Resolution: lean on search, accept "commit now, organize later"

**Raycast** (commands + global notes)
- Pure quick-capture: Alt+N (configurable) anywhere → notes outside any project
- Inverse model: maximally frictionless capture, no organization
- ([Notes manual](https://manual.raycast.com/notes))

**Obsidian** (notes inside vaults + Daily Notes)
- Vault-bound (Cursor's problem)
- Daily Notes plugin acts as always-on capture surface

### Three patterns that recur

1. **Tiered context commitment** — every mature tool has both an "in-project" tier and a "no-project" tier. Slack's DMs vs channels. JetBrains' scratches vs project files. Linear's My Issues vs team views (weaker — still team-scoped). The tools that feel best **make these tiers maximally separate** so you can fluidly skip the project commitment.

2. **Cross-cutting view = notification sink, not work view** — Linear Inbox, Slack Threads, Notion Inbox all *notify* (mentions, assignments, unread); they don't reorganize work. The primary unit (team / channel / project) stays the source of truth. **No tool makes the cross-cutting view the primary landing page for active work.** Recency-based "Recent" or "Today" views are the closest.

3. **Sidebar as context rail** — universal. Persistent left rail with hierarchy (teams nested with channels, or favorites at top). Humans scan a sidebar in <1s. Cursor's per-workspace sidebar is the outlier and the source of its pain.

### Two patterns that DON'T transfer to duraclaw

1. **Filesystem-bound workspaces** — Cursor and Obsidian both bind context to file paths. Claude Code sessions are async and multi-project; binding session context to repo path will fail catastrophically when the user switches branches or moves a clone. **Sessions must be first-class entities with stable IDs, not filesystem-derived.**

2. **Inbox-as-notification model** — Linear and Slack inboxes work because they're real-time team-collaboration surfaces (you get pinged, you react, the thread resolves). Claude Code sessions are async and often solo; you might return after days. A notification-sink inbox will fill with stale items. Duraclaw needs a **temporal-decay** model (snooze, archive, fade), not pure notification-stack.

### The unexpected insight: it's a three-axis problem

The user said two axes (project + arc). Prior art says **three**:

- **Axis 1 — Organizational scope:** project (repo)
- **Axis 2 — Work unit:** arc (workflow / issue)
- **Axis 3 — Temporal state:** active / recent / dormant / archived

Linear optimizes 1+2, ignores 3 (snooze is a patch). Slack optimizes 1+3, treats 2 as side-effect. JetBrains optimizes 3 (Recent Files), accepts no Axis 1 organization for scratches.

**Tools that feel least frustrating dominate one axis and accept weakness in others, hidden by raw speed.** Linear's My Issues uses a fuzzy "Focus" heuristic, but it loads in 200ms with a hotkey, so the fuzziness doesn't matter. JetBrains scratches require manual organization, but they're created in <100ms, so the lack of structure doesn't matter.

**For duraclaw:** don't try to be strong on all three axes. Pick **Axis 2 (arc/session as primary unit)** since Claude Code is multi-turn and conversation-centric, then make project-switching and recent-finding sub-second.

## Three UX models, compared

### Model A — Reconciled sidebar + Scratch primitive *(incremental)*

Keep today's sidebar shape but kill the duplication and add a real scratch concept.

```
┌─────────────────────────────────────┬──────────────────────────────────┐
│ + New scratch         (cmd+shift+n) │   Active session (full width)    │
├─────────────────────────────────────┤                                  │
│ ▼ Scratch              (3)           │                                  │
│   • untitled — 2m ago      ●         │   [chat / streaming / kata     ] │
│   • untitled — 1h ago                │                                  │
│   • untitled — yest                  │                                  │
├─────────────────────────────────────┤                                  │
│ ▼ Recent               [filter ▾]    │                                  │
│   ● 160-research • duraclaw • 2m     │                                  │
│   ● auth-debug • baseplane • 1h      │                                  │
│   ⌛ #157 verify • duraclaw • yest    │                                  │
│   …  [show 22 more]                  │                                  │
├─────────────────────────────────────┤                                  │
│ ▼ Arcs in flight       (4)           │                                  │
│   ▸ #160 group projects (research)   │                                  │
│   ▸ #157 mobile follow-ups (impl)    │                                  │
│   ▸ #156 image bug (debug)           │                                  │
│   ▸ side-arc: yjs proto              │                                  │
├─────────────────────────────────────┤                                  │
│ ▼ Projects             (5)           │                                  │
│   ▸ duraclaw           [3 wt, 8 ses] │                                  │
│   ▸ baseplane          [1 wt, 2 ses] │                                  │
│   ▸ packages/kata      [1 wt]        │                                  │
│   …                                  │                                  │
└─────────────────────────────────────┴──────────────────────────────────┘
                                       [↓ status bar: 3 running · 1 ⌛  ]
```

**Changes:**

- **New Scratch section at top.** One-off sessions live here, never inside a project tree. `Cmd+Shift+N` creates a scratch with no project pick — defers the project decision until first prompt or first commit-touch. JetBrains' scratches model. Promote-to-project is a one-click action when the scratch graduates into real work.
- **Recent stays as global cross-project glance** but gets a filter chip bar (`Awaiting input / Running / Errors / All`). Reuses the existing All/Mine toggle pattern from `nav-sessions.tsx:511-539`.
- **Arcs section becomes "Arcs in flight"** — open/draft only, no implicit-single-session arcs (those collapse to scratch or to the project tree as appropriate).
- **Worktrees section renamed to Projects.** Repo → worktree → sessions tree. The grouping uses `repo_origin` (already done at `nav-sessions.tsx:393`) — this is the GH#160 fix at the structural level, not just a `/projects`-page patch.
- **`/projects` becomes admin-only.** Ownership, docs path setup, visibility — settings-style page, not a navigation surface. Removes the duplication.
- **Status bar at bottom.** Persistent across-all aggregates ("3 running · 1 awaiting input · 0 errors"). Click to filter Recent.

**Pros:** Closest to today; minimal user re-learning; fixes GH#160 + scratch gap + status-glance gap in one pass.
**Cons:** Sidebar is still doing four things; some users will still find Recent vs Projects vs Arcs confusing.
**Lift:** ~2-3 weeks of UI work + one schema add (scratch as a session-without-arc, or an "is_scratch" flag on arcs).

### Model B — Three-pane (rail | content | inspector) *(bigger refactor)*

```
┌──────────┬─────────────────────────────────────┬──────────────────────┐
│ ▾ All    │   duraclaw — Arcs                   │   Active session     │
│ ▾ Scratch│                                      │                      │
│ ───      │   ▸ #160 group projects   research   │   [chat / kata /   ] │
│ ▸ duraclw│   ▸ #157 mobile           impl       │                      │
│   3wt    │   ▸ #156 image bug        debug      │                      │
│ ▸ basepln│                                      │                      │
│   1wt    │   ─── recent sessions in duraclaw ───│                      │
│ ▸ packgs │   ● 160-research • 2m • mode=res     │                      │
│   1wt    │   ⌛ #157 verify • yest • mode=verif  │                      │
│ ───      │   ● auth-debug • 1h • mode=debug     │                      │
│ + new    │                                      │   [inspector tabs]   │
│  project │                                      │                      │
└──────────┴─────────────────────────────────────┴──────────────────────┘
[                          + new scratch (cmd+shift+n)                    ]
```

**Changes:**

- **Left rail = project switcher.** Includes "All" (cross-cutting view, default landing) and "Scratch" (the no-project tier) at the top. This is Linear's team rail / Slack's workspace rail.
- **Center = active context.** When project is selected, shows arcs (kanban or list) + recent sessions in that project. When "All" is selected, shows global Recent. When "Scratch" is selected, shows the scratch list.
- **Right = inspector.** The active session, plus tabs for kata state, sources, branches.
- **Quick-create FAB.** Always visible. Default action: create scratch. Hold-modifier: create in current project.
- **One-offs are first-class.** "Scratch" rail item is permanent; never goes through project selection.

**Pros:** Cleanest mental model; matches mature tools; project switching becomes O(1). Solves the four-section duplication completely.
**Cons:** Major refactor; users have to relearn navigation; inspector pane on small screens (mobile, narrow desktop) is a problem.
**Lift:** ~1-2 months. Probably wants to be sequenced after Model A as a v2.

### Model C — Faceted single list + Cmd+K *(power-user, minimal-chrome)*

```
┌──────────────────────────────────────────────────────────────────────┐
│ Cmd+K to find/jump  ·  Cmd+Shift+N for scratch                       │
│ Filters: [Awaiting input] [Running] [duraclaw ▾] [last 7d ▾]         │
├──────────────────────────────────────────────────────────────────────┤
│ ⌛ #157 verify           duraclaw   verify       yest   awaiting input│
│ ●  160-research          duraclaw   research     2m     running       │
│ ●  auth-debug            baseplane  debug        1h     running       │
│ ○  #156 image bug        duraclaw   debug        2d     idle          │
│ ⌛ #122 ownership review  duraclaw   verify       3d     awaiting input│
│ ○  scratch — yest        scratch    —            yest   idle          │
│ …                                                                     │
└──────────────────────────────────────────────────────────────────────┘
```

**Changes:**

- **One main view.** Scrollable list of arcs + sessions. Filter chips replace the sidebar tree. Cmd+K command palette for find/jump.
- **Project becomes a filter chip, not a hierarchy.** "All" is the default; click "duraclaw" to scope.
- **Scratch is a project-like filter** ("scratch" appears in the project chip dropdown alongside duraclaw, baseplane, etc.).
- **No persistent navigation tree.** Search-first.

**Pros:** Maximally flexible; matches Linear's My Issues feel; small screen works.
**Cons:** Loses the "scan and locate" affordance of a sidebar; users who work mostly in one project want a stable tree they can muscle-memory.
**Lift:** ~3-4 weeks. Tighter scope than B but a bigger conceptual shift than A.

## Comparison

| | Model A (sidebar+scratch) | Model B (three-pane) | Model C (faceted list) |
|---|---|---|---|
| Fixes GH#160 grouping | yes (Projects section uses `repo_origin`) | yes (rail-driven) | yes (filter chip) |
| Adds first-class one-offs | yes (Scratch section + hotkey) | yes (Scratch rail item + FAB) | yes (Scratch filter + hotkey) |
| Cross-all glance | yes (Recent + status bar) | yes ("All" rail item) | yes (default unfiltered list) |
| Project switching speed | sidebar click (~200ms) | rail click (~100ms) | Cmd+K (~50ms) |
| Mental model clarity | medium (still 4 sections) | high (three panes, three jobs) | medium-high (search-first) |
| Mobile/narrow viable | yes (sidebar collapses) | hard (three panes) | yes |
| Lift | 2-3 weeks | 1-2 months | 3-4 weeks |
| Risk | low | high (relearning) | medium (search dependency) |

## Recommendation

**Lead: Model A — reconciled sidebar + Scratch primitive.**

This is the right next step because:

1. **It's the smallest change that fixes all four UX wins** the user named: project organization (the GH#160 surface), arc organization (Arcs in flight section), across-all (Recent + status bar), one-off (Scratch section + hotkey).
2. **It introduces the Scratch primitive correctly** — JetBrains' gold-standard pattern — which retroactively justifies the "implicit single-session arc" data shape: scratches *are* sessions without an arc, surfaced as such in UI.
3. **`/projects` becomes admin-only**, which lets the data-side proposal #2 (collapse `projects` into a derived view) land cleanly without UX disruption — admin pages are tolerant of refactors that the sidebar isn't.
4. **It paves the road to Model B** if you eventually want the cleaner three-pane layout. Model A's "Projects section" is a sidebar version of Model B's "rail with project list" — refactoring later means promoting the section, not redesigning it.

Model B is the right destination if you ever decide on a UX-focused rewrite, but it's a 1-2 month commitment and forces user relearning. Model C is appealing for power users but probably wrong for the "muscle memory" cohort who lives in duraclaw daily.

### What Model A actually requires

**UI changes (no schema changes for v1):**
1. Add **Scratch section** at top of sidebar. Render sessions where `arc.externalRef === null && arc.parentArcId === null && arc.sessions.length === 1` *and* mark them visually as scratch (italic title, grey dot). This is just a re-render of `isImplicitSingleSessionArc` (`nav-sessions.tsx:65-71`) under a different label.
2. Add **`Cmd+Shift+N` global hotkey** that creates a draft tab with `project: null` (skip the dropdown). On first prompt submission, infer project from `pwd`/last-used or stay project-less and run as a researchy session.
3. Add **filter chip bar** above Recent (`Awaiting input / Running / Errors / All`). Reuse the All/Mine toggle styling from `nav-sessions.tsx:511-539`.
4. Rename **Worktrees → Projects**. Same code (`RepoGroup` at `nav-sessions.tsx:738-798`), different label.
5. Add **persistent status bar** at bottom: derived counts from `sessionsCollection`. Click to filter Recent.
6. Demote **`/projects` to `/settings/projects`** (admin-only). Remove the public-route flat list. The card view becomes a row in a settings table.
7. **Promote-scratch action.** A button on a scratch session: "Move to project / Create arc from this." Migrates the session under a chosen arc + project context. Aligns with JetBrains' F6 file-promotion pattern.

**Schema changes (v1.5, optional):**
- Either keep the current implicit-single-session-arc fiction and tag scratches via `arc.externalRef IS NULL AND arc.parentArcId IS NULL`, OR
- Add an explicit `arcs.kind` enum (`scratch | workflow | branch`) — cleaner but breaks data-side simplicity.

**Schema changes (v2, after data-side proposal #2):**
- If `agent_sessions` ever drops `arcId NOT NULL`, scratches become true arc-less sessions. Until then, they're a UI-only abstraction over the implicit-arc pattern.

### Concrete UI proposals (mockups)

**Sidebar Scratch section (with promote action):**

```
▼ Scratch                                    (3)
  ● untitled (yjs CRDT exploration) — 2m       [↑ promote ▾]
  ● untitled (auth flow notes)      — 1h       [↑ promote ▾]
  ● untitled                        — yest     [↑ promote ▾]
```

**Recent with filter chips:**

```
▼ Recent  [ ⌛ Awaiting (1) ] [ ● Running (3) ] [ ❌ Errors (0) ] [ All (12) ]
  ⌛ #157 verify     duraclaw   verify    yest    awaiting input
  ●  160-research   duraclaw   research  2m      streaming…
  ●  auth-debug     baseplane  debug     1h      running
  ●  scratch        —          —         3m      running
  …
```

**Status bar (bottom of viewport, persistent):**

```
[●] 3 running   [⌛] 1 awaiting   [❌] 0 errors   ·   ⌘K to jump   ⌘⇧N for scratch
```

**Quick-create flow (Cmd+Shift+N from anywhere):**

```
┌─────────────────────────────────────────────────┐
│  New scratch session                            │
│                                                 │
│  > _                                            │
│                                                 │
│  Project: (auto)   Mode: (auto)   ⌘↩ to spawn   │
└─────────────────────────────────────────────────┘
```

Defaults to no project, no mode; first prompt determines whether it stays scratch or graduates.

## Open questions

- **Promote-scratch UX.** When a scratch graduates into a real arc, does the existing session get re-parented (changes `arcId`) or does a new arc get minted around it? The data side currently makes re-parenting easy (just update `agent_sessions.arcId`); a new arc with `parentArcId` pointing at the scratch's arc is more honest about lineage.
- **Project inference for scratches.** If a scratch ends up touching code in `/data/projects/duraclaw-dev2`, should we offer to auto-promote with that project pre-selected? Or stay strict (user must promote explicitly)?
- **Status bar mobile.** Bottom status bar steals scroll real estate on small screens. Collapse to a count-only chip in the header on narrow viewports.
- **Search affordance.** Model A doesn't add full session search (which Journey 3 really wants). Probably belongs in Cmd+K palette as a separate workstream — not a blocker for Model A but a known gap.
- **Arc auto-advance under scratch.** If a scratch session triggers `advanceArc`, what does the successor session look like? Probably stays in scratch (scratches form a chain in scratch, not a project arc) until promote.
- **Closed arc archive.** Where do closed arcs go? Today they're invisible. Model A's "Arcs in flight" name implies they're hidden; we need either a "Show closed" toggle or a `/archive` view. Decide before shipping.

## Next steps

1. **Decide Model A vs B vs C.** Recommendation: Model A with eyes on B as the eventual destination.
2. **If Model A: spec it.** Concrete deliverables are the seven UI changes above. Each is independently shippable; recommend sequencing as: (a) GH#160 fix via Worktrees-→-Projects rename, (b) Scratch section + Cmd+Shift+N, (c) Recent filter chips, (d) status bar, (e) `/projects` → `/settings/projects` demotion, (f) promote-scratch action.
3. **Validate the Scratch concept with one user session.** Ship a feature flag, observe whether implicit-arc sessions actually feel like scratch in the user's hands, or whether the project-less default is jarring.
4. **Couple with data-side proposal #2** (`projects` becomes a derived view). Model A's `/projects` → `/settings/projects` demotion is the easiest place to land that refactor — admin pages tolerate schema churn.
