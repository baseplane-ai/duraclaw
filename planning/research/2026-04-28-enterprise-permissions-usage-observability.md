---
date: 2026-04-28
topic: Enterprise-grade permissions, usage tracking, and observability for Duraclaw
type: feasibility + library-eval hybrid
status: complete
github_issue: null
items_researched: 8
---

# Research: Enterprise-grade permissions, usage tracking, and observability

## Context

Duraclaw orchestrates Claude Code sessions across CF Workers + Durable Objects + a VPS gateway/runner system. Today the product is single-user-shaped: every resource is owned by one `userId`, there's a binary `user`/`admin` role, an `audit_log` table sits empty, the Claude SDK's per-tool permission API is unused, cache tokens are discarded, and there's no metrics/traces/RUM anywhere. To serve "enterprise" — defined by the asker as **anything from a 3-person team to a 200-person engineering department** — we need three new pillars working together: multi-tenant permissions, per-(org, user, key, model) usage tracking with quotas, and ops-grade observability.

This research scopes the work, evaluates the library/architecture options for each pillar, and produces a unified phased roadmap.

## Scope

**Items deep-dived (parallel Explore agents):**

1. Org/team data model & ownership migration
2. RBAC architecture & enforcement (incl. SDK tool-level permissions)
3. SSO / SAML / OIDC / SCIM
4. Audit log productionization
5. Usage ledger + cost attribution
6. Quota & rate-limit enforcement
7. Observability stack — logs/metrics/traces
8. Cost dashboards + admin UI

**Customer assumption:** team-grade for orgs from 3 to 200 users. Foundation must work for both. Multi-tenant orgs are first-class from day 1.

## Current state — situational map

| Pillar | What exists | Critical gap |
|---|---|---|
| **Auth foundation** | Better Auth + D1 (Drizzle), email+password, `bearer()` + `capacitor()` plugins, sessions with `impersonatedBy` already in schema | No social login, no MFA, no SSO |
| **Permissions / RBAC** | Single `role` column (user/admin), public/private visibility flags on sessions+projects (spec #68 P1 done), admin-override on access | No org/team concept, no granular RBAC, no resource ACLs, SDK permission mode is global per-session |
| **Audit** | `audit_log` table exists in schema (lines 238–252) | **Zero writers anywhere in the codebase** |
| **Resource ownership** | `userId` FK on `agent_sessions`, `projects`, `worktree_reservations`, `user_preferences` | Everything is single-owner, no shared ownership |
| **Usage tracking** | `agent_sessions.totalCostUsd` + `numTurns` per session, updated from SDK `result` events | Cache tokens emitted by SDK but **discarded**; no per-user/org rollups; `org_id` plumbed through CAAM as metadata only, never aggregated |
| **Quotas** | `user_preferences.max_budget` enforced reactively at turn level | No pre-spawn gates, no concurrent-session caps, no fairness across runners on shared keys |
| **Observability — logs** | Per-DO `event_log` SQLite (7-day retention, 4 tags: gate/conn/rpc/reap), runner stdout to `/run/duraclaw/sessions/{id}.log`, gateway plain console | No Logpush, no cross-session aggregation, no log shipping from VPS |
| **Observability — metrics** | docs-runner has 5 plain counters (metrics.ts) | Zero metrics for Worker, DO, gateway, session-runner, frontend |
| **Observability — traces** | None | A single user message crosses 6 hops invisibly |
| **Frontend telemetry** | None (test files only) | No RUM, no error tracking, no product analytics |
| **Health probes** | Gateway `/health`, docs-runner `/health` | No orchestrator `/health`, no DO liveness |

## Findings

### 1. Org/team data model

**Recommendation: GitHub/Vercel-style personal-org pattern.** Every user gets an auto-created personal org on signup; team orgs are explicit. Zero breaking changes for existing users.

**Schema additions** (`apps/orchestrator/src/db/schema.ts`):

```typescript
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),                    // 'org-' + nanoid(12)
  name: text('name').notNull(),
  slug: text('slug').notNull(),                   // unique, used in URLs
  ownerId: text('owner_id').notNull().references(() => users.id),
  type: text('type').notNull().default('team'),   // 'personal' | 'team'
  maxUsers: integer('max_users'),                 // null = unlimited
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),                  // soft-delete
}, (t) => ({
  slugUnique: uniqueIndex('idx_org_slug').on(t.slug),
  byOwner: index('idx_org_owner_id').on(t.ownerId),
}))

export const organizationMembers = sqliteTable('organization_members', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'), // 'owner' | 'admin' | 'member' | 'viewer'
  joinedAt: text('joined_at').notNull(),
}, (t) => ({
  orgUserUnique: uniqueIndex('idx_org_user_unique').on(t.organizationId, t.userId),
}))

export const organizationInvites = sqliteTable('organization_invites', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  email: text('email').notNull(),
  invitedBy: text('invited_by').notNull(),
  role: text('role').notNull().default('member'),
  token: text('token').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  acceptedAt: text('accepted_at'),
  createdAt: text('created_at').notNull(),
})
```

**Migration plan** (Option A — recommended):

1. Migration 0021: create three tables; add `organization_id TEXT DEFAULT ''` to `agent_sessions`, `projects`, `worktree_reservations`, `user_preferences`, `projectMetadata`.
2. Post-deploy backfill: for each user, create a personal org (`type='personal'`, slug derived from email local-part with collision suffix). Insert membership row (owner). Backfill all resources to their owner's personal org.
3. Auth middleware: on login, ensure user has personal org (lazy-create for any user that missed step 2).
4. Set `users.currentOrgId` to personal org by default.

**URL routing** — switch to `/orgs/:orgSlug/projects/:projectSlug`. Add legacy redirect `/projects/:name` → personal-org URL.

**DO topology** — keep per-session DO model unchanged. Stamp `org_id` on every event payload. **Do not** introduce `OrgDO` for member cache (D1 is fast enough; cache invalidation is the harder problem).

**Better Auth Organization plugin decision:** **enable it.** Plugin v1.5+ schema is compatible with custom Drizzle tables if we mirror its column names. Saves invite/role logic. Agent #1 argued against; agent #2 argued for; the plugin's invite-token + role-change hooks save real time and ship audit hooks for free. Migration cost is one-time naming alignment, not ongoing friction.

---

### 2. RBAC architecture & enforcement

**Recommendation: Better Auth Organization plugin + custom `org_role_permissions` Drizzle table for resource ACLs.**

Avoid OpenFGA, Cerbos, Oso for our scale (10–200 users per org) — operational overhead exceeds benefit. Custom + plugin keeps everything in CF Workers in-process, sub-2ms eval latency, $0 marginal cost.

**Comparison:**

| Engine | Storage | Eval latency | CF Workers | $/month @ 100 users | DX |
|---|---|---|---|---|---|
| **Better Auth Org + custom table** | D1 SQLite | <2ms in-process | ✓ Native | $0 | Excellent — extends existing auth |
| OpenFGA | PostgreSQL/Etcd | 2–10ms (network) | ✗ External sidecar | $500–2k SaaS | Powerful ReBAC, but heavyweight |
| Cerbos | YAML files + cache | <5ms in-process | ✗ Sidecar | $0 OSS + ops | Good for complex policies, overkill here |
| Oso Cloud | Managed | <2ms cached | ✗ External API | $2k+ SaaS | Best DX, vendor lock-in |
| Pure custom | D1 + middleware | <2ms | ✓ Native | $0 | DIY, transparent |

**Layered enforcement plan:**

| Layer | Where | What it checks |
|---|---|---|
| **L1** Worker middleware | `apps/orchestrator/src/api/auth-middleware.ts:14-29` | Session valid + `orgId` + `orgRole` stamped onto context |
| **L2** SessionDO RPC | `apps/orchestrator/src/agents/session-do/rpc-gates.ts:29-96` | Action allowed for this `(orgRole, resource_type)` |
| **L3** Gateway `/sessions/start` | `apps/orchestrator/src/api/index.ts:2300` | Org member + within budget + tool policy attached |
| **L4** SDK `canUseTool` | `packages/session-runner/src/claude-runner.ts:70-84` (NEW) | Per-tool allow/deny stamped at spawn (immutable) |

**Default permission matrix** (3 roles × ~16 actions):

| Action | org_admin | member | viewer |
|---|---|---|---|
| Project read/write | ✓ | ✓ (own) | read-only |
| Project delete | ✓ | ✗ | ✗ |
| Session spawn | ✓ | ✓ | ✗ |
| Session read transcript | ✓ | ✓ (own + public) | public only |
| Session send message | ✓ | ✓ (own) | ✗ |
| Session kill / fork / share | ✓ | ✓ (own) | ✗ |
| Worktree claim | ✓ | ✓ | ✗ |
| Worktree force-takeover | ✓ | ✗ | ✗ |
| Org invite + role change | ✓ | ✗ | ✗ |
| Manage billing / API keys | ✓ | ✗ | ✗ |
| Audit log read | ✓ | ✗ | ✗ |

**SDK tool-level permissions — the missing layer.** The Claude Agent SDK supports `canUseTool(toolName, input) → 'allow'|'deny'|'ask'` and `allowedTools[]`. Today neither is wired. The fix:

```typescript
// Stamp at spawn time, immutable for the session
const orgRole = ctx.state.orgRole          // from JWT
const toolPolicy = ORG_TOOL_POLICIES[orgRole]  // {viewer: ['Read','Glob'], member: [...]}
command.allowed_tools = toolPolicy
```

**Sensitive-tool approval workflow** — extend existing `PermissionRequestEvent` (shared-types:444). When viewer tries `Bash`, SessionDO promotes to gate, broadcasts to org_admin (push notification), awaits approval, audits the decision.

**Permission caching** — stamp `orgId` + `orgRole` into Better Auth session token on login; refresh on org-change event. SessionDO maintains 60s TTL in-memory cache for `(userId → orgRole, allowedTools)`.

---

### 3. SSO / SAML / OIDC / SCIM

**Recommendation: defer until first enterprise customer asks. Then WorkOS.**

For 3-50 user orgs, email+password + Better Auth's 2FA plugin covers the demand. Building SSO speculatively is expensive (4-6 weeks DIY via Better Auth SSO/SCIM plugins, or $125/connection/month for WorkOS) with little near-term return.

**Tier table:**

| Feature | Small (3-15) | Mid (30-100) | Large (100-200+) |
|---|---|---|---|
| Email+password | ✓ | ✓ (fallback admin) | ✗ |
| SAML 2.0 | ✗ | ✓ | ✓ |
| OIDC | ✗ | optional | ✓ |
| JIT provisioning | ✗ | ✓ | ✓ |
| SCIM 2.0 | ✗ | wanted | ✓ non-negotiable |
| MFA via IdP | ✗ | ✓ | ✓ |
| Session policies | ✗ | ✗ | ✓ |

**Vendor comparison @ 50 / 500 users:**

| Vendor | SAML | SCIM | $@50 | $@500 | Time-to-integrate |
|---|---|---|---|---|---|
| Better Auth SSO+SCIM plugins | ✓ | ✓ (beta) | $0 | $0 | 4-6 weeks |
| **WorkOS** | ✓ | ✓ | $125-250/mo | $125-500/mo | **2-3 days** |
| Stytch B2B | ✓ | ✓ | $0 (5 free) → $125/conn | $125/conn | 3-5 days |
| Clerk Pro | ✓ | roadmap | $75/conn | $75/conn | 2-3 days |
| Okta CIC | ✓ | ✓ | $3000/mo min | $3000/mo min | 6-8 weeks |
| Keycloak self-host | ✓ | ⚠ community | $0 + ops | $0 + ops | 4-8 weeks |

**Migration path (when SSO lands):**
- Add `users.sso_provider` (nullable; null = email+password).
- Add `organizations.sso_enforced` + `sso_provider_id`.
- Reserve a per-org admin user as lockout safety; SCIM provisioning must never delete the org_admin.
- WorkOS handles SAML/OIDC externally; webhooks upsert to `users` + audit_log. No Better Auth plugin required.

**MFA today** — Better Auth 2FA plugin (`@better-auth/2fa`): TOTP, backup codes, trusted devices. ~3 days to integrate. Should ship in Phase 5 alongside admin UI, before SSO.

**Capacitor consideration** — bearer-token flow already works; SSO via SFSafariViewController (iOS) requires `ASWebAuthenticationSession` for IdP cookie sharing. Test early.

---

### 4. Audit log productionization

**Recommendation: schema upgrade + tag-based promotion from `event_log` + sync writes for high-value actions.**

The existing `audit_log` table (5 columns) is too thin for compliance. Upgrade:

```typescript
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: text('org_id').notNull(),
  actorUserId: text('actor_user_id'),
  actorType: text('actor_type').notNull(),       // 'user' | 'system' | 'api_key'
  actorIpAddress: text('actor_ip_address'),
  actorUserAgent: text('actor_user_agent'),
  action: text('action').notNull(),               // 'session_spawned', 'role_changed', ...
  actionOutcome: text('action_outcome').notNull().default('success'),
  targetType: text('target_type'),                // 'session' | 'project' | ...
  targetId: text('target_id'),
  targetOldValue: text('target_old_value'),       // JSON, before-state
  targetNewValue: text('target_new_value'),       // JSON, after-state
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  previousRowHash: text('previous_row_hash'),     // optional hash-chain
}, (t) => ({
  orgCreated: index('idx_audit_org_created').on(t.orgId, t.createdAt),
  targetTypeId: index('idx_audit_target_type_id').on(t.targetType, t.targetId),
  actorUser: index('idx_audit_actor_user_id').on(t.actorUserId, t.createdAt),
}))
```

**Event taxonomy (~25 actions):**

| Category | Actions | Sync? |
|---|---|---|
| Auth | login, login_failed, logout, password_reset, sso_login, mfa_enrolled | sync |
| Org | org_created, member_invited, member_joined, member_role_changed, member_removed | sync |
| Resource | project_created/deleted, session_spawned/killed, session_shared, session_forked, worktree_claimed/forced | sync (mostly) |
| Billing/keys | api_key_created/revoked, plan_changed, claude_key_rotated | async via CF Queue |
| Permissions | permission_denied, permission_granted, role_assigned | async via tag promotion |
| Sensitive tool use | bash_with_sudo, file_write_outside_project | async |

**Relationship to per-DO `event_log`:** **don't dual-write at source.** Tag-based promotion: a background task (cron or queue consumer) reads `event_log` rows tagged `gate` with resolved metadata and inserts a single audit_log row per decision. Decouples ephemeral debugging logs from compliance.

**Retention strategy:**
- D1 hot tier: 180 days default (admin-configurable: 90 / 180 / 365).
- Weekly cron exports older rows to R2 as Parquet (compressed ~50%, immutable retention).
- Cost projection: 1000 events/day × 1 year × 5 KB = 1.8 GB hot D1 (well within tier); R2 archive ~$0.50/year.

**Query API:**
```
GET /api/admin/audit-logs?org_id=X&since=ISO&action=Y&limit=100&cursor=opaque
POST /api/admin/audit-logs/export → signed R2 URL (CSV/JSON)
```

**SOC2-adjacent discipline:** never log raw tokens / full prompts / credentials. Redact via `sanitizeAuditMetadata()` helper before insert. Defer hash-chain immutability to Phase 6 (paranoia tier).

---

### 5. Usage ledger + cost attribution

**Recommendation: build, don't buy. Per-turn ledger, multi-provider cost computation, async write-through with CF Queue.**

**Why build over Anthropic Admin API:** Admin API is per-key aggregate only — no session/user/turn breakdown. Daily batch delay. We need live granularity for quotas and dashboards. Use Admin API for monthly reconciliation only.

**Schema:**

```typescript
export const usageLedger = sqliteTable('usage_ledger', {
  id: text('id').primaryKey(),                     // ulid()
  orgId: text('org_id'),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  runnerSessionId: text('runner_session_id'),
  claudeKeyId: text('claude_key_id'),              // CAAM key registry
  keyOwner: text('key_owner'),                     // 'user' | 'org' | 'platform'
  model: text('model').notNull(),
  provider: text('provider').notNull(),            // 'anthropic' | 'openai' | 'gemini'
  turnSeq: integer('turn_seq').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),    // NEW
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0), // NEW
  totalTokens: integer('total_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull(),
  costCurrency: text('cost_currency').notNull().default('USD'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
  metadataJson: text('metadata_json'),
}, (t) => ({
  orgStarted: index('idx_usage_ledger_org_started').on(t.orgId, t.startedAt),
  userStarted: index('idx_usage_ledger_user_started').on(t.userId, t.startedAt),
  sessionId: index('idx_usage_ledger_session_id').on(t.sessionId),
  keyStarted: index('idx_usage_ledger_claude_key_id_started').on(t.claudeKeyId, t.startedAt),
}))

export const modelPricing = sqliteTable('model_pricing', { /* model, provider, *_per_mtok, effective_from/to */ })
export const usageDailyOrg = sqliteTable('usage_daily_org', { /* org_id, date, model, provider, totals */ })
export const usageDailyUser = sqliteTable('usage_daily_user', { /* same shape */ })
```

**Cache token capture — the small fix that everyone is forgetting.** SDK emits them; we discard them. Required changes:

```typescript
// packages/shared-types/src/index.ts — extend WireContextUsage
cache_read_input_tokens?: number
cache_creation_input_tokens?: number

// packages/session-runner/src/claude-runner.ts — capture from SDK Message.usage
const usage = sdkMessage?.usage
const contextUsage: WireContextUsage = {
  ...existing,
  cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
}
```

Without this, every cost number is wrong by 25–90% (cache reads are 90% cheaper, cache creation is 25% premium — both meaningfully different from regular input).

**Multi-provider cost computation:**

| Provider | Token source | Cost model |
|---|---|---|
| **Anthropic** | `Message.usage` | Native `total_cost_usd` from ResultEvent; assign directly |
| **OpenAI (Codex)** | `turn.completed.usage` | Token count × `model_pricing` lookup, computed in DO |
| **Google (Gemini)** | `result.stats.models` | Token count × `model_pricing` lookup, computed in DO |

**Write path:**
1. Runner emits `ResultEvent` with `context_usage` and (Anthropic only) `total_cost_usd`.
2. SessionDO's `handleGatewayEvent('result')` calls `writeUsageLedger(ctx, event)` after existing message broadcast.
3. Ledger writer enqueues to CF Queue (fire-and-forget via `ctx.waitUntil`).
4. Queue consumer writes to D1 with retry + idempotency on `(sessionId, turnSeq)`.
5. Same writer upserts daily rollup tables (`usage_daily_org`, `usage_daily_user`) for fast dashboards.

**BYO-key vs shared-key:** `keyOwner='user'` lifts org/shared-key TPM gates but keeps concurrent-session caps. Detected via `user_preferences.anthropic_api_key` presence.

**Stripe Metering bridge (Phase 6):** ledger rows are meter events. After D1 insert, optionally `stripe.billing.meterEvents.create({event_name, customer, value, timestamp, identifier: row.id})`. Add `users.stripe_customer_id`.

---

### 6. Quota & rate-limit enforcement

**Recommendation: layered quotas with pre-spawn DO gate + live overage watchdog. Defer `OrgQuotaDO` and `KeyDispatcherDO` until v2/v3.**

**Quota types:**

| Type | Scope | Where enforced | Hard/soft | Default |
|---|---|---|---|---|
| Per-org monthly USD | org | DO `spawnImpl` pre-flight | hard @ 100%, soft @ 80% email | $500/mo |
| Per-user daily USD | user | DO `spawnImpl` + per-turn check | hard @ 100%, soft @ 80% | $50/day |
| Concurrent active sessions | org / user | DO `spawnImpl` (D1 count) | hard | 10/org, 3/user |
| Tokens-per-minute per key | CAAM key | gateway `/sessions/start` (Phase 2) | hard, queue | 400K TPM |
| Tools per session | session | runner local counter + DO interrupt | hard | 50 |

**Pre-spawn budget gate:**

```typescript
// In rpc-lifecycle.ts:spawnImpl, before triggerGatewayDial
const budgetGate = await assertWithinBudget(ctx, config)
if (!budgetGate.ok) {
  return {
    ok: false,
    error: budgetGate.reason,
    quota_remaining_usd: budgetGate.remainingUsd,
    quota_percent_used: budgetGate.percentUsed,
  }
}
```

`assertWithinBudget` checks org monthly cap (D1 daily rollup join), user daily cap (rolling 24h ledger sum), concurrent-session count (D1). Sub-50ms with proper indexes.

**Live overage watchdog** — extend `watchdog.ts:runAlarm()` to compare `total_cost_usd` to `max_budget_usd` every 30s; if exceeded, send `interrupt` GatewayCommand and flip status to `error`.

**Token-bucket fairness across CAAM keys (v2):** introduce `KeyDispatcherDO` keyed by Claude profile. Bucket state in DO storage. Refill on resets_at from rate_limit events. Pre-spawn check consumes estimated tokens; gate spawn if no profile has capacity.

**Rate-limit telemetry** — every 429 emits to observability + writes audit_log row. UI surfaces transient banner.

**Email warnings** — at 80% threshold, scheduled worker (CF cron) sends one email per period. At 100%, hard block + immediate notification.

**v1 defaults** — pure SessionDO + D1 lookups. No new DOs. Acceptable latency for the small-team scale.

---

### 7. Observability stack

**Recommendation: OpenTelemetry self-hosted on the existing VPS (Loki + Tempo + Grafana). PostHog free tier for frontend RUM.**

**Comparison @ 100 users, 50K events/day, 10K spans/day:**

| Stack | Logs | Metrics | Traces | $/mo | Lock-in | Setup |
|---|---|---|---|---|---|---|
| CF-native (Logpush+Analytics Engine) | ✓ R2 archive | ✓ custom datasets | ⚠ Workers Trace Events status unclear | ~$15 | Medium | Low |
| **OTEL self-host (Loki+Tempo+Grafana)** | ✓ OTLP → Loki | ✓ Prometheus/OTLP | ✓ Tempo, full distributed | **~$50** | **None** | **Medium** |
| Datadog/Honeycomb/New Relic | ✓ | ✓ | ✓ | $200-600 | High | Very Low |

**Why OTEL self-host wins for Duraclaw:** distributed traces across Worker → DO → VPS → Claude API are the unique pain point. CF-native loses the trace story. Managed APM is 4-12x more expensive at our scale and locks us in. We already have a VPS (a 2-vCPU instance covers Loki + Tempo + Grafana with headroom). Owns the data. Compliance-friendly.

**Distributed trace propagation** (W3C traceparent end-to-end):

```
Browser generates traceparent (crypto.randomUUID)
  → POST /api/sessions/:id/messages [X-Trace-Parent header]
    → Worker middleware extracts, emits [worker-api.messages] span
      → DO RPC with traceId in context, emits [do-handle-message] span
        → Gateway HTTP /sessions/start [X-Trace-Parent], emits [gateway-spawn] span
          → Runner spawned with trace-id in env, emits [runner-execute] span
            → SDK adapter wraps Claude API call, emits [claude-api] span
            ← response
          ← runner WS reply with trace-id in frame header
        ← DO emits [do-broadcast] span
      ← Worker → browser response
    ← browser emits [message-receive] span
```

**Per-DO `event_log` decision: keep and augment.** Local SQLite is fast (no I/O wait), durable, and already wired into 10+ call sites. Add Logpush every hour for cross-session aggregation; dual-export to OTEL Loki on `getEventLog()` RPC call. Don't replace.

**Metrics catalog (~15 metrics):**

| Metric | Type | Emitter | Why |
|---|---|---|---|
| worker_request_duration_ms | histogram | Worker | latency SLO |
| worker_d1_query_duration_ms | histogram | Worker | D1 contention |
| do_message_count | gauge | SessionDO | session size |
| do_ws_disconnect_reason | counter | SessionDO | abnormal closes |
| do_gate_open_duration_ms | histogram | SessionDO | user wait time |
| do_runner_dial_failure | counter | SessionDO | spawn health |
| gateway_spawn_duration_ms | histogram | Gateway | spawn latency |
| gateway_inflight_runners | gauge | Gateway | saturation |
| gateway_reaper_kill_count | counter | Gateway | reap pattern |
| runner_sdk_turn_duration_ms | histogram | Runner | core SLO |
| runner_claude_api_latency_ms | histogram | Runner | API vs SDK overhead |
| runner_tool_invocation_count | counter | Runner | tool usage |
| runner_queue_drop_overflow | counter | Runner | BufferedChannel overflow |
| frontend_session_start_to_first_token_ms | histogram | Browser | user-facing SLO |
| frontend_route_change_duration_ms | histogram | Browser | navigation perf |

**Frontend RUM: PostHog free tier as default, CF Web Analytics as free baseline.** PostHog covers TanStack Router route-change instrumentation, session replay, LLM observability plugin auto-parses Claude API. ~1k events/day → free tier covers indefinitely. Sentry as escape hatch if error tracking dominates.

**Health probes** — add `getHealth()` RPC to SessionDO, enhance gateway `/health` with saturation signal (reaper-last-run, inflight count, spawn-p95), add aggregated `/api/admin/health` endpoint.

**Alerting** — Grafana AlertManager (free) → Slack webhook for v1; PagerDuty ($15-30/mo) when on-call rotation matters.

**Total stack cost @ 100 users: ~$50/mo** (VPS compute) vs $200-600/mo for managed APM. ~60-80h engineering effort.

---

### 8. Cost dashboards + admin UI

**Recommendation: Recharts + TanStack Table. Org admin UI scaffolded under `/_authenticated/admin/` with TanStack Router `beforeLoad` gating.**

**Existing admin UI inventory:**

| Route | Purpose |
|---|---|
| `/admin/users` | Global user list (Better Auth admin client) |
| `/admin/codex-models` | OpenAI Codex catalog CRUD |
| `/admin/gemini-models` | Gemini catalog CRUD |
| `/admin/feature-flags` | (API only, no route yet) Global flags |

Pattern: runtime gate (`session.role !== 'admin'` → redirect), Radix UI + sonner, useState forms.

**Charting library: Recharts** (~35KB gzip — smallest viable). Tremor/visx/nivo evaluated; Recharts wins on bundle size + accessibility + composability with Radix. Upgrade to Tremor later if design polish becomes a bottleneck.

**Tabular: TanStack Table** (not currently in package.json — add `@tanstack/react-table`). CSV export client-side via row iteration; server-side streaming for >100k row exports.

**Permission gating** — TanStack Router `beforeLoad` on `/_authenticated/admin/*`:

```typescript
export const Route = createFileRoute('/_authenticated/admin')({
  beforeLoad: async ({ context }) => {
    const orgRole = context.session?.user?.orgRoles?.[currentOrgId] ?? 'member'
    if (!['admin', 'owner'].includes(orgRole)) {
      throw redirect({ to: '/settings' })
    }
  },
})
```

**Sections to build (org-scoped):**

| Section | v1 (MVP) | v2 | v3+ |
|---|---|---|---|
| Members & roles | invite, remove, change role | bulk import | SCIM sync |
| Cost dashboard | this-month USD, top users, by model, by project, daily chart | per-session drill-down | forecast + alerts |
| Quotas | view usage-vs-cap | set USD limits, soft-cap warn | per-project caps |
| Audit log | filter + CSV export (polled) | live-tail via synced-collection | SIEM streaming |
| Claude key registry (CAAM) | view, mark BYO/shared | rotate UI | per-key spend |
| API keys | (deferred) | create/revoke | scoped tokens |
| Org settings | name, default permission mode | SSO config | branding |
| Billing teaser | "Free / Team / Enterprise — at your usage..." | Stripe portal | self-serve plan upgrade |

**Real-time vs polled:** cost dashboard 5-min refresh fine. Audit log polled in v1; live-tail via existing synced-collection pattern (spec #28) in v2.

---

## Cross-cutting decisions made

| # | Decision | Rationale |
|---|---|---|
| 1 | **Personal-org pattern** (GitHub/Vercel) | Zero breaking changes for existing users, every row has `org_id` from day 1 |
| 2 | **Better Auth Organization plugin** (use it) | Schema concerns are overstated; saves invite/role plumbing; ships audit hooks |
| 3 | **Layered enforcement (L1-L4)** | Defense in depth; SDK `canUseTool` is the missing layer |
| 4 | **Capture cache tokens NOW** | ~10 LOC fix; without it, all cost data is wrong by 25–90% |
| 5 | **Build usage ledger** (not Anthropic Admin API) | Need session/user/turn granularity for quotas + dashboards |
| 6 | **Stay in SessionDO for v1 quotas** | Defer `OrgQuotaDO` / `KeyDispatcherDO` until CAAM ships multi-key |
| 7 | **OTEL self-host on VPS** | Cross-runtime traces (Worker→DO→VPS→Claude) are the unique pain |
| 8 | **Keep `event_log`, augment with Logpush** | Local SQLite is fast + durable; don't replace |
| 9 | **Tag-based audit promotion** | Decouples ephemeral debug logs from compliance trail |
| 10 | **Defer SSO until first enterprise asks** | WorkOS is 2-3 day integration when needed; not worth speculative build |
| 11 | **Recharts + TanStack Table** | Smallest bundle, best accessibility, composable with Radix |
| 12 | **Runtime org_role in session JWT + DO 60s cache** | Sub-2ms permission eval without per-request D1 hop |

## Phased roadmap — ~10–12 weeks total

### Phase 1 — Foundation (2-3 weeks)
- Org schema + Better Auth Organization plugin enabled
- Personal-org migration (backfill all existing resources)
- `org_id` stamped on `agent_sessions`, `projects`, `worktree_reservations`, `user_preferences`, `projectMetadata`, all GatewayCommand/Event payloads
- URL routing: `/orgs/:slug/projects/:slug` + legacy redirect
- L1 middleware: stamp `orgId` + `orgRole` into Hono context
- **Zero user-visible UX changes** — every existing user lands in their personal org

### Phase 2 — Permissions + audit teeth (2 weeks)
- 3 default roles: `org_admin`, `member`, `viewer`
- L2 (DO RPC), L3 (gateway spawn) enforcement
- `audit_log` schema upgrade
- Sync writes for: auth events, member changes, session spawn/kill, role changes, key rotation
- Async via CF Queue for: project syncs, permission gates (tag promotion from `event_log`)
- Admin endpoint: `/api/admin/audit-logs` cursor-paginated

### Phase 3 — Usage ledger + quotas (2 weeks)
- `usage_ledger` + `model_pricing` + `usage_daily_org/user` tables
- **Cache token capture (small but critical)**
- Multi-provider cost computation (Anthropic native; Codex/Gemini computed)
- Async write-through via CF Queue
- Pre-spawn budget gate in DO `spawnImpl`
- Per-org monthly USD + per-user daily USD + concurrent-session caps
- Email warnings @ 80% (CF cron + Better Auth email sender)
- Rate-limit telemetry → audit + UI banner

### Phase 4 — Observability stack (3 weeks)
- Deploy Loki + Tempo + Grafana on VPS (2 vCPU instance)
- OTEL instrumentation: Worker (`@microlabs/otel-cf-workers`), DO (RPC wrapper), session-runner (SDK adapter)
- W3C traceparent end-to-end
- 15 metrics catalog (Prometheus scrape on VPS, OTLP push from Worker)
- Logpush from D1 `event_log` + auth tables to R2 hourly
- rsyslog → fluent-bit → Loki for runner stdout
- PostHog free tier: TanStack Router instrumentation, session replay
- Grafana AlertManager → Slack
- Health probes: orchestrator `/api/admin/health`, DO `getHealth()`, gateway saturation

### Phase 5 — Admin UI + tool-level RBAC (2 weeks)
- Org admin section under `/_authenticated/admin/`
- Members + roles UI (invite, remove, change role)
- Cost dashboard (Recharts, daily/monthly views, by-user/model/project)
- Quota config UI (set caps, view usage)
- Audit log viewer (filter + CSV export)
- Claude key registry (CAAM keys, rotate, BYO/shared marking)
- L4 SDK `canUseTool` wiring with per-org tool policies (immutable at spawn)
- Sensitive-tool approval flow (extend `permission_request`)
- Better Auth 2FA plugin (TOTP + backup codes)

### Phase 6 — Deferred (customer-demand triggered)
- WorkOS SAML/SCIM integration (2-3 days when needed)
- Stripe Metering bridge for usage-based billing
- R2 cold archive for `audit_log` (Parquet weekly export)
- Hash-chain audit immutability
- `OrgQuotaDO` + `KeyDispatcherDO` for token-bucket fairness across CAAM keys
- Per-project quotas
- Live-tail audit log via synced-collections
- BYO-key support (per-user Anthropic key)

## Open questions

1. **CAAM `org_id` plumbing — does spec #92 already populate `ctx.state.org_id` on session spawn?** Ledger writer needs it on day 1 of Phase 3. Verify before starting that phase.
2. **Codex/Gemini cache-token availability — do those SDKs emit cache token counts?** If not, cost computation needs a graceful "no cache data" path. Affects Phase 3.
3. **Pricing table seed strategy** — Anthropic published rates as defaults, or admin sets markup from day 1? Affects Phase 3 admin UI.
4. **Multi-tenant in CF Workers without per-tenant DOs** — does our DO model still work if one org has 50 concurrent sessions? Verify D1 row-count growth doesn't degrade `usage_daily_org` aggregation queries past 1M rows.
5. **Audit log immutability bar** — do we need hash-chain in v1 for paranoia tier or defer to Phase 6? Decision affects Phase 2 schema.
6. **Better Auth Organization plugin schema — exact column-name overlap with our existing `organizations`/`organization_members` Drizzle definitions?** Need to confirm before Phase 1 to avoid migration churn.
7. **Tool-level policy granularity** — flat `allowed_tools[]` per role, or per-tool conditions (e.g., "Bash allowed but only without sudo")? Phase 5 design depends on this.
8. **Grafana RBAC at scale** — single Grafana instance for all orgs, or per-org? Affects Phase 4 ops model. (Recommend single + label-based isolation for v1.)
9. **Orphan personal-orgs on user deletion** — delete cascade, soft-delete-and-archive, or transfer-to-co-owner? Policy decision for Phase 1.
10. **Reaper / system actions in audit log** — `actor_type='system'` covers it, but who's the `actor_user_id` for a CAAM key rotation triggered by a 429? Probably `null`. Confirm in Phase 2.

## Next steps

1. **Confirm scope** — does this 6-phase roadmap match priority? If foundation is too slow for the team, Phase 1 + Phase 3 + Phase 4 alone cover "team-grade" minus admin polish.
2. **Spec Phase 1 in detail** (likely a `planning/specs/` doc per phase). Foundation has the most architectural decisions; should be its own spec before any coding.
3. **Resolve open questions 1, 2, 6** before starting Phase 1 (they affect schema design).
4. **Open GitHub issue(s)** to track the umbrella effort — likely one epic + 6 phase issues.
5. **Spike on Better Auth Organization plugin schema compat** — 1 day of investigation before committing to enabling it.
6. **Spike on cache token capture** — that's a 30-minute fix worth landing standalone now (no migration risk, immediate cost-attribution improvement).

## Sources

**Codebase:**
- `apps/orchestrator/src/db/schema.ts` (full schema review)
- `apps/orchestrator/src/lib/auth.ts`, `auth-middleware.ts`, `auth-routes.ts`, `auth-session.ts`
- `apps/orchestrator/src/api/index.ts` (admin checks, session/project access)
- `apps/orchestrator/src/agents/session-do/event-log.ts` (existing local audit)
- `apps/orchestrator/src/agents/session-do/rpc-gates.ts`, `rpc-lifecycle.ts`, `runner-link.ts`, `resume-scheduler.ts`, `watchdog.ts`
- `apps/orchestrator/wrangler.toml`
- `packages/agent-gateway/src/server.ts`
- `packages/session-runner/src/claude-runner.ts`, `main.ts`
- `packages/shared-types/src/index.ts` (GatewayCommand/Event, WireContextUsage)
- `packages/shared-transport/src/buffered-channel.ts`
- `packages/docs-runner/src/metrics.ts`
- `apps/orchestrator/src/routes/_authenticated/admin*.tsx`

**Specs:**
- `planning/specs/68-visibility-public-private-sessions-projects.md`
- `planning/specs/92-caam-claude-auth-rotation.md`
- `planning/specs/107-codex-runner-revival.md`
- `planning/specs/110-gemini-cli-runner.md`
- `planning/specs/28-synced-collections-pattern.md`

**Web:**
- Better Auth Organization plugin: https://www.better-auth.com/docs/plugins/organization
- Better Auth SSO/SCIM/2FA plugins
- WorkOS, Stytch B2B, Clerk, Okta CIC, Keycloak (SSO comparison)
- OpenFGA, Cerbos, Oso Cloud (RBAC engines)
- Anthropic Admin API: https://docs.anthropic.com/en/api/admin-api/usage
- Stripe Meter Events API
- @microlabs/otel-cf-workers
- Grafana Loki + Tempo + Mimir self-host docs
- PostHog, Sentry, Datadog, Honeycomb pricing
- SOC 2 audit-log requirement summaries (Drata, Vanta, Venn level)
- GitHub Actions / Vercel / Stripe quota patterns
