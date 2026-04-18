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
//   • message_count    — written by ProjectRegistry.syncDiscoveredSessions
//                        (gateway → registry), read by SessionHistory.tsx
//                        (`session.num_turns ?? session.message_count`).
//   • kata_mode        — written by SessionDO.syncKataToRegistry, read by
//                        features/agent-orch/SessionCardList.tsx (badge).
//   • kata_issue       — same write path, read by SessionCardList.tsx.
//   • kata_phase       — same write path, read by SessionCardList.tsx.
//
// Dropped (no live consumer found):
//   • (none — every populated column has at least one client read path).
//
// Net: 17 baseline + 6 extras = 23 columns, matching the current DO DDL minus
// dead-on-arrival fields. The spec's "13 extra columns" prose was a worst-case
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

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    project: text('project').notNull(),
    status: text('status').notNull().default('running'),
    model: text('model'),
    sdkSessionId: text('sdk_session_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastActivity: text('last_activity'),
    numTurns: integer('num_turns'),
    prompt: text('prompt'),
    summary: text('summary'),
    title: text('title'),
    tag: text('tag'),
    origin: text('origin').default('duraclaw'),
    agent: text('agent').default('claude'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Audit-retained extensions (see header comment for justification):
    durationMs: integer('duration_ms'),
    totalCostUsd: real('total_cost_usd'),
    messageCount: integer('message_count'),
    kataMode: text('kata_mode'),
    kataIssue: integer('kata_issue'),
    kataPhase: text('kata_phase'),
  },
  (t) => ({
    sdkIdUnique: uniqueIndex('idx_agent_sessions_sdk_id')
      .on(t.sdkSessionId)
      .where(sql`${t.sdkSessionId} IS NOT NULL`),
    userLastActivity: index('idx_agent_sessions_user_last_activity').on(t.userId, t.lastActivity),
    userProject: index('idx_agent_sessions_user_project').on(t.userId, t.project),
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
  },
  (t) => ({
    userPosition: index('idx_user_tabs_user_position').on(t.userId, t.position),
  }),
)

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  permissionMode: text('permission_mode').default('default'),
  model: text('model').default('claude-opus-4-6'),
  maxBudget: real('max_budget'),
  thinkingMode: text('thinking_mode').default('adaptive'),
  effort: text('effort').default('high'),
  // Audit-driven extension to the columnar shape: the legacy KV
  // `hidden_projects` key is live-read by /api/projects and /api/gateway/projects*.
  // Stored as JSON-stringified `string[]` to avoid a separate junction table.
  // Treated as a 7th column on top of the 6-column block in B-DATA-3.
  hiddenProjects: text('hidden_projects_json'),
  updatedAt: text('updated_at').notNull(),
})
