---
date: 2026-04-12
topic: UX Ergonomics Improvements
type: brainstorm
status: complete
github_issue: null
items_researched: 14
---

# Research: UX Ergonomics Improvements

## Context

The duraclaw orchestrator UI needs to feel as fluid as the best chat apps and dev tools. This research pulls patterns from WhatsApp, Telegram, Slack, Discord, Claude.ai, Cursor, Linear, and VS Code — then maps them onto duraclaw's session orchestration UX.

## Current Duraclaw UX Gaps

The UI today has friction at every step: starting a session requires a form, switching between sessions takes multiple clicks, status is buried in a per-session header, settings is an empty page, and there's no keyboard-first navigation. It feels like a CRUD app, not a chat-native tool.

---

## Part 1: Patterns from External Apps (New Findings)

### P1. Quick Switcher / Command Palette (Cmd+K)

**Pattern:** Slack, Discord, Linear, and Cursor all use Cmd+K for a universal fuzzy-search launcher. Slack optimized theirs to open in 7ms and render results in 12ms. Linear routes every action through it — create, navigate, search, run commands.

**Why it works:** Eliminates the "where is that?" problem. Power users never touch the mouse. Casual users discover features by typing naturally.

**Application to duraclaw:**
- **Cmd+K** opens a command palette with sections:
  - **Sessions** — fuzzy search by title, project, prompt text, tag
  - **Projects** — jump to a project and optionally start a new session
  - **Actions** — "New session", "Stop all", "Toggle permission mode", "Open settings"
  - **Recent** — last 5 sessions, prioritized like Slack's Quick Switcher
- Replaces the need for the session search bar, status filter, and spawn form as separate UI elements
- The existing `CommandMenu` component (`components/command-menu.tsx`) exists but isn't connected to sessions

**Source:** [Slack Quick Switcher Engineering](https://slack.engineering/a-faster-smarter-quick-switcher/), [Superhuman Command Palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)

---

### P2. Zero-Friction New Chat (Telegram / Claude.ai Pattern)

**Pattern:** In Telegram, tapping the compose button immediately opens a blank chat — you type and go. Claude.ai's "New chat" is a single click; you're immediately in the text input. No forms, no dropdowns, no "select model" step. Defaults handle everything.

**Why it works:** The #1 action (start chatting) should be the #1 fastest action. Every form field between intent and action is abandonment risk.

**Application to duraclaw:**
- **New Session = one click + type prompt.** That's it.
- Project defaults to: (a) last-used project, or (b) workspace default, or (c) first available worktree
- Model defaults to user preference (stored in settings)
- Permission mode defaults to user preference
- The `SpawnAgentForm` with its dropdowns becomes an **advanced options** expandable, not the primary flow
- The prompt textarea IS the new session creator — like ChatGPT's empty-state input:

```
┌──────────────────────────────────────────────┐
│  What should the agent do?                   │
│  ________________________________________    │
│  [baseplane-dev1] [opus-4-6] [bypass]  ↓    │  <- inline chips, not a form
└──────────────────────────────────────────────┘
```

- Clicking a chip cycles through options; right-click or long-press for full list
- Start typing and hit Enter — session spawns immediately

---

### P3. Chat List as Primary Navigation (WhatsApp / iMessage)

**Pattern:** WhatsApp and iMessage treat the conversation list as the app's main screen. Each row shows: avatar/icon, name, last message preview, timestamp, unread badge, and delivery status (tick marks). Swipe gestures enable quick actions (archive, pin, mute).

**Why it works:** Glanceability — you can assess the state of 20 conversations in 2 seconds. No clicking into each one.

**Application to duraclaw:**
The `SessionSidebar` should become a WhatsApp-style chat list:

```
┌─ Sessions ───────────────────────────┐
│ 🟢 Implement auth middleware    2m   │  <- green dot = running
│    baseplane-dev1 · 14 turns         │
│    "Adding JWT validation to..."     │  <- last message preview
│                                      │
│ ⏸ Fix CI pipeline             12m   │  <- pause icon = waiting_gate
│    duraclaw-dev2 · 3 turns           │
│    Waiting: approve file edit        │  <- gate reason as preview
│                                      │
│ ⚪ Research caching            1h    │  <- grey = idle
│    baseplane-dev3 · 42 turns         │
│    Completed · $1.23                 │  <- result summary
└──────────────────────────────────────┘
```

Key changes from current:
- **Last message/action preview** — show what the agent is doing or last said (truncated)
- **Status as icon, not badge** — colored dot (running=green, gate=yellow, idle=grey, error=red)
- **Swipe actions** — swipe left to archive, swipe right to pin/star
- **Long-press context menu** — rename, tag, fork, archive (replaces the `...` dropdown)
- **Cost/turns as secondary text** — always visible, not buried in detail view
- **Unread indicator** — if the session produced output since you last viewed it

---

### P4. Presence Dots & Delivery Ticks (WhatsApp / Slack)

**Pattern:** WhatsApp's tick system (✓ sent, ✓✓ delivered, blue ✓✓ read) communicates message state without text. Slack's presence dots (green=active, hollow=away) show status at a glance.

**Why it works:** Pre-attentive processing — the brain processes color and shape before reading text. A green dot is faster to parse than the word "running".

**Application to duraclaw:**
- **Session status dots** in the sidebar (already partially there, but make them bigger and more prominent):
  - 🟢 Solid green = running
  - 🟡 Yellow = waiting for input (gate/question)
  - ⚪ Grey outline = idle (resumable)
  - 🔴 Red = error/failed
  - 🔵 Blue pulse = spawning/connecting
- **WS connection indicator** in status bar (not per-session — it's a global state)
- **Activity animation** — subtle pulse or spinner on the green dot when actively streaming

---

### P5. Agent Tabs / Split View (Cursor Pattern)

**Pattern:** Cursor lets you run multiple agent conversations in parallel tabs (Cmd+T for new tab). You can view them side-by-side. Each tab is independent.

**Why it works:** When orchestrating 3-6 agents simultaneously, you need to monitor multiple streams. Tabbing through a single view loses context.

**Application to duraclaw:**
- **Tab bar** above the chat area showing active sessions as tabs
- **Cmd+T** to open current session in a new tab
- **Cmd+1/2/3** to switch between tabs (like browser tabs)
- **Split view** — drag a tab to the right to get a 2-panel view (side-by-side agents)
- Tabs show: session name + status dot + optional "unread" badge
- This complements the sidebar — sidebar is the full list, tabs are your "working set"

---

### P6. VS Code Status Bar (Bottom, Not Top)

**Pattern:** VS Code's status bar sits at the very bottom. Left side = workspace info (branch, errors, warnings). Right side = contextual info (language, encoding, line/col). Items are clickable to toggle or change settings. Background color changes for special states (debugging = orange, remote = green).

**Why it works:** The bottom of the screen is stable real estate — content above scrolls, but the status bar is always there. It's the "ground truth" layer.

**Application to duraclaw:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ● idle │ baseplane-dev1 │ opus-4-6 │ 42 turns │ $1.23 │ ctx: 34%  │  ← left: session info
│                                                    bypass │ kata: impl/p2 │  ← right: mode info
└─────────────────────────────────────────────────────────────────────┘
```

- **Color-coded background** like VS Code:
  - Default (dark grey) = idle
  - Blue = running
  - Orange = waiting gate/input
  - Red = error
- Every item is **clickable**:
  - Click project name → switch project
  - Click model → change model
  - Click permission mode → cycle through modes
  - Click kata status → expand kata panel
- **Disappears when no session selected** (or shows "No session" in muted text)

---

### P7. Claude.ai Projects = Workspaces

**Pattern:** Claude.ai organizes conversations into "Projects" — folders containing multiple chats plus reference documents. Projects appear in the sidebar above individual conversations. Switching projects filters the chat list.

**Why it works:** Groups related work without losing individual conversation access. The mental model is "folder of chats" not "database with filters".

**Application to duraclaw:**
- **Workspaces in the sidebar** above the session list:
  ```
  ┌─ Workspaces ──────────┐
  │ ▸ Baseplane (4)       │  <- 4 active sessions across dev1-dev6
  │ ▸ Duraclaw (1)        │
  │ ▸ Personal (0)        │
  └───────────────────────┘
  ```
- Clicking a workspace **filters** the session list to that workspace's projects
- "All" shows everything (default)
- Workspace = auto-grouped by git remote origin, user can rename
- Each workspace has its own defaults (model, permissions, budget)
- This replaces the current hardcoded `TeamSwitcher`

---

### P8. Inline Reply & Quick Actions from Notifications

**Pattern:** iOS/Android notifications support inline reply (type a response without opening the app). Slack notifications include "Mark as read" and "Reply" actions.

**Application to duraclaw:**
Push notification actions:
- **Reply** — inline text reply, POSTed to session (resumes if needed)
- **Approve** — for permission_request gates, one-tap approve
- **Open** — open session in browser
- **Stop** — abort the session

---

## Part 2: Duraclaw-Specific Fixes

### F1. Session Status Bug — `completed` Should Be `idle`

Sessions show `completed` after finishing. The SDK uses `idle` for finished-but-resumable sessions. The `ResultEvent` handler in `session-do.ts` likely sets `completed` — should set `idle`.

### F2. Notification Links — 404 on Click

Two competing URL schemes: `/?session={id}` (AgentOrchPage) vs `/session/{id}` (route file). Notifications probably generate `/session/{id}` but the app uses search params. Fix: make `/session/{id}` the canonical URL.

### F3. Settings Page Is Empty

Currently just a sign-out button. Needs: permission mode default, model default, budget default, notification preferences, appearance settings (move from config drawer), workspace management.

---

## Comparison Matrix

| Pattern | Source | Impact | Effort | Priority |
|---|---|---|---|---|
| Quick Switcher (Cmd+K) | Slack/Linear/Cursor | High — keyboard-first | Medium | P0 |
| Zero-friction new chat | Telegram/Claude.ai | High — removes biggest friction | Medium | P0 |
| Status bar (bottom) | VS Code | High — foundational | Medium | P0 |
| Chat-list session sidebar | WhatsApp/iMessage | High — glanceability | Medium | P0 |
| Presence dots & status icons | WhatsApp/Slack | Medium — visual clarity | Low | P0 |
| Permission mode defaults | Settings UX | High — daily friction | Low | P0 |
| Session status fix (idle) | Bug fix | Medium — correctness | Low | P0 |
| Notification link fix | Bug fix | Medium — broken feature | Low | P0 |
| Workspace grouping | Claude.ai Projects | High — org/scale | High | P1 |
| Agent tabs / split view | Cursor | High — multi-agent monitoring | High | P1 |
| Notification reply/actions | iOS/Slack | Medium — convenience | Medium | P2 |
| Kata status in status bar | VS Code extensions | Medium — visibility | Low | P1 |

## Recommendations

1. **The "chat-native" bundle (P0):** Quick switcher + zero-friction new chat + chat-list sidebar + status bar + presence dots. These 5 patterns together transform the UX from "form-driven CRUD app" to "chat-native orchestrator". Ship as one cohesive update.

2. **Settings + defaults (P0):** Permission mode, model, budget defaults in settings. Applied automatically on new session. Eliminates spawn form friction.

3. **Bug fixes (P0):** Status `completed`→`idle`, notification link routing. Quick wins, do immediately.

4. **Workspaces (P1):** Requires gateway changes (repo_origin), new storage, sidebar rework. Spec separately.

5. **Tabs + split view (P1):** Power-user feature for monitoring multiple agents. Spec separately after the chat-native bundle ships.

## Key Insight

The biggest UX win isn't any single pattern — it's the **shift from form-driven to chat-driven interaction**. Today, starting a session means: click New → fill form → select project → select model → type prompt → click Spawn. The target is: type prompt → Enter. Everything else is defaults or discoverable through Cmd+K. That's the WhatsApp/Telegram lesson applied to agent orchestration.

## Sources

- [Slack Quick Switcher Engineering](https://slack.engineering/a-faster-smarter-quick-switcher/)
- [Superhuman: How to Build a Command Palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- [Command Palette UX Patterns (Medium)](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)
- [Telegram UI/UX Design Deep Dive](https://createbytes.com/insights/telegram-ui-ux-review-design-analysis)
- [WhatsApp UX Breakdown](https://www.uxsnaps.com/chat-interface)
- [Chat App Design Best Practices (CometChat)](https://www.cometchat.com/blog/chat-app-design-best-practices)
- [VS Code Status Bar UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [Linear UI Redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Cursor Features](https://cursor.com/features)
- [Claude.ai Projects](https://www.anthropic.com/news/projects)
- [Chat UI Design Ideas 2026 (Muzli)](https://muz.li/inspiration/chat-ui/)
- [Command Palette UI Design (Mobbin)](https://mobbin.com/glossary/command-palette)
