# Theory & Primitives Review

Review the provided feature spec for alignment with platform theory and correct use of platform primitives.

## Context

Duraclaw has two layers of platform doctrine that specs must respect:

**Theory** (invariants that survive stack rewrites — see `docs/theory/`):
- [`docs/theory/domains.md`](../../docs/theory/domains.md) — module boundaries, capability ownership, which package/worker owns which behavior (orchestrator vs gateway vs runners)
- [`docs/theory/data.md`](../../docs/theory/data.md) — entity definitions, schemas, archetypes, field types, validation rules across D1 + DO SQLite + TanStack DB
- [`docs/theory/dynamics.md`](../../docs/theory/dynamics.md) — lifecycle states, transitions, phase rules, session/runner state machines, reaper + reconnect timing
- [`docs/theory/topology.md`](../../docs/theory/topology.md) — process/network shape: how Worker, DO, gateway, and runners are wired and where the boundaries fall
- [`docs/theory/trust.md`](../../docs/theory/trust.md) — auth, identity, token validation, permission models, what each tier is allowed to do
- [`docs/theory/boundaries.md`](../../docs/theory/boundaries.md) — integration patterns, transport contracts, sync models, external API conventions

**Platform Primitives** (use these instead of rolling your own — see `docs/primitives/`):

The original baseplane primitives map to duraclaw equivalents as follows. When this prompt evaluates a spec it MUST use the duraclaw column — never the baseplane column — for terminology and code references.

| Baseplane | Duraclaw equivalent |
|---|---|
| DataForge | → Drizzle + D1 schema (`apps/orchestrator/src/db/schema.ts`) — maps to duraclaw entity definitions |
| Relationships | → Drizzle relations (in the same schema file) — duraclaw foreign keys + reference integrity |
| Workflows | → DO state machines + kata phases (`packages/kata/`) — duraclaw multi-step processes |
| Templates | → `planning/spec-templates/` — duraclaw reusable spec/config presets |
| CommandBus | → TanStack DB collection writes + DO RPC dispatch — maps to duraclaw frontend operation dispatch |
| EventBus | → DialBackClient + BufferedChannel (`packages/shared-transport/`) — maps to duraclaw real-time runner↔DO sync |

When this prompt evaluates a spec, it MUST reference duraclaw equivalents — not baseplane terminology. A spec that introduces a new pattern should be checked against whether an existing duraclaw primitive ([`docs/primitives/arch/`](../../docs/primitives/arch/)) already covers it.

**UI Primitives** (see [`docs/primitives/ui/`](../../docs/primitives/ui/)) — flag specs that introduce ad-hoc UI behavior contracts when an existing primitive applies:
- [`docs/primitives/ui/design-system.md`](../../docs/primitives/ui/design-system.md) — tokens, spacing, type scale, color usage; the source of truth for visual language
- [`docs/primitives/ui/ai-elements.md`](../../docs/primitives/ui/ai-elements.md) — shared chat/agent UI components in `packages/ai-elements/` (use these, do not re-implement)
- [`docs/primitives/ui/chain-status.md`](../../docs/primitives/ui/chain-status.md) — the canonical session/runner status indicator pattern (derived status, never DB-truth-gated)
- [`docs/primitives/ui/tabs-and-drafts.md`](../../docs/primitives/ui/tabs-and-drafts.md) — tab state, draft persistence, and unsaved-input contracts

## What to Check

### 1. Theory Alignment

For each behavior and implementation decision in the spec, flag if it:

- **Contradicts theory** — spec assumes something that conflicts with a known invariant in `docs/theory/`
  (e.g. spec routes SDK execution through the gateway, but `docs/theory/domains.md` says only `session-runner` owns the SDK)
- **Introduces new theory-level concept** — spec defines a new invariant/domain rule not in any `docs/theory/` doc
  (flag for doc update, not a blocker)
- **Misidentifies module ownership** — feature puts logic in the wrong package (`apps/orchestrator` vs `packages/agent-gateway` vs `packages/session-runner` vs `packages/docs-runner`)
- **Violates lifecycle rules** — state transitions don't follow the patterns in `docs/theory/dynamics.md` (session lifecycle, reaper rules, dial-back reconnect)
- **Crosses a topology / trust boundary incorrectly** — e.g. gateway embedding the SDK, runner talking to D1 directly, browser bypassing the DO; cross-check against `docs/theory/topology.md` and `docs/theory/trust.md`

### 2. Primitives Compliance

For each data storage, process, transport, or UI operation in the spec, flag:

- 🔴 **Primitive bypass** — spec proposes a custom solution where a duraclaw primitive exists
  (e.g. spec adds a new bespoke websocket transport instead of using DialBackClient/BufferedChannel; spec hand-rolls a status pill instead of the chain-status primitive)
- 🟡 **Primitive opportunity** — spec could use a primitive but doesn't mention it
  (not a bypass, but worth flagging for the implementer)
- ✅ **Correct primitive usage** — spec explicitly references and uses the right primitive from `docs/primitives/`

### 3. Primitives Design Section

Check if the spec has a `## Primitives Design` section:
- If missing: flag as 🔴 (required for all features touching data, process, transport, or UI)
- If present: verify it maps each feature concern to the correct duraclaw primitive (arch + ui) with rationale, and links into `docs/primitives/`

## Output Format

```
PRIMITIVES_SCORE: {number}/100

## Assessment

### Status: PASS | NEEDS_REVISION

### Theory Alignment

| Finding | Type | Theory Area | Impact |
|---------|------|-------------|--------|
| {description} | Contradicts / New concept / Misowned / Lifecycle violation / Boundary violation | {docs/theory/<file>.md} | {blocker/flag-for-update} |

(Write "No issues found" if clean.)

### Primitives Compliance

**🔴 Bypasses (must fix):**
1. **{spec section}:** {what the spec does} → should use {duraclaw primitive, with `docs/primitives/...` link}
   - Why: {brief explanation}

**🟡 Opportunities (consider):**
1. **{spec section}:** {what the spec does} → could use {duraclaw primitive}

**✅ Correct usage:**
- {duraclaw primitive}: used correctly in {spec section}

### Primitives Design Section
- Present: yes / no
- Quality: complete / partial / missing

### Issues

1. **[Category]:** {specific issue}
   - **Where:** {section in spec}
   - **Fix:** {what to change}
```

Score guide:
- 90-100: No primitive bypasses, theory-aligned across all six `docs/theory/` files, Primitives Design section complete
- 75-89: Minor opportunities or partial Primitives Design section
- 60-74: One or more 🔴 bypasses or theory contradictions
- <60: Multiple bypasses or fundamental theory misalignment
