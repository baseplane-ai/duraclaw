#!/usr/bin/env tsx
/**
 * export-do-state.ts — issue #7 cutover (B-DATA-1).
 *
 * Run AGAINST THE PRE-CUTOVER DEPLOYMENT to capture state, then apply the
 * generated SQL via:
 *
 *   wrangler d1 execute duraclaw-auth --remote --file=export.sql
 *
 * against the post-cutover DB. The script reads JSON dumps from stdin and
 * emits idempotent INSERT … ON CONFLICT DO UPDATE statements to stdout.
 *
 * ── Operator workflow ─────────────────────────────────────────────────
 *
 * The deployed Worker doesn't expose a single "dump every DO" endpoint
 * (deliberately — DO state is per-instance and there's no enumeration API).
 * Producing the JSON dump is therefore a manual two-step on the operator:
 *
 *   1. ProjectRegistry rows. From the pre-cutover branch, hit the existing
 *      session list/search endpoints OR add a temporary admin route that
 *      calls registry.searchSessions() with a wide query and serialises the
 *      result. Save the array as `registry.json`.
 *
 *   2. UserSettings rows. Pre-p3, the legacy DO held `state.tabs` and
 *      `state.preferences`. From the pre-p3 branch, hit
 *        GET /api/user-settings/tabs
 *        GET /api/preferences
 *      for each user (iterate `users` table from D1). Aggregate into a
 *      `settings.json` of shape:
 *        { userId: string, tabs: UserTabRow[], preferences: UserPreferencesRow }[]
 *
 * Then pipe the combined dump to this script:
 *
 *   cat dump.json | pnpm tsx scripts/export-do-state.ts > export.sql
 *
 * Expected stdin shape:
 *
 *   {
 *     "agent_sessions": AgentSessionRow[],
 *     "user_tabs":      UserTabRow[],
 *     "user_preferences": UserPreferencesRow[]
 *   }
 *
 * Drafts are NOT migrated (per spec non-goals). Anything outside the three
 * arrays above is silently ignored so the script tolerates partial dumps.
 *
 * The SQL output is safe to re-run: each statement uses ON CONFLICT to
 * UPDATE in place. agent_sessions conflicts are keyed on `id` (the PK — so
 * NULL sdk_session_id rows still upsert deterministically); user_tabs on
 * (id) and user_preferences on (user_id).
 */

import { readFileSync } from 'node:fs'

interface AgentSessionDump {
  id: string
  user_id: string
  project: string
  status: string
  model: string | null
  sdk_session_id: string | null
  created_at: string
  updated_at: string
  last_activity: string | null
  num_turns: number | null
  prompt: string | null
  summary: string | null
  title: string | null
  tag: string | null
  origin: string | null
  agent: string | null
  archived: number | boolean
  duration_ms: number | null
  total_cost_usd: number | null
  message_count: number | null
  kata_mode: string | null
  kata_issue: number | null
  kata_phase: string | null
}

interface UserTabDump {
  id: string
  user_id: string
  session_id: string | null
  position: number
  created_at: string
}

interface UserPreferencesDump {
  user_id: string
  permission_mode: string | null
  model: string | null
  max_budget: number | null
  thinking_mode: string | null
  effort: string | null
  hidden_projects_json: string | null
  updated_at: string
}

interface DumpShape {
  agent_sessions?: AgentSessionDump[]
  user_tabs?: UserTabDump[]
  user_preferences?: UserPreferencesDump[]
}

function sqlEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  // String — single-quote-escape per SQLite/D1 rules.
  return `'${String(value).replace(/'/g, "''")}'`
}

function emitAgentSessions(rows: AgentSessionDump[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    const cols = [
      'id',
      'user_id',
      'project',
      'status',
      'model',
      'sdk_session_id',
      'created_at',
      'updated_at',
      'last_activity',
      'num_turns',
      'prompt',
      'summary',
      'title',
      'tag',
      'origin',
      'agent',
      'archived',
      'duration_ms',
      'total_cost_usd',
      'message_count',
      'kata_mode',
      'kata_issue',
      'kata_phase',
    ]
    const vals = [
      sqlEscape(r.id),
      sqlEscape(r.user_id),
      sqlEscape(r.project),
      sqlEscape(r.status),
      sqlEscape(r.model),
      sqlEscape(r.sdk_session_id),
      sqlEscape(r.created_at),
      sqlEscape(r.updated_at),
      sqlEscape(r.last_activity),
      sqlEscape(r.num_turns),
      sqlEscape(r.prompt),
      sqlEscape(r.summary),
      sqlEscape(r.title),
      sqlEscape(r.tag),
      sqlEscape(r.origin),
      sqlEscape(r.agent),
      sqlEscape(typeof r.archived === 'boolean' ? (r.archived ? 1 : 0) : r.archived),
      sqlEscape(r.duration_ms),
      sqlEscape(r.total_cost_usd),
      sqlEscape(r.message_count),
      sqlEscape(r.kata_mode),
      sqlEscape(r.kata_issue),
      sqlEscape(r.kata_phase),
    ]
    // ON CONFLICT(id) — keyed on the primary key so re-running the script is
    // deterministic even for rows where sdk_session_id IS NULL. We previously
    // keyed on sdk_session_id, but SQL's NULL ≠ NULL means a NULL row would
    // bypass the upsert and hit a PRIMARY KEY violation on `id` instead.
    // sdk_session_id is still written as a regular column value (and updated
    // from excluded on subsequent runs).
    const updateAssignments = cols
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')
    out.push(
      `INSERT INTO agent_sessions (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${updateAssignments};`,
    )
  }
  return out
}

function emitUserTabs(rows: UserTabDump[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    const cols = ['id', 'user_id', 'session_id', 'position', 'created_at']
    const vals = [
      sqlEscape(r.id),
      sqlEscape(r.user_id),
      sqlEscape(r.session_id),
      sqlEscape(r.position),
      sqlEscape(r.created_at),
    ]
    const updateAssignments = cols
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')
    out.push(
      `INSERT INTO user_tabs (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${updateAssignments};`,
    )
  }
  return out
}

function emitUserPreferences(rows: UserPreferencesDump[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    const cols = [
      'user_id',
      'permission_mode',
      'model',
      'max_budget',
      'thinking_mode',
      'effort',
      'hidden_projects_json',
      'updated_at',
    ]
    const vals = [
      sqlEscape(r.user_id),
      sqlEscape(r.permission_mode),
      sqlEscape(r.model),
      sqlEscape(r.max_budget),
      sqlEscape(r.thinking_mode),
      sqlEscape(r.effort),
      sqlEscape(r.hidden_projects_json),
      sqlEscape(r.updated_at),
    ]
    const updateAssignments = cols
      .filter((c) => c !== 'user_id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')
    out.push(
      `INSERT INTO user_preferences (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` +
        `ON CONFLICT(user_id) DO UPDATE SET ${updateAssignments};`,
    )
  }
  return out
}

function main(): void {
  // Read JSON from stdin (or a file path passed as the first argv).
  const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
  let dump: DumpShape
  try {
    dump = JSON.parse(input) as DumpShape
  } catch (err) {
    process.stderr.write(
      `[export-do-state] could not parse stdin as JSON: ${err instanceof Error ? err.message : err}\n`,
    )
    process.exit(1)
    return
  }

  const lines: string[] = [
    '-- Generated by scripts/export-do-state.ts (#7 p6 cutover).',
    '-- Apply with: wrangler d1 execute duraclaw-auth --remote --file=export.sql',
    'BEGIN TRANSACTION;',
  ]

  if (Array.isArray(dump.agent_sessions)) lines.push(...emitAgentSessions(dump.agent_sessions))
  if (Array.isArray(dump.user_tabs)) lines.push(...emitUserTabs(dump.user_tabs))
  if (Array.isArray(dump.user_preferences))
    lines.push(...emitUserPreferences(dump.user_preferences))

  lines.push('COMMIT;')
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
