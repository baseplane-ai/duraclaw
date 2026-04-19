# Duraclaw Dev Container

One-click dev environment. Works with GitHub Codespaces and the VS Code / Cursor "Reopen in Container" command.

## What you get

- Node 22 (pnpm via corepack) + Bun (for `packages/agent-gateway`)
- GitHub CLI (`gh`)
- Biome configured as the default formatter
- `.env` seeded from `.env.example` (fill in secrets before `pnpm dev`)
- `pnpm install` already done; git hooks wired via `pnpm run prepare`
- Forwarded port ranges (per-worktree derived — see CLAUDE.md port table):
  - `43000-43799` — Orchestrator (Vite SPA)
  - `9800-10599` — Agent Gateway (WS)
  - `8787` — Miniflare

Actual orchestrator / gateway ports are derived from the workspace path via
`cksum % 800`, so every checkout gets a stable unique pair. The ranges above
cover the whole derivation space; the specific live pair is printed at the
end of `post-create.sh` and in `pnpm run verify:dev:up`.

## First-run checklist

```bash
npx wrangler login             # one-time CF auth
gh auth login                  # optional, for gh-axi / PRs

# Fill in .env — CC_GATEWAY_API_TOKEN and BOOTSTRAP_TOKEN at minimum.
$EDITOR .env

pnpm dev                       # turbo dev — orchestrator + gateway + ai-elements
pnpm verify:devcontainer       # confirm devcontainer config shape
```

Full `pnpm verify:smoke` additionally requires seeded users (`/api/bootstrap`)
and a running gateway — see CLAUDE.md > "Verify-mode local stack" before
running it.

Local test credentials (also in `CLAUDE.md`):

- email: `agent.verify+duraclaw@example.com`
- password: `duraclaw-test-password`

## Verifying the config itself

```bash
pnpm verify:devcontainer
```

Static check of `.devcontainer/devcontainer.json` shape + `post-create.sh` parse. Full build / preflight evidence belongs in `.kata/verification-evidence/`.
