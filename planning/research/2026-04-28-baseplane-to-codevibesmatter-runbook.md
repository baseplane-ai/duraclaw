# Runbook: baseplane-ai → codevibesmatter cutover

**Date:** 2026-04-28
**Companion to:** `2026-04-28-baseplane-to-codevibesmatter-migration.md`
(the inventory + topology research)
**Workspace:** `/data/projects/duraclaw-migration/` (its own git repo,
holds scripts + `.env.targets`)

## Status as of 2026-04-28 22:19 UTC

- [x] **GitHub takeback complete.** `codevibesmatter/duraclaw`
      unarchived, `main` fast-forwarded from `06afbee` →  `8092c8a`
      (742 commits). Description cleared. All 9 branches preserved
      (including 3 orphans not in baseplane main:
      `feat/29-mobile-session-cards-nav-cleanup`,
      `feature/1-remote-workbench`,
      `feature/40-file-watcher-message-sync`).
- [ ] Local git remotes still point at `baseplane-ai/duraclaw` —
      next: `scripts/40-swap-git-remotes.sh`
- [ ] Personal CF account state inventory — blocked on
      `wrangler logout && wrangler login` (currently authed as
      `ben@baseplane.ai`, account `87bd3030c315cfdc6e9f9c04ad6f37bc`)
- [ ] D1 export → import / R2 sync — blocked on CF inventory
- [ ] Worker secrets re-set against personal account — blocked
- [ ] DNS flip + Worker deploy — blocked
- [ ] Archive `baseplane-ai/duraclaw` — last step, post-cutover

## T-7d — Lower DNS TTL

```bash
# In old account's CF dashboard → DNS → dura.baseplane.ai → TTL = 60s
# Default is usually 5min; cut to 60s so the cutover propagates fast.
```

## T-2d — Pre-flight (dress rehearsal)

```bash
cd /data/projects/duraclaw-migration
cp .env.targets.example .env.targets
$EDITOR .env.targets   # fill in NEW_* values

# 1. Take back the GitHub repo (idempotent — safe to run anytime).
#    Unarchives codevibesmatter/duraclaw, fast-forwards main from
#    baseplane main. Does NOT yet archive baseplane.
scripts/05-github-takeback.sh   # ← already done 2026-04-28

# 2. Verify the personal CF account state — what's already there?
wrangler logout                  # flush old baseplane OAuth session
wrangler login                   # browser flow → login as personal
wrangler whoami                  # paste account ID into 00-targets.md
wrangler d1 list --json          # any pre-existing duraclaw-auth?
wrangler r2 bucket list --json   # any pre-existing buckets?

# 3. CF preflight (uses .env.targets, not OAuth — safer for scripts).
scripts/00-preflight.sh          # confirms wrangler context = personal account

# 4. D1 snapshot from old account.
scripts/10-export-d1.sh          # writes snapshots/d1-<ts>.sql
# Inspect: grep -c '^INSERT INTO' snapshots/d1-*.sql
```

Apply the code changes from `01-inventory.md` (in the migration repo)
to a `migrate/cf-account` branch in `duraclaw`. **Don't merge yet.**

## T-1d — New account smoke test

```bash
# 1. Deploy Worker to new account on staging hostname.
cd /data/projects/duraclaw                       # use main duraclaw checkout
git checkout migrate/cf-account
cd ../duraclaw-migration
scripts/70-deploy-staging.sh                     # deploys to NEW_STAGING_DOMAIN

# 2. Spawn a fresh dev runner pointed at staging:
#    on the VPS, set CC_GATEWAY_URL via gateway env override and confirm
#    a new session round-trips end-to-end (login → session → message → response).
```

If smoke test fails, fix forward — do not cut over.

## T-0 — Cutover window

Communicate downtime: "Sessions paused 5-10 min for infra migration."

```bash
# 1. Drain in-flight sessions.
#    From the orchestrator admin UI, mark all active sessions idle, or:
wrangler d1 execute duraclaw-auth --remote \
  --command "UPDATE agent_sessions SET status='idle' WHERE status NOT IN ('idle','crashed','completed')" \
  --account-id "$OLD_CLOUDFLARE_ACCOUNT_ID"

# 2. Final D1 snapshot + import.
scripts/10-export-d1.sh
scripts/20-import-d1.sh

# 3. R2 sync (idempotent; safe to re-run).
scripts/30-r2-sync.sh

# 4. Re-set secrets in new account.
scripts/60-secrets-set.sh

# 5. Re-deploy to new account on the PRODUCTION hostname pin.
#    Edit wrangler.toml [[routes]] pattern to NEW_PRODUCTION_DOMAIN, push.
cd /data/projects/duraclaw
git checkout main
git merge --ff-only migrate/cf-account
git push origin main
# (if using infra pipeline, this triggers the deploy; otherwise:)
cd apps/orchestrator && pnpm ship

# 6. DNS flip.
#    In NEW account CF dashboard, add the production hostname as a custom
#    domain on the Worker. Old account's custom domain binding is removed.
#    DNS propagation: ~60s (TTL was lowered T-7d).

# 7. Update VPS gateway env.
ssh <vps>
sudo systemctl edit duraclaw-agent-gateway   # add WORKER_PUBLIC_URL override + new CC_GATEWAY_SECRET
sudo systemctl restart duraclaw-agent-gateway
# Detached runners are unaffected (KillMode=process); they reconnect via
# the dial-back URL they were spawned with — drain naturally.

# 8. Smoke test from a clean browser session.
#    Login → start session → send message → confirm streaming.
```

## T+24h — Decommission

```bash
# Old Worker stays up for 24-48h as rollback. After that:
CLOUDFLARE_API_TOKEN="$OLD_CLOUDFLARE_API_TOKEN" \
CLOUDFLARE_ACCOUNT_ID="$OLD_CLOUDFLARE_ACCOUNT_ID" \
  wrangler delete --name duraclaw-orchestrator

# Revoke old CF API token in old account dashboard.
# Reset DNS TTL to 5min.

# Archive baseplane-ai/duraclaw with a back-pointer.
gh api -X PATCH repos/baseplane-ai/duraclaw \
  -f archived=true \
  -f description='[ARCHIVED - moved back to codevibesmatter/duraclaw]'
```

## T+1w — Cleanup PR

- Final `rg baseplane` sweep
- Update planning docs opportunistically
- Decide disposition of the 3 orphan branches on `codevibesmatter/duraclaw`

## Rollback (if cutover fails inside the window)

See `/data/projects/duraclaw-migration/90-rollback.md`. Short version:

- **Within 5 min** — re-add production hostname binding to the OLD
  account's Worker; remove it from the new one. TTL=60s = ~60s flip back.
- **Within 24h** — `git revert` the merge commit on `main`, redeploy.
- **After 24h** — old Worker is decommissioned; rollback means
  re-creating it from the D1 snapshot in `snapshots/`. DO state has
  diverged and is not recoverable.

## Source-of-truth pointers

- Inventory + topology: `2026-04-28-baseplane-to-codevibesmatter-migration.md`
- Migration scripts: `/data/projects/duraclaw-migration/scripts/`
- File-level edit checklist: `/data/projects/duraclaw-migration/01-inventory.md`
- Secrets list + rotation policy: `/data/projects/duraclaw-migration/02-secrets.md`
- Rollback plan: `/data/projects/duraclaw-migration/90-rollback.md`
