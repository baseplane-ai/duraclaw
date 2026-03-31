---
date: 2026-03-31
topic: Scope Narrowing — Remote Workbench
status: complete
github_issue: null
---

# Research: Scope Narrowing

## Decision

Drop the orchestration layer entirely. Duraclaw becomes a **remote workbench** with five capabilities:

1. **Folder management** — worktree allocation, locks, status visibility
2. **Session tracking** — which sessions exist, where they're running, history
3. **CLI chat mirror** — live view of Claude Code session output
4. **Interactive chat** — send messages/answers to the CLI session from the browser
5. **Project file browser** — browse and view files in each worktree

## What's Out

- Task queuing / scheduling
- Prompt curation / context injection
- End-of-session eval loops
- Session chaining (plan → implement → verify)
- Cross-session coordination
- SDK execution (no running the Agent SDK ourselves)

## What's In

### Folder Management
- List available worktrees and their state (free, locked, by whom)
- Lock/unlock worktrees for sessions
- Show git status per worktree (branch, dirty state, recent commits)

### Session Tracking
- Register active CLI sessions against worktrees
- Track session metadata (start time, model, cost if available)
- Session history (past sessions, what worktree, duration)
- Session state (running, paused, completed)

### CLI Chat Mirror
- Live stream of Claude Code conversation output
- Useful for monitoring multiple concurrent sessions from one place
- Could work via CLI hook that forwards messages, or tailing session logs

### Interactive Chat
- Send messages to the running CLI session from the browser
- Answer AskUserQuestion prompts remotely
- Provide follow-up instructions without needing terminal access
- Requires bidirectional channel between browser → DO → VPS → CLI

### Project File Browser
- Browse the file tree of any worktree from the browser
- View file contents (read-only)
- See git status per file (modified, staged, untracked)
- Useful for reviewing what a session has changed without SSH

## Architecture Implications

```
Browser → TanStack Start (CF Worker) → Durable Objects
                                          ├─ WorktreeRegistry DO (singleton)
                                          └─ Session DO (1 per session)
                                                ├─ chat mirror (WS to browser)
                                                ├─ input relay (browser → CLI)
                                                └─ file browse requests

VPS (cc-gateway):
  ├─ Claude Code CLI (user-started or gateway-spawned)
  ├─ Event bridge (CLI hooks → DO via WebSocket)
  ├─ File server (read-only file tree + contents API)
  └─ Worktrees (baseplane-dev1..dev6)
```

Key change: **no SDK execution on our side**. The user runs Claude Code themselves (or the gateway spawns it). We mirror, relay input, and serve files.

### VPS Component Simplifies Dramatically

The cc-gateway package goes from "SDK executor" to "event bridge + file server":
- Forwards CLI session output to the DO (via hooks or log tailing)
- Relays user input from DO back to the CLI (stdin pipe or API)
- Serves file tree listings and file contents for the browser
- Reports worktree status (git branch, dirty state, locks)
- No Agent SDK dependency, no command execution protocol

### What Stays from Current Codebase

- `SessionRegistry` DO → becomes `WorktreeRegistry` (worktree locks, index)
- `SessionAgent` DO → becomes lighter, just mirrors chat + tracks metadata
- TanStack Start frontend → dashboard UI
- Better Auth → still needed for the dashboard

### What Gets Removed

- VpsCommand/VpsEvent protocol (no SDK execution)
- Claude Agent SDK dependency
- Session execution logic in cc-gateway
- Kata workflow phases (overkill for a dashboard)

## Decided

- **Transport**: Live WebSocket streaming (browser ↔ DO ↔ VPS)
- **CLI reporting**: Claude Code hooks for events (post-tool, post-message, etc.)
- **Chat direction**: Bidirectional — mirror output + send input
- **File access**: Read-only browse/view via cc-gateway HTTP API

## Open Questions

1. **Hook payload design** — What data do hooks send? Full message content, or just event type + ID with content fetched on demand?
2. **File browser scope** — Just the worktree root, or also allow navigating outside (e.g., `~/.claude/` for session data)?

## Notes

- CLI input relay is already solved: cc-gateway spawns the CLI, owns the WebSocket per session, and accepts input as a post/message on the existing session ID. No new mechanism needed.
- `~/.claude/` home dir stores full session history for all sessions (managed or manual). Gateway can discover and monitor any session on the VPS.
- Can send messages to any session using its session ID — same mechanism regardless of who started it. No managed/monitored distinction in capabilities, only in who spawned the process. All sessions get full bidirectional chat from the browser.

## Next Steps

- Strip cc-gateway down to a status/event reporter
- Redesign the DO layer for monitoring, not execution
- Prototype the CLI-to-DO reporting mechanism (hooks vs. sidecar)
- Build the dashboard UI (worktree grid + session chat view)
