---
date: 2026-04-30
topic: Team collab layer (chat + per-message comments) — interview summary
type: interview-summary
status: complete
github_issue: null
input_research: planning/research/2026-04-27-user-chat-and-comments.md
---

# Interview Summary: Team collab layer (chat + comments)

## Outcome

User confirmed full-scope: **per-message comments AND side-channel team
chat**, scoped per-arc, shipped in a single spec with phased delivery.
All 10 open questions from the research §6 are now resolved, plus
several spec-phase decisions surfaced during the interview.

The spec will absorb the research recommendations except where the
user expanded scope:
- **#116 has landed** — arcs are real, so the research's "depend on
  #116" caveat dissolves. Chat is per-arc from day one.
- **FCM push is in MVP** (research recommended deferring).
- **Reactions are in MVP** (research didn't address).
- **Presence + typing are in MVP** (research recommended deferring) —
  user noted this reuses existing Yjs awareness from prompt collab.

## Decisions (grouped by category)

### Foundation

| # | Decision | Reasoning |
|---|---|---|
| F1 | **Sharing model: per-arc ACL** with new `arcMembers(arc_id, user_id, role, added_at)` table. Auto-grants on session spawn within an arc. | Now that #116 has shipped (`arcs` table, `agentSessions.arcId` FK exist), the chat-and-comments lifecycle naturally aligns with the arc lifecycle. Per-session would require re-sharing every mode advance. Org plugin is overkill until there's a hard team requirement. |
| F2 | **Chat scope: per-arc.** One chat lane per arc, shared across all sessions inside it. Keyed `arcChat:<arcId>`. | Matches user mental model — discussion of "this work" persists planning → impl → review. Also: every new session auto-creates an implicit arc (per `db/schema.ts` GH#116 comment), so every session has a chat lane for free. |
| F3 | **MVP: single spec, phased delivery.** Phases land separately (auth handshake → ACL → comments → chat → reactions → presence/typing → push). | Avoids re-litigating shared decisions (auth, broadcast plumbing, ACL). Phased shipping de-risks. |
| F4 | **Streaming-message comment policy: lock during stream, unlock on finalize.** UI disables "add comment" while assistant is streaming. Anchor is `(arcId, sessionId, messageId)`. | Simple invariant; matches GitHub PR review. Content-hash is a forward-compatible escape hatch if drift becomes a problem. |
| F5 | **Visibility unification: drop `agentSessions.visibility`; add `arcs.visibility = 'private' \| 'public'`.** Public arc = any authed user reads (preserves current behavior). Private arc = only `arcMembers` can read. Sessions inherit from arc. | Single source of truth. The current `visibility` field on session was originally per-session because arcs didn't exist; it does now. Migration: data move + drop column. |

### Comments

| # | Decision | Reasoning |
|---|---|---|
| C1 | **Threading: parent-child replies** via `parent_comment_id` self-FK. Two levels enforced by UI (top-level + replies-only-to-top); DB allows arbitrary depth. | Slack/GitHub-PR pattern. Every modern collab tool has this; users will expect it. Two-level UI prevents pathological depth. |
| C2 | **Anchoring: composite `(arcId, sessionId, messageId)`** — survives reconnect, replay, gap sentinels. No text-offset anchoring. | Direct from research §1. `assistant_messages.id` is the SDK-owned stable PK. |
| C3 | **Fork semantics: hide from fork.** When `forkWithHistory(content)` mints a new arc/session, comments do NOT clone. Original arc retains them. | Cleaner mental model; fork is a new conversation. Avoids orphaned-context problems where comments reference reasoning that didn't happen on the new branch. |
| C4 | **Visibility within arc: all members see all comments.** No private/draft comments in MVP. | Defer privacy modes to v2 if asked for. |

### Chat

| # | Decision | Reasoning |
|---|---|---|
| Ch1 | **Storage: DO SQLite (authoritative) + D1 mirror (for cross-arc search and unread).** Async write-through; drift up to ~10s acceptable. | Direct from research §4. DO authoritative for low-latency replay; D1 mirror for cross-arc queries that don't want to wake DOs. |
| Ch2 | **Flat (not threaded) within a chat lane.** Per-message comments handle threaded discussion; chat is a single time-ordered stream. | Don't recreate per-message threads in chat — that's what comments are for. |

### Reactions

| # | Decision | Reasoning |
|---|---|---|
| R1 | **Reactions in MVP** on both chat messages and comments. Schema: `reactions(target_kind: 'comment'\|'chat', target_id, user_id, emoji, created_at)`. | User-elevated to MVP. Standard UI pattern; no architectural risk. |
| R2 | **Standard emoji set (1f600 etc.) only for v1.** No custom emoji upload. | Defer custom emoji until there's demand and an upload pipeline. |

### Membership & moderation

| # | Decision | Reasoning |
|---|---|---|
| M1 | **Arc owner invites by username (existing user) or email (sends invite).** New `arcInvitations(token, arc_id, email, role, expires_at, invited_by)` table. Owner can also remove members. | Familiar pattern. Email invites can grow team beyond existing users. |
| M2 | **Roles: `owner`, `member` for v1.** Owner = arc creator, immutable. Members can read/write/comment/chat. No "viewer" role yet. | Two roles cover MVP. Add `viewer` (read-only) when asked. |
| M3 | **Moderation: author + arc owner + system admin** can delete a comment, chat message, or reply. | Author can retract their own; owner can clean up; admin can intervene. Anyone-can-delete is too risky for any non-trivial team. |
| M4 | **Soft-delete with tombstone.** Set `deleted_at`, `deleted_by`. Render as "deleted by X" placeholder. Hard delete only on arc hard-delete. | Audit-friendly. Preserves thread continuity. |
| M5 | **Edit allowed, "(edited)" marker, no revision history** for v1. Author-only edit. | Slack-style. Low storage; future revision-history is additive. |

### Read state & notifications

| # | Decision | Reasoning |
|---|---|---|
| N1 | **D1 summary table `arc_unread(user_id, arc_id, unread_comments, unread_chat, last_read_at)`.** Updated on write (increment for all members except author) and read (reset on view). | Sidebar badge counts without DO wakes. Direct from research §4. |
| N2 | **@-mentions: full stack including FCM push.** Parse `@username` in chat and comments. Record in `arc_mentions(user_id, arc_id, source_kind, source_id, mention_ts)` for an "Inbox" view. | User elevated to MVP (research had deferred push). Existing scaffolding: D1 has `fcmSubscriptions` and `pushSubscriptions` tables. |
| N3 | **Push delivery scope: ALL chat messages in arcs you're a member of, PLUS @-mentions in comments.** Per-user mute toggle deferred. | User chose the "loud" option. Implication: rate-limiting and quiet-hours become real concerns; spec must address. |
| N4 | **Mention parsing: server-side at write time.** Walk text for `@<token>` patterns; resolve token to user via `arcMembers` join. Unresolved tokens are just text. | Server-side prevents client-side spoof. Constrains mentions to arc members (intentional). |

### Presence & typing

| # | Decision | Reasoning |
|---|---|---|
| P1 | **Reuse Yjs awareness; promote `SessionCollabDOv2` → `ArcCollabDOv1`.** Per-arc Yjs document. Awareness fields: `viewing: 'prompt' \| 'chat' \| 'comments:<messageId>'`, `typing: boolean`, `userId`, `sessionId`. | User explicitly: "we already have this in prompt collab." Reuses `y-partyserver`, awareness sync, hibernation behavior. Append-only chat/comment DATA still flows through `SyncedCollection` — Yjs only carries ephemeral presence. |
| P2 | **Sub-doc-per-session for prompt drafts.** When promoted to arc-scope, the existing per-session prompt Y.Doc becomes a sub-doc keyed by `sessionId`. Migration converts existing per-session collab DOs into sub-docs of the arc. | Preserves existing prompt-collab semantics; arc-level awareness comes for free. |
| P3 | **Typing debounce: 2s start, 5s idle clears.** Standard heuristic. | Avoids flicker. |

### Mobile

| # | Decision | Reasoning |
|---|---|---|
| Mo1 | **Comment thread = Capacitor bottom sheet, swipe-dismiss.** Tap message → bottom sheet over the transcript. | Slack/Linear pattern. Capacitor gesture API gives smooth swipe; webview-only feels janky. |
| Mo2 | **Side-channel chat = "Team" tab in session view.** Tab-bar nav. | Persistent presence; matches sidebar paradigm on desktop. |
| Mo3 | **Push permission flow: lazy.** Request notification permission only when user enables push for the first arc, not at app launch. | Best-practice; avoids preemptive denial. |

### Cascade & lifecycle

| # | Decision | Reasoning |
|---|---|---|
| L1 | **Soft-delete arc (`archived = true`):** comments, chat, reactions, mentions hidden from default views; rows kept in storage. | Allows undo-archive. |
| L2 | **Hard-delete arc (DO destroyed, row removed):** comments and chat go with it (DO SQLite is per-arc/per-session). D1 mirror tables (`arc_unread`, `arc_mentions`, chat mirror) cleaned by the same job that drops the arc row. | Direct from research §4. |
| L3 | **Member removal:** removed user loses read/write immediately. Their existing comments/chat messages stay (with author attribution); deletion follows the moderation rules (M3). | Privacy-friendly default. |
| L4 | **Streaming-finalize hook:** on message stream end, broadcast `comment_unlock` event so UI can re-enable "add comment" on that message. | Implements F4. |

### Agent isolation invariant

| # | Decision | Reasoning |
|---|---|---|
| A1 | **Comments, chat, reactions, mentions are NEVER surfaced to the SDK.** Stored in separate DO SQLite tables. The SDK transcript file (`assistant_messages` + on-disk SDK state) is not modified by this feature. | Spec calls this out as a hard invariant. The SDK resume-file path must remain the only thing the SDK reads — collab data is orthogonal. |

### Authorship attribution

| # | Decision | Reasoning |
|---|---|---|
| At1 | **Extend browser→DO WS handshake to inject `userId`.** Use existing per-request session cookie (Better Auth) on the upgrade; attach `userId` to the `Connection` object. Available to broadcast handlers as `conn.userId`. | Direct from research §3. The `assistant_messages.sender_id` column (v12) was already shaped for this. Separable PR; could land first. |
| At2 | **Comments and chat rows store `author_user_id`.** Render with the user's display name and avatar (Better Auth `users.image`). | Standard. |

## Architectural bets (hard to reverse)

These are the decisions whose cost compounds if we get them wrong. Spec
must call them out explicitly:

1. **Per-arc as the collab unit (F1, F2).** If we later want per-session
   private chats, we'll need a second collab tier. Cheap to add (just
   another scope key); but the default mental model is locked in here.
2. **`ArcCollabDO` promotion (P1).** Migrating existing per-session
   `SessionCollabDOv2` Y.Docs into arc-scoped sub-docs is a one-shot
   data migration. If we get the sub-doc topology wrong (e.g., prompt
   drafts collide), the rollback is painful.
3. **Visibility move to arc (F5).** Once `agentSessions.visibility` is
   dropped, restoring per-session visibility requires rebuilding the
   column AND a backfill. Very high cost.
4. **DO SQLite as authoritative chat store (Ch1).** If chat ever needs
   true cross-arc fan-out (e.g., DMs), we'd need a separate transport.
   Reasonable bet given the team-collab framing.
5. **Push scope = "all chat + comment mentions" (N3).** Loud default.
   Easy to make quieter (add per-arc mute toggle); harder to make
   louder later because users will have set quiet preferences.

## Open risks

These are decisions where my recommendation might not survive contact
with implementation reality. Spec writer should flag them as "verify
during P0 of implementation":

1. **Yjs sub-doc promotion (P2).** I haven't read enough of
   `SessionCollabDOv2` to know whether `y-partyserver` supports the
   sub-doc pattern cleanly, or whether we'll end up running multiple
   Y.Docs per arc DO. If sub-docs don't work, fallback is one Y.Doc per
   arc with namespace prefixes on awareness keys.
2. **DO SQLite quota at scale.** Research said 100MB cap, ~3 MB for a
   team-of-10-1-year envelope. With reactions and presence-history
   added, recheck the envelope before P4.
3. **FCM credential management.** "Full stack push" requires the infra
   pipeline to manage FCM service-account credentials. If the infra
   team can't add them, push lands as a follow-up phase (not
   blocking).
4. **Mention parsing edge cases.** `@everyone`, `@here`, code-fence
   escaping, email-address false-positives. Spec must define the
   regex / tokenizer precisely.
5. **Rate limiting.** Loud push default + chat could spam users on a
   noisy arc. Need write-side rate limit (per arc, per minute) and
   client-side digest mode. Defer to spec phase.

## Codebase findings (key citations)

Verified during the interview:

- **Arcs are shipped (#116 closed):** `apps/orchestrator/src/db/schema.ts:268+`
  defines `arcs` table; `agentSessions.arcId` FK at line ~164.
  `planning/specs/116-arcs-first-class-parent.md` exists.
  CLAUDE.md acknowledges `advanceArc`, `branchArc`, `rebindRunner`.
- **Existing collab DO:** `apps/orchestrator/src/agents/session-collab-do.ts`
  (86 lines) — `SessionCollabDOv2 extends YServer` from `y-partyserver`.
  Uses `hibernate: true` and persists Y.Doc state as a single SQLite BLOB.
  This is the basis for `ArcCollabDOv1`.
- **Client hook:** `apps/orchestrator/src/hooks/use-session-collab.ts`
  (286 lines) — current per-session collab subscription. Will need an
  arc-aware sibling (`use-arc-collab.ts`) plus migration of the prompt
  draft to an arc sub-doc.
- **Synced collection plumbing:** `apps/orchestrator/src/db/synced-collection.ts`
  (factory) and `packages/shared-types/src/index.ts` (`SyncedCollectionFrame`).
  New scopes: `comments:<arcId>`, `arcChat:<arcId>`, `reactions:<arcId>`,
  `arcMentions:<userId>`.
- **Broadcast fan-out:** `apps/orchestrator/src/agents/session-do/broadcast.ts`
  (`broadcastToClients`) — but chat broadcasts will live in the new
  `ArcDO` or via `broadcast-arc.ts` (which exists at
  `apps/orchestrator/src/lib/broadcast-arc.ts`). Spec writer: read
  `broadcast-arc.ts` to confirm the existing arc-broadcast pattern.
- **Better Auth:** `apps/orchestrator/src/lib/auth.ts`. No org plugin
  installed. We don't need it for this feature.
- **Migration ladder:** `apps/orchestrator/src/agents/session-do/session-do-migrations.ts`.
  Spec writer: confirm next migration version (research said v19,
  schema mentions migration 0032 from #116). Likely v20+ for
  comments/chat/reactions tables; or new arc DO migrations starting at v1.
- **D1 schema (drizzle):** `apps/orchestrator/src/db/schema.ts`. New
  tables to add: `arcMembers`, `arcInvitations`, `arc_unread`,
  `arc_mentions`, `arcChat_mirror`, `reactions`. Plus `arcs.visibility`
  column add and `agentSessions.visibility` drop (with backfill).
- **Route guard:** `apps/orchestrator/src/server.ts` — `checkSessionAccess()`.
  Replace with `checkArcAccess()` that reads `arcs.visibility` and
  `arcMembers`. Old behavior preserved for `visibility = 'public'`.
- **FCM scaffold:** `fcmSubscriptions`, `pushSubscriptions` in
  `db/schema.ts`. Currently unwired. Spec writer: trace what's there
  and what's missing.

## Implementation phasing (proposed for spec writer)

The spec should structure phases roughly as follows. This is a
suggestion — the spec writer can re-order based on dependency analysis:

- **P0**: Verify codebase state (migration version, presence of
  `broadcast-arc.ts` patterns, FCM scaffolding completeness).
- **P1**: Auth handshake — inject `userId` into WS connection. Add
  `arcMembers` and `arcInvitations` tables. Replace `checkSessionAccess`
  with `checkArcAccess`. Drop `agentSessions.visibility`, add
  `arcs.visibility`. (Standalone; useful even without rest.)
- **P2**: Comments — DO SQLite migration for `comments` table. New
  `comments:<arcId>` SyncedCollection, broadcaster, RPC, optimistic
  client write path. UI: comment-thread component (desktop drawer,
  mobile bottom sheet). Lock-during-stream behavior.
- **P3**: Chat — DO SQLite `chat_messages` table. D1 mirror table.
  `arcChat:<arcId>` SyncedCollection. UI: "Team" tab/panel with chat
  composer.
- **P4**: Reactions — `reactions` table (DO SQLite + D1 mirror).
  `reactions:<arcId>` SyncedCollection. UI: emoji picker on hover/long-press.
- **P5**: Unread + mentions — `arc_unread` and `arc_mentions` D1 tables.
  Server-side mention parsing. In-app "Inbox" view.
- **P6**: Presence + typing — promote `SessionCollabDOv2` to
  `ArcCollabDOv1`; sub-doc-per-session for prompt drafts. Awareness
  for viewing/typing. Migration of existing collab DOs.
- **P7**: FCM push — wire `fcmSubscriptions` to a push delivery worker.
  All-chat + mention-comment delivery rule. Per-user push toggle (deferred
  but mention scaffolding hooks).
- **P8**: Cascade + moderation — soft/hard-delete cascade behavior;
  edit + delete UI; "(edited)" / "deleted by X" rendering.
- **P9**: Mobile polish — bottom sheet gestures, push permission flow.

## Verification approach (for spec writer to elaborate)

End-to-end verification should cover:
1. Two browsers on the same arc see each other's comments and chat in
   real time (via PartySocket fan-out).
2. Comment-during-stream is locked, then unlocks on finalize.
3. Forking an arc starts comment-clean.
4. Removing an arc member revokes WS access on next reconnect.
5. Hard-deleting an arc cleans D1 mirror tables.
6. Mention in chat fires FCM push to the mentioned user's mobile shell.
7. Yjs awareness convergence: 3 users typing simultaneously, all see
   the same typing-indicator state within 2s.
8. Migration from per-session `visibility` to per-arc preserves all
   existing public/private session behavior.

## Mapping to research §6 questions

| Research Q | Status | Decision ID |
|---|---|---|
| 1. Sharing model | ✅ resolved | F1 |
| 2. Authorship attribution | ✅ resolved | At1, At2 |
| 3. Streaming comment policy | ✅ resolved | F4 |
| 4. Fork semantics for comments | ✅ resolved | C3 |
| 5. Per-chain vs per-session chat | ✅ resolved | F2 |
| 6. Unread counts | ✅ resolved | N1 |
| 7. @-mentions and push | ✅ resolved (elevated to MVP) | N2, N3, N4 |
| 8. Moderation | ✅ resolved | M3, M4, M5 |
| 9. Mobile interaction | ✅ resolved | Mo1, Mo2 |
| 10. Agent transcript integrity | ✅ resolved | A1 |

## Next steps

1. P2 (kata-spec-writing): produce `planning/specs/<n>-team-collab.md`
   absorbing this summary. B-IDs per behavior; phases per the proposed
   sequencing above; verification plan; migration plan.
2. Suggested spec slug: `team-collab-chat-comments` or
   `arc-collab-layer`. Issue number TBD when filed.
3. Spec writer should read `broadcast-arc.ts`, `session-collab-do.ts`,
   and `db/schema.ts` arcs section before drafting.
