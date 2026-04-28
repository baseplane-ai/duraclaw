# GH#125 P1a — before-screenshots

Visual baseline of the orchestrator UI captured against production
(`https://dura.baseplane.ai`) at `main` HEAD, **pre-Tamagui spike**. The
intent is for a human to eyeball-diff these against post-P1a state.

## Capture metadata

- **Date captured:** 2026-04-28
- **Source URL:** https://dura.baseplane.ai (prod, live deployment)
- **Branch:** `main` (pre-spike)
- **`origin/main` HEAD SHA at capture time:** `96834e416a37c29ddb0530c8030e4947544ed27c`
- **Test user:** `agent.verify+prod@example.com` (seeded admin from `.env.test-users.prod`)
- **Tooling:** `scripts/axi` (chrome-devtools-axi via per-worktree wrapper, headless)
- **Viewport:** chrome-devtools-axi default (1280x720 headless)

## Per-flow status

| # | File | Status | Notes |
|---|------|--------|-------|
| 1 | `01-login.png` | OK | Sign-in screen, captured pre-credentials. |
| 2 | `02-sessions-list.png` | OK | `/` post-login. Sidebar shows Recent / Worktrees / Admin sections. Main panel is the "What should the agent do?" new-session composer (root with no `?session=` param renders the create form, not a separate list page — `/sessions` 404s). |
| 3 | `03-session-detail.png` | OK | Opened first recent session ("Any settings UI? duraclaw-dev2", `sess-fc6362e4-…`). Shows full chat history with collapsed tool-call rows. |
| 4 | `04-message-sent.png` | OK | Sent benign message "hello" via the composer; captured ~5s post-submit. The session was idle so the runner had to resume; capture is during/just-after submit. |
| 5 | `05-settings-light.png` | OK | `/settings` with Theme set to **Light** explicitly via the Appearance combobox. Page is scrolled so Appearance section is in view. |
| 6 | `06-settings-dark.png` | OK | Same page with Theme set to **Dark** (selected via combobox keyboard navigation — direct option click on listbox didn't register, ArrowDown+Enter worked). |
| 7 | `07-header-theme-toggle.png` | **SKIPPED** | No header theme toggle is rendered in the current UI. The `<ThemeSwitch>` component exists at `apps/orchestrator/src/components/theme-switch.tsx` but is **not imported anywhere** (verified via grep). The header banner contains only "Toggle Sidebar" + "Notifications" + the user-menu (`AG …`) trigger; the user menu only exposes Settings / Sign out, no theme entry. The only theme control in production today is the combobox on the Settings page (captured in #5/#6). |
| 8 | `08-file-viewer.png` | OK | Closest analog to a "file viewer" is the per-tool-call detail dialog. Captured by clicking "Show 1 Read call" on a chat turn — opens a modal with file path, parameters, and result/error content. The app does not have a standalone file-browser/viewer route (DocsFileTree exists at `/projects/:projectId/docs` but for markdown, not arbitrary files). |
| 9 | `09-kanban.png` | OK | `/board` route. Kanban with TASK / RESEARCH / PLAN / IMPL / VERIFY / DONE columns; cards are draggable issue tiles with action buttons. |
| 10 | `10-signed-out.png` | OK | Sign-out via user menu → confirm dialog → redirect to `/login`. Capture is the post-redirect login page (visually identical to #1, but separately captured per spec). |

## Visual anomalies / observations

- The settings page has a hard-coded width and the captured viewport
  (1280x720 headless) leaves significant empty space to the right of the
  Appearance section. Not a bug, but worth noting for diff comparison.
- `04-message-sent.png` shows the Idle status indicator and the optimistic
  user turn but no assistant response yet (5s window elapsed without an
  assistant turn — the runner was resuming from kill, which can take >5s).
- `10-signed-out.png` is ~1.3 MB (notably larger than `01-login.png` at
  819 KB) — likely because it captured during the post-logout redirect
  with the sidebar / app shell briefly still rendered. Visually the
  active view is the login screen.
- The header is dense: Skip-to-Main link, Duraclaw home link, sidebar
  sections (Recent, Worktrees, Admin), the user-menu trigger, and a
  separate "Toggle Sidebar" button. This is the area most likely to
  differ post-Tamagui.

## Bridge note (operational)

The chrome-devtools-axi bridge hung twice during capture (after
multi-second `wait` calls and `click` on session-list items). Recovery
is `scripts/axi stop` → `scripts/axi start` → re-`open` → re-login. The
per-worktree user-data-dir (`/tmp/duraclaw-chrome-duraclaw-dev6`)
persisted cookies across the restart, so re-login was not strictly
required but was performed for hygiene. This is informational for the
post-P1a re-capture run; it does not affect the captured baseline.
