# Phase 0 Foundation Evidence

Date: 2026-04-03

Scope covered in this pass:

- `0.1` Bug Fixes
- `0.1b` Session Ownership
- `0.1c` Drop Start -> SPA
- `0.1d` CI Pipeline
- `0.1e` DO SQLite Schema Versioning
- `0.2` Dependency Upgrades
- `0.3` Mobile-First Layout
- `0.4` CLI Parity -- Core

Code checks:

- `pnpm verify:ci`
- `pnpm --filter @duraclaw/orchestrator typecheck`
- `pnpm --filter @duraclaw/orchestrator test`
- `pnpm test`
- `pnpm --filter @duraclaw/orchestrator build`

Real verification:

- `pnpm verify:dev:up`
- `pnpm verify:session:ownership`
- `pnpm verify:mobile-shell`
- `pnpm verify:session:interaction`
- `pnpm verify:smoke`

Observed results:

- The local CI gate now installs a repo-managed hooks path via `pnpm prepare`, then runs the versioned `.git-hooks/pre-commit` wrapper on every commit.
- The pre-commit gate executes staged-file Biome checks plus repo-wide `pnpm typecheck`, which avoids unrelated artifact noise while still blocking bad staged code.
- `pnpm verify:ci` exercised the real hook through an isolated git index with a temporary staged JS file, so the proof did not mutate the working tree or current staging state.
- The dependency pass is complete on the current stack: the orchestrator now runs on `agents@^0.9.0`, `vite@^8.0.3`, `@cloudflare/vite-plugin@^1.31.0`, current React 19.2.x / Better Auth 1.5.x pins, and updated Wrangler/Workers types without reopening the SPA or session regressions.
- SPA booted through the Worker/static-assets path and served `/login`, `/`, and `/session/:id`.
- Better Auth cookie sessions gated `/api/*` routes while leaving `/api/auth/*` and `/api/health` open.
- Session ownership filtered registry results by `userId` and blocked unauthenticated HTTP access.
- Session creation, polling, persisted assistant output, browser login, and browser session rendering all passed via the real local stack.
- SessionDO and registry migration coverage landed with `_schema_version` tracking plus forward-compatible columns.
- The mobile shell now holds at `320px`, `768px`, and `1440px` with bottom tabs on mobile, overlay menu behavior on tablet, sidebar on desktop, safe-area padding, and no horizontal overflow at the smallest viewport.
- CLI-parity core landed with typed AskUserQuestion rendering, client-side validation, rich tool detail rendering, model/turn/cost header metadata, and 44px touch targets across the new interaction controls.
- The session page now uses authenticated HTTP polling plus explicit Hono/SessionDO action endpoints for session state, question answers, and tool approvals. The chat stream remains on the session WebSocket, while the old `/agent` live-state path is no longer required for browser correctness.
- `SessionDO.onStart()` now schedules reconnect work idempotently, and the fresh post-fix verify stack start no longer emits the duplicate-schedule warning seen during the initial `agents@0.9.0` pass.
- The live browser proof for `0.4` uses a real AskUserQuestion session plus a real Bash-tool session that renders command details. The approval-request layout itself remains covered by the component test in `apps/orchestrator/src/lib/components/message-parts/tool-part.test.tsx` because the local SDK runs did not consistently stop in `waiting_permission`.

Artifacts:

- `logs/verify/ci-prepare.log`
- `logs/verify/ci-precommit.log`
- `logs/verify/gateway-health.json`
- `logs/verify/gateway-projects.json`
- `logs/verify/gateway-files.json`
- `logs/verify/gateway-git-status.json`
- `logs/verify/orchestrator-projects.json`
- `logs/verify/session-state.json`
- `logs/verify/session-messages.json`
- `logs/verify/browser-snapshot.txt`
- `logs/verify/browser-login.png`
- `logs/verify/browser-session-snapshot.txt`
- `logs/verify/browser-session.png`
- `logs/verify/mobile-shell-snapshot.txt`
- `logs/verify/mobile-shell.png`
- `logs/verify/session-interaction-snapshot.txt`
- `logs/verify/session-interaction.png`
- `logs/verify/session-ownership-authenticated.json`
- `logs/verify/session-ownership-unauthenticated-state.txt`
- `logs/verify/session-ownership-unauthenticated-messages.txt`
- `logs/verify/session-ownership-unauthenticated-ws-note.txt`

Verification caveat:

- The unauthenticated WebSocket curl probe against the local Cloudflare Vite dev server returned `curl: (52) Empty reply from server` instead of surfacing an HTTP `401` body. The upgrade was still blocked and the script records that local-dev behavior explicitly in `logs/verify/session-ownership-unauthenticated-ws-note.txt`.
