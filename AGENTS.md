# AGENTS.md — Duraclaw

## Priority Docs

- Product/sequence audit: `planning/research/2026-04-01-product-roadmap.md`
- Delivery tracker: `planning/progress.md`
- Detailed implementation specs: `planning/specs/`
- Verification tool config for `kata`: `.kata/verification-tools.md`

If the roadmap, progress tracker, and a concrete spec disagree, follow the spec linked from `planning/progress.md`, then update the tracker.

## Roadmap / Progress Review

- The roadmap already treats foundation work as the gating layer before higher-level UX work.
- `planning/progress.md` tracks feature/subphase delivery, but the important rule is that verification must grow with the roadmap instead of staying fixed.
- `pnpm verify:smoke` is only the baseline floor. It is not sufficient forever.
- For this repo, the first verification priority is not synthetic unit coverage. It is real curl coverage against the local APIs plus real browser coverage through `agent-browser`.

## Roadmap-Driven Verification Policy

Every roadmap subphase must carry its own verification delta.

That means:

1. When a subphase moves from `spec` to `in-progress`, identify the new behavior it introduces and add or extend real verification for it.
2. Put those checks in `scripts/verify/` and expose them through root `pnpm verify:*` commands in `package.json`.
3. Keep the checks cumulative. New work should expand coverage; it should not rely on the old baseline alone.
4. Before a subphase moves to `done`, run the targeted verification for that subphase, keep the baseline smoke green, and save evidence under `.kata/verification-evidence/`.

Naming rule:

- Prefer capability-oriented commands such as `verify:session:rewind` or `verify:dashboard` over throwaway one-off script names.
- Keep `verify:smoke` as the repo-wide baseline, then layer targeted commands on top as roadmap coverage grows.

## Phase Verification Map

Use this as the default expectation when implementing roadmap work:

- `0.x Foundation`: extend auth, routing, session-ownership, mobile-shell, CI, and CLI-parity verification. Baseline is `verify:smoke`, then add targeted checks for unauthorized access, SPA routing, mobile rendering, and approval/question flows as those land.
- `1.x Chat Quality + Mobile Chat`: extend chat-input, file-change rendering, reconnect/error, and mobile-chat verification. Changes here should add browser checks, not just API checks.
- `2.x Multi-Session Dashboard`: add dashboard-specific backend and browser checks for multi-session tiles, attention queue behavior, status indicators, and cost display.
- `3.x Session Management`: add targeted checks for rename/delete/export, rewind, compaction, history, and new-session options. Session lifecycle work is not done until those operations are proven through real API calls and the browser where relevant.
- `4.x Push Notifications + PWA`: add notification delivery, in-app notification rendering, and installability/PWA checks.
- `5.x File Viewer + Integrations`: add file-viewer, diff rendering, GitHub integration, kata state, and executor abstraction verification as those features land.
- `6.x Settings + Auth + Theming`: add settings-page, advanced auth, timeout/reset/logout, and theme-mode verification.
- `7.x Advanced Chat Features`: add slash-command, input-history, and command-palette verification.
- `8.x Data Layer + Offline`: add offline/cache/sync verification and any native-shell checks required for the shipped scope.
- `9.x Backend Hardening`: add observability, cleanup, lifecycle, and rate-limit verification.
- `10.x Platform Evolution`: add executor-registry, multi-provider, multi-model, and orchestration verification.

## Verification Standard

Always prefer these in order:

1. Real local stack
2. Real `curl` calls against running endpoints
3. Real browser automation with `agent-browser`
4. Direct DB inspection only when API evidence is insufficient

Do not mark work complete based only on static code inspection, mocked fetches, or HTML-only fetches when the feature depends on auth, JS rendering, or gateway integration.

## Local Verification Commands

Use the repo-local CLI and wrappers from the repo root:

- `pnpm kata ...`
- `pnpm verify:dev:up`
- `pnpm verify:preflight`
- `pnpm verify:auth`
- `pnpm verify:gateway`
- `pnpm verify:session`
- `pnpm verify:browser`
- `pnpm verify:browser:session`
- `pnpm verify:smoke`
- `pnpm verify:dev:down`

What each command does:

- `verify:dev:up` starts the local gateway and orchestrator in the background, logs to `logs/verify/`, and forces the orchestrator to use the local gateway/auth URLs.
- The orchestrator stays alive in tmux session `duraclaw-verify-orchestrator`; use `pnpm verify:dev:down` to stop it cleanly.
- `verify:preflight` confirms `curl`, `jq`, and `agent-browser` are installed, then checks gateway and orchestrator readiness.
- `verify:auth` creates or signs into the local verification user and refreshes `logs/verify/state/auth.cookies.txt`.
- `verify:gateway` performs real API checks against `/projects`, `/projects/:name/files`, `/projects/:name/git-status`, and orchestrator `/api/projects`.
- `verify:session` creates a real low-cost session, polls `/api/sessions/:id`, and verifies persisted assistant output through `/api/sessions/:id/messages`.
- `verify:browser` signs in through the real login page with `agent-browser`, captures a snapshot, and saves a screenshot.
- `verify:browser:session` opens a real session page in `agent-browser` and verifies that live session output is rendered in the UI.
- `verify:smoke` runs the standard preflight + auth + gateway + session + browser + browser-session sequence.

## Environment Knobs

These defaults are safe for local verification and can be overridden per shell:

- `VERIFY_ORCH_PORT=43173`
- `VERIFY_ORCH_URL=http://127.0.0.1:43173` preferred default
- `VERIFY_GATEWAY_URL=http://127.0.0.1:9877`
- `VERIFY_GATEWAY_WS_URL=ws://127.0.0.1:9877`
- `VERIFY_AUTH_EMAIL=agent.verify+duraclaw@example.com`
- `VERIFY_AUTH_PASSWORD=duraclaw-test-password`
- `VERIFY_PROJECT=` optional; if unset, the first gateway-discovered project is used
- `VERIFY_GATEWAY_TOKEN=` optional override for gateway Bearer auth

## Evidence Rules

- Raw smoke artifacts live in `logs/verify/`
- Phase/issue evidence lives in `.kata/verification-evidence/`
- If you run `kata check-phase`, make sure the evidence file reflects the current commit
- When a change touches auth, gateway proxying, session creation, or routing, run both `pnpm verify:gateway` and `pnpm verify:browser`
- When a change touches session lifecycle, run `pnpm verify:session` and `pnpm verify:browser:session`

## Done Gate

Before changing a phase/subphase in `planning/progress.md` to `done`, the implementing agent should have:

1. Run targeted code checks such as `pnpm typecheck`, `pnpm test`, or narrower package-level commands as appropriate
2. Updated the verification suite for the roadmap item if the change introduced new behavior
3. Run the real verification path relevant to the change, with `pnpm verify:smoke` as the default baseline plus any new targeted commands for that subphase
4. Saved evidence under `.kata/verification-evidence/` when the work maps to a tracked phase or issue
5. Noted any remaining gaps explicitly instead of silently assuming the smoke checks were enough

## Current Scope Note

The gateway discovers `/data/projects/baseplane*` worktrees by default. That is expected. Duraclaw's own verification target is the orchestrator/gateway stack itself, while gateway project-level smoke checks usually operate on a discovered baseplane worktree unless `VERIFY_PROJECT` is overridden.

## Runtime Note

`pnpm verify:dev:up` records the actual orchestrator URL in `logs/verify/state/runtime.env`. Later verification commands reuse that detected URL, so they keep working even if the Cloudflare/Vite stack auto-selects a different local port.

## Verified Baseline

As of 2026-04-03, the local baseline is expected to pass end to end with:

- `pnpm verify:dev:up`
- `pnpm verify:smoke`

That baseline now proves all of the following with real calls:

- Gateway health and authenticated gateway project/file/git-status APIs
- Better Auth sign-in and cookie session creation
- Orchestrator project proxying
- Real session creation through `/api/sessions`
- Session completion polling through `/api/sessions/:id`
- Persisted assistant output through `/api/sessions/:id/messages`
- Real browser login through `/login`
- Real browser rendering of `/session/:id`

Important launcher note:

- The orchestrator must keep a live PTY. A detached launch that redirects process output directly to a file can make `/` and `/login` return empty HTML bodies even though the API routes still answer.
- `scripts/verify/dev-up.sh` avoids that by keeping the orchestrator inside tmux and logging with `tmux pipe-pane` instead of shell redirection.
