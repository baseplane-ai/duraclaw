---
date: 2026-04-27
topic: User chat and comments on sessions (team collaboration layer)
type: feature
status: complete
github_issue: null
items_researched: 5
---

# Research: User chat and comments on sessions

## Context

Duraclaw today is a single-owner-per-session product. We want to add a
**team collaboration layer** on top of an agent session:

1. **Per-message comments** — annotations attached to a specific message
   in the agent transcript. The agent does NOT see comments. Multiple
   team members can read and reply.
2. **Side-channel team chat** — a separate human-to-human chat lane
   attached to the session (or arc/chain). The agent does NOT see it.
   Persists with the session.

Scope decisions confirmed up-front with the requester:

- "User chat" = side-channel where teams chat *about* the current
  session (agent does not see). Not multi-user co-driving.
- "Comments" = per-message annotations on the agent transcript.
- Audience = team-shared, scoped to one session **or one chain/arc**.

Classification: **feature research**. Codebase-grounded with light
external UX prior art.

## Scope

| # | Item | Output |
|---|------|--------|
| 1 | Data model: sessions, messages, arcs/chains | What comments anchor onto; storage shape |
| 2 | Multi-user ACL & team sharing | How "team-shared session" lands on Better Auth + D1 |
| 3 | Real-time delivery infra | Whether existing WS + SyncedCollection can carry it |
| 4 | Storage model & retention | DO SQLite vs D1; cleanup; search |
| 5 | UX prior art | Anchoring, render placement, mobile, hazards |
| 6 | Open questions for spec phase | Synthesised from items 1–5 |

## Findings

### 1. Data model: sessions, messages, arcs/chains

**Message identity is solid as a comment anchor.** Messages have a
stable `id` (TEXT PK in the DO's `assistant_messages` table, SDK-owned)
plus a `canonical_turn_id` (`usr-N` for user turns, bumped from
`assistant_config.turnCounter`) used for P3 idempotency
(`apps/orchestrator/src/agents/session-do/rpc-messages.ts:178–209`).
The wire frame stamps a per-DO monotonic `messageSeq`
(`apps/orchestrator/src/agents/session-do/broadcast.ts:97,160`) so
gap-detection on reconnect works. A composite anchor of
`(session_id, message_id)` survives reconnect, replay, and gap
sentinels.

**DO SQLite is at migration v19.** Tables today (per
`session-do-migrations.ts`):

- `session_meta` (v6+): typed singleton per DO (`status`,
  `runner_session_id`, `message_seq`, `title`, `agent`, ...).
- `assistant_messages` (SDK-owned, v9–v13): transcript; indexed on
  `(session_id, created_at, id)` and `(session_id, modified_at, id)`
  for cursor replay; has a `sender_id` column (v12, multi-user
  collab — already shaped for what we want).
- `event_log` (v17): structured observability; **7-day TTL**, GC'd on
  `onStart` (`event-log.ts:4,40`). Logs only, not user content.
- `submit_ids` (v5): idempotency, 60s TTL, max 64 chars.
- `kv` (v3), `assistant_config` (SDK-owned).

**D1 schema** (`apps/orchestrator/src/db/schema.ts`) — relevant
cross-session tables:

- `users` (line 34) — Better Auth canonical.
- `agentSessions` (line 127–184) — `userId`, `project`, `status`,
  `runnerSessionId`, `numTurns`, `messageSeq`, `kataIssue`,
  `kataMode`, `kataPhase`, `archived`, `visibility` (`'public' |
  'private'`).
- `userPreferences.chainsJson` (line 302) — chains live as JSON, not
  a normalised table.
- `userTabs.meta.kind in {'chain','session'}` (line 186).
- No `teams`, `orgs`, `members`, `comments`, or `chat` tables.

**SyncedCollection plumbing is generic.**
`SyncedCollectionFrame<TRow>` is parameterised on `TRow` and addressed
by string (`'<scope>:<sessionId>'`); the existing `messages:<id>`
collection is one instance. New collections (`comments:<id>`,
`sessionChat:<id>`) ride the exact same wire shape with no protocol
changes. Factory at
`apps/orchestrator/src/db/synced-collection.ts`.

**Arcs/chains are virtual today, not a table.** A chain is a sequence
of mode-linked sessions against one GitHub issue, derived from
`agentSessions.kataIssue` and `userTabs.meta.issueNumber`. Open
issue **#116** (*"arcs as first-class durable parent — drop kata
terminology, formalise branching"*) proposes promoting arcs to a real
parent entity. **This is directly relevant**: if arcs land first,
"per-chain chat" gets a clean home (an `ArcDO` or an `arcs` table). If
not, per-chain chat falls back to keying by `kataIssue` until #116
ships.

Citations: shared-types/index.ts:836,895–974;
session-do-migrations.ts:63–82, 310–321; rpc-messages.ts:36, 178–209;
broadcast.ts:32–58, 119–176; db/schema.ts:34–322; event-log.ts:4,40,57.

### 2. Multi-user ACL & team sharing

**Today's ownership model is single-owner-with-public-read.** A
session row has `userId` (FK to users) and `visibility` (default
`'public'`). The route guard
(`apps/orchestrator/src/server.ts:25`) — `checkSessionAccess()` —
allows access if any of:

- `sessionRow.userId === authSession.userId` (owner), or
- `sessionRow.userId === 'system'`, or
- `sessionRow.visibility === 'public'` (any authed user can read), or
- `authSession.role === 'admin'`.

Mutations are owner-only at the DO level. The same guard wraps the
WS upgrade for `session-agent` and collab routes
(server.ts:142, 187).

**Better Auth `1.5.6`.** Plugins enabled
(`apps/orchestrator/src/lib/auth.ts:73`): `admin()`, `bearer()` (sets
`set-auth-token` for Capacitor), `capacitor()` (CSRF allowlist for
native WebView). **The `organization` plugin is NOT installed.**
Tables are limited to Better Auth canonicals (`users`, `sessions`,
`accounts`, `verifications`).

**Four sharing-model paths:**

| Option | Schema delta | Pros | Cons |
|---|---|---|---|
| **A. Better Auth org plugin** | `organizations`, `organizationMembers`, `organizationInvitations` + `agentSessions.organizationId` | Hierarchical, invitation flow built-in, role inheritance | Forces upfront org ceremony; sessions are org-scoped (no ad-hoc share) |
| **B. Per-session ACL** | `sessionMembers(sessionId, userId, role, addedAt)` | Granular, ad-hoc, low ceremony | No auto-discovery; role inheritance is app-code |
| **C. Arc-level ACL** (depends on #116) | `arcMembers(arcId, userId, role)` + `agentSessions.arcId` | Auto-grants on session spawn under an arc; matches kata mental model | Presupposes arc model (gated on #116) |
| **D. Magic-link share URL** | `sessionTokens(token, sessionId, role, expiresAt)` | No-auth share, trivial UX | No identity → no per-author attribution; token leakage risk |

**No prior commitment** in `planning/progress.md` for org/team work
(Phase 6.2 "Auth Enhancements" is `not-started`, no spec). #116 is the
strongest constraint — chat-per-chain wants arcs to be real.

Citations: db/schema.ts:127–184; server.ts:25–42, 142, 187;
lib/auth.ts:1–75; package.json:71;
https://www.better-auth.com/docs/plugins/organization.

### 3. Real-time delivery infra

**PartySocket lineage — this is what the transport is built for.**
The Cloudflare Agents SDK is built on PartyKit/PartySocket, and the
DO's `ctx.getConnections()` IS the PartyKit "room" primitive: one room
per session DO, fan-out is `for (conn of ctx.getConnections())
conn.send(...)`. The browser uses `PartySocket` directly in
`apps/orchestrator/src/lib/connection-manager/manager.ts` and
`features/agent-orch/use-coding-agent.ts`. **Multi-human collaboration
on one session is the use case the library was designed for** — we
don't need a new socket, a new room, or a new transport. PartySocket
gives us per-room fan-out + reconnect-with-backoff for free; the
SyncedCollection layer (delta frames, `messageSeq` gap detection,
TanStack DB reconciliation) is the application protocol *on top of*
PartySocket. The recommendation in this section (Option B — parallel
SyncedCollections) is the PartySocket-native answer: new typed
channels in the existing room, not new connections.

**The existing stack already does multi-client fan-out per session.**
`broadcastToClients(ctx, data)` at
`apps/orchestrator/src/agents/session-do/broadcast.ts:32` iterates
`ctx.getConnections()` (Agent SDK / PartyKit room) and unicasts to
every WS except the one identified by `cachedGatewayConnId` (the
runner). Two browsers on the same DO each get every frame. The `messageSeq` envelope counter
(broadcast.ts:97, 160) is stamped on every non-targeted frame; the
client tracks `lastSeq` per session and triggers `requestSnapshot()`
on a gap.

**Tab-sync is metadata-only** (`hooks/use-tab-sync.ts:364–683`,
`lib/broadcast-session.ts`). It uses `BroadcastChannel` / `storage`
events to share *which tab is active* and a server-synced
`userTabs` collection — it does **not** carry messages between tabs.
Each tab has its own WS subscription, which is the correct primitive
for comments/chat: cross-user sync goes through the DO; cross-tab
sync of one user falls out for free because each tab independently
subscribes.

**Optimistic write path is well-grooved.** Messages today: client
inserts into `messagesCollection` optimistically (with
`clientMessageId`), the collection's `onInsert` POSTs to
`/api/sessions/:id/messages`, the DO appends to `assistant_messages`,
broadcasts a `synced-collection-delta` to all connected clients
(`use-coding-agent.ts:1078–1140`, `rpc-messages.ts:47–200`). Comments
and chat can use the identical pattern.

**Three delivery options (recommendation in §Recommendations):**

- **A. Reuse `messagesCollection`** with new role values
  (`'comment'`, `'session_chat'`). Zero new infra, but pollutes the
  agent transcript stream and complicates SDK transcript export.
- **B. Parallel `commentsCollection` + `sessionChatCollection`.**
  Same wire shape, separate scope strings (`comments:<id>`,
  `sessionChat:<id>` or `sessionChat:<arcId>`). New `broadcastComments()`
  / `broadcastSessionChat()` wrappers; new RPC handlers; new client
  factory call. Clean.
- **C. New ad-hoc WS event types** (`{type:'comment_added',...}`).
  Loses cursor-seek and gap detection — comments would have to
  rebuild from a snapshot RPC on reconnect.

**Mobile (Capacitor) is identical to desktop.** `apps/mobile/` is a
WebView shell over the same Vite SPA, same `useAgent` hook, same WS
plumbing. FCM is scaffolded (`fcmSubscriptions`, `pushSubscriptions`
tables in D1) but not wired to a notification path today.

**Presence is not built.** `ctx.getConnections()` returns connection
objects with no per-connection user metadata. Adding `userId` to a
connect handshake (URL query or header) would unlock both attribution
("posted by Alice") and presence ("Bob is viewing"). The existing
`assistant_messages.sender_id` column (v12) is shaped for this but
unused.

Citations: broadcast.ts:32–58, 119–176; client-ws.ts:76–80;
use-tab-sync.ts:364–683, 616–624; broadcast-session.ts:38;
use-coding-agent.ts:1078–1140; rpc-messages.ts:36, 47–200.

### 4. Storage model & retention

**DO SQLite quotas.** Cloudflare DO SQLite caps at ~100 MB per
instance (CF docs; not coded). For our envelope (team of 10, 50
sessions/week, 20 msg / 6 comments / 10 chat per session), per-DO
total stays well under 1 MB. No quota pressure.

**Retention reality:** `event_log` is GC'd to 7 days on `onStart`
(`event-log.ts:4,40`). `assistant_messages` has **no retention
sweep** — messages live as long as the session does. This is the
right precedent for comments and chat: tie their lifetime to the
session, not to a 7-day TTL.

**Two-axis decision:**

| | DO SQLite (per-session) | D1 (centralised) | Hybrid (write-through) |
|---|---|---|---|
| **Comments** | ✅ Atomic with messages, low-latency replay, GC'd with session | ⚠️ Adds a hop and ACL middleware on every comment write | ⚠️ Drift risk; only justified if cross-session search is hot |
| **Chat** | ✅ Same low latency | ✅ Cross-session search ("find auth discussions"), unread counts before DO wakes | ⚠️ Reasonable if both cross-session search AND warm replay matter |

**Recommended split:**

- **Comments → DO SQLite only.** They're transcript annotations.
  Cross-session "where am I @-mentioned" can be served by a thin D1
  summary table (`session_mention_index`) updated on write — not by
  putting the comment body in D1.
- **Chat → DO SQLite for replay + D1 mirror for search/unread.**
  Write to DO first (broadcast immediately), async-mirror to D1 with
  a job. Drift is acceptable because chat is human-paced; if D1 is
  10s stale, no one notices.

**Per-chain chat** (when #116 lands): scope key becomes `arcId`
instead of `sessionId`. The collection name (`sessionChat:<id>`)
stays — only the id namespace shifts. Until then: key by
`kataIssue` (already on every session).

**Cascade rules (recommended):**

- Session soft-delete (`archived = true`): hide chat + comments
  from default views; keep rows.
- Session hard-delete (DO destroyed): comments and chat go with it
  (DO SQLite is per-session). D1 mirror cleaned by the same job.
- `forkWithHistory(content)`: see §Open questions — the deep-dives
  disagree on whether comments should clone into the fork.
- Arc delete (post-#116): cascade comments + chat to all child
  sessions, or orphan-mark with `arc_id = null`. Spec call.

**Search & list strategy:**

- "Sessions with unread comments for me" → D1 summary table
  `session_unread(user_id, session_id, unread_comments,
  unread_chat, last_read_at)` updated on read/write.
- "Sessions where someone @mentioned me" → denormalise mentions
  into `session_mention_index(user_id, session_id, mention_ts)` on
  write; index by `(user_id, mention_ts DESC)`.
- Full-text search across chat → D1 FTS5 on the chat mirror, deferred
  unless asked for.

**Quota envelope.** Team of 10 × 50 sessions/week × 1 yr ≈ 26K chat
rows ≈ ~3 MB in D1. Comfortable.

Citations: do-migrations.ts:23–44; session-do-migrations.ts:310–321;
event-log.ts:4,40; index.ts:184,214; db/schema.ts (full).

### 5. UX prior art

The patterns that transfer cleanly to a streaming-AI-chat substrate:

**For per-message comments:**

- **Anchoring → message ID, not text offset.** Slack/Discord/GitHub
  PR review all anchor by id/line; Google Docs and Notion use text
  selection, which is fragile when a streamed message rewrites.
  Duraclaw should anchor on `(sessionId, messageId)`.
- **Render → inline counter badge + side rail thread.** Slack's
  reply-counter under a message + drawer/side-panel thread is the
  closest fit. GitHub PR review has both inline-on-line and a
  unified Conversation tab; the unified view is useful for arcs
  (one chain, many sessions, all comments).
- **Mobile → bottom sheet / full-screen modal with swipe-dismiss.**
  Linear/Slack mobile pattern. Capacitor's native gesture API gives
  smooth swipe; webview-only feels janky at scroll boundaries.
- **Resolve / unread.** Linear and Notion both filter resolved out
  of unread tallies. Default open; resolved threads collapse.

**For side-channel team chat:**

- **Layout → persistent right panel (desktop), tab-based nav (mobile).**
  Slack Huddles' persistent thread + Notion's page-level discussion
  + Figma's comment rail all converge on: visible-by-default beside
  the primary content, badge-counted unread, distinct styling from
  the primary stream so it doesn't read as transcript.
- **Scope → one chat per session-or-arc.** Don't thread per message;
  that's what comments are for. One flat chat lane per scope.
- **Visual distinction is critical.** Side-channel chat must not look
  like agent dialogue. Different background, no agent avatar, "team
  notes" framing.

**Streaming-specific hazards (no good prior art — flag for spec):**

- **Commenting on a partial message.** A user comments on assistant
  message X while it's still streaming, and the message rewrites
  (e.g., model retries, partial replaced by final). Recommend
  *locking comments while a message is streaming*; once finalised,
  comments are anchored to that message id and the body is
  effectively immutable from the comment's POV. Alternative
  (content-hash) is more complex without obvious user benefit.
- **Forking and inheritance.** When the user `forkWithHistory(content)`,
  do parent comments appear on the cloned messages in the fork? The
  storage agent recommended deep-clone (so context transfers); the
  UX agent recommended hide-and-archive (cleaner mental model).
  This is a spec-phase decision.
- **@-mentions and push.** Mentions in either stream should fire a
  push notification on the mobile shell. FCM is scaffolded but
  unwired; this is a real implementation cost.

Sources: figma comments docs; github review docs; slack threads
design write-up; linear comments docs; notion comments docs;
capacitor action sheet api; material bottom sheet.

### 6. Open questions for the spec phase

Synthesised from §1–§5. The spec writer needs to land each of these:

1. **Sharing model** — which of the four ACL options? Recommended
   path is **per-session ACL (B)** as the MVP since #116 isn't
   blocking, with **arc-level ACL (C)** layered on once #116 lands.
   Org plugin (A) only if a hard team requirement appears.
2. **Authorship attribution** — extend the WS handshake to inject
   `userId` into the DO connection context. The
   `assistant_messages.sender_id` column already exists (v12) and is
   the precedent.
3. **Streaming-message comment policy** — lock during stream, unlock
   on finalise (recommended) vs content-hash (more flexible, more
   work).
4. **Fork semantics for comments** — clone-into-fork vs hide-from-fork.
   The deep-dives disagreed. Pick one with a clear user-facing rule.
5. **Per-chain vs per-session chat scope** — both are useful. MVP
   could ship per-session only and key by `sessionId`; per-chain
   becomes a small migration once #116 lands (rekey to `arcId`).
6. **Read state and unread counts** — D1 summary table or compute
   on-read? Strong default: D1 summary table updated on
   write-or-read so the sidebar can show counts without a DO wake.
7. **@-mentions and push** — wire FCM (D1 already has
   `fcmSubscriptions`, `pushSubscriptions`). Out-of-band from the
   core feature; OK to land mentions visibly first and push second.
8. **Moderation** — who can delete a comment? Author, session
   owner, or any team member with `admin` role? Edit history?
9. **Mobile interaction model** — bottom sheet or tab? Probably
   different per-feature: bottom sheet for per-message comment
   thread, tab for side-channel chat.
10. **Agent transcript integrity** — the SDK resume reads the on-disk
    transcript file. We MUST keep comments and chat out of that
    file. Storing in separate DO SQLite tables already gives us this,
    but the spec needs an explicit "comments and chat are never
    surfaced to the SDK" assertion.

## Comparison

### Storage matrix (recommended cells in **bold**)

| | DO SQLite only | D1 only | Hybrid |
|---|---|---|---|
| Comments | **✅ Recommended** | Adds latency, no benefit | Drift cost > benefit |
| Chat | Works for replay; misses cross-session search | Slower writes, but searchable | **✅ Recommended** (DO authoritative + D1 mirror) |

### Delivery options

| Option | Reuses cursor-seek? | Pollutes transcript? | New plumbing | Verdict |
|---|---|---|---|---|
| A. Reuse `messagesCollection` | ✅ | ❌ Yes (bad) | None | ❌ |
| **B. Parallel SyncedCollections** | ✅ | ✅ No | 2 broadcasters, 2 RPCs, 2 factories | ✅ **Recommended** |
| C. Ad-hoc WS event types | ❌ | ✅ No | Snapshot RPC on reconnect | ❌ |

### Sharing-model sequencing

| Phase | Option | Trigger |
|---|---|---|
| MVP | **B (per-session ACL)** | Ship now |
| When #116 lands | **+C (arc-level ACL inherits to sessions)** | Issue #116 closes |
| If/when teams formalise | **A (Better Auth org plugin)** | Explicit org requirement |
| Optional, public demos | D (magic-link) | Layer on top of B/A |

## Recommendations

1. **Storage**: comments in DO SQLite per session; chat in DO SQLite
   with async D1 mirror for search and unread counts.
2. **Delivery**: two new parallel `SyncedCollection`s
   (`comments:<sessionId>`, `sessionChat:<sessionId>` — later
   `sessionChat:<arcId>`). Reuse the existing `broadcastToClients`
   plumbing and `messageSeq` envelope. **No new sockets — this rides
   the PartySocket room the Agents SDK already gives us per DO.** New
   channels are typed `SyncedCollection` scopes inside the same room,
   not parallel connections.
3. **Anchoring**: composite `(sessionId, messageId)` for comments.
   Lock during streaming, unlock on finalisation. Don't use text
   offsets.
4. **Sharing**: ship per-session ACL (Option B) as MVP. Layer
   arc-level ACL (Option C) once issue #116 lands. Defer org plugin
   (Option A) until there's a real team requirement.
5. **Authorship**: extend WS handshake to carry `userId`. Use the
   already-shipped `assistant_messages.sender_id` column as the
   precedent.
6. **Mobile**: bottom sheet for comment threads (Capacitor gesture
   API); a "Team Chat" tab in the session view for the side channel.
7. **Push notifications for @-mentions**: deferred work item; FCM is
   scaffolded in D1 but unwired. Land mentions visibly first.
8. **Agent isolation**: explicit invariant — comments and chat must
   never reach the SDK transcript file. Keep them in separate DO
   SQLite tables; do not surface them in any SDK-facing prompt.

## Open questions

See §6. The biggest two for the spec writer:

- **Fork semantics for comments**: clone or hide? (Pick one.)
- **Streaming-message comment policy**: lock or content-hash? (Lock
  is recommended; content-hash is the forward-compatible escape
  hatch.)

## Next steps

1. **Spec writing** — issue or epic that absorbs this research and
   lands the 10 spec-phase questions in §6. Suggested title:
   *"feat(collab): per-message comments + side-channel team chat
   on sessions/arcs"*.
2. **Coordinate with #116** — the arc-level chat scope depends on
   #116. The MVP doesn't block on it, but the spec should call out
   the migration path (rekey `sessionChat` from `sessionId` to
   `arcId` once arcs are real).
3. **Auth handshake**: a small, separable PR that extends the
   browser→DO WS handshake to inject `userId`. Useful on its own;
   unlocks attribution for this feature and presence for future work.
4. **D1 schema**: design `sessionMembers`, `session_unread`,
   `session_mention_index`, and `chat_mirror` tables. Migration
   numbers TBD.
5. **DO SQLite v20 migration**: `comments` and `chat_messages` tables
   per the schemas in §1.

## Citations

Codebase:

- `apps/orchestrator/src/server.ts:25–42` (route guard)
- `apps/orchestrator/src/lib/auth.ts:1–75` (Better Auth config)
- `apps/orchestrator/src/db/schema.ts:34–322` (D1 schema)
- `apps/orchestrator/src/agents/session-do/broadcast.ts:32–205`
  (multi-client fan-out, messageSeq stamping)
- `apps/orchestrator/src/agents/session-do/rpc-messages.ts:47–209`
  (sendMessage RPC, idempotency, canonical_turn_id)
- `apps/orchestrator/src/agents/session-do/event-log.ts:4,40,57`
  (7-day retention precedent)
- `apps/orchestrator/src/agents/session-do/session-do-migrations.ts`
  (v1–v19 migration ladder)
- `apps/orchestrator/src/agents/session-do/client-ws.ts:76–80`
  (gateway connection identification)
- `apps/orchestrator/src/hooks/use-tab-sync.ts:364–683` (tab-sync
  scope)
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:1078–1140`
  (optimistic write path)
- `packages/shared-types/src/index.ts:836,895–974`
  (`SyncedCollectionFrame` shape)

External:

- https://www.better-auth.com/docs/plugins/organization
- https://help.figma.com/hc/en-us/articles/360041068574
- https://docs.github.com/articles/reviewing-proposed-changes-in-a-pull-request
- https://slack.design/articles/threads-in-slack-a-long-design-journey-part-2-of-2/
- https://linear.app/docs/comment-on-issues
- https://www.notion.com/help/comments-mentions-and-reminders
- https://capacitorjs.com/docs/apis/action-sheet

Issues:

- #116 — arcs as first-class durable parent (constrains per-chain
  scope).
