# Worktree Setup & Port Derivation

Clone and bootstrap a new dev worktree in one shot:

```bash
cd /data/projects
git clone git@github.com:baseplane-ai/duraclaw.git duraclaw-dev4
cd duraclaw-dev4
scripts/setup-clone.sh --from /data/projects/duraclaw/.env
```

Or manually:

```bash
cp .env.example .env        # fill in CC_GATEWAY_API_TOKEN + BOOTSTRAP_TOKEN
scripts/verify/dev-up.sh    # generates .dev.vars, starts gateway + orchestrator
```

**Port derivation** — each worktree auto-derives a unique set of ports from
its absolute path via `cksum % 800`. No manual allocation needed — any new
clone Just Works.

| Worktree | Orch | Gateway | CDP-A | CDP-B | Bridge-A | Bridge-B | Axi |
|----------|------|---------|-------|-------|----------|----------|-----|
| duraclaw | 43307 | 10107 | 11307 | 12307 | 13307 | 14307 | 15307 |
| duraclaw-dev1 | 43054 | 9854 | 11054 | 12054 | 13054 | 14054 | 15054 |
| duraclaw-dev2 | 43613 | 10413 | 11613 | 12613 | 13613 | 14613 | 15613 |
| duraclaw-dev3 | 43537 | 10337 | 11537 | 12537 | 13537 | 14537 | 15537 |

Port ranges (all non-overlapping):

| Range | Purpose |
|-------|---------|
| 9800-10599 | Gateway |
| 11000-11799 | Browser A CDP (dual-browser) |
| 12000-12799 | Browser B CDP (dual-browser) |
| 13000-13799 | AXI-A bridge (dual-browser) |
| 14000-14799 | AXI-B bridge (dual-browser) |
| 15000-15799 | AXI bridge (single-browser via `scripts/axi`) |
| 43000-43799 | Orchestrator |

**Rules:**
- Never set `CC_GATEWAY_PORT` in `.env` — it collides across worktrees. Use `VERIFY_GATEWAY_PORT` to override.
- `.dev.vars` is generated — never hand-edit. Override via `.env` + `dev-up.sh`.
- `.env` is gitignored. `.env.example` is the canonical template.
- Use `scripts/axi` (not raw `chrome-devtools-axi`) so browser sessions are isolated per worktree.
