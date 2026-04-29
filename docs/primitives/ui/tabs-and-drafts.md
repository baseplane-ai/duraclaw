# Tabs and Drafts

> The collaborative-draft primitive — a per-tab prompt input with multi-user presence, live cursors, and CRDT-merged text.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign. The contract — a tab is a draft, presence is per-tab, edits merge character-by-character, the textarea pin and submit-clears-for-everyone — is the contract every implementation has to honour. A redesign that, say, replaced live cursors with per-character author halos would change this doc. A stack rewrite that swapped the CRDT library would not.

## What it is

The chat input on a session tab is a **collaborative draft**: any authenticated peer connected to the same session sees the same text in real time, can type into it, and can watch the others' cursors. The draft is the single source of truth — there is no localStorage shadow copy, no per-client debounced cache. Submitting clears the draft for every connected client; if the submit fails, the text is restored for everyone.

## Behavior contract

### What a user sees

- **The textarea** — bound to the shared draft text. Local keystrokes apply optimistically. Remote keystrokes appear without yanking the local cursor.
- **A typing indicator** — under the input: "Alice is typing…" while another user is actively typing, with a 2-second idle debounce before it disappears.
- **Live cursors** — for every other connected peer, a thin colored bar at their cursor position with a small name badge above. Selections show as a 20%-opacity range fill in the user's color. Cursors outside the visible scroll viewport are hidden until scrolled into view (avoids floating markers at the edges).
- **A presence bar** — above the chat area, an avatar dot per connected user. Hover shows the full name; > 5 users collapses into "first 4 + N" overflow.
- **Connection states on the input itself** — `connecting` (disabled, "Connecting…" placeholder), `connected` (normal), `disconnected, reconnecting` (still editable, the provider buffers locally), `auth-expired` (disabled, "Session expired — please reload"), `error` (disabled, "Connection error — retrying…").

### Tab affordances — a tab IS a draft

- **One tab, one session, one draft.** The draft text lives with the session, not with the user; a different user opening the same session sees the same draft.
- **Closing a tab archives the draft** in the sense that it stops contributing presence and stops broadcasting cursor updates. The text itself persists at the session level — the draft survives hibernation, eviction, and worker restarts (snapshotted on last-client-disconnect, restored on next connect).
- **Presence is per-tab.** Only the currently focused tab holds an active provider connection; backgrounded tabs disconnect to stay under per-browser connection limits.
- **Active-tab indicator (ghost presence).** When a peer switches away from a session, their avatar fades out over five seconds in the presence bar of that session, with tooltip "Left recently." When they return, they reappear. There is no persistent "dimmed" state — peers are present, fading, or gone.

### Submit flow

1. Snapshot the draft text.
2. Optimistically clear the draft in a single transaction — every connected client sees the textarea empty instantly.
3. Call the per-session send API.
4. On success — the message arrives in chat history through the regular session-broadcast channel.
5. On failure — re-insert the original text into the draft. Every client sees it reappear; a toast notification reads "Failed to send — draft restored."

### Concurrent submit guard (two layers)

- **UI hint:** a `submitting` flag on a shared metadata map, set by the first sender. The second sender sees "Someone else is sending…" and their click is ignored. Best-effort; not a mutex (two near-simultaneous clicks both succeed at setting the flag).
- **Server-side idempotency:** the submit call carries a client-generated submit-id; the server records ids in a short-TTL table and returns success without duplicating a message if the same id arrives twice.

## Conflict model

The draft is a CRDT text type. Concurrent edits merge under standard yjs semantics: each character carries a stable identity, so two users typing at different positions interleave without conflict; two users editing the same character region get a deterministic merge (effectively last-writer-wins per character) that is the *same* on every client. Cursor positions are broadcast as relative positions inside the text type, so they survive concurrent inserts/deletes — a cursor "after the word `hello`" stays after `hello` regardless of what other clients did to the surrounding text.

The draft text type holds plain text only; the chat surface intentionally does not run rich-text inside the collaborative input. Rich-text collaboration is a separate primitive (rich docs / blocknote-class) and out of scope here.

## Where this lives in code

- `apps/orchestrator/src/hooks/use-session-collab.ts` — primary client hook (provider connect, awareness, draft observe).
- `packages/ai-elements/src/components/prompt-input.tsx` — the textarea component the draft binds into.
- `apps/orchestrator/src/components/typing-indicator.tsx` — typing-indicator component.
- `apps/orchestrator/src/components/cursor-overlay.tsx` — live cursor overlay.
- `apps/orchestrator/src/components/presence-bar.tsx` — presence bar.
- `apps/orchestrator/src/agents/session-collab-do.ts` — server-side per-session collab Durable Object (snapshot on last-disconnect, restore on first-connect).
- `planning/specs/3-yjs-multiplayer-draft-collab.md` — behaviors B1–B9 that this primitive realises.
