# Research: baseplane-ai → codevibesmatter migration + .env-scoped wrangler auth

**Date:** 2026-04-28
**Mode:** research
**Workflow:** RE-a915-0428
**Type:** Feature inventory + feasibility study
**Outcome:** Inventory complete. Migration is mostly stringy + one external dep (`baseplane-infra`). Wrangler auth is *already* `.env`-scoped — the change is small and mostly hardening.

---

## TL;DR

1. **GitHub coupling is shallow.** Two real code paths reference `baseplane-ai/duraclaw` (a UI link builder and one test). The rest is docs, READMEs, and historical spec text. No GitHub Actions to migrate. No GitHub OAuth provider in Better Auth.
2. **Cloudflare coupling is deep but standard.** 5 Durable Object classes, 1 D1 (`duraclaw-auth`), 2 R2 buckets, custom domain `dura.baseplane.ai`, 7 DO migration tags. Account ID is *not* pinned in `wrangler.toml`'s `account_id` field — only in a comment — and is sourced from `CLOUDFLARE_ACCOUNT_ID` env. This is a feature, not a bug, for migration.
3. **Mobile is the hairiest item.** `com.baseplane.duraclaw` is baked into the Android Java package directory, gradle namespace, Firebase `google-services.json`, and the Capacitor appId. Renaming requires a directory move + Firebase reprovision.
4. **`baseplane-infra` is the missing piece.** A separate repo at `/data/projects/baseplane-infra` runs all production deploys. The orchestrator's `/api/deploys` tab reads `.deploy-state.json` from that path (`packages/agent-gateway/src/deploy-state.ts:3`). Migrating off it requires either (a) cloning `baseplane-infra`, renaming, and giving it new credentials, or (b) building a minimal personal pipeline and pointing `DEPLOY_STATE_PATH` at it.
5. **Wrangler auth: already `.env`-scoped.** `apps/orchestrator/package.json:11` does `set -a && . ../../.env && set +a && wrangler deploy`. The work is to formalize this for the new account, document required scopes, and add a guardrail.

---

## Part 1 — GitHub inventory (`baseplane-ai/duraclaw` → `codevibesmatter/duraclaw`)

### Code references (must change)

| File | Line | What |
|---|---|---|
| `apps/orchestrator/src/components/chain-status-item.tsx` | 58 | `const GH_REPO = 'baseplane-ai/duraclaw'` — used to build issue/PR links in the chain UI |
| `packages/agent-gateway/src/projects.test.ts` | 290, 367 | Test fixtures referencing the literal repo path |

### Docs / README / clone instructions

| File | Line | What |
|---|---|---|
| `README.md` | 32, 443 | Org link + `git clone git@github.com:baseplane-ai/duraclaw.git` |
| `CLAUDE.md` | 108 | Mentions `github.com/baseplane-ai/duraclaw` |
| `.claude/rules/worktree-setup.md` | 7 | Clone command |
| `planning/specs/16-chain-ux.md` | 848 | URL-build template |
| `planning/specs/116-arcs-first-class-parent.md` | 882 | SQL building GH URLs |
| `planning/**/*.md` | (many) | ~40 issue-link templates; cosmetic — fix opportunistically |

### Auth — Better Auth

**Finding:** Better Auth is configured with **email + password only** (`apps/orchestrator/src/lib/auth.ts:47-74`). No GitHub OAuth provider. Nothing to re-register on the GitHub side.

### CI / Workflows

**Finding:** No `.github/workflows/` directory. All deploys run from the external `baseplane-infra` repo. Only `.github/ISSUE_TEMPLATE/` (3 templates, no URLs) and `.github/wm-labels.json`. The migration touches *zero* GitHub Actions.

### Migration step

```bash
# 1. Transfer the repo via GitHub UI / API (preserves issues, PRs, stars).
gh repo transfer baseplane-ai/duraclaw codevibesmatter
# 2. Rewrite remotes in every worktree.
for d in /data/projects/duraclaw{,-dev1,-dev2,-dev3}; do
  git -C "$d" remote set-url origin git@github.com:codevibesmatter/duraclaw.git
done
# 3. Fix the two real code references + readme + CLAUDE.md.
# 4. Run `rg baseplane-ai` to find anything missed.
```

---

## Part 2 — Cloudflare inventory

### Wrangler config (`apps/orchestrator/wrangler.toml`)

| Concern | Value | Line |
|---|---|---|
| Worker name | `duraclaw-orchestrator` | 1 |
| Custom domain | `dura.baseplane.ai` | 15 |
| Cron | `*/5 * * * *` | 24 |
| Account ID | **NOT** pinned in TOML — sourced from `$CLOUDFLARE_ACCOUNT_ID` | 111-114 (comment) |
| D1 binding | `AUTH_DB` → `duraclaw-auth` (`c5b4d822-9bc6-467f-9ad6-7ee779b82e0c`) | 115-118 |
| R2 #1 | `MOBILE_ASSETS` → `duraclaw-mobile` (OTA bundles) | 131-133 |
| R2 #2 | `SESSION_MEDIA` → `duraclaw-session-media` (image offload) | 139-141 |
| Vars | `VAPID_SUBJECT = "mailto:push@codevibesmatter.com"` | 144 |

### Durable Objects (5 classes, 7 migration tags)

| Class | Binding | File | Storage |
|---|---|---|---|
| `SessionDO` | `SESSION_AGENT` | `apps/orchestrator/src/agents/session-do/index.ts` | SQLite — message history, event_log, session_transcript |
| `UserSettingsDO` | `USER_SETTINGS` | `apps/orchestrator/src/agents/user-settings-do.ts` | none (D1-backed presence, SQLite dropped at v4) |
| `SessionCollabDOv2` | `SESSION_COLLAB` | `apps/orchestrator/src/agents/session-collab-do.ts` | SQLite `y_state` (Yjs) |
| `SessionCollabDO` | `SESSION_COLLAB_LEGACY` | `apps/orchestrator/src/agents/session-collab-do-legacy.ts` | none — kept alive to avoid CF error 10061 |
| `RepoDocumentDO` | `REPO_DOCUMENT` | `apps/orchestrator/src/agents/repo-document-do.ts` | SQLite `y_state` + tombstone alarms |

**Critical:** DO storage cannot be migrated cross-account. See "Phase 3" of the plan.

### D1 schema (migrations 0001-0031)

Tables of interest for migration: `users`, `sessions`, `accounts`, `verifications` (Better Auth), `agent_sessions`, `runner_identities`, `projects`, `worktrees_first_class`, `chains`, plus push/presence/preferences. All exportable via `wrangler d1 export`.

### Secrets (per `wrangler.toml:147-160`)

`CC_GATEWAY_URL`, `CC_GATEWAY_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WORKER_PUBLIC_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `FCM_SERVICE_ACCOUNT_JSON` (optional), `SYNC_BROADCAST_SECRET`, `GITHUB_WEBHOOK_SECRET` (optional), `GITHUB_API_TOKEN` (optional).

All re-`wrangler secret put` after migration. Better Auth secret rotation invalidates all live sessions — expected.

### Hardcoded production hostname

| File | Line | Value |
|---|---|---|
| `apps/orchestrator/wrangler.toml` | 15 | `dura.baseplane.ai` |
| `apps/mobile/.env.production` | 15-16 | `VITE_API_BASE_URL=https://dura.baseplane.ai`, `VITE_WORKER_PUBLIC_URL=...` |
| `scripts/seed-admin.sh` | 17 | Default `BASE_URL` |
| `apps/orchestrator/src/agents/session-do/session-do.test.ts` | 585-587 | Test reference to `duraclaw.workers.dev` |
| `apps/orchestrator/scripts/cutover.sh` | 14, 128-129 | Cutover-rehearsal script |

---

## Part 3 — VPS / infra coupling

### systemd

| File | Line | Note |
|---|---|---|
| `packages/agent-gateway/systemd/duraclaw-agent-gateway.service` | 24 | `EnvironmentFile=/data/projects/duraclaw/.env` |
| Same | 26 | `CC_GATEWAY_PORT=9877` (prod port) |
| `packages/docs-runner/systemd/duraclaw-docs-runner@.service` | 30, 38 | `User=ubuntu`, templated by `%i` |

`IDENTITY_HOME_BASE=/srv/duraclaw/homes` is account-agnostic. No change required for the CF migration; only matters if you also move VPS providers.

### `baseplane-infra` (external)

`packages/agent-gateway/src/deploy-state.ts:3` — `DEFAULT_DEPLOY_STATE_PATH = '/data/projects/baseplane-infra/.deploy-state.json'`. Overridable via `DEPLOY_STATE_PATH` env (line 25). The `/api/deploys` tab in the orchestrator reads this file directly.

**Implication:** there is a separate repo (`baseplane-infra`) that holds the deploy pipeline. **It is not in this monorepo.** Migrating off it means one of:

- **Option A — fork-and-rename.** Clone `baseplane-infra` to `codevibesmatter-infra`, swap the embedded CF account ID + GitHub creds, change the path on the VPS, and update `DEPLOY_STATE_PATH` in the gateway env.
- **Option B — replace.** Build a minimal pipeline (a single `deploy.sh` triggered by a webhook or cron) that runs the contract from `.claude/rules/deployment.md`. Set `DEPLOY_STATE_PATH` to its output.

Either way, the orchestrator side needs no code change beyond pointing the env var. Option B is cleaner for a one-person setup; option A is faster.

---

## Part 4 — Mobile (hairiest single change)

| File | Line | Current | Target |
|---|---|---|---|
| `apps/mobile/capacitor.config.ts` | 4 | `appId: 'com.baseplane.duraclaw'` | `com.codevibesmatter.duraclaw` |
| `apps/mobile/android/app/build.gradle` | 22, 25 | `namespace`, `applicationId` | same |
| `apps/mobile/android/app/src/main/res/values/strings.xml` | 5-6 | `package_name` | same |
| `apps/mobile/android/app/src/main/java/com/baseplane/duraclaw/MainActivity.java` | 1 | `package com.baseplane.duraclaw;` + the directory | rename dir + edit |
| `apps/mobile/android/app/google-services.json` | 12 | Firebase `package_name`, `project_id: baseplane-3ce67` | New Firebase project under your Google Cloud account |
| `.claude/rules/mobile.md` | 76, 84, 96 | doc | doc |

**Risk:** changing `applicationId` makes existing Play Store installs into a separate app. If the app is published, you cannot rename it in place — you'd need a new listing. If it's not published yet, this is free.

Firebase project must be re-provisioned under your Google Cloud — `google-services.json` is regenerated, FCM server keys rotate, and `FCM_SERVICE_ACCOUNT_JSON` (Worker secret) must be updated. Without this, FCM push to the Android shell breaks.

---

## Part 5 — `.env`-scoped wrangler auth

### Current state

**Already `.env`-scoped, just under-documented.**

```jsonc
// apps/orchestrator/package.json:11
"ship": "set -a && . ../../.env && set +a && wrangler deploy"
```

```bash
# .env.example:19-20
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
```

Wrangler natively reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the process env — no `dotenv-cli` wrapper, no `wrangler login` interaction needed once those vars are set. The `set -a && . .env && set +a` pattern in the ship script is the standard "source `.env` into the process env" idiom.

**The current setup is correct. Nothing to refactor.**

### Why `wrangler login` (system auth) is dangerous for this migration

If a developer ran `wrangler login` against the *old* baseplane account, those creds live in `~/.wrangler/config/default.toml` and **silently take precedence** over `.env`-loaded API tokens in some wrangler versions. Concrete failure mode: you set `CLOUDFLARE_API_TOKEN` to a new-account token, run `pnpm ship`, and the deploy hits the *old* account because wrangler picked up the system OAuth session.

### Hardening plan (small, do during migration)

1. **Pin the new account_id explicitly in `wrangler.toml`.** Currently the comment at `wrangler.toml:111-114` says "always pass `CLOUDFLARE_ACCOUNT_ID=...` explicitly" — that's the env-var path. Adding an `account_id = "<new-id>"` field at the top of `wrangler.toml` makes wrangler refuse to deploy to any other account (regardless of env or system auth). This is the single highest-leverage guardrail.
2. **Update `.env.example` with the new account ID as a default value** (not blank), so a fresh clone fails closed if the developer forgets to set it but cannot deploy to the wrong account.
3. **Add a preflight check to the `ship` script:**
   ```bash
   "ship": "set -a && . ../../.env && set +a && [ -n \"$CLOUDFLARE_API_TOKEN\" ] && [ \"$CLOUDFLARE_ACCOUNT_ID\" = \"<new-id>\" ] && wrangler deploy"
   ```
   Fails fast if either is missing or wrong.
4. **Force unauth of system wrangler on dev machines that previously deployed to baseplane:** `wrangler logout`. Document this in the migration checklist.
5. **Document the required CF API token scopes** in `.env.example`:
   - `Account / Workers Scripts: Edit`
   - `Account / Workers KV Storage: Edit` (future-proof; not currently used)
   - `Account / D1: Edit`
   - `Account / Workers R2 Storage: Edit`
   - `Account / Workers Tail: Read` (for `wrangler tail`)
   - `Account / Account Settings: Read`
   - `Zone / DNS: Edit` (only on `dura.<your-domain>` zone — needed for custom-domain binding)
   - **NOT** Workers AI, Logpush, Pages, Workers for Platforms.
6. **Token rotation cadence:** create the token with a 1-year expiry. Calendar reminder. Tokens for the infra pipeline (separate from local dev) should be a different token with the same scopes — so a leaked dev token doesn't compromise prod deploys.
7. **Worktree isolation:** every worktree's `.env` is a separate file (gitignored). They all point at the same CF account. The `account_id` pin in `wrangler.toml` is the cross-worktree safety net.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Developer's old `wrangler login` session masks `.env` token | `wrangler logout` step in migration checklist + `account_id` pin in TOML |
| `.env` accidentally committed | Already gitignored; add a pre-commit hook to reject any file containing `CLOUDFLARE_API_TOKEN=` followed by a non-empty value |
| Token leaked via shell history (`export CLOUDFLARE_API_TOKEN=...`) | Document: "set in `.env`, never `export`" |
| Different worktrees deploy to different accounts | Pin `account_id` in `wrangler.toml` (single source of truth) |
| Infra pipeline token has more scope than needed | Issue separate scoped tokens for {dev, infra-pipeline, OTA-uploader} |

---

## Part 6 — Recommended migration sequencing

This consolidates findings into an executable order. Each phase is independently revertable until cutover.

### Phase A — GitHub (independent, low risk, ~1h)

1. `gh repo transfer baseplane-ai/duraclaw codevibesmatter`
2. Update remotes in 4 worktrees.
3. Fix `chain-status-item.tsx:58`, `projects.test.ts:290+367`.
4. Sweep README/CLAUDE.md/worktree-setup.md.
5. Push, confirm GitHub auto-redirect works for old issue links.

### Phase B — New CF account preflight (independent, ~2h)

1. Create CF account on the codevibesmatter email; capture `account_id`.
2. Provision in new account: D1 `duraclaw-auth` (capture new id), R2 buckets `duraclaw-mobile` + `duraclaw-session-media`, Workers token with the scopes listed above.
3. Add `dura.<your-domain>` to the new CF zone — but **do not point the public DNS yet**. Use a parallel hostname like `dura-new.<your-domain>` for staging.
4. On a `migrate/cf-account` branch:
   - Pin `account_id` in `wrangler.toml`.
   - Update `database_id` to the new D1 id.
   - Update `[[routes]] pattern` to the staging hostname.
   - Update `.env.example` with the new account id as default.
5. Stamp all secrets via `wrangler secret put`.

### Phase C — Data migration (cold-cut, ~1-2h window)

1. Drain in-flight sessions (mark all `agent_sessions` rows `idle` from D1 admin).
2. `wrangler d1 export duraclaw-auth --remote --output=snapshot.sql` (old account).
3. Switch `wrangler.toml` to new account/db, `wrangler d1 execute duraclaw-auth --remote --file=snapshot.sql`.
4. R2 cross-account copy via `rclone` for both buckets. Re-upload `ota/version.json` last.
5. **DO state: accept loss.** No live runner state worth migrating mid-window. Runner-side SDK transcripts on the VPS survive — sessions resume via `forkWithHistory` on next message.
6. Reset `projectMetadata.docs_runner_do_id` rows (the new DOs have new IDs).

### Phase D — Cutover (~30 min)

1. Deploy Worker to new account on staging hostname. Smoke-test with a fresh dev runner pointed at it.
2. Update VPS gateway env: `WORKER_PUBLIC_URL` → new hostname. `systemctl restart duraclaw-agent-gateway`. `KillMode=process` keeps detached runners alive; they reconnect on next backoff.
3. Flip DNS for `dura.<your-domain>`. Lower TTL 24h prior.
4. Ship a new mobile OTA bundle whose `VITE_*` URLs point at the new domain.
5. Old Worker stays deployed for 48h as rollback.

### Phase E — Mobile (independent of A-D, can be done later)

Only required if Android shell needs to ship a new release. Renames `com.baseplane.duraclaw` → `com.codevibesmatter.duraclaw`. New Firebase project. New Play Store listing if previously published.

### Phase F — `baseplane-infra` (the missing dep)

Out of scope for this monorepo's research, but the migration is incomplete without it. Either fork+rename or build a thin replacement pipeline. Until done, manual `pnpm --filter @duraclaw/orchestrator ship` from a developer machine works (it sources `.env`).

### Phase G — Cleanup (~1 week post-cutover)

- Decommission old Worker.
- Revoke old CF token.
- `rg baseplane` final sweep.
- Update planning docs opportunistically.

---

## Open questions for the operator

1. **Is `dura.baseplane.ai` staying or moving?** If staying, only the CF account that controls the zone needs to change. If moving to e.g. `dura.codevibesmatter.com`, the DNS work is bigger.
2. **Is the Android app published on Play Store?** Determines whether the package rename is "free" or requires a new listing.
3. **Fork or replace `baseplane-infra`?** Open question — the research above doesn't pick because the answer depends on what's in that repo (which isn't visible from here).
4. **Acceptable downtime window?** Phase C requires a brief cold-cut for active sessions. 1-2h is conservative; could be ~15min if no users are active.

---

## File-level migration checklist (copy into a tracking issue)

```
[ ] gh repo transfer baseplane-ai/duraclaw codevibesmatter
[ ] Rewrite git remotes in /data/projects/duraclaw{,-dev1,-dev2,-dev3}
[ ] apps/orchestrator/src/components/chain-status-item.tsx:58
[ ] packages/agent-gateway/src/projects.test.ts:290,367
[ ] README.md:32,443
[ ] CLAUDE.md:108
[ ] .claude/rules/worktree-setup.md:7
[ ] apps/orchestrator/wrangler.toml: pin new account_id, swap database_id, update [[routes]] pattern
[ ] apps/orchestrator/wrangler.toml:111-114: rewrite the comment block
[ ] apps/orchestrator/wrangler.toml:144 (vars): VAPID_SUBJECT — already codevibesmatter.com, no change
[ ] .env.example:19-20: pin new CLOUDFLARE_ACCOUNT_ID as default; add scope-list comment
[ ] apps/orchestrator/package.json:11: add account-id preflight check to ship script
[ ] apps/mobile/.env.production:15-16
[ ] apps/mobile/capacitor.config.ts:4
[ ] apps/mobile/android/app/build.gradle:22,25
[ ] apps/mobile/android/app/src/main/res/values/strings.xml:5-6
[ ] mv apps/mobile/android/app/src/main/java/com/baseplane → com/codevibesmatter
[ ] apps/mobile/android/app/google-services.json (regenerate from new Firebase project)
[ ] scripts/seed-admin.sh:17
[ ] apps/orchestrator/scripts/cutover.sh:14,128-129
[ ] packages/agent-gateway/src/deploy-state.ts:3 OR set DEPLOY_STATE_PATH env
[ ] All wrangler secrets re-`secret put` against new account
[ ] All developer machines: wrangler logout (kill any old OAuth session)
[ ] Final: rg baseplane (sweep for stragglers)
```
