---
initiative: team-collab-chat-comments
type: project
issue_type: feature
status: approved
priority: high
github_issue: 152
created: 2026-04-30
updated: 2026-04-30
phases:
  - id: p1
    name: "Auth handshake + per-arc ACL (arcMembers, arcInvitations, arcs.visibility)"
    tasks:
      - "Add D1 migration `apps/orchestrator/migrations/0034_arc_collab_acl.sql` — **expand-only** (no destructive drops). Use the expand-then-contract pattern: this migration ADDS new tables + columns + backfills only; the destructive `DROP COLUMN agent_sessions.visibility` ships in a follow-up migration `0036_drop_session_visibility.sql` AFTER the backfill is verified in production. This protects against silent backfill failure across D1's non-transactional DDL (Gotcha #4). Statements (separated by `--> statement-breakpoint` per the 0031/0032 pattern): (1) `CREATE TABLE arc_members (arc_id text NOT NULL REFERENCES arcs(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')), added_at text NOT NULL, added_by text REFERENCES users(id) ON DELETE SET NULL, PRIMARY KEY (arc_id, user_id))`. (2) `CREATE INDEX idx_arc_members_user ON arc_members(user_id, arc_id)` for the per-user 'arcs I'm in' query. (3) `CREATE TABLE arc_invitations (token text PRIMARY KEY, arc_id text NOT NULL REFERENCES arcs(id) ON DELETE CASCADE, email text NOT NULL, role text NOT NULL DEFAULT 'member', invited_by text NOT NULL REFERENCES users(id), created_at text NOT NULL, expires_at text NOT NULL, accepted_at text, accepted_by text REFERENCES users(id) ON DELETE SET NULL)`. (4) `CREATE INDEX idx_arc_invitations_arc ON arc_invitations(arc_id) WHERE accepted_at IS NULL`. (5) `ALTER TABLE arcs ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public'))`. (6) Backfill: `UPDATE arcs SET visibility = COALESCE((SELECT MAX(visibility) FROM agent_sessions WHERE arc_id = arcs.id), 'private')` — MAX puts 'public' before 'private' lexicographically; COALESCE handles arcs with no sessions. (7) Auto-grant arc owner: `INSERT INTO arc_members(arc_id, user_id, role, added_at, added_by) SELECT id, user_id, 'owner', created_at, user_id FROM arcs`. (8) `CREATE INDEX idx_arcs_visibility_status ON arcs(visibility, status)` for kanban + discoverability. **DO NOT** drop `agent_sessions.visibility` in this migration — keep the column readable (and read-only, app-side; new writes go to `arcs.visibility`) until 0036"
      - "Add D1 migration `apps/orchestrator/migrations/0036_drop_session_visibility.sql` — the destructive contract phase. Ships AS A SEPARATE FILE (not in 0034) so it can be deployed independently after a verification window. Statements: (1) Verification check via the migration runner (see Gotcha #4): `SELECT COUNT(*) FROM arcs WHERE visibility IS NULL` MUST return 0 (assertion runs in `migration-test.ts` against a snapshot of production data; if it returns >0, halt). (2) `ALTER TABLE agent_sessions DROP COLUMN visibility`. (3) `DROP INDEX idx_agent_sessions_visibility_last_activity`. Implementation note: 0036 is authored in P1 but committed and deployed only after one full deploy cycle on 0034 has completed and a manual smoke (P1 VP1) confirms no regressions"
      - "Update `apps/orchestrator/src/db/schema.ts`: add Drizzle tables `arcMembers`, `arcInvitations` matching the migration. Add `visibility: text('visibility', { enum: ['private','public'] }).notNull().default('private')` to `arcs` table. Drop `visibility` column from `agentSessions` table. Update `ArcSummary` type in `lib/types.ts` to include `visibility`, drop `visibility` from `SessionSummary`"
      - "Add `apps/orchestrator/src/lib/arc-acl.ts` (NEW). Export `checkArcAccess(env, db, arcId, userSession): Promise<{ allowed: boolean, role: 'owner'|'member'|null, reason?: string }>`. Logic: (a) load arc row; if arc.visibility='public' AND userSession.userId truthy → allowed (role from arc_members if any, else null). (b) if userSession.role='admin' → allowed (role: 'owner' override for moderation). (c) lookup `arcMembers WHERE arc_id=? AND user_id=?` → if found, allowed with role. (d) else not allowed. Mirrors today's `checkSessionAccess()` in `server.ts:25-42`"
      - "Replace `checkSessionAccess()` calls in `apps/orchestrator/src/server.ts` (line ~25-42, ~142, ~187 per research): wrap each session-id-based access check with `checkArcAccess(arc_id_from_session)`. Update WS upgrade routes `/agents/session-agent/<id>` and any HTTP routes that gate on session ownership. Keep the system-actor and admin overrides. The route guard now reads `arcs.visibility` and `arc_members` instead of `agent_sessions.visibility` + `userId === sessionRow.userId`"
      - "Inject `userId` into the Connection on WS upgrade. In `apps/orchestrator/src/server.ts` WS upgrade handler: after `checkArcAccess` succeeds, attach `request.cf.userId = userSession.userId` and `request.cf.userEmail = userSession.userEmail`. In the SessionDO and ArcCollabDO `onConnect(connection, ctx)`, read `ctx.request.cf.userId` and store it on `connection.state.userId`. Make available to `broadcast.ts` so messages can attribute the sender. Reference: research §3 — `assistant_messages.sender_id` (DO migration v12) is already shaped for this and currently unused"
      - "Add Hono routes in new file `apps/orchestrator/src/api/arc-members.ts`: (1) `GET /api/arcs/:id/members` returns `{members: [{userId, email, name, role, addedAt}], invitations: [{token, email, role, expiresAt}]}` — gated by `checkArcAccess` (any member can list). (2) `POST /api/arcs/:id/members` body `{email}` — owner-only; if user with that email exists, insert into `arc_members` directly; else insert into `arc_invitations` with 7-day expiry, send email via Better Auth's email sender or noop in dev. (3) `DELETE /api/arcs/:id/members/:userId` — owner-only; remove from `arc_members`. (4) `POST /api/arcs/invitations/:token/accept` — public-but-authed; matches token + accepting user's email, moves into `arc_members`, marks invitation accepted. Returns the arc id for client redirect. Wire the new module into `api/index.ts`"
      - "Update `apps/orchestrator/src/lib/arcs.ts:buildArcRow` to include `visibility` and a lightweight `memberCount` field in `ArcSummary`. Update `arcsCollection` (in `db/arcs-collection.ts`) so the client receives visibility on every arc. Update kanban query (research: `api/index.ts:2659-2756` arcs-list endpoint) to filter by membership: a user sees arcs where `visibility='public' OR EXISTS (SELECT 1 FROM arc_members WHERE arc_id=arcs.id AND user_id=?)`. Add `?lane=mine|public|all` query param; default `mine` for the sidebar"
      - "Wire `sender_id` population end-to-end. In `apps/orchestrator/src/agents/session-do/rpc-messages.ts:sendMessageImpl`, read `connection.state.userId` (set by the WS handshake earlier in this phase) and pass it to the `assistant_messages` INSERT — populates the `sender_id` column shipped in DO migration v12 but currently NULL. Also update the assistant-side write in `gateway-event-handler.ts` (the path that appends streamed assistant messages) to set `sender_id = 'system'` (sentinel) so user vs system origin is distinguishable. Update `transcript.ts:export` to round-trip `sender_id` (still excluded from the SDK transcript per B24 — the field is for collab UI only). Test: post a user message, assert `assistant_messages.sender_id` matches the authed user's id"
      - "Build `ArcMembersDialog.tsx` (NEW component) under `apps/orchestrator/src/features/arc-orch/`. Props: `{arcId, open, onClose}`. Layout: header 'Members of <arc title>'; tabs 'Members' (`role='owner'|'member'`, with avatar, name, email, addedAt, addedBy) and 'Pending invites' (email, role, expiresAt, 'Resend' / 'Revoke' actions). Owner-only controls: add-member input (email field + role dropdown defaulting 'member'), remove-member (X button per row). Non-owners see read-only. Mount: opens from a 'Members' button in the existing arc settings panel (search for the arc title rendering site, currently in `features/arc-orch/ArcHeader.tsx` or equivalent — verify path during implementation). Wire to the four endpoints from the prior task; refresh list on dialog open"
      - "Tests: `apps/orchestrator/src/api/arc-members.test.ts` — covers all 4 endpoints, owner/member/admin role gating, expired invitation rejection, accept-by-wrong-email rejection. `apps/orchestrator/src/lib/arc-acl.test.ts` — public arc allows any authed read, private arc blocks non-member, admin override works. `apps/orchestrator/src/features/arc-orch/ArcMembersDialog.test.tsx` — owner sees add/remove controls, member sees read-only, dialog refreshes after invite. Add a `migration-test.ts` case: post-0034, an existing `agent_sessions.visibility='public'` row backfills to its arc with `visibility='public'`"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- arc-members arc-acl migration-test`"
    test_cases:
      - id: "migration-0034-creates-tables"
        description: "After 0034, arc_members and arc_invitations tables exist with correct schema; arcs.visibility column exists; agent_sessions.visibility STILL EXISTS (expand-only)"
        type: "unit"
      - id: "migration-0034-backfills-owner"
        description: "Every existing arc has its userId user inserted as 'owner' in arc_members with addedAt = arc.created_at"
        type: "unit"
      - id: "migration-0034-preserves-public"
        description: "An agent_sessions row with visibility='public' results in its arc having visibility='public'"
        type: "unit"
      - id: "migration-0036-asserts-backfill-complete"
        description: "0036 pre-check fails (refuses to run) if any arcs.visibility IS NULL; passes when all rows are populated"
        type: "unit"
      - id: "migration-0036-drops-session-visibility"
        description: "After 0036, agent_sessions.visibility column is gone and idx_agent_sessions_visibility_last_activity index is dropped"
        type: "unit"
      - id: "check-arc-access-public"
        description: "checkArcAccess returns allowed=true for any authed user on a public arc, role=null if not a member"
        type: "unit"
      - id: "check-arc-access-private-blocks"
        description: "checkArcAccess returns allowed=false for non-member non-admin on a private arc"
        type: "unit"
      - id: "ws-handshake-injects-userid"
        description: "WS upgrade attaches userId to the Connection; broadcast handlers can read connection.state.userId"
        type: "integration"
      - id: "owner-can-invite-and-remove"
        description: "POST /api/arcs/:id/members with {email} adds to arc_members (existing user) or arc_invitations (new user); DELETE removes; non-owner gets 403"
        type: "integration"
      - id: "invitation-accept-flow"
        description: "POST /api/arcs/invitations/:token/accept moves invitation row → arc_members; expired token returns 410; wrong-email returns 403"
        type: "integration"
  - id: p2
    name: "Per-message comments — DO SQLite migration, SyncedCollection, threaded replies, lock-on-stream"
    tasks:
      - "Add SessionDO migration v23 to `apps/orchestrator/src/agents/session-do-migrations.ts`. SQL: `CREATE TABLE comments (id TEXT PRIMARY KEY, arc_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, parent_comment_id TEXT, author_user_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, deleted_by TEXT)`. Indexes: `(session_id, message_id, created_at)` for thread reads, `(parent_comment_id)` for reply lookup, `(arc_id, modified_at, id)` for cursor replay. Comments live in the SessionDO of the message they anchor to (matches the `assistant_messages` colocation pattern from migrations v9-v13)"
      - "Add new SyncedCollection wire scope `comments:<sessionId>`. In `apps/orchestrator/src/db/synced-collection.ts`, register a factory `createCommentsCollection(sessionId)`. Wire shape mirrors `messagesCollection`: `SyncedCollectionFrame<CommentRow>` typed in `packages/shared-types/src/index.ts`. The `CommentRow` type: `{ id, sessionId, messageId, parentCommentId?, authorUserId, body, createdAt, modifiedAt, editedAt?, deletedAt?, deletedBy? }`. Stamp the per-DO `messageSeq` envelope (broadcast.ts:97,160 pattern) on every comment delta — gap detection and snapshot RPC come for free"
      - "Add RPC handlers in new `apps/orchestrator/src/agents/session-do/rpc-comments.ts` (mirrors `rpc-messages.ts:47-200` shape): (1) `addCommentImpl(ctx, args: {messageId, parentCommentId?, body, clientCommentId})` — guards: arc access, message exists in this session, message is not currently streaming (read `assistant_config.turnCounter` vs latest finalized message). Insert into `comments` table; broadcast delta. (2) `editCommentImpl(ctx, args: {commentId, body})` — guards: comment.author_user_id === connection.userId AND not deleted. UPDATE body, edited_at; broadcast delta with edited flag. (3) `deleteCommentImpl(ctx, args: {commentId})` — guards: author OR arc owner OR admin. Soft-delete: set deleted_at, deleted_by; broadcast delta. (4) `listCommentsForMessage(ctx, args: {messageId})` — read API for snapshot/RPC"
      - "Add HTTP routes in `apps/orchestrator/src/agents/session-do/http-routes.ts`: `POST /sessions/:sid/comments`, `PATCH /sessions/:sid/comments/:cid`, `DELETE /sessions/:sid/comments/:cid`. Each routes to the corresponding `*Impl` after `checkArcAccess` on the parent arc. Idempotency: `addCommentImpl` accepts `clientCommentId` and uses the existing `submit_ids` table (DO migration v5) to dedupe within 60s"
      - "Lock-during-stream: in `gateway-event-handler.ts`, on the streaming-start event for an assistant message, broadcast `{type: 'comment_lock', messageId}`; on the finalize/stopped event, broadcast `{type: 'comment_unlock', messageId}`. Client tracks lock state per message id. `addCommentImpl` server-side guard rejects with 409 `{error: 'message_streaming'}` if the message is in lock state — single source of truth"
      - "Client comment write path. New hook `apps/orchestrator/src/hooks/use-comments-collection.ts` (mirrors `use-messages-collection.ts`): subscribes to `comments:<sessionId>` SyncedCollection. New optimistic-write `addComment(messageId, body, parentCommentId?)` — generates clientCommentId (uuid v4), inserts into TanStack DB store, POSTs to `/api/sessions/:sid/comments`. Pattern from `use-coding-agent.ts:1078-1140`"
      - "Comment thread UI. New component `apps/orchestrator/src/features/agent-orch/CommentThread.tsx` — opens as right-side drawer on desktop (anchored to message), Capacitor bottom sheet on mobile (via `@capacitor/action-sheet` or a custom sheet — see Implementation Hints). Renders thread tree (top-level + replies), 'Add comment' / 'Reply' inputs. Replies are rendered indented under parent, max one level (UI-enforced; DB allows arbitrary). Edit/delete inline icons gated by author/owner/admin. 'Add comment' input is disabled and reads 'Message is streaming…' when comment_lock is active for that message"
      - "Inline counter badge on each transcript message. Update `apps/orchestrator/src/features/agent-orch/Message.tsx` (or wherever the transcript rows render) to show comment count + 'open thread' affordance when `comments[messageId].length > 0`. Use the existing `messagesCollection` row's `id` as the join key into `commentsCollection`"
      - "Fork semantics — `branchArcImpl` in `branches.ts` does NOT clone comments into the new arc. No code change required (comments live in the source DO and aren't part of the prompt-history serialization), but add an explicit test asserting comments don't surface on a forked arc's first session"
      - "Tests: `apps/orchestrator/src/agents/session-do/rpc-comments.test.ts` — cover add/edit/delete, role gating, lock-during-stream rejection, idempotency via clientCommentId. UI test `apps/orchestrator/src/features/agent-orch/CommentThread.test.tsx` — opens thread, adds top-level + reply, lock state disables input, optimistic insert appears immediately. Migration test: SessionDO migration v23 creates `comments` table with all 5 indexes"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- rpc-comments CommentThread`"
    test_cases:
      - id: "comment-add-broadcasts"
        description: "addComment via two browsers on same arc: browser A posts, browser B sees the new comment within the next SyncedCollection delta (no manual refresh)"
        type: "integration"
      - id: "comment-thread-replies"
        description: "Reply to a comment sets parent_comment_id; thread UI renders reply indented under parent"
        type: "unit"
      - id: "comment-lock-during-stream"
        description: "While message is streaming, comment_lock is broadcast; addComment server returns 409; UI input disabled. After stopped event, comment_unlock fires; input re-enabled"
        type: "integration"
      - id: "comment-edit-marker"
        description: "Editing a comment sets edited_at; UI shows '(edited)'; only author can edit"
        type: "unit"
      - id: "comment-delete-tombstone"
        description: "Author/owner/admin delete sets deleted_at; UI renders 'deleted by X' placeholder; row not removed"
        type: "unit"
      - id: "comment-fork-hidden"
        description: "branchArc creates new arc; first session has no inherited comments; original arc's comments untouched"
        type: "integration"
      - id: "comment-idempotent"
        description: "Two addComment calls with same clientCommentId result in one row (submit_ids table)"
        type: "unit"
  - id: p3
    name: "Side-channel team chat — ArcCollabDO scaffolding + chat lane (DO SQLite + D1 mirror)"
    tasks:
      - "Create `apps/orchestrator/src/agents/arc-collab-do.ts` (NEW). **Hybrid DO design:** extends `YServer` from `y-partyserver` (so the prompt-collab Yjs surface promoted in P6 inherits the existing y-partyserver wire/awareness) AND owns custom SQLite tables for chat, reactions, mentions metadata. The Y.Doc state is persisted in `y_state` (same as `SessionCollabDOv2`); the chat/reactions tables are siblings in the same DO's SQLite. This is supported because YServer extends the Cloudflare Agents Server pattern — it does not constrain additional `ctx.storage.sql.exec(...)` schema. P3 ships the SQLite half; P6 layers the Y.Doc topology on top of the same DO. Static options: `hibernate: true`, `callbackOptions: { debounceWait: 2000, debounceMaxWait: 10000, timeout: 5000 }`. Register the DO class in `apps/orchestrator/wrangler.toml` with binding `ARC_COLLAB_DO`. Add the WS upgrade route at `/agents/arc-collab-do/<arcId>` in `server.ts` (gated by `checkArcAccess`, B1)"
      - "ArcCollabDO migration v1 (in `apps/orchestrator/src/agents/arc-collab-do-migrations.ts` — NEW file mirroring `session-do-migrations.ts:1-22` shape; uses the `Migration` type from `~/lib/do-migrations`). Migration v1 SQL — three statements: (a) `CREATE TABLE chat_messages (id TEXT PRIMARY KEY, arc_id TEXT NOT NULL, author_user_id TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, deleted_by TEXT)`. (b) `CREATE TABLE submit_ids (client_id TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)` — per-DO idempotency table mirroring SessionDO migration v5; 60s TTL enforced in app code on every insert. (c) `CREATE TABLE y_state (id TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)` — same shape as `session-collab-do.ts:23-31`, holds the Y.Doc snapshot for P6's awareness/draft layer. Indexes: `(arc_id, modified_at, id)` on chat_messages for cursor replay, `(arc_id, created_at)` for time-ordered fetch. The `mentions` column is a JSON array of userIds, populated server-side at write time (P5). Run migrations from `onLoad` (matches the `session-collab-do.ts:33-46` pattern — DDL is idempotent and runs before y-partyserver's first read)"
      - "D1 mirror table — migration `apps/orchestrator/migrations/0035_chat_mirror.sql`. `CREATE TABLE chat_mirror (id text PRIMARY KEY, arc_id text NOT NULL REFERENCES arcs(id) ON DELETE CASCADE, author_user_id text NOT NULL REFERENCES users(id), body text NOT NULL, created_at text NOT NULL, fts_indexed_at text)`. Index: `(arc_id, created_at)`. NOT a full FTS5 yet — that's deferred. The mirror exists for cross-arc 'find auth discussions' search and unread counts (P5)"
      - "Add SyncedCollection scope `arcChat:<arcId>`. New typed `ChatMessageRow` in `shared-types`. Broadcaster: new `apps/orchestrator/src/lib/broadcast-arc-room.ts` — fans out to all `arcMembers(arc_id)` via per-user UserSettingsDO sockets (mirrors `broadcast-arc.ts` but member-aware). Function: `broadcastArcRoom(env, ctx, arcId, channel, ops)` where channel is one of `arcChat`, `comments`, `reactions`, `arcAwareness`"
      - "RPC + HTTP in `apps/orchestrator/src/agents/arc-collab-do.ts` — `sendChatImpl(ctx, args: {body, clientChatId})`, `editChatImpl`, `deleteChatImpl`, `listChatHistory(args: {beforeSeq?, limit})`. HTTP routes mounted at `/arc-collab/<arcId>/chat`. Idempotency via clientChatId in `submit_ids` table (per-DO)"
      - "D1 mirror writer — fire-and-forget. After `sendChatImpl` writes to DO SQLite + broadcasts, schedule `ctx.waitUntil(mirrorChatToD1(env, arcId, row))` which inserts into `chat_mirror`. Drift up to ~10s acceptable per the research. Edits and deletes propagate to D1 the same way"
      - "Client chat hook — `apps/orchestrator/src/hooks/use-arc-chat.ts`. Subscribes to `arcChat:<arcId>`. Optimistic insert + POST to `/api/arcs/:id/chat`. Pattern from `use-comments-collection.ts` (P2)"
      - "Chat panel UI — `apps/orchestrator/src/features/arc-orch/TeamChatPanel.tsx`. Desktop: persistent right rail (collapsible). Mobile: 'Team' tab in session view. Visual distinction: different background (e.g., `bg-amber-50` on light theme), no agent avatar, header reads 'Team chat — agent doesn't see this'. Composer at bottom; messages render newest-bottom; auto-scroll on new message when scrolled to bottom"
      - "Tests: `apps/orchestrator/src/agents/arc-collab-do.test.ts` — chat send/edit/delete, two members see each other's messages, mirror writes happen async. Migration test for `0035_chat_mirror`"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- arc-collab-do TeamChatPanel`"
    test_cases:
      - id: "chat-arc-scoped"
        description: "Two sessions in same arc share one chat lane; sessions in different arcs are isolated"
        type: "integration"
      - id: "chat-mirror-async"
        description: "After sendChat, chat_mirror row appears in D1 within 30s (waitUntil)"
        type: "integration"
      - id: "chat-cross-member-fanout"
        description: "Member A sends chat, member B (different browser, different user) receives delta within 1s"
        type: "integration"
      - id: "chat-non-member-blocked"
        description: "User not in arc_members on a private arc gets 403 on POST chat"
        type: "integration"
      - id: "chat-edit-delete"
        description: "Author can edit (sets edited_at, '(edited)' marker); author/owner/admin can delete (soft-delete with deleted_by)"
        type: "unit"
      - id: "chat-isolation-from-agent"
        description: "Chat messages are NEVER appended to the SDK transcript file; SessionDO transcript export omits chat"
        type: "integration"
  - id: p4
    name: "Reactions on comments + chat — emoji table, optimistic toggle, broadcast"
    tasks:
      - "ArcCollabDO migration v2: `CREATE TABLE reactions (target_kind TEXT NOT NULL CHECK(target_kind IN ('comment','chat')), target_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (target_kind, target_id, user_id, emoji))`. Index: `(target_kind, target_id)` for the per-target rollup. The composite PK enforces 'one user one emoji per target' (toggling re-presses the same key)"
      - "D1 mirror: D1 migration `0039_reactions_mirror.sql` mirrors the same table for cross-arc analytics (deferred but cheap to land alongside). Migration number 0039 (not 0036) avoids collision with `0036_drop_session_visibility.sql` from P1. Drop if not needed; spec defaults to mirror-on"
      - "Add SyncedCollection scope `reactions:<arcId>`. Wire shape: `ReactionRow = {targetKind, targetId, userId, emoji, createdAt}`. Broadcaster uses `broadcastArcRoom`. Stamp messageSeq for replay"
      - "RPC: `toggleReactionImpl(ctx, args: {targetKind, targetId, emoji})`. Logic: if (target_kind, target_id, user_id, emoji) exists → DELETE; else INSERT. Single broadcast either way (`{op: 'toggle', ...}`). Server validates targetId exists in `comments` or `chat_messages`"
      - "UI: emoji-picker on hover (desktop) / long-press (mobile). Component `apps/orchestrator/src/features/arc-orch/ReactionPicker.tsx`. Standard emoji set: a curated list of ~32 emojis from Unicode 6+ (avoid skin-tone variants for v1). Render under each comment/chat message: stacked emoji chips with counts, click to toggle"
      - "Tests: `toggleReactionImpl` toggles correctly, two users can react with same emoji (count = 2), removing your reaction doesn't affect others"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- reactions ReactionPicker`"
    test_cases:
      - id: "reaction-toggle"
        description: "First click adds reaction; second click by same user removes it; third user click adds (count = 2)"
        type: "unit"
      - id: "reaction-multi-emoji"
        description: "Same user can have different emojis on the same target"
        type: "unit"
      - id: "reaction-broadcasts"
        description: "User A reacts; user B sees the chip update within the next delta"
        type: "integration"
      - id: "reaction-on-deleted-target"
        description: "Reactions on a soft-deleted comment/chat are hidden in UI but rows preserved"
        type: "unit"
  - id: p5
    name: "Unread tracking + @-mentions — D1 summary tables, server-side parser, Inbox view"
    tasks:
      - "D1 migration `0037_collab_summary.sql`: (1) `CREATE TABLE arc_unread (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, arc_id text NOT NULL REFERENCES arcs(id) ON DELETE CASCADE, unread_comments integer NOT NULL DEFAULT 0, unread_chat integer NOT NULL DEFAULT 0, last_read_at text, PRIMARY KEY (user_id, arc_id))`. Index: `(user_id, arc_id)` (already PK). (2) `CREATE TABLE arc_mentions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, arc_id text NOT NULL REFERENCES arcs(id) ON DELETE CASCADE, source_kind text NOT NULL CHECK(source_kind IN ('comment','chat')), source_id text NOT NULL, mention_ts text NOT NULL, read_at text)`. Indexes: `(user_id, mention_ts DESC)` for the Inbox view, `(source_kind, source_id)` for cleanup"
      - "Server-side mention parser. New `apps/orchestrator/src/lib/parse-mentions.ts`. Token regex: `/(?<![\\w@])@([a-zA-Z0-9._-]{2,32})/g`. Token resolution: SELECT users.id FROM users INNER JOIN arc_members ON arc_members.user_id = users.id WHERE arc_members.arc_id = ? AND (lower(users.email) = lower(?) OR lower(users.name) = lower(?)). Unresolved tokens render as plain text. Strip `@everyone` and `@here` (treat as plain text in v1; revisit in v2). Code-fence escaping: skip tokens inside backticks (run after a markdown-aware tokenizer or before any rendering). Return `{ resolvedUserIds: string[], normalizedBody: string }`"
      - "Wire mention parser into `addCommentImpl` (P2) and `sendChatImpl` (P3). On every write, parse body → store resolved user ids in the row's `mentions` column (JSON array) and INSERT one row per mention into `arc_mentions`. Broadcast a `mention_new` event to the mentioned user via their UserSettingsDO socket (mirrors the unread-counter fanout)"
      - "Unread tracking. On every comment/chat write: increment `arc_unread.unread_*` for every arc member EXCEPT the author (use atomic `INSERT ... ON CONFLICT(user_id, arc_id) DO UPDATE SET unread_*=unread_*+1`). On 'open thread' / 'open chat panel' client event: POST `/api/arcs/:id/read` body `{kind: 'comments'|'chat'}` — server resets the counter and updates `last_read_at`. Broadcast a delta to that user's other devices so the badge clears everywhere"
      - "API endpoints: `GET /api/arcs/:id/unread` (returns own counts), `POST /api/arcs/:id/read` (resets), `GET /api/inbox/mentions?cursor=&limit=` (paginated mention list, joins to comment/chat for body preview), `POST /api/inbox/mentions/:id/read` (mark single mention read), `POST /api/inbox/mentions/read-all` (mark all read up to cursor)"
      - "Client: `useArcUnread(arcId)` hook returns counts + `markRead(kind)`. Sidebar `ArcRow` renders unread badge if `unread_comments + unread_chat > 0`. New page `/inbox` with `MentionsList.tsx` — shows context preview ('Alice mentioned you in <arc title> — \"...\"' with link to the message)"
      - "Tests: parser unit tests for regex edge cases (email-like, code-fenced, @everyone, multibyte), `arc_unread` integration test (write → counts go up for non-authors only; read → reset). Inbox API test"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- parse-mentions arc_unread inbox`"
    test_cases:
      - id: "mention-parser-basic"
        description: "Body 'hi @alice and @bob' resolves both to user ids when both are arc members"
        type: "unit"
      - id: "mention-parser-non-member"
        description: "Body '@stranger' where stranger is not in arc_members returns empty resolved ids"
        type: "unit"
      - id: "mention-parser-codefence"
        description: "Body 'see ```@alice```' does NOT resolve the mention inside backticks"
        type: "unit"
      - id: "mention-parser-no-everyone"
        description: "@everyone and @here are stripped (treated as plain text); no mention rows created"
        type: "unit"
      - id: "unread-increment-on-write"
        description: "Member A posts comment; arc_unread.unread_comments increments for all other members; A's own row unchanged"
        type: "integration"
      - id: "unread-reset-on-read"
        description: "POST /api/arcs/:id/read?kind=comments resets that user's unread_comments to 0 and stamps last_read_at"
        type: "integration"
      - id: "inbox-mentions-pagination"
        description: "GET /api/inbox/mentions returns cursor-paginated list ordered by mention_ts DESC; mark-read sets read_at"
        type: "integration"
  - id: p6
    name: "Presence + typing — Yjs Y.Doc topology on existing ArcCollabDO, lazy hydration from SessionCollabDOv2"
    tasks:
      - "Layer Yjs Y.Doc structure on the ArcCollabDO created in P3 (the DO already extends `YServer`). **Topology decision baked in (not deferred):** a single Y.Doc per arc with namespace-prefixed top-level keys — NOT y-partyserver sub-docs. Rationale: y-partyserver's documented surface targets one Y.Doc per server instance; sub-doc support is an underdocumented escape hatch. We use a SINGLE Y.Doc with prefixed `Y.Map`/`Y.Text` keys, which works on every y-partyserver version and avoids the question. Concrete keys: `arc:meta` (`Y.Map` — title/notes/etc. — placeholder for future arc-level live-collab fields), `arc:chat-draft` (`Y.Text` — the shared team-chat composer draft), and one `prompt:<sessionId>` (`Y.Text`) per session in the arc, written into the document's root. Map of session → Y.Text is exposed as `doc.getText('prompt:' + sessionId)`. New session in arc → client lazily creates `doc.getText('prompt:' + sessionId)` on first edit"
      - "Awareness fields per connection: `{ userId: string, sessionId?: string, viewing: 'prompt' | 'chat' | 'comments:<msgId>', typing: boolean, displayName: string, avatarUrl?: string }`. Set on connect via the awareness API (`provider.awareness.setLocalStateField(...)`); cleared on disconnect (y-partyserver handles this automatically when the connection closes). Awareness updates (typing/viewing) ride the existing y-partyserver fanout — no SyncedCollection involved. ArcCollabDO carries (i) the Yjs draft state and (ii) the awareness layer; chat/comment/reaction DATA still flows through SyncedCollection (P3, P2, P4)"
      - "Hydration of legacy `SessionCollabDOv2` data into the new arc-scoped Y.Doc. On first ArcCollabDO load per arc (detected by checking if `prompt:*` keys exist in the Y.Doc): for each session in this arc, fetch the session's `SessionCollabDOv2` y_state snapshot via a one-time RPC call to that DO; decode with `Y.applyUpdate` into a temp Y.Doc; copy the prompt text into our `doc.getText('prompt:' + sessionId)`. Mark hydration done by writing a sentinel key (`arc:hydrated-from-legacy = true`). Old `SessionCollabDOv2` instances stay readable for 30 days post-cutover then are reaped by a follow-up migration. Add a feature flag `ARC_COLLAB_DO_ENABLED` (env binding) so we can ship the new DO behind a flag and roll back without data loss"
      - "Update `apps/orchestrator/src/hooks/use-session-collab.ts` — make it a wrapper that, when ARC_COLLAB_DO_ENABLED, dials the ArcCollabDO and reads/writes `arc.prompts.get(sessionId)`. Otherwise falls back to legacy. After cutover, rename to `use-arc-collab.ts` and inline the legacy fallback"
      - "Awareness UI. Component `apps/orchestrator/src/features/arc-orch/ArcPresenceBar.tsx`: renders avatars of users with active awareness states for this arc. Hover → tooltip 'Bob is viewing chat'. Typing dots in the chat composer when any awareness has `typing: true AND viewing: 'chat'`. Per-message typing indicator in comment threads when awareness has `viewing: 'comments:<msgId>'` and typing"
      - "Awareness debounce — typing signal: set `typing: true` on first keystroke; clear on (a) Enter (sent), (b) 5s idle. Use lodash `debounce(set, 100, {leading: true, trailing: true})` for the 'true' signal and `setTimeout(clear, 5000)` for the idle clear. Reset on any subsequent keystroke"
      - "Server-side: extract `userId` and `sessionId` from the WS upgrade (P1). Pass via `request.cf` into `onConnect` (Y server passes through). Set them as awareness 'local state' fields on connect, clear on disconnect"
      - "Tests: `apps/orchestrator/src/agents/arc-collab-do.test.ts` — sub-doc topology: prompt for session A is independent of prompt for session B in same arc. Awareness convergence: 3 connections, all see consistent typing state within 2s. Migration test: legacy SessionCollabDOv2 state hydrates into ArcCollabDO sub-doc on first load"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- arc-collab-do`"
    test_cases:
      - id: "arc-collab-prompt-namespaced"
        description: "Two sessions in same arc have independent Y.Text under keys 'prompt:<sidA>' and 'prompt:<sidB>'; editing session A's prompt does not appear in session B"
        type: "integration"
      - id: "arc-collab-awareness-presence"
        description: "Three connections: each sees the other two in awareness; viewing='chat' updates within 1s"
        type: "integration"
      - id: "arc-collab-typing-debounce"
        description: "Typing in composer sets awareness typing=true; after 5s of no input, typing=false"
        type: "unit"
      - id: "arc-collab-legacy-hydration"
        description: "Legacy SessionCollabDOv2 with prompt 'foo' hydrates into ArcCollabDO Y.Text at key 'prompt:<sid>' = 'foo' on first arc-collab read; arc:hydrated-from-legacy sentinel set"
        type: "integration"
      - id: "arc-collab-feature-flag-rollback"
        description: "With ARC_COLLAB_DO_ENABLED=false, legacy SessionCollabDOv2 still serves prompt collab; flipping the flag mid-session does not corrupt either DO's state"
        type: "integration"
  - id: p7
    name: "FCM push delivery — wire fcmSubscriptions + pushSubscriptions for chat + comment mentions"
    tasks:
      - "Add `apps/orchestrator/src/lib/push-delivery.ts`. Export `dispatchPush(env, args: {targetUserId, kind: 'chat' | 'comment_mention', arcId, sourceId, preview, actorName})`. Logic: (a) load `fcmSubscriptions` rows for user; (b) load `pushSubscriptions` (web-push VAPID) rows for user; (c) call FCM HTTP v1 API for each fcm token, web-push for each VAPID subscription; (d) log delivery results in `event_log` (DO migration v17 retention applies). Mark and prune subs on persistent 410/404 (token revoked). Rate-limit per user: max 5 pushes/min, 50/hour; excess collapses into a digest"
      - "FCM credentials: rely on infra pipeline to inject service-account JSON into Worker secrets as `FCM_SERVICE_ACCOUNT_JSON`. Document in `.claude/rules/deployment.md` (separate task). Local dev: log payloads instead of dispatching"
      - "Wire chat: at the end of `sendChatImpl`, after broadcast, enqueue (`ctx.waitUntil`) one push per arc member EXCEPT the author. Body: 'Alice in <arc title>: <body preview 60 chars>'. Title: '<arc title>'. Action URL: `/arc/<arcId>?focus=chat`. Coalesce per (user, arc) on the 5/min rate-limit"
      - "Wire comment mentions: in `addCommentImpl`, after mention parser resolves user ids, enqueue one push per resolved user id with kind='comment_mention'. Body: 'Alice mentioned you in <arc title>: <body preview>'. Action URL: `/arc/<arcId>/session/<sid>?focusComment=<cid>`"
      - "Per-user toggle (deferred but scaffold). Add `user_push_prefs(user_id, arc_id?, channel TEXT CHECK(channel IN ('all_chat','mention')), enabled INTEGER NOT NULL DEFAULT 1)` table — D1 migration `0038_push_prefs.sql`. v1 default: all_chat=enabled, mention=enabled, no UI to toggle. Future v2 ships the toggle UI; the wiring is already there. `dispatchPush` checks this table before sending"
      - "Capacitor permission flow. Update `apps/mobile/` Capacitor wrapper: lazy permission request on first 'enable push for this arc' click (NOT at app launch). Call `PushNotifications.requestPermissions()` then register the FCM token via `POST /api/push/register-fcm`. Handle iOS/Android divergence per the existing scaffolding"
      - "Tests: integration test for `dispatchPush` (mock FCM endpoint, verify body shape). Rate-limit test: post 10 chat messages in 30s; only 5 pushes dispatched, rest collapsed. End-to-end manual VP step: send chat from desktop → mobile shell receives push"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- push-delivery`"
    test_cases:
      - id: "push-chat-fanout"
        description: "sendChat dispatches push to N-1 arc members (all except author)"
        type: "integration"
      - id: "push-mention-only-mentioned"
        description: "addComment with '@alice' dispatches push to alice; other arc members do not get a push for this comment"
        type: "integration"
      - id: "push-rate-limit"
        description: "10 chats in 30s → 5 pushes dispatched + 1 digest at the end of the window"
        type: "integration"
      - id: "push-revoked-token-pruned"
        description: "FCM 410 response causes the fcm_subscriptions row to be deleted on next dispatch"
        type: "integration"
  - id: p8
    name: "Cascade rules + moderation surfaces — soft/hard-delete cascade, edit/delete UI"
    tasks:
      - "Soft-delete arc behavior. `POST /api/arcs/:id/archive` (already in #116 spec) sets `arcs.status = 'archived'`. Update arcs sidebar query to filter archived by default; add 'Show archived' toggle. Comments and chat ROWS untouched — but UI hides the panels when arc is archived. Members still see arc in the archived view; can un-archive (P1: PATCH /api/arcs/:id with {status: 'open'})"
      - "Hard-delete arc cascade. New `DELETE /api/arcs/:id` (owner-only). Steps: (1) DELETE arcs.* rows in D1 (FK CASCADE drops `arc_members`, `arc_invitations`, `chat_mirror`, `arc_unread`, `arc_mentions`). (2) Walk all sessions in this arc; for each, send the SessionDO an RPC to drop its `comments` and `submit_ids` rows then call `ctx.storage.deleteAll()`. (3) Send the ArcCollabDO an RPC to `deleteAll()`. (4) Worktree release follows existing #115 patterns"
      - "Edit / delete UI. In `CommentThread.tsx` and `TeamChatPanel.tsx`, render an actions menu on hover/long-press for own messages (or all messages if owner/admin). Actions: Edit, Delete. Edit replaces body with composer + Cancel/Save buttons. Delete shows confirm dialog 'Delete for everyone?'"
      - "Tombstone rendering. After soft-delete, the row renders as: '[ deleted by Alice 2 minutes ago ]' (italic, muted). Replies under a deleted parent still render — parent shows tombstone, replies remain. For chat, deleted messages just show the tombstone in their position"
      - "Member removal cascade. When `DELETE /api/arcs/:id/members/:userId` runs (P1), the removed user's WS connections to ArcCollabDO and SessionDOs in this arc are CLOSED on next broadcast (server-side; client reconnects, fails ACL check, redirects to /). Their existing comments and chat messages are NOT deleted — they remain attributed to the user (matching git-style 'commit attribution survives access change'). They can be deleted individually by owner/admin per the moderation rules"
      - "Tests: hard-delete arc test — assert all D1 cascade rows gone and DO destruction triggered. Tombstone test — render shows the right phrase. Removed-member test — user A is in arc, user B (owner) removes A, user A's next WS reconnect fails 403"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- cascade moderation`"
    test_cases:
      - id: "soft-delete-arc-hides"
        description: "Archive arc → sidebar hides by default; comments and chat rows preserved; un-archive restores"
        type: "integration"
      - id: "hard-delete-arc-cascades"
        description: "DELETE arc → arc_members/invitations/chat_mirror/arc_unread/arc_mentions rows gone; SessionDOs destroyed; comments DO storage cleared"
        type: "integration"
      - id: "edit-comment-shows-marker"
        description: "Edit comment → '(edited)' visible; only author sees Edit action menu"
        type: "unit"
      - id: "tombstone-render"
        description: "Deleted comment renders '[ deleted by X N minutes ago ]'; replies still render under it"
        type: "unit"
      - id: "removed-member-disconnected"
        description: "User A removed from arc → A's existing comments/chat preserved; A's next WS connect fails ACL"
        type: "integration"
  - id: p9
    name: "Mobile polish — bottom-sheet for comments, Team tab for chat, lazy push permission"
    tasks:
      - "Bottom-sheet component for the comment thread. **Implementation path: custom React component, NOT `@capacitor/action-sheet`** (that plugin renders only native action sheets with string labels — it cannot host a React component tree). Build `apps/orchestrator/src/components/BottomSheet.tsx` (NEW) using `framer-motion` (already in the workspace — verify via `grep -r framer-motion apps/orchestrator/package.json`; if absent, add `framer-motion` as a dep) for spring physics, and the existing pointer-event surface for swipe gestures. Implementation: (a) full-viewport portal positioned at the bottom; (b) sheet height controlled by `motion.div` y-translation, snap points at 0% / 50% / 90% viewport height; (c) drag handle at top responds to `onPan` with velocity threshold (>500px/s downward → dismiss); (d) backdrop click dismisses; (e) **scroll-trap mitigation**: the inner scroll container uses `overscroll-behavior: contain` AND tracks `touchStart Y` — when scrollTop=0 AND user drags down, the gesture transfers to the sheet (translates the sheet) rather than rubber-banding the inner scroll. Reference pattern: Vaul (https://vaul.emilkowal.ski) — we hand-roll because Vaul is a heavier dep than this single-use case warrants. Test: vitest+jsdom for state machine, manual VP for gesture behavior on Android shell"
      - "Mobile-variant `CommentThread.tsx` — same component as desktop, host swap based on `useMediaQuery('(max-width: 768px)')`. Desktop: render inside the existing right-drawer slot. Mobile: wrap in `<BottomSheet>` from the prior task. The thread content (composer, list, replies) is identical; only the chrome differs"
      - "Team tab integration. Update `apps/orchestrator/src/components/layout/session-tab-bar.tsx` (or wherever the session sub-nav lives — verify via Glob) to add a 'Team' tab between 'Transcript' and 'Settings'. Tab body is `TeamChatPanel.tsx`. Mobile: tab is full-width; scroll is panel-internal"
      - "Push permission flow. On first user click of a push-related toggle (or first arc-join on mobile), call `PushNotifications.requestPermissions()`. If denied, show a one-time tooltip explaining how to enable in OS settings; never re-prompt within a session"
      - "FCM token registration. On successful permission grant, call `PushNotifications.register()`. On `registration` event, POST token to `/api/push/register-fcm` body `{token, platform: 'android'|'ios'}`. Update `fcm_subscriptions` (existing table, migration 0010)"
      - "Mobile presence indicator. Render `ArcPresenceBar` as a thin top strip in mobile layout (not a side panel). Tap → modal listing all present users with viewing/typing state"
      - "Tests: e2e via the testing harness — open arc on two devices, verify bottom sheet on mobile shows comment thread; tab switch shows chat. Manual VP step covers FCM token round-trip"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- mobile`"
    test_cases:
      - id: "bottom-sheet-state-machine"
        description: "BottomSheet state transitions (closed → 50% → 90% → dismissed) under simulated pointer events; jsdom + RTL"
        type: "unit"
      - id: "bottom-sheet-swipe-dismiss"
        description: "Manual VP on the Capacitor Android shell: tap message → bottom sheet rises; swipe down dismisses; backdrop tap dismisses; scroll inside list does not propagate to sheet drag"
        type: "manual"
      - id: "team-tab-mobile"
        description: "Mobile: 'Team' tab appears in session sub-nav between Transcript and Settings"
        type: "unit"
      - id: "push-lazy-permission"
        description: "Manual VP on Android shell: fresh app install + first launch does NOT prompt for push; first toggle of push setting prompts; denial does not re-prompt within session"
        type: "manual"
      - id: "fcm-token-registered"
        description: "Granted permission → POST /api/push/register-fcm with platform-correct token; row appears in fcm_subscriptions (verified via D1 query)"
        type: "integration"
---

# Team collab layer — chat + per-message comments

> GitHub Issue: [#152](https://github.com/baseplane-ai/duraclaw/issues/152)

## Overview

Add a team collaboration layer on top of arcs: per-message **comments**
(annotations on the agent transcript, threaded, agent-isolated) plus
**side-channel team chat** (a per-arc human-to-human chat lane the
agent never sees). Reactions, presence/typing, @-mentions with FCM
push, and unread tracking all ship with v1. Sharing is governed by a
new per-arc ACL (`arc_members` + invitations); the existing
`agent_sessions.visibility` is replaced by `arcs.visibility` since
arcs (#116) are now the durable parent.

## Feature Behaviors

### B1: Per-arc ACL gates all reads and writes

**Core:**
- **ID:** arc-acl-gating
- **Trigger:** any HTTP/WS request scoped to an arc or session
- **Expected:** route guard `checkArcAccess` allows iff (arc.visibility='public' AND user authed) OR user is in `arc_members` for this arc OR user.role='admin'
- **Verify:** integration test — non-member user gets 403 on private-arc routes; same user gets 200 after owner adds them
- **Source:** new `apps/orchestrator/src/lib/arc-acl.ts`; replaces `apps/orchestrator/src/server.ts:25-42`

#### API Layer
Replaces `checkSessionAccess` calls. New endpoints `GET/POST/DELETE /api/arcs/:id/members`, `POST /api/arcs/invitations/:token/accept`. All collab routes (comments, chat, reactions) inherit `checkArcAccess`.

#### Data Layer
New tables `arc_members`, `arc_invitations`. New column `arcs.visibility`. Drop `agent_sessions.visibility` and its index. D1 migration `0034_arc_collab_acl.sql`. Drizzle schema updated in `apps/orchestrator/src/db/schema.ts`.

---

### B2: WS handshake injects userId

**Core:**
- **ID:** ws-handshake-userid
- **Trigger:** browser opens WS to `/agents/session-agent/<id>` or `/agents/arc-collab-do/<arcId>`
- **Expected:** server reads Better Auth session cookie, attaches `userId`, `userEmail` to `request.cf`; DO `onConnect` stores them on the Connection object
- **Verify:** unit test asserting `connection.state.userId` is set after handshake; broadcast handlers can attribute writes
- **Source:** `apps/orchestrator/src/server.ts` WS upgrade handlers; new fields in `apps/orchestrator/src/agents/session-do/client-ws.ts`

#### API Layer
No new endpoint — augments existing WS upgrade. The `assistant_messages.sender_id` column (DO migration v12, currently unused) becomes populated.

---

### B3: Arc owner invites by email or username

**Core:**
- **ID:** arc-invite-flow
- **Trigger:** owner POSTs `/api/arcs/:id/members` with `{email}`
- **Expected:** existing user → row in `arc_members`; non-existing → row in `arc_invitations` with 7-day expiry, email sent (or logged in dev). Acceptance link: `/invitations/<token>`
- **Verify:** integration test covering both paths; expired token returns 410; accept-by-wrong-email returns 403
- **Source:** new `apps/orchestrator/src/api/arc-members.ts`

#### UI Layer
New `ArcMembersDialog.tsx` accessible from arc settings. List members + pending invites. Owner sees Add/Remove controls; member sees read-only.

---

### B4: Arc visibility governs discoverability

**Core:**
- **ID:** arc-visibility
- **Trigger:** any arcs-list or arc-detail query
- **Expected:** `visibility='public'` arcs visible to all authed users (matches today's session 'public' behavior); `'private'` arcs visible only to members + admin
- **Verify:** integration test — private arc invisible to non-member; PATCH visibility to public makes it visible without changing membership
- **Source:** `apps/orchestrator/src/lib/arcs.ts:buildArcRow`; arcs-list endpoint at `apps/orchestrator/src/api/index.ts:2659-2756`

#### Data Layer
Backfilled from `agent_sessions.visibility` during migration 0034. Sessions inherit visibility from their arc.

---

### B5: Author/owner/admin moderation, soft-delete with tombstone

**Core:**
- **ID:** moderation-soft-delete
- **Trigger:** delete action on a comment, chat message, OR reply (this behavior unifies all three; chat-specific delete is NOT a separate B-ID — it's covered here. Same for chat edit, which inherits B9's contract)
- **Expected:** allowed iff (caller = author) OR (caller = arc owner) OR (caller.role = admin); on success, sets `deleted_at`, `deleted_by`; row preserved; UI renders 'deleted by X N min ago'
- **Verify:** unit test — non-author non-owner non-admin gets 403; soft-deleted row still in DB; UI shows tombstone. Tested per surface (`rpc-comments.test.ts` for comments, `arc-collab-do.test.ts` for chat)
- **Source:** `rpc-comments.ts:deleteCommentImpl`; `arc-collab-do.ts:deleteChatImpl`

---

### B6: Per-message comment with stable anchor

**Core:**
- **ID:** comment-anchor
- **Trigger:** user POSTs `/api/sessions/:sid/comments` with `{messageId, body, parentCommentId?, clientCommentId}`
- **Expected:** server validates message exists in this session; inserts comment row keyed by `(arcId, sessionId, messageId)`; broadcasts via `comments:<sessionId>` SyncedCollection
- **Verify:** integration test — two browsers on same arc both see the new comment within next delta; survives reconnect via cursor replay
- **Source:** new `apps/orchestrator/src/agents/session-do/rpc-comments.ts`; SessionDO migration v23 adds `comments` table

#### UI Layer
`CommentThread.tsx`: right-side drawer (desktop) / bottom sheet (mobile). Inline counter on each transcript message.

#### Data Layer
SessionDO SQLite `comments` table. SyncedCollection scope `comments:<sessionId>`. Migration v23.

---

### B7: Threaded comment replies (one level UI)

**Core:**
- **ID:** comment-threading
- **Trigger:** user clicks 'Reply' on an existing comment
- **Expected:** `parent_comment_id` stored; UI renders reply indented under parent (max 1 level enforced UI-side); DB allows arbitrary depth
- **Verify:** unit test — reply row has correct parent FK; UI tree only shows parents and one level of children
- **Source:** `comments` table self-FK; `CommentThread.tsx` render logic

---

### B8: Lock-during-stream — no comments on partial messages

**Core:**
- **ID:** comment-lock-stream
- **Trigger:** assistant message starts streaming
- **Expected:** broadcast `{type: 'comment_lock', messageId}`; client disables 'Add comment' on that message; server `addCommentImpl` returns 409 `{error: 'message_streaming'}` if attempted; on stopped/finalize, `comment_unlock` broadcast re-enables
- **Verify:** integration test — comment attempt during stream returns 409, after stopped returns 200
- **Source:** `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts` (broadcast lock/unlock); rpc-comments.ts (server guard)

---

### B9: Edit comment marks `(edited)`, no history kept

**Core:**
- **ID:** comment-edit
- **Trigger:** author PATCHes `/api/sessions/:sid/comments/:cid` with new body
- **Expected:** UPDATE body, edited_at = now; broadcast delta; UI shows '(edited)' next to author
- **Verify:** unit test — non-author edit returns 403; row body changes; edited_at populated; no revision row created
- **Source:** `rpc-comments.ts:editCommentImpl`

---

### B10: Comments hide from forked arcs

**Core:**
- **ID:** comment-fork-hide
- **Trigger:** `branchArcImpl` creates new arc + session
- **Expected:** new arc starts with no comments; original arc's comments preserved; no clone, no orphan reference
- **Verify:** integration test — branch arc; new session shows zero comments on its (cloned) message ids
- **Source:** no code change required (comments live in source DO and are not part of `serializeHistoryForFork`); test added in `branches.test.ts`

---

### B11: Per-arc team chat lane

**Core:**
- **ID:** chat-arc-scope
- **Trigger:** user POSTs `/api/arcs/:id/chat` with `{body, clientChatId}`
- **Expected:** server inserts into ArcCollabDO `chat_messages`, broadcasts via `arcChat:<arcId>` SyncedCollection to all `arc_members`, mirrors to `chat_mirror` D1 table async
- **Verify:** integration test — two members see each other's chat in real time; non-member gets 403; D1 mirror row appears within 30s
- **Source:** new `apps/orchestrator/src/agents/arc-collab-do.ts`; D1 migration `0035_chat_mirror.sql`

#### UI Layer
`TeamChatPanel.tsx`: persistent right rail (desktop), 'Team' tab (mobile). Visually distinct background ('agent doesn't see this' header).

#### Data Layer
ArcCollabDO SQLite `chat_messages`. D1 mirror `chat_mirror`. SyncedCollection scope `arcChat:<arcId>`.

---

### B12: Reactions on chat + comments (toggle, MVP emoji set)

**Core:**
- **ID:** reactions-toggle
- **Trigger:** user clicks/long-presses an emoji on a chat message or comment
- **Expected:** toggles reaction in `reactions` table (composite PK `(target_kind, target_id, user_id, emoji)`); broadcasts via `reactions:<arcId>` SyncedCollection
- **Verify:** unit test — first click adds, second removes; two users with same emoji → count=2
- **Source:** new ArcCollabDO migration v2; `toggleReactionImpl`

---

### B13: Server-side @-mention parsing constrained to arc members

**Core:**
- **ID:** mention-parse
- **Trigger:** comment or chat write
- **Expected:** parser walks body for `@<token>`; resolves token to user via `arc_members` join; unresolved → plain text; `@everyone`/`@here` stripped; code-fenced tokens skipped
- **Verify:** unit test suite covering basic, non-member, code-fence, multibyte, @everyone
- **Source:** new `apps/orchestrator/src/lib/parse-mentions.ts`

#### Data Layer
`mentions` JSON array column on `comments` and `chat_messages`. `arc_mentions` D1 row per resolved mention.

---

### B14: Unread counters in sidebar via D1 summary

**Core:**
- **ID:** unread-counts
- **Trigger:** any comment/chat write to an arc
- **Expected:** `arc_unread.unread_*` increments for all members except author (atomic upsert). On `POST /api/arcs/:id/read`, counter resets and `last_read_at` stamps; delta broadcast clears badge across user's other devices
- **Verify:** integration test — write → counters up; read → counters zero; sidebar shows badge without DO wake
- **Source:** D1 migration `0037_collab_summary.sql`; `useArcUnread(arcId)` hook

---

### B15: Inbox view of @-mentions

**Core:**
- **ID:** inbox-mentions
- **Trigger:** user navigates to `/inbox`
- **Expected:** paginated list of mentions ordered by mention_ts DESC; each row shows actor, arc title, body preview, link; mark-read sets `read_at`
- **Verify:** integration test — three mentions across two arcs render correctly; mark-read persists
- **Source:** new `apps/orchestrator/src/api/inbox.ts`; `MentionsList.tsx` page

---

### B16: ArcCollabDO carries Yjs awareness for presence + typing

**Core:**
- **ID:** arc-collab-presence
- **Trigger:** user opens any arc surface (transcript, chat, comments)
- **Expected:** WS connection to `ArcCollabDO`; awareness state set with `userId`, `viewing`, `typing`; other connections see updates within 1s
- **Verify:** integration test — three connections converge; viewing/typing state observable
- **Source:** new `apps/orchestrator/src/agents/arc-collab-do.ts` (extends `YServer`)

#### Data Layer
ArcCollabDO replaces per-session `SessionCollabDOv2`. Sub-doc-per-session for prompt drafts (existing `SessionCollabDOv2` data hydrates lazily on first ArcCollabDO load). Feature flag `ARC_COLLAB_DO_ENABLED`.

---

### B17: Typing indicator with 5s idle clear

**Core:**
- **ID:** typing-indicator
- **Trigger:** user types in chat composer or comment composer
- **Expected:** `typing: true` set in awareness on first keystroke (debounced 100ms leading); cleared on Enter (sent) or 5s idle
- **Verify:** unit test on the debounce wrapper; e2e shows indicator appear within 100ms and clear after 5s of inactivity
- **Source:** `useTypingAwareness` hook in `arc-collab` client

---

### B18: FCM push on every chat message

**Core:**
- **ID:** push-chat
- **Trigger:** chat message written
- **Expected:** push dispatched to all arc members except author; preview body, action URL `/arc/<arcId>?focus=chat`; rate-limited 5/min/user/arc with digest collapse
- **Verify:** integration test mocks FCM endpoint, verifies N-1 payloads
- **Source:** new `apps/orchestrator/src/lib/push-delivery.ts`; existing `fcm_subscriptions` (D1 migration 0010), `push_subscriptions` (0002)

---

### B19: FCM push on @-mention in comment

**Core:**
- **ID:** push-mention
- **Trigger:** comment written with resolved mentions
- **Expected:** one push per mentioned user (only); body 'Alice mentioned you in <arc>: <preview>'; action URL `/arc/<arcId>/session/<sid>?focusComment=<cid>`
- **Verify:** integration test — resolved mention fires push, non-mentioned arc members get no push for this comment
- **Source:** `push-delivery.ts:dispatchPush`; called from `addCommentImpl`

---

### B20: Soft-delete arc hides; hard-delete cascades

**Core:**
- **ID:** arc-cascade
- **Trigger:** archive (status='archived') or hard-delete (DELETE /api/arcs/:id)
- **Expected:** archive → sidebar hides by default, rows preserved, un-archivable. Hard-delete → CASCADE drops `arc_members`, `arc_invitations`, `chat_mirror`, `arc_unread`, `arc_mentions`; SessionDO storage cleared; ArcCollabDO destroyed
- **Verify:** integration test for both paths; archived arc visible only with toggle, deleted arc fully gone
- **Source:** existing `POST /api/arcs/:id/archive` (#116) + new `DELETE /api/arcs/:id`

---

### B21: Removed member loses access on next reconnect

**Core:**
- **ID:** member-remove-revoke
- **Trigger:** owner removes user from arc
- **Expected:** existing comments/chat messages by removed user PRESERVED with attribution; their next WS reconnect fails ACL check (403); browser redirects per existing 403 handling
- **Verify:** integration test — A removed by B, A's comments still render with name, A's next /api/arcs/:id load returns 403
- **Source:** `arc-members.ts:DELETE` handler; existing 403 redirect in `apps/orchestrator/src/lib/api-client.ts`

---

### B22: Mobile UX — bottom sheet for comments, Team tab for chat

**Core:**
- **ID:** mobile-ux
- **Trigger:** mobile (Capacitor) user taps a transcript message or session 'Team' tab
- **Expected:** message tap → bottom sheet rises (Capacitor gesture API, swipe-down dismisses, backdrop tap dismisses, no scroll trap). 'Team' tab → full-width `TeamChatPanel` with internal scroll
- **Verify:** manual VP step on Android shell + e2e via the testing harness
- **Source:** mobile variant of `CommentThread.tsx`; `session-tab-bar.tsx` adds 'Team' tab

---

### B23: Lazy push permission flow on mobile

**Core:**
- **ID:** push-permission-lazy
- **Trigger:** first user click of a push-related toggle
- **Expected:** `PushNotifications.requestPermissions()` called only at this moment, NOT at app launch; on grant, register FCM token via `POST /api/push/register-fcm`; on deny, one-time tooltip, never re-prompt
- **Verify:** manual VP — fresh app install, no permission prompt at launch; first toggle prompts
- **Source:** `apps/mobile/` Capacitor plugin wiring

---

### B24: Agent-isolation invariant — collab data never reaches the SDK

**Core:**
- **ID:** agent-isolation
- **Trigger:** any SDK resume / transcript export / prompt construction
- **Expected:** comments, chat messages, reactions, mentions, awareness state are NEVER read into the SDK transcript file or the prompt seed. Storage is in tables segregated from SDK-owned `assistant_messages`. Verified by transcript-export tests
- **Verify:** integration test — write 5 comments and 3 chats; trigger SDK resume; assert resumed transcript contains zero collab data; existing transcript-export tests in `transcript.test.ts` extended
- **Source:** existing storage segregation (DO migrations v9-v13 own `assistant_messages`; new v23+ table separate); `apps/orchestrator/src/agents/session-do/transcript.ts` export logic

---

### B25: Authorship attribution — sender_id populated end-to-end

**Core:**
- **ID:** authorship
- **Trigger:** any comment, chat, reaction, or message write through the new layer
- **Expected:** `author_user_id` (or equivalent) populated from `connection.state.userId` set by B2 handshake; UI renders user name + avatar from Better Auth `users.image`
- **Verify:** unit test — write captures the right user id, broadcast carries it, render shows correct name
- **Source:** `connection.state.userId` from B2; new write paths in P2/P3/P4

---

## Error Contract

Consolidated error responses across all collab endpoints. All errors
return JSON `{ error: <code>, message?: <human> }` with the listed
status code. Client error-handling lives in
`apps/orchestrator/src/lib/api-client.ts`; this table is the source of
truth.

| Endpoint | Status | `error` code | When |
|---|---|---|---|
| Any collab route | 401 | `unauthenticated` | No session cookie / Better Auth check fails |
| Any collab route | 403 | `forbidden` | `checkArcAccess` returns `{allowed: false}` |
| `POST /api/arcs/:id/members` | 403 | `not_owner` | Caller is a member but not owner |
| `POST /api/arcs/:id/members` | 409 | `already_member` | User is already in `arc_members` for this arc |
| `POST /api/arcs/invitations/:token/accept` | 404 | `invitation_not_found` | Token does not exist |
| `POST /api/arcs/invitations/:token/accept` | 410 | `invitation_expired` | `expires_at < now` |
| `POST /api/arcs/invitations/:token/accept` | 403 | `email_mismatch` | Authed user's email ≠ invitation email |
| `POST /api/sessions/:sid/comments` | 404 | `message_not_found` | `messageId` not in this session's `assistant_messages` |
| `POST /api/sessions/:sid/comments` | 409 | `message_streaming` | `comment_lock` active for that message |
| `POST /api/sessions/:sid/comments` | 422 | `body_required` | Empty body |
| `POST /api/sessions/:sid/comments` | 422 | `parent_not_found` | `parentCommentId` set but row missing |
| `PATCH /api/sessions/:sid/comments/:cid` | 404 | `comment_not_found` | Row missing or already hard-deleted |
| `PATCH /api/sessions/:sid/comments/:cid` | 403 | `not_author` | Caller is not the comment author |
| `PATCH /api/sessions/:sid/comments/:cid` | 410 | `comment_deleted` | Row is soft-deleted (cannot edit a tombstone) |
| `DELETE /api/sessions/:sid/comments/:cid` | 404 | `comment_not_found` | Row missing |
| `DELETE /api/sessions/:sid/comments/:cid` | 403 | `forbidden` | Caller is not author/owner/admin |
| `POST /api/arcs/:id/chat` | 422 | `body_required` | Empty body |
| `PATCH /api/arcs/:id/chat/:msgid` | 404 | `chat_not_found` | Row missing |
| `PATCH /api/arcs/:id/chat/:msgid` | 403 | `not_author` | Caller is not the message author |
| `DELETE /api/arcs/:id/chat/:msgid` | 403 | `forbidden` | Caller is not author/owner/admin |
| `POST /api/arcs/:id/reactions` | 404 | `target_not_found` | `targetId` missing in `comments`/`chat_messages` |
| `POST /api/arcs/:id/reactions` | 422 | `invalid_emoji` | Emoji not in the curated v1 set |
| `POST /api/arcs/:id/read` | 422 | `invalid_kind` | `kind` not in `'comments'|'chat'` |
| `GET /api/inbox/mentions` | 422 | `invalid_cursor` | Cursor unparseable |
| Idempotent write (`addComment`, `sendChat`) | 200 | (no error) | Existing `submit_ids` row → returns the prior server response |
| `toggleReaction` (intentionally NOT idempotent) | 200 | (no error) | Each call flips state via composite PK; no `submit_ids` involvement — calling twice toggles add→remove |
| Rate-limited push trigger | 200 | (no error, push collapsed) | Internal — never surfaced to client |

## Non-Goals

Explicitly out of scope for this feature (defer to v2 or never):

- **Custom emoji upload.** Only the curated standard emoji set in v1.
- **Per-user push toggle UI.** Wiring is scaffolded (`user_push_prefs` table) but no settings UI lands. Manual mute via direct DB edit only.
- **Quiet-hours / digest UI.** Rate-limit + collapse exists server-side; no user-facing schedule.
- **Per-comment privacy modes.** All comments visible to all arc members. No 'private comment to one user'.
- **Cross-arc mention.** A user mentioned in a comment they're not a member of: parser returns no resolution; mention falls back to plain text. No 'invite + ping' flow.
- **Full-text search across chat.** D1 `chat_mirror` exists but no FTS5 index in v1. Cross-arc search is best-effort scan; deferred.
- **Per-message read receipts.** Only per-arc unread counters. No 'X read this comment' UI.
- **Edit history / revisions for comments and chat.** `(edited)` marker only.
- **'Resolve thread' on comments.** Linear-style resolved state is deferred; v1 has no resolved/unresolved distinction.
- **DMs / private chat between members.** Chat is arc-scoped only.
- **Org plugin (Better Auth `organization`).** Not installed. Re-evaluate if a hard team requirement appears.
- **Magic-link share URL** (research option D). Out of scope; if needed, layer on later.
- **Threading depth > 1 in UI.** DB allows arbitrary; UI caps at top-level + 1 reply level.
- **Reactions in transcript export to SDK.** Reactions are collab data; agent never sees them.

## Open Questions

- [ ] **FCM service-account credential management** — needs infra-pipeline coordination (env var `FCM_SERVICE_ACCOUNT_JSON` to be added to wrangler secrets). If not available at P7, push lands as a follow-up — P8 (cascade/moderation) ships before it. Out of band from collab-feature blocking dependencies.
- [ ] **Rate-limit envelope (5/min/user/arc, 50/hour)** — initial heuristic. Revisit after first dogfood week. The mechanism (per-bucket counter in DO memory or KV) is decided; only the constants are tunable.
- [ ] **Project-scope visibility (`projects.visibility` from migration 0020)** — outside this spec's scope, but the same expand-then-contract migration pattern applies. Document the parallel for a future spec; do NOT touch `projects.visibility` here.

**Resolved during review (no longer blocking):**
- ✅ Yjs sub-doc topology — RESOLVED: spec now uses a single Y.Doc per arc with namespace-prefixed top-level keys (`prompt:<sessionId>`, `arc:chat-draft`, `arc:meta`). Avoids the y-partyserver sub-doc support question entirely. See P6 task 1.
- ✅ Member display name fallback — RESOLVED: standard render function `userDisplay(user)` returns `user.name ?? user.email`, defined once in `apps/orchestrator/src/lib/user-display.ts` and used by every component that renders an author or member.

## Implementation Phases

See YAML frontmatter `phases:` above. Execution order is the natural
P1 → P9 sequence — the previous draft's "do P6 before P3" reorder is
gone: ArcCollabDO scaffolding now lives in P3's first task (the DO
ships with chat and is reused by reactions in P4 and presence in P6).
P6 layers Yjs Y.Doc topology + awareness ON TOP of the existing DO,
so it depends on P3 but does not block earlier phases.

**D1 migration numbers reserved by this spec:** `0034`
(arc_collab_acl, P1), `0035` (chat_mirror, P3), `0036`
(drop_session_visibility, P1, expand-then-contract follow-up),
`0037` (collab_summary — arc_unread + arc_mentions, P5), `0038`
(push_prefs, P7), `0039` (reactions_mirror, P4). If a concurrent
spec lands first and claims one of these, this spec's migration
files renumber on rebase. The convention is: the first spec to merge
to `main` claims the next sequential number; later specs renumber
on PR rebase before merge.

Phase dependencies:
- P1 is standalone and useful on its own (ACL + handshake + sender_id).
- P2 (comments) needs P1's handshake and ACL.
- P3 (chat + ArcCollabDO scaffolding) needs P1.
- P4 (reactions) needs P3's ArcCollabDO.
- P5 (mentions + unread) needs P2 and P3 to have write paths to hook into.
- P6 (Yjs presence) needs P3's ArcCollabDO; can ship as a standalone follow-up if the team wants to ship MVP without presence.
- P7 (FCM push) is parallelizable with P5/P6 once P3 is done.
- P8 (cascade + moderation) needs P2 and P3 done.
- P9 (mobile polish) integrates everything; ships last.

## Verification Strategy

### Test Infrastructure

- **vitest** with miniflare D1 + DO mocks — config at `apps/orchestrator/vitest.config.ts`. New tests under each module's directory.
- **Manual VP** runs against `pnpm dev` (Vite + miniflare locally) on the per-worktree port from `.claude/rules/worktree-setup.md`.
- **Migration tests** mirror the pattern from `apps/orchestrator/src/db/migration-test.ts` (#116) — seed pre-migration state, run migration, assert post-state.
- **Two-browser collab test** uses Playwright via the existing `chrome-devtools-axi` infra (per-worktree CDP ports).
- **FCM/push** mocks the FCM HTTP endpoint with msw; live FCM delivery to a real device is a manual VP step.
- **Test type taxonomy** (used in `test_cases`):
  - `unit` — pure functions, jsdom-rendered components, in-process mocks
  - `integration` — requires miniflare DO + D1, may span multiple modules
  - `manual` — must be exercised on a physical device or browser by a human operator. Used for B22 bottom-sheet gestures and B23 push permission flow, where Capacitor's native bridges cannot be reliably automated. The state-machine half of those features IS unit-tested; only the device-side behavior is `manual`.

### Build Verification

`pnpm build` (turbo) and `pnpm typecheck` across the workspace. The orchestrator-specific build is `pnpm --filter @duraclaw/orchestrator build`. Do NOT run `pnpm ship` manually — deploys are infra-driven (`.claude/rules/deployment.md`).

## Verification Plan

### VP1: Per-arc ACL gates a private arc

1. As user A, `POST /api/arcs` with `{title: 'private-arc', visibility: 'private'}`. Note the returned `arcId`.
2. As user B (different session cookie), `GET /api/arcs/<arcId>` — Expected: 403.
3. As user A, `POST /api/arcs/<arcId>/members` with `{email: 'b@example.com'}` — Expected: 200 (existing user, inserted into `arc_members`).
4. As user B, `GET /api/arcs/<arcId>` again — Expected: 200 with arc summary including `visibility: 'private'`, `members[].userId` includes B.

### VP2: Two browsers see real-time comment delta

1. Open two Chrome contexts via `chrome-devtools-axi` on the same arc (user A in browser 1, user B in browser 2 — both arc members).
2. Browser 1 sends a message; wait for assistant response to finalize.
3. Browser 1 clicks the message → comment thread drawer opens → posts comment 'looks wrong here'.
4. Browser 2: assert comment appears in the same drawer within 1.5s, attributed to user A.
5. Browser 2: click 'Reply', post 'agree, suggest X'. Browser 1 sees the reply indented under the parent within 1.5s.

### VP3: Lock-during-stream blocks comments

1. Browser 1: send a multi-paragraph prompt that triggers ~30s of streaming.
2. While streaming: try to add a comment on the in-progress assistant message. Expected: 'Add comment' input is disabled with text 'Message is streaming…'.
3. `curl` the API directly during streaming: `POST /api/sessions/<sid>/comments {messageId, body, clientCommentId}` — Expected: 409 `{error: 'message_streaming'}`.
4. Wait for stream to finalize. Browser 1: input re-enabled. Posting now succeeds (200).

### VP4: Per-arc chat persists across mode advance

1. In an arc with mode='research', open `TeamChatPanel`; user A sends 'kicking off research'. User B (in the panel) sees the message.
2. Run `advanceArc({mode: 'planning', prompt: '...'})` — new session row appears, same `arcId`.
3. In the new (planning) session, open `TeamChatPanel`. Expected: prior chat message 'kicking off research' STILL VISIBLE — chat is per-arc, not per-session.

### VP5: Reactions toggle correctly

1. User A reacts with 👍 on user B's chat message. Both see chip with count=1, A in 'reacted' state.
2. User C reacts with 👍 too. Both see count=2.
3. User A clicks 👍 again. Count drops to 1.
4. User A reacts with 🎉 (different emoji). Now two chips: 🎉×1, 👍×1.

### VP6: @-mention fires push to mentioned user only

1. User A on desktop posts a comment '@bob check this'.
2. Server-side: assert mention parser resolved to user B's id, `arc_mentions` row inserted, push dispatched ONLY to B's FCM tokens (mock the FCM endpoint via msw to capture).
3. User B's mobile shell receives push notification 'Alice mentioned you in <arc title>: check this'.
4. User C (third arc member, unmentioned) receives NO comment-mention push — but DOES receive a chat-message push when A posts in `arcChat`.

### VP7: Unread counter increments and resets

1. As user A, post 3 chat messages. Server: `arc_unread.unread_chat=3` for B and C, 0 for A.
2. User B opens `TeamChatPanel`; client POSTs `/api/arcs/<arcId>/read?kind=chat`. Server: B's row updates to `unread_chat=0`, `last_read_at=now`. C's row unchanged.
3. Sidebar badge on B clears immediately. C still shows badge with 3.

### VP8: Hard-delete cascades

1. User A creates arc, invites B, both post comments and chat. Note all generated ids.
2. User A `DELETE /api/arcs/<arcId>`.
3. Verify in D1: zero rows in `arcs`, `arc_members`, `arc_invitations`, `chat_mirror`, `arc_unread`, `arc_mentions` for this arcId.
4. Verify the SessionDO storage is cleared (storage.deleteAll called) — observable via DO metric or re-fetching the session 404s.
5. ArcCollabDO storage cleared.

### VP9: Yjs awareness presence converges

1. Open three browsers on the same arc as different users.
2. Browser 1 navigates to chat tab. Within 1.5s, browsers 2 and 3 see user 1's avatar in `ArcPresenceBar` with `viewing: chat`.
3. Browser 1 starts typing in the chat composer. Within 200ms, browsers 2 and 3 see typing dots in the composer area.
4. Browser 1 stops typing for 5s. Within 100ms after, dots clear in 2 and 3.

### VP10: SDK never sees collab data

1. Create a session, post 5 comments and 3 chat messages, add several reactions and mentions.
2. Trigger SDK resume (e.g., by killing and restarting the session-runner against this DO).
3. Inspect the SDK transcript file (path via `apps/orchestrator/src/agents/session-do/transcript.ts:export`): assert it contains ONLY user prompts and assistant responses. No comment bodies, no chat bodies, no '@bob', no reactions.

## Implementation Hints

### Dependencies

No new top-level dependencies. All required:

```bash
# Already installed:
# - y-partyserver, yjs (existing prompt collab)
# - @capacitor/push-notifications (mobile push)
# - drizzle-orm (D1)
# - hono (API)
```

### Key Imports

| Module | Import | Used For |
|---|---|---|
| `~/db/synced-collection` | `createSyncedCollection` | New `comments`, `arcChat`, `reactions` collections |
| `~/db/schema` | `arcMembers, arcInvitations, arcUnread, arcMentions, chatMirror, reactions` | Drizzle table refs |
| `~/lib/arcs` | `buildArcRow` | Augmented to carry `visibility` + `memberCount` |
| `~/lib/arc-acl` | `checkArcAccess` | Replaces `checkSessionAccess` |
| `~/lib/parse-mentions` | `parseMentions` | Server-side @-mention parser |
| `~/lib/push-delivery` | `dispatchPush` | FCM + web-push fanout |
| `~/lib/broadcast-arc-room` | `broadcastArcRoom` | Member-aware fanout (unlike `broadcastArcRow` which is owner-scoped) |
| `y-partyserver` | `YServer` | ArcCollabDO base class |
| `yjs` | `Y.Map`, `Y.Text`, `Y.applyUpdate`, `encodeStateAsUpdate` | Sub-doc topology |
| `@capacitor/push-notifications` | `PushNotifications` | Mobile push registration |

### Code Patterns

**1. Optimistic write (mirror `use-coding-agent.ts:1078-1140`):**

```ts
// In use-comments-collection.ts
async function addComment(input: { messageId: string; body: string; parentCommentId?: string }) {
  const clientCommentId = crypto.randomUUID()
  const optimisticRow: CommentRow = {
    id: clientCommentId, // overwritten by server-assigned id on broadcast
    sessionId, messageId: input.messageId, parentCommentId: input.parentCommentId ?? null,
    authorUserId: currentUserId, body: input.body,
    createdAt: Date.now(), modifiedAt: Date.now(),
  }
  collection.insert(optimisticRow) // TanStack DB store
  await fetch(`/api/sessions/${sessionId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ ...input, clientCommentId }),
  })
}
```

**2. Member-aware broadcast (mirror `broadcast-arc.ts` shape, expand fanout):**

```ts
// In lib/broadcast-arc-room.ts
// MEMBER-LIST CACHE: queried on every write; cache invalidated when
// arc_members changes. Cache key: `arc_members:<arcId>`. TTL 60s,
// purged synchronously on POST/DELETE /api/arcs/:id/members. Use
// the existing per-Worker in-memory cache (Cache API or a Map with
// LRU), NOT KV — the read-through latency on a hot path matters more
// than cross-isolate consistency (a 60s stale member list is OK; a
// 200ms KV read on every chat write is not).
const MEMBER_CACHE = new Map<string, { members: string[]; expiresAt: number }>()

export async function broadcastArcRoom(env, ctx, arcId, channel, ops) {
  const cached = MEMBER_CACHE.get(arcId)
  let members: string[]
  if (cached && cached.expiresAt > Date.now()) {
    members = cached.members
  } else {
    const db = drizzle(env.AUTH_DB, { schema })
    const rows = await db.select({ userId: arcMembers.userId }).from(arcMembers).where(eq(arcMembers.arcId, arcId))
    members = rows.map(r => r.userId)
    MEMBER_CACHE.set(arcId, { members, expiresAt: Date.now() + 60_000 })
  }
  ctx.waitUntil(Promise.all(members.map(uid =>
    broadcastSyncedDelta(env, uid, channel, ops)
  )))
}

// In arc-members.ts: after INSERT/DELETE, call:
// MEMBER_CACHE.delete(arcId)  // synchronous purge
```

**3. Mention parser skeleton (server-side):**

```ts
const MENTION_RE = /(?<![\w@])@([a-zA-Z0-9._-]{2,32})/g
const RESERVED = new Set(['everyone', 'here'])
export async function parseMentions(db, arcId, body): Promise<{ resolvedUserIds: string[]; ... }> {
  const candidates = []
  for (const [match, token] of body.matchAll(MENTION_RE)) {
    if (RESERVED.has(token.toLowerCase())) continue
    if (isInsideCodeFence(body, match.index)) continue
    candidates.push(token)
  }
  if (!candidates.length) return { resolvedUserIds: [] }
  const rows = await db.select().from(users)
    .innerJoin(arcMembers, eq(arcMembers.userId, users.id))
    .where(and(eq(arcMembers.arcId, arcId),
      or(inArray(sql`lower(${users.email})`, candidates.map(c => c.toLowerCase())),
         inArray(sql`lower(${users.name})`, candidates.map(c => c.toLowerCase())))))
  return { resolvedUserIds: rows.map(r => r.users.id) }
}
```

**4. Yjs namespace-prefixed top-level keys (in ArcCollabDO):**

The canonical topology is a SINGLE Y.Doc per arc with prefixed
top-level keys — NOT nested Y.Maps and NOT y-partyserver sub-docs.
Each session's prompt is `doc.getText('prompt:' + sessionId)`. See
P6 task 1 for rationale.

```ts
// In arc-collab-do.ts
async onLoad() {
  this.ensureChatTables()  // chat_messages, reactions, submit_ids — see P3
  // hydrate existing Y.Doc snapshot from y_state BLOB
  const rows = this.ctx.storage.sql.exec("SELECT data FROM y_state WHERE id='snapshot'").toArray()
  if (rows.length) Y.applyUpdate(this.document, new Uint8Array(rows[0].data as ArrayBuffer))
  // No nested structure to ensure — keys are created lazily on first edit
  // (e.g., client calls doc.getText('prompt:<sid>') which auto-creates the entry)
}

// Client reads its session's prompt:
const arcDoc = provider.document
const promptText = arcDoc.getText('prompt:' + sessionId) // top-level key, auto-created
const chatDraft = arcDoc.getText('arc:chat-draft')
const arcMeta   = arcDoc.getMap('arc:meta')
```

**5. Comment lock state (broadcast):**

```ts
// In gateway-event-handler.ts — on assistant message start:
broadcastToClients(ctx, { type: 'comment_lock', messageId })
// On stopped/finalize:
broadcastToClients(ctx, { type: 'comment_unlock', messageId })

// Client tracks via a Map<messageId, boolean>; CommentThread reads it.
```

### Gotchas

1. **`broadcastArcRow` ≠ `broadcastArcRoom`** — the existing helper at `lib/broadcast-arc.ts` only fans to the arc's owner's UserSettingsDO (single-user), because today arcs are user-scoped. The new `broadcast-arc-room.ts` fans to ALL `arc_members`. Don't reuse the old one.
2. **D1 migration sequencing.** D1 doesn't allow DDL inside BEGIN/COMMIT. Use `--> statement-breakpoint` separators. Match the 0031/0032 pattern.
3. **SQLite NULL distinct-ness in unique indexes.** P5's `arc_unread` and P1's `arc_members` use composite PKs — no nullable columns. P4's `reactions` PK includes `user_id` which is NOT NULL.
4. **`agent_sessions.visibility` drop is destructive — split via expand-then-contract.** Migration 0034 is EXPAND-ONLY: it adds `arcs.visibility`, backfills, and grants ownership. The destructive `DROP COLUMN agent_sessions.visibility` lives in a SEPARATE migration `0036_drop_session_visibility.sql` deployed AFTER 0034 has been live for at least one full deploy cycle and post-deploy spot checks confirm the backfill. D1 has no DDL transaction, so a single 10-statement migration risks partial application; splitting eliminates the data-loss path. The `migration-test.ts` 0036 case asserts `SELECT COUNT(*) FROM arcs WHERE visibility IS NULL = 0` BEFORE the column is dropped, and refuses to run if not.
5. **DO migration version bump.** P2 adds SessionDO migration v23 (`comments` table). ArcCollabDO migrations start fresh at v1, v2 (chat_messages, reactions) — separate migration ladder.
6. **Yjs topology resolved — single Y.Doc with namespace-prefixed top-level keys.** Decision baked into P6 task 1. We do NOT use y-partyserver sub-docs (their support is underdocumented). We do NOT nest under a `Y.Map` named 'arc' (that's an extra indirection). Each session's prompt is exactly `doc.getText('prompt:' + sessionId)`. The chat draft is `doc.getText('arc:chat-draft')`. Arc-level metadata (future) lives in `doc.getMap('arc:meta')`. This shape is what the hydration in P6 task 3 writes into; tests assert against these paths.
7. **`SessionCollabDOv2 → ArcCollabDOv1` migration.** Lazy hydration on first ArcCollabDO load. Keep legacy DOs readable for 30 days post-cutover. Behind feature flag `ARC_COLLAB_DO_ENABLED` so we can disable at runtime.
8. **Push permission UX.** Capacitor's `requestPermissions()` is one-shot — denied stays denied until user changes OS settings. Lazy-prompt only on user intent (toggle click), not at app launch.
9. **`useArcUnread` cache invalidation.** When server broadcasts `arc_unread_delta`, all client tabs of the same user must update. Use the existing `BroadcastChannel` plumbing in `apps/orchestrator/src/lib/broadcast-session.ts` for cross-tab sync of read state.
10. **Comment-on-deleted-message.** If the assistant message is somehow removed (e.g., resume edge case), the comment row remains but renders 'Message no longer available'. Don't cascade-delete comments on message removal.
11. **FCM rate limit collapse.** When 5/min cap hits, do NOT drop pushes — coalesce into a digest sent at end-of-window: 'You have 7 new messages in <arc>'. The collapse logic lives in `push-delivery.ts`.
12. **Reactions composite PK.** `(target_kind, target_id, user_id, emoji)` — same user can react with multiple distinct emojis on one target, but cannot stack the same emoji.
13. **Member removal preserves attribution.** Removing user A from `arc_members` leaves their comment/chat rows with `author_user_id = 'A'`. UI still resolves the name from `users.id` (Better Auth row not deleted). This is intentional — see B21.

### Reference Docs

- [Cloudflare Agents SDK / PartyKit room model](https://developers.cloudflare.com/agents/) — `ctx.getConnections()` is the room primitive; per-DO fan-out is the existing pattern.
- [y-partyserver](https://github.com/cloudflare/y-partyserver) — Yjs server for PartyServer. Awareness, debounced save, hibernation.
- [Better Auth / D1 + Drizzle](https://www.better-auth.com/docs) — session cookie reading on WS upgrade.
- [Capacitor Push Notifications](https://capacitorjs.com/docs/apis/push-notifications) — Android FCM + iOS APNs registration flow.
- [Capacitor Action Sheet / Bottom Sheet patterns](https://capacitorjs.com/docs/apis/action-sheet) — for the comment thread bottom sheet.
- Research doc: `planning/research/2026-04-27-user-chat-and-comments.md`
- Interview summary: `planning/research/2026-04-30-collab-chat-comments-interview-summary.md`
- Sibling spec (for arc primitives): `planning/specs/116-arcs-first-class-parent.md`
- Sibling spec (for visibility precedent): `planning/specs/68-*` (visibility migration 0020 — file may not exist; check `git log --all -- apps/orchestrator/migrations/0020_visibility.sql`)

---

<!-- Status: approved. Updated 2026-04-30 by /kata-close in PL-98ea-0430. Review score: 91/100 PASS. -->
