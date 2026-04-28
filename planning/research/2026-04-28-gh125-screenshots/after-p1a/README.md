# GH#125 P1a — after-p1a screenshots

Visual capture of the orchestrator UI from the **post-P1a Tamagui-migrated**
branch, intended to be human-eyeball-diffed against `before/` (which was
captured against prod `main` HEAD pre-spike).

## Capture metadata

- **Date captured:** 2026-04-28
- **Source:** local dev (`http://127.0.0.1:43236`, miniflare via
  `scripts/verify/dev-up.sh`)
- **Branch:** `feature/125-tamagui-orchestrator`
- **HEAD SHA at capture time:** `2fc4cdd` (`chore(orchestrator): GH#125 P1a — capture before-screenshots from prod baseline`)
- **Test user:** `agent.verify+duraclaw@example.com` (admin, seeded via
  `/api/bootstrap`)
- **Tooling:** `scripts/axi` (chrome-devtools-axi via per-worktree wrapper, headless)
- **Viewport:** chrome-devtools-axi default (1280x720 headless)
- **Working-tree hygiene:** the user had ~7 uncommitted P1b-in-progress
  files in the working tree at session start (extract:true in
  vite.config.ts, a 524-line sidebar.tsx rewrite, tamagui.config.ts edits,
  etc.). Those were stashed before the canonical capture pass so the
  screenshots reflect committed HEAD only; the stash was restored after
  capture.

## Headline finding — the branch is broken at HEAD

**Every authenticated route renders a runtime error overlay**, not the
intended UI:

```
Something went wrong!
`CollapsibleContent` must be used within `Collapsible`
```

The error originates from
`apps/orchestrator/src/components/ui/collapsible.tsx` (the Tamagui port
of the shadcn Radix-Collapsible wrapper). Wrapping
`CollapsiblePrimitive.CollapsibleContent` in Tamagui's `styled(...)`
appears to break Radix's internal context provider chain — the child
`CollapsibleContent` no longer sees the parent `Collapsible`'s context
and throws on mount. Affected callers include `nav-sessions.tsx` (Recent
+ Worktrees sections of the sidebar) and `nav-group.tsx`. Because the
sidebar mounts inside the root layout, **every authed route inherits the
crash** — sessions list, session detail, settings, board, etc.

Before this regression is fixed, post-P1a vs pre-P1a visual diffing on
authed routes is impossible from local dev. The error overlay screenshots
ARE the post-P1a-as-shipped-on-this-branch state.

## Per-flow status

| # | File | Status | Notes |
|---|------|--------|-------|
| 1 | `01-login.png` | OK (renders cleanly) | Sign-in screen pre-credentials. Login route does not mount the sidebar / Collapsible, so it survives. Visually nearly identical to `before/01-login.png`. |
| 2 | `02-sessions-list.png` | **ERROR** | Post-login `/` crashes at root with the CollapsibleContent error. Captured the error overlay. |
| 3 | `03-session-detail.png` | **ERROR** | `/?session=...` — same root crash, never reaches session-detail render. Captured the error overlay. |
| 4 | `04-message-sent.png` | **ERROR** | Cannot send a message — the composer is unreachable behind the crashed root. Captured the error overlay. |
| 5 | `05-settings-light.png` | **ERROR** | `/settings` — same root crash. Captured the error overlay. |
| 6 | `06-settings-dark.png` | **ERROR** | Same as 05 (toggling theme would require a settings page that never renders). File is a copy of 05 since the rendered state is byte-identical (error overlay has no theming). |
| 7 | `07-header-theme-toggle.png` | **SKIPPED** | Per before/ finding — `<ThemeSwitch>` exists but is not imported anywhere in the layout. Skipping matches the before/ skip. |
| 8 | `08-file-viewer.png` | **ERROR** | Cannot click into a tool-call detail dialog — the chat thread is unreachable behind the crashed root. Captured the error overlay. |
| 9 | `09-kanban.png` | **ERROR** | `/board` — same root crash. Captured the error overlay. |
| 10 | `10-signed-out.png` | OK | Signed out via API (`POST /api/auth/sign-out`) since the in-app user-menu trigger ALSO crashes on click (Radix Dropdown has the same Tamagui-styled context-loss issue). Captured the post-redirect login page; visually identical to `01-login.png`. |

## Visual observations vs `before/`

- **`01-login.png`** — visually nearly identical to `before/01-login.png`.
  Login form layout, "ACCESS" / "Sign in" headers, button styling all
  appear unchanged. File size 813 KB after vs 819 KB before — within
  PNG-encoder noise. No obvious regression on the unauthenticated route.
- **`10-signed-out.png`** — same as 01. (`before/10-signed-out.png` is
  1.3 MB and contains the briefly-rendered sidebar shell; in our capture
  the redirect happens cleanly with no shell visible. Slight difference
  but explained by the API-driven sign-out path.)
- **All authed routes (02-09)** — N/A. Direct visual comparison is
  impossible because the post-P1a state is the error overlay. The
  73 KB file size is uniform (same overlay text rendered on a near-empty
  body) and the pixel content is essentially identical across routes —
  only the URL differs (and URL bar isn't in the headless screenshot).

## Subjective deltas (where comparable)

Limited to login screens (1 + 10) since those are the only successfully
rendered surfaces:

- Form inputs — same border radius, same padding, same focus behavior
  (didn't see in static capture but no error in axi snapshot).
- "Sign In" button — visually identical, no detectable Tamagui-vs-shadcn
  rendering difference.
- Background — no visible difference.
- Typography — no visible difference (font, size, weight).

So at minimum the auth-page primitives (Button, Input, Label, Card)
survived the migration without visible regression. The breakage is
specific to the Collapsible component's context flow, not to surface-level
styling.

## Reproducer for the human reviewer

To reproduce the runtime error locally:

```bash
cd /data/projects/duraclaw-dev6
git checkout 2fc4cdd
# Stash any local diffs first if your working tree has P1b-in-progress
unset NODE_ENV
bash scripts/verify/dev-up.sh
# In another shell:
scripts/axi open http://127.0.0.1:43236/login
# fill creds, click Sign In, observe error overlay on /
```

Or directly inspect the error in the React tree by clicking the user-menu
trigger on the (cached, working) root layout — the `DropdownMenu` Tamagui
wrapper crashes on first mount with the same context-loss pattern.

## Operational notes

- The dev server itself (Vite + miniflare) booted cleanly. The bootstrap
  POST to seed the test user returned 500 (the user already existed from
  a prior session — sign-in worked directly).
- One observed transient: running with stale Vite caches after a
  vite.config.ts toggle (extract:true → false) produced a separate
  `Failed to resolve import .../table.tsx.tamagui.css` error. Cleared
  with `rm -rf apps/orchestrator/node_modules/.vite` and a tmux orch
  restart. Not part of the headline regression.
- `scripts/axi` was restarted twice during capture (`stop` → `start` and
  one `rm -rf /tmp/duraclaw-chrome-duraclaw-dev6` to drop the cached
  authed cookie state). No bridge hangs observed this run.
