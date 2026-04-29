# Chain Status

> The rung-ladder primitive that surfaces a kata chain's progress (research → planning → impl → verify → close) inline in the status bar.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign. The five-rung ladder, the per-rung state model, the popover affordance, the auto-advance toggle, and the stall overlay are all visual contracts. A redesign that replaced the ladder with, say, a single arrow-and-label widget would require this doc to change. A stack rewrite that swapped the underlying styling system would not.

## What it is

A compact widget on the per-session status bar, shown only when the session is part of a kata chain. It surfaces *the chain's* progress, not just the viewed session's position — a session viewing the `planning` rung still sees the full ladder with the live frontier highlighted. Clicking a rung that has a backing session rebinds the current tab to that session. Clicking the widget itself opens a popover with chain metadata (issue title, PR number, worktree), per-rung session-status badges, the auto-advance toggle, and the stall reason if one exists.

## Rung model

The chain has five canonical rungs in fixed order: **research, planning, implementation, verify, close.** Every session in a chain carries a `kataMode` that maps to exactly one rung. The widget computes per-rung state by inspecting the chain's session list:

- **completed** — at least one session for this rung has reached the terminal (parked) marker, and the rung is not the active frontier.
- **current** — this rung is the active frontier: either the most-recent non-terminal session lives on this rung, or (fallback) the chain's derived column points to it.
- **future** — no session has been started for this rung yet, and the frontier is on an earlier rung.

Glyphs:

- ● filled circle — completed
- ◐ half-filled circle — current
- ○ hollow circle — future
- ⚠ warning — overlays the *current* rung when a stall has been signalled

A separator arrow `→` is drawn between rungs.

## Visual encoding

- **Completed and current rungs** use the strong foreground color; **future rungs** are muted.
- **The viewed session's rung** carries an underline so the user can see "where I am" inside the ladder.
- **A stalled current rung** flips to the warning color (amber) and shows the ⚠ glyph; the popover surfaces the stall reason in a tinted callout.
- **A running session on the current rung** pulses gently to communicate live activity; idle / waiting sessions don't pulse.
- **Chain complete** (all five rungs completed) appends a small `Complete` label in the success color.

## State transitions

A rung's state changes in response to:

- **A new session is spawned for this rung** — future → current (and the previous current rung either advances to completed or stays current depending on its own session's terminal state).
- **The viewed session reaches the terminal/parked state** — the rung's session is eligible to count as completed; the frontier may move to the next rung if auto-advance fires.
- **A `chain_stalled` event arrives over the WebSocket** — the current rung gains a stall overlay; the popover gains a "Stalled: {reason}" callout. This is the authoritative signal.
- **Mount-time fallback** — if the user reloads onto a parked session and missed the original push, the precondition checker re-runs and may surface a stall reason locally. The WS-pushed reason wins when both are present.
- **The user toggles auto-advance** — affects whether the next rung gets spawned automatically when the current rung parks; does not change the visible rung states by itself.
- **The user clicks a rung in the popover** — if the rung has a backing session and it isn't already the viewed one, the current tab rebinds to that session.

## Where this lives in code

- `apps/orchestrator/src/components/chain-status-item.tsx` — primary implementation.
- `apps/orchestrator/src/lib/auto-advance.ts` — the canonical rung order and `CoreRung` type.
- `apps/orchestrator/src/hooks/use-chain-auto-advance.ts` — per-chain auto-advance toggle, wired through user preferences.
- `apps/orchestrator/src/hooks/use-chain-preconditions.ts` — the mount-time stall-precondition fallback.
- `apps/orchestrator/src/lib/chain-stall-store.ts` — the WS-pushed stall-reason store.
- `planning/specs/16-chain-ux-p1-5.md` — behaviors B3, B4, B5, B8, B9 that this primitive realises.
