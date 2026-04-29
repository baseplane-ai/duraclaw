// ─────────────────────────────────────────────────────────────────────────────
// agent_sessions column audit (issue #7, phase p1)
//
// The pre-migration ProjectRegistry DO (`src/agents/project-registry-migrations.ts`)
// accumulated 23 columns across 12 in-DO migrations. The B-DATA-1 17-column
// minimum is the baseline; this audit decides which of the remaining 6
// ProjectRegistry extras survive into D1 based on whether they are BOTH
// live-written by some DO/sync path AND live-read by some client/API path.
//
// Survives (live-written + live-read):
//   • duration_ms      — written by ProjectRegistry.updateSessionResult,
//                        read by features/agent-orch/SessionHistory.tsx (sort
//                        + cell), components/status-bar.tsx (display).
//   • total_cost_usd   — same write path (updateSessionResult), read by
//                        SessionHistory.tsx, SessionListItem.tsx, status-bar.tsx.
//   • message_count    — SUPERSEDED by `num_turns` in spec #37 (P1a-1);
//                        column dropped from D1 in migration 0016.
//
// Dropped by GH#116 migration 0032 (arcs-first-class):
//   • kata_mode   — replaced by `mode` (renamed; same nullable text shape).
//                   Backfilled from kataMode at migration time.
//   • kata_issue  — replaced by `arc_id` (FK to arcs); arcs carry
//                   externalRef={provider:'github',id:kataIssue} JSON.
//   • kata_phase  — dropped entirely; phase tracking now lives in kata's
//                   internal state.json, not in the D1 row.
//
// Added by GH#116 migration 0032 (arcs-first-class):
//   • arc_id            — FK→arcs.id (CASCADE). NOT NULL is enforced at the
//                         Drizzle/app layer; the DB column is nullable
//                         post-migration because SQLite can't ALTER an
//                         existing column to add NOT NULL without a table
//                         recreate (and the auth `sessions` table owns the
//                         clean name we'd otherwise rename to).
//   • mode              — text, nullable. Backfilled from kata_mode.
//   • parent_session_id — self-FK to agent_sessions.id, nullable. Drizzle
//                         self-reference is omitted (matches user_tabs
//                         pattern); app-layer integrity only.
//
// Net: baseline + audit-retained extensions, with kata-trio replaced by
// arc-graph columns. The spec's "13 extra columns" prose was a worst-case
// estimate; the actual ProjectRegistry DDL only had 6 extras over the baseline.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('user'),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  impersonatedBy: text('impersonated_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    userEndpointUnique: uniqueIndex('push_subscriptions_user_id_endpoint_unique').on(
      t.userId,
      t.endpoint,
    ),
  }),
)

export const fcmSubscriptions = sqliteTable(
  'fcm_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: text('platform').notNull().default('android'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    byUser: index('idx_fcm_user_id').on(t.userId),
    tokenUnique: uniqueIndex('idx_fcm_token').on(t.token),
  }),
)

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // GH#116: parent arc FK. notNull() is enforced at the Drizzle + app
    // layer only — the DB column is nullable (added by migration 0032
    // as `ALTER TABLE ... ADD COLUMN arc_id text` and backfilled, then
    // left nullable because SQLite cannot ALTER an existing column to
    // add NOT NULL without a table recreate, and the auth `sessions`
    // table collision rules out the rename-to-clean-table path
    // (Gotcha #12 + #13). Every code path that writes a session row
    // MUST supply arcId; createSession() auto-creates an implicit arc
    // when the caller doesn't have one.
    arcId: text('arc_id')
      .notNull()
      .references(() => arcs.id, { onDelete: 'cascade' }),
    project: text('project').notNull(),
    status: text('status').notNull().default('running'),
    model: text('model'),
    runnerSessionId: text('runner_session_id'),
    // GH#119 P2: which runner identity owns this session. Populated by
    // the DO at triggerGatewayDial after LRU selection from
    // runner_identities; cleared/blanked when no identity is available
    // (zero-identities fallback). Mirrored to clients via
    // broadcastSessionRow so the UI can surface the active identity.
    identityName: text('identity_name'),
    capabilitiesJson: text('capabilities_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastActivity: text('last_activity'),
    numTurns: integer('num_turns'),
    messageSeq: integer('message_seq').notNull().default(-1),
    prompt: text('prompt'),
    summary: text('summary'),
    title: text('title'),
    // GH#86: provenance for `title` — `'user'` freezes the title (Haiku
    // never overwrites), `'haiku'` allows future retitles, NULL means no
    // title yet (or never auto-titled). Writes happen via the session
    // PATCH handler (sets `'user'`) or the DO's `case 'title_update':`
    // handler (sets `'haiku'`) — never directly from clients.
    titleSource: text('title_source'),
    tag: text('tag'),
    origin: text('origin').default('duraclaw'),
    agent: text('agent').default('claude'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Audit-retained extensions (see header comment for justification):
    durationMs: integer('duration_ms'),
    totalCostUsd: real('total_cost_usd'),
    // GH#116: renamed from kata_mode. Backfilled from kata_mode by
    // migration 0032; nullable text shape preserved.
    mode: text('mode'),
    // GH#116: self-FK for branchArc / parentSessionId tree. Drizzle
    // self-references are awkward to express in the table builder; we
    // omit the explicit `.references()` and rely on app-layer integrity
    // (matches the userTabs.sessionId pattern).
    parentSessionId: text('parent_session_id'),
    // Spec #37 P1a-1: per-session live state mirrored from DO-owned state
    // onto the D1 row so non-active callers (sidebar, history) render
    // uniformly without a DO roundtrip.
    error: text('error'),
    errorCode: text('error_code'),
    // GH#116: PRESERVED — still used for KataStatePanel UI rendering.
    // Only the kataMode/kataIssue/kataPhase trio was dropped.
    kataStateJson: text('kata_state_json'),
    contextUsageJson: text('context_usage_json'),
    // GH#115: FK into worktrees(id). NULL for sessions in read-only
    // kata modes (research, planning, freeform); populated by kata
    // auto-reserve for code-touching modes. Backfilled from the prior
    // (kataIssue, project) tuple by migration 0027.
    worktreeId: text('worktreeId'),
    visibility: text('visibility').notNull().default('public'),
  },
  (t) => ({
    runnerIdUnique: uniqueIndex('idx_agent_sessions_runner_id')
      .on(t.runnerSessionId)
      .where(sql`${t.runnerSessionId} IS NOT NULL`),
    userLastActivity: index('idx_agent_sessions_user_last_activity').on(t.userId, t.lastActivity),
    userProject: index('idx_agent_sessions_user_project').on(t.userId, t.project),
    visibilityLastActivity: index('idx_agent_sessions_visibility_last_activity').on(
      t.visibility,
      t.lastActivity,
    ),
    // GH#116: partial unique on (arcId, mode) WHERE status IN
    // ('idle','pending','running'). Closes the auto-advance idempotency
    // race — two concurrent `stopped` events can no longer spawn
    // duplicate successors for the same (arc, mode) tuple.
    arcModeActive: uniqueIndex('idx_agent_sessions_arc_mode_active')
      .on(t.arcId, t.mode)
      .where(sql`${t.status} IN ('idle','pending','running')`),
  }),
)

/**
 * GH#116: arcs are the durable parent of every session — the
 * orchestrator-side analog of a kata "chain", but expanded to cover
 * orphan/debug/freeform sessions and explicit branch trees. One arc per
 * (userId, externalRef.id) for kata-linked work; one implicit arc per
 * arc-less session.
 *
 * `externalRef` is JSON `{provider, id, url?}` stored as text (D1 has
 * no native JSON type); parsed on read. The unique index on the
 * `(provider, id)` extraction enforces "one arc per GH issue per user"
 * at the DB layer.
 *
 * `worktreeId` is FK into worktrees(id) (table introduced by GH#115's
 * migration 0031). Nullable because read-only arcs (research-only,
 * archived) may have no worktree.
 *
 * `parentArcId` is a self-FK for side arcs created via branchArc.
 * Drizzle handles self-reference via the `() => arcs.id` callback.
 */
export const arcs = sqliteTable(
  'arcs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // JSON: {provider:'github'|'linear'|'plain', id, url?}. Parse on read
    // via parseExternalRef() in lib/arcs.ts.
    externalRef: text('external_ref'),
    // FK→worktrees.id; nullable for arc-less / read-only arcs.
    worktreeId: text('worktree_id').references(() => worktrees.id),
    // Allowed: 'draft'|'open'|'closed'|'archived' (app-layer validation).
    status: text('status').notNull().default('draft'),
    // Self-FK to arcs.id for branchArc parent/child trees. Drizzle's
    // self-reference inside the table builder fights TypeScript's
    // circular-binding inference; we omit the explicit `.references()`
    // and rely on app-layer integrity (matches the userTabs.sessionId
    // pattern at line ~204).
    parentArcId: text('parent_arc_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => ({
    // Expression unique on the (provider, id) tuple inside externalRef
    // — deduplicates GH issue → arc 1:1. Filtered to skip arcs without
    // an externalRef (orphan / draft arcs are unconstrained).
    externalRefUnique: uniqueIndex('idx_arcs_external_ref')
      .on(
        sql`json_extract(${t.externalRef}, '$.provider')`,
        sql`json_extract(${t.externalRef}, '$.id')`,
      )
      .where(sql`${t.externalRef} IS NOT NULL`),
    userStatusActivity: index('idx_arcs_user_status_lastactivity').on(t.userId, t.status),
  }),
)

export const userTabs = sqliteTable(
  'user_tabs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Intentionally NO foreign key to agent_sessions.id — tabs may reference a
    // session that hasn't been synced from the gateway yet (e.g., deep-link
    // pointed at an active-but-undiscovered session). The tab-bar join handles
    // this with a leftJoin that renders a skeleton when the session row is
    // absent. Adding the FK here would reject valid inserts.
    sessionId: text('session_id'),
    position: integer('position').notNull(),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
    // Stringified `TabMeta` JSON (client parses). Carries the rich semantics
    // that the Yjs tab-sync hook previously held in its per-entry value —
    // `kind`, `project`, `issueNumber`, `activeSessionId`. Kept opaque on
    // the server (no server-side predicates) so adding a new meta field is
    // a pure client change.
    meta: text('meta'),
  },
  (t) => ({
    userPosition: index('idx_user_tabs_user_position').on(t.userId, t.position),
    // Partial unique index — see migration 0015. Drizzle's `uniqueIndex`
    // doesn't expose a WHERE clause, so the constraint lives only in the
    // migration SQL; this entry is here for documentation / future-introspection
    // and intentionally a plain `index` so drizzle-kit doesn't try to
    // re-emit it.
    liveSessionUq: index('idx_user_tabs_live_session_uq').on(t.userId, t.sessionId),
  }),
)

/**
 * GH#115: registry over /data/projects/* clones. Decouples worktree
 * reservation from kataIssue so debug, freeform, side-arc, and arc-bound
 * sessions all share one primitive. See planning/specs/115-worktrees-
 * first-class-resource.md §B-SCHEMA-1.
 *
 * `reservedBy` is a JSON blob `{kind: 'arc'|'session'|'manual', id}`
 * and is NULL only when status='free'. `released_at` is set when the
 * row enters the cleanup grace window (B-LIFECYCLE-1).
 */
export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    branch: text('branch'),
    status: text('status').notNull().default('held'),
    reservedBy: text('reservedBy'),
    releasedAt: integer('released_at'),
    createdAt: integer('createdAt').notNull(),
    lastTouchedAt: integer('lastTouchedAt').notNull(),
    ownerId: text('ownerId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    byReservedBy: index('idx_worktrees_reservedBy').on(
      sql`json_extract(${t.reservedBy}, '$.kind')`,
      sql`json_extract(${t.reservedBy}, '$.id')`,
    ),
  }),
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    details: text('details').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    byActionTime: index('idx_audit_action').on(t.action, t.createdAt),
  }),
)

export const userPresence = sqliteTable('user_presence', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstConnectedAt: text('first_connected_at').notNull(),
})

export const projects = sqliteTable('projects', {
  name: text('name').primaryKey(),
  displayName: text('display_name'),
  rootPath: text('root_path').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
  visibility: text('visibility').notNull().default('public'),
  // GH#84: optional per-project display overrides for the tab strip.
  // Both default-NULL → fall back to the auto-derivation in
  // `lib/project-display.ts` (FNV-1a slot hash + regex abbrev). Admins
  // patch via `PATCH /api/projects/:name/customization`. Gateway sync
  // upserts MUST omit these columns from the update set so admin
  // overrides survive a re-sync (same pattern as `visibility`).
  // `abbrev` is constrained client+server-side to `[A-Z0-9]{1,2}`;
  // `colorSlot` is an integer index into `PROJECT_COLOR_SLOTS`
  // (10 slots today). See migration 0032.
  abbrev: text('abbrev'),
  colorSlot: integer('color_slot'),
})

/**
 * GH#86: Generic global feature-flag table.
 *
 * Read at session-spawn time by SessionDO.triggerGatewayDial (cached 5
 * min in-DO). Admin-only CRUD via `/api/admin/feature-flags*`. Flags
 * are global, not per-user. Write semantics: `enabled` is INTEGER
 * (0/1) for SQLite truthiness; `updated_at` is ISO-8601 string.
 */
export const featureFlags = sqliteTable('feature_flags', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
})

/**
 * GH#107 P2: admin-managed catalog of OpenAI Codex models.
 *
 * Read on `triggerGatewayDial` for codex sessions and injected onto
 * the spawn payload as `cmd.codex_models`. CRUD via
 * `/api/admin/codex-models*` (admin role gated). Seeded by migration
 * 0024 with `gpt-5.1` (1M) and `o4-mini` (200k).
 */
export const codexModels = sqliteTable('codex_models', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  contextWindow: integer('context_window').notNull(),
  maxOutputTokens: integer('max_output_tokens'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

/**
 * GH#119 P2: admin-managed catalog of Claude runner identities.
 *
 * Each row maps a logical identity name (e.g. `work1`) to a HOME
 * directory whose `.claude/.credentials.json` carries that identity's
 * auth. The DO picks one via LRU at `triggerGatewayDial` time and
 * passes the derived HOME to the gateway as `runner_home`; the gateway
 * sets `HOME` in the spawn env so the runner picks up the identity-
 * scoped credentials.
 *
 * GH#129: the HOME path is derived at use time as
 * `${env.IDENTITY_HOME_BASE ?? '/srv/duraclaw/homes'}/${name}` rather
 * than stored as an arbitrary admin-supplied string — eliminates the
 * name-vs-path drift foot-gun and centralises the convention in env.
 *
 * Status: `'available'` (selectable), `'cooldown'` (temporarily
 * unavailable, expires lazily via `cooldown_until < datetime('now')`),
 * `'disabled'` (admin-disabled, never selected). CRUD lives at
 * `/api/admin/identities*` (admin-role gated).
 */
export const runnerIdentities = sqliteTable('runner_identities', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull().unique(),
  status: text('status').notNull().default('available'),
  cooldownUntil: text('cooldown_until'),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

/**
 * GH#110 P2: admin-managed catalog of Google Gemini models.
 *
 * Read on `triggerGatewayDial` for gemini sessions and injected onto
 * the spawn payload as `cmd.gemini_models`. CRUD via
 * `/api/admin/gemini-models*` (admin role gated). Seeded by migration
 * 0026 with 5 models.
 */
export const geminiModels = sqliteTable('gemini_models', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  contextWindow: integer('context_window').notNull(),
  maxOutputTokens: integer('max_output_tokens'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * GH#27 P1.1: project metadata for docs-as-Yjs dial-back runners.
 *
 * One row per logical project (16-char SHA-based projectId). Carries
 * the user-supplied `docsWorktreePath` (where the docs runner mounts
 * the project's docs tree) and a `tombstoneGraceDays` retention knob
 * for soft-deleted docs. Created/updated timestamps are ISO-8601
 * strings to match the surrounding `agent_sessions` / `projects`
 * convention. Column names are camelCase (matching the spec's B2 task
 * list shape) — distinct from the older snake_case tables in this
 * file but consistent with how the docs API will surface them.
 */
export const projectMetadata = sqliteTable('projectMetadata', {
  projectId: text('projectId').primaryKey(),
  projectName: text('projectName').notNull(),
  originUrl: text('originUrl'),
  docsWorktreePath: text('docsWorktreePath'),
  tombstoneGraceDays: integer('tombstoneGraceDays').notNull().default(7),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  permissionMode: text('permission_mode').default('default'),
  model: text('model').default('claude-opus-4-6'),
  codexModel: text('codex_model').default('gpt-5.1'),
  maxBudget: real('max_budget'),
  thinkingMode: text('thinking_mode').default('adaptive'),
  effort: text('effort').default('high'),
  // Audit-driven extension to the columnar shape: the legacy KV
  // `hidden_projects` key is live-read by /api/projects and /api/gateway/projects*.
  // Stored as JSON-stringified `string[]` to avoid a separate junction table.
  // Treated as a 7th column on top of the 6-column block in B-DATA-3.
  hiddenProjects: text('hidden_projects_json'),
  chainsJson: text('chains_json'),
  defaultChainAutoAdvance: integer('default_chain_auto_advance', { mode: 'boolean' }).default(
    false,
  ),
  updatedAt: text('updated_at').notNull(),
})
