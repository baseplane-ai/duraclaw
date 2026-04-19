# Duraclaw Dev Container

One-click dev environment. Works with GitHub Codespaces and the VS Code / Cursor "Reopen in Container" command.

## What you get

- Node 22 (pnpm via corepack) + Bun (for `packages/agent-gateway`)
- GitHub CLI (`gh`)
- Biome configured as the default formatter
- Forwarded ports:
  - `43173` — Orchestrator (Vite SPA)
  - `9877` — Agent Gateway (WS)
  - `8787` — Miniflare
- `pnpm install` already done; git hooks wired via `pnpm run prepare`

## First-run checklist

```bash
npx wrangler login        # one-time CF auth
gh auth login             # optional, for gh-axi / PRs
pnpm dev                  # turbo dev — orchestrator + gateway + ai-elements
pnpm verify:smoke         # baseline verification
```

Local test credentials (also in `CLAUDE.md`):

- email: `agent.verify+duraclaw@example.com`
- password: `duraclaw-test-password`

## Verifying the config itself

```bash
pnpm verify:devcontainer
```

Static check of `.devcontainer/devcontainer.json` shape + `post-create.sh` parse. Full build / preflight evidence belongs in `.kata/verification-evidence/`.
