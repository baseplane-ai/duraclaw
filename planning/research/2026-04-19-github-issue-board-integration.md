# GitHub Issue ↔ Board Feature Integration

**Date:** 2026-04-19
**Author:** research session (RE-b650-0419)
**Type:** Feature research — gap analysis + recommendations
**Scope:** How the kanban Board (`/board`) currently consumes GitHub
issues, what's wired vs. missing, and where to invest next.

## Context

The board (kanban) feature is owned by `apps/orchestrator/src/features/kanban/`.
Spec lives in `planning/specs/16-chain-ux.md`; design rationale in
`planning/research/2026-04-19-kata-mode-chain-ux.md`. Issue **#16** ("Chain UX:
chain tabs, session reset, kanban home, worktree checkout") is closed — the
board exists, lanes/columns are wired, drag-to-advance works, the
`/api/chains` endpoint joins D1 + GitHub.

There is **no open issue today** explicitly named "GitHub-issue
integration" — the question this doc answers is "what is the *current*
GH integration on the board, and where would the next integration
investment go?" so a follow-up issue can be filed against a concrete
gap rather than a vague intent.

## What's wired today

### Server: `GET /api/chains` (`apps/orchestrator/src/api/index.ts:1882`)

End-to-end pipeline that produces the rows the board renders:

1. `fetchGithubIssues(env)` — paginates `GET /repos/:repo/issues?state=all`
   (3 × 100, 5-min in-memory cache, `moreAvailable` flag when truncated).
   Token from `env.GITHUB_API_TOKEN` (single shared bot token; **not
   per-user**). PR entries filtered out via `issue.pull_request` presence.
2. `fetchGithubPulls(env)` — same shape for `/pulls`.
3. D1 union: `selectDistinct(agentSessions.kataIssue)` — chains can exist
   for an issue with no GH-side row (off-page or deleted).
4. Bulk join: one `agentSessions WHERE kataIssue IN (…)` and one
   `worktreeReservations WHERE issueNumber IN (…)`.
5. Per-issue derivations:
   - `deriveIssueType(labels)` — precedence `bug > enhancement > other`
     (see `api/index.ts:328`).
   - `deriveColumn(sessions, issueState)` — closed → `done`; no sessions
     → `backlog`; otherwise newest qualifying session's kataMode
     (`research/planning/implementation/task→implementation/verify`); skips
     `debug`/`freeform`.
   - `findPrForIssue(pulls, n)` — branch regex
     `^(feature|fix|feat)/(\d+)[-_]` OR body `Closes|Fixes #N`.
6. Filters honoured: `mine`, `lane`, `column`, `project`, `stale={N}d`.
7. Sorted by `lastActivity` DESC.

### Client: board UI

- `apps/orchestrator/src/db/chains-collection.ts` — TanStack DB
  `queryCollection`, OPFS-persisted, 30 s refetch / 15 s stale.
- `KanbanBoard.tsx` — fixed lanes `enhancement | bug | other`; columns
  `backlog → research → planning → implementation → verify → done`;
  drag-to-advance with strict +1 adjacency rule.
- `useKanbanLanes` — Yjs-backed lane collapse state (`user-settings`
  party), shared with `useTabSync`.
- `advance-chain.ts` + `use-chain-checkout.ts` — POST
  `/api/chains/:issue/{checkout,release,force-release}` to reserve a
  worktree against an issue before advancing.

### Data shape (`ChainSummary`, `lib/types.ts:137`)

`{ issueNumber, issueTitle, issueType, issueState, column, sessions[],
worktreeReservation, prNumber?, lastActivity }`. No assignees, no
labels other than the type derivation, no comments, no checks/CI status,
no milestones, no reviewers, no project-board column.

## Gaps (ranked by leverage)

### 1. Read-only → no write-back to GitHub  ★★★ leverage

The board reads issue/PR state but never mutates GH. You cannot:
- Create a GH issue from the board (every chain must already exist
  upstream or be auto-created by some other surface).
- Close / reopen an issue when its chain reaches `done`.
- Comment when a chain advances (e.g. "spec ready", "VP passed").
- Apply labels (e.g. `in-progress:research`, `blocked`).
- Assign / unassign on checkout.

**Why it matters:** the board is the operator's primary surface, but
status updates have to be done in GH separately, and GH-side observers
(reviewers, PMs) get no signal from a chain's progression. The
worktree-reservation lock has no GH-visible counterpart, so two humans
can race over an issue if one of them isn't looking at the board.

**Cost shape:** small — `GITHUB_API_TOKEN` already has write scope on
the repo; one Hono handler per mutation; optimistic-update through
`chainsCollection.update` would cover the latency. The hard part is
**auth attribution** (see #4) — anything written under the bot token
loses the per-user audit trail.

### 2. Polling-only freshness  ★★ leverage

`refetchInterval: 30_000` on the client, `GH_CACHE_TTL_MS = 5 min` on
the server. So the worst-case staleness for a label change made in GH
is ~5.5 minutes. Drag-to-advance still works because column/lane
derive from D1, but issue-side mutations (close, label, title edit)
take minutes to surface.

**Options:**
- GH webhooks → CF Worker `/api/gh-webhook` → bust `ghIssueCache` →
  fanout to clients via the existing UserSettingsDO room (or a new
  `chains` room). Complexity: moderate (HMAC verify, replay protection),
  payoff: sub-second freshness for label/title/state events, no extra
  GH API quota.
- Hybrid: keep the 30 s poll as fallback, add webhook for "right now"
  invalidation. Lowest risk.

### 3. Pagination beyond the first 300 issues  ★★ leverage

`fetchGithubIssues` caps at 3 × 100 and exposes `moreAvailable`. The
client surfaces nothing for it. Repos with 300+ open+closed issues will
silently miss the tail (fine for duraclaw today — only ~20 issues —
but the feature is generic and other adopters will hit it).

**Options (cheap → comprehensive):**
- a) Filter to `state=open` server-side once `more_issues_available` is
  true; let `column='done'` be reserved for D1-driven chains where
  `issueState` is already known closed.
- b) Cursor pagination on the API (`?after=<issueNumber>`), accumulate
  client-side. Need a "load older" button.
- c) Scrub via the GH GraphQL API and store the digest in D1 so we no
  longer rebuild from scratch every 5 min. Heaviest, but unlocks PR
  reviewers / checks (#5) for free.

### 4. No per-user GH auth  ★★ leverage (blocks #1 cleanly)

`env.GITHUB_API_TOKEN` is one bot token shared across all sessions.
Better Auth is already wired (D1 + Drizzle). Two clean paths:

- **GH OAuth via Better Auth** — add the GitHub provider plugin, store
  `accessToken` per user, fall back to bot token when the user hasn't
  linked GH. Reads stay on the bot token (cache-friendly); writes use
  the per-user token. This is the "cheap version of #1" — write-back
  becomes attributable without the operator re-pasting a PAT.
- **Per-user PATs** — UI to paste a token, store encrypted in D1 / DO.
  Ugly but avoids the OAuth dance.

### 5. Underused issue/PR fields  ★★ leverage

`GhIssue` and `GhPull` are fetched in full but only `title / state /
labels / updated_at / pull_request / head.ref / body / number` get
read. Cheap wins on the card / chain detail surface:

- Assignees → avatar stack on card; filter `mine` could OR-include
  `assignees.contains(currentUser.ghLogin)` instead of relying purely
  on owned sessions.
- Milestones → group/filter (could replace or augment `lane` if a
  team uses milestones for releases).
- Issue body excerpt → tooltip on card.
- PR review state (`reviews`, `mergeable`, checks) — pulled separately
  per PR (rate-limit-sensitive); only fetch on chain-detail view.
- `closed_by` → who closed it shows up in the chain timeline.

### 6. Brittle issue↔PR linking  ★ leverage

`findPrForIssue` only matches branches `^(feature|fix|feat)/N[-_]` or
bodies `Closes|Fixes #N`. Misses common patterns:
- `chore/N-…`, `infra/N-…`, `docs/N-…` (we already have an `infra`
  branch in the wild — see PR #21).
- "Resolves #N", "Implements #N", "Part of #N".
- GH's own `closingIssuesReferences` GraphQL field (authoritative).

Switching to the GraphQL field would remove the heuristic entirely and
support multi-PR-per-issue.

### 7. Backlog UX is anaemic  ★ leverage

A brand-new GH issue with no session lands in `backlog` with
`sessions=[]`. From the board you can drag it forward, but the chain
card has no description preview and no "create research session" CTA
specialised for the backlog → research transition (the generic
advance-chain modal handles it, but the affordance isn't great).

### 8. Labels other than `bug` / `enhancement` are invisible  ★ leverage

`deriveIssueType` collapses everything else to `other`. `needs-spec`,
`blocked`, `regression`, `infra`, area labels — none surface. Could be:
- A label-pill row on the card.
- Faceted filters in the Board header (in addition to project).
- A second swim-lane axis (lanes-by-label rather than lanes-by-type).

### 9. No presence on cards  ★ leverage (mostly nice-to-have)

The Yjs `user-settings` doc already broadcasts users. A presence
indicator on each card ("alice is on this chain right now") would help
the multi-operator case the worktree-reservation system was built for.

## Recommendation matrix

| Move | Leverage | Cost | Risk | Order |
|------|----------|------|------|-------|
| Webhook-driven cache bust + push | ★★ | M | L (drop-in fallback) | **1st** |
| GH OAuth via Better Auth | ★★ | M | L | **2nd** (unblocks 3rd) |
| Write-back actions (close / comment / label) | ★★★ | S | M (auth-attribution) | **3rd** |
| GraphQL `closingIssuesReferences` swap | ★ | S | L | 4th |
| Surface assignees, milestones, full label list | ★★ | S | L | 4th (parallel) |
| Pagination beyond 300 | ★★ | M | L | defer until adopter hits it |
| Backlog → research CTA polish | ★ | S | L | opportunistic |
| Card presence indicators | ★ | S | L | nice-to-have |

## Suggested next issue

If a single issue gets filed off this research, the highest-leverage
shape is:

> **feat(board): two-way GitHub integration — webhook freshness +
> per-user OAuth + write-back actions**
>
> P1: `/api/gh-webhook` handler (HMAC verify, replay window) busts
> `ghIssueCache` and broadcasts a chain-invalidate to clients. Keep the
> 30 s poll as fallback.
>
> P2: GitHub provider on Better Auth — store per-user `accessToken`,
> fall back to `GITHUB_API_TOKEN` for reads when unlinked.
>
> P3: Card-action menu — close issue, comment "advanced to <mode>",
> apply/remove `in-progress:<mode>` label. Use per-user token; toast on
> failure. Optimistic update through `chainsCollection`.
>
> P4: Replace `findPrForIssue` heuristic with GraphQL
> `closingIssuesReferences`. Also pull `reviewDecision` + check status
> for the chain-detail page.

P1 + P2 are independent and can ship in parallel; P3 depends on P2;
P4 is a standalone cleanup that benefits chain-detail more than the
board itself.

## Files cited

- `apps/orchestrator/src/api/index.ts:240-414` — GH fetch + derive
  helpers (`fetchGithubIssues`, `fetchGithubPulls`, `deriveIssueType`,
  `deriveColumn`, `findPrForIssue`).
- `apps/orchestrator/src/api/index.ts:1882-2069` — `GET /api/chains`.
- `apps/orchestrator/src/api/index.ts:1677-1862` — checkout / release /
  force-release endpoints.
- `apps/orchestrator/src/db/chains-collection.ts` — client query
  collection (30 s poll, OPFS-persisted).
- `apps/orchestrator/src/features/kanban/KanbanBoard.tsx` — board UI,
  lanes, drag-to-advance.
- `apps/orchestrator/src/hooks/use-kanban-lanes.ts` — Yjs lane state.
- `apps/orchestrator/src/lib/types.ts:137-160` — `ChainSummary` shape.
- `planning/specs/16-chain-ux.md` — original spec (closed via #16).
- `planning/research/2026-04-19-kata-mode-chain-ux.md` — design
  rationale for the chain abstraction the board is built on.
