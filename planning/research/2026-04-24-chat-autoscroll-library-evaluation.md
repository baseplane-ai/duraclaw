# Chat Auto-Scroll: Library Evaluation vs. Our Custom System

**Date:** 2026-04-24
**Type:** Library/tech evaluation + inspiration cataloging
**Status:** Complete — recommendation at end
**Related code:** `packages/ai-elements/src/components/conversation.tsx`, `apps/orchestrator/src/features/agent-orch/ChatThread.tsx` (`VirtualizedMessageList`)

## Problem statement

User feedback: "Our current auto-scroll system still sucks." Despite 8+
iterations of fixes (see git log below), we keep hitting edges. This doc
evaluates what the best open-source AI chat UIs do, compares their
algorithms line-by-line with ours, and recommends a path forward.

## TL;DR

1. **Adopt `use-stick-to-bottom`** (StackBlitz, MIT, powers bolt.new,
   Vercel AI Elements, shadcn/ui `Conversation`, prompt-kit) as the
   pin-to-bottom primitive. Our custom hook has the right *shape* but is
   missing four mechanisms that cause the "sucks" tail: spring animation,
   text-selection guard, content-shrink anchoring, and a proper
   programmatic/user scroll tokenizer.
2. **Wire TanStack Virtual's built-in
   `shouldAdjustScrollPositionOnItemSizeChange`** so the virtualizer
   stops fighting the user during streaming at the layer where the fight
   actually happens (item-size change → scroll shift). We don't currently
   use this API at all.
3. **Kill the settle-gate** (`visibility: hidden` until 2 stable rAFs).
   It's a workaround for a problem the library solves via its `initial`
   mode + scroll-anchoring math; once the pin-to-bottom primitive is
   right, the jitter source is gone.
4. **Add a 50vh bottom padding on the last message** (Hakim pattern).
   Free UX win, zero algorithmic complexity. Streaming text no longer
   hugs the compose bar.

Migration is 1–2 days of work, net LOC *removed*, and the library's
algorithm has been battle-tested at bolt.new scale (millions of streaming
tokens/day).

---

## 1. Current state: what we have today

### Algorithm (conversation.tsx:57–234)

Single flag `pinnedRef` with three transition paths:

1. **Mount** — `useLayoutEffect` sets `scrollTop = scrollHeight - clientHeight`
   before paint. Guarded by `el.scrollTop === 0` to survive Android WebView
   concurrent-commit re-fires every ~430ms
   (memory: `project_react_layout_effect_refire.md`).
2. **User scroll** — `scroll` event listener with direction check:
   upward motion → unpin; downward motion within 70px of bottom → re-pin.
   Wheel / touchstart / touchmove listeners fire *before* `scroll` to win
   the race vs. programmatic writes (mobile WebView compositor lags the
   scroll event).
3. **Our own writes** — `programmaticRef` flag set during `pinNow()`,
   cleared on next rAF, filters out self-induced scroll events.

**Content growth** — `ResizeObserver` on content; on positive delta and
`pinnedRef === true`, schedule rAF → re-check flag → `pinNow()`.

**Virtualizer layer (ChatThread.tsx:889–1052):**
- `@tanstack/react-virtual` with `estimateSize: 160`, `overscan: 6`.
- **Settle gate** — list is `visibility: hidden` until `scrollHeight`
  stable for 2 consecutive rAFs (100ms fallback). Prevents visible
  estimate→measurement swap jitter.
- On reveal, `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })`
  instead of raw `scrollTop = scrollHeight`, because the latter reads the
  *estimated* total when many rows are still at 160px.

### Recent git log on these files

```
e3c7c1b fix(chat): use virtualizer.scrollToIndex for initial scroll-to-bottom
26ff376 fix(chat-thread): flush scroll button to bottom
a4d2c54 fix(ai-elements): direction-aware scroll + wheel/touch listeners
4811985 19ce7f6 1c5c10a a807cf2 77c8335   (scroll-button positioning / rAF re-check)
aefe016 fix(chat): hide virtualized list until scrollHeight settles
3095762 fix(chat): eliminate remount jitter via per-session cache (later removed)
8d028a4 perf(chat-thread): virtualize message list with @tanstack/react-virtual (#55)
4ddb9c6 revert: drop Virtuoso (#55)   ← already tried & abandoned Virtuoso
```

### Known failure modes the code is aware of

1. Mount jitter from estimate→measurement swap (settle gate exists)
2. Scroll-up during streaming vs. ResizeObserver re-pin (wheel/touch race)
3. Part-mutation flicker (memo comparator scans full parts)
4. Mid-turn gate visibility (gate hoisted to end of turn)
5. Virtualizer estimated-total bottom miss (`scrollToIndex` fix)
6. Android WebView layout-effect re-fire (`scrollTop === 0` guard)
7. Long-thread reconnect history burst (handled by RO growth path)

### Failure modes the code is **not** aware of

8. **Text selection kills stickiness** — if user is mid-drag selecting
   text across a streaming message, every `pinNow()` call yanks the
   selection out from under them. No guard.
9. **Content shrink** (rewind / branch-navigate / resubmit clears tail) —
   RO fires negative delta; we `return` without adjusting scroll anchor,
   so pinned users end up no longer pinned after a rewind.
10. **Spring-less snap during streaming** — `scrollTop = scrollHeight`
    on every delta. For fast token streams this looks like a jitter
    even when perfectly correct, because the eye sees discrete jumps.
11. **Programmatic/user scroll tokenizer is weak** — single-frame rAF
    clear of `programmaticRef`. On slow devices or contended main
    thread, the real scroll event can fire *after* the clear, getting
    misinterpreted as user intent. Symptom: random unpin mid-stream.
12. **No scroll anchoring during resize** — when content below the
    viewport grows (rare but happens with branch snapshots), we have no
    correction. Library solves this via `targetScrollTop` clamp.

Items 8–12 are the most likely sources of "still sucks."

---

## 2. Industry state of the art

### 2.1 `use-stick-to-bottom` (StackBlitz, MIT)

**Who uses it:** bolt.new (production), Vercel AI SDK Elements
`<Conversation>`, shadcn/ui `<AIConversation>`, prompt-kit `<ChatContainer>`.
Essentially *every* polished open-source AI chat UI in 2026 converges here.

**Core algorithm (from source reading):**

```
const STICK_TO_BOTTOM_OFFSET_PX = 70      // same as our NEAR_BOTTOM_PX
const SIXTY_FPS_INTERVAL_MS      = 16.67
const RETAIN_ANIMATION_DURATION_MS = 350

// Spring physics (defaults)
damping   = 0.7
stiffness = 0.05
mass      = 1.25

// Per-frame loop
velocity   = (damping * velocity + stiffness * scrollDifference) / mass
accumulated += velocity * tickDelta
scrollTop  += accumulated
```

**Five mechanisms worth stealing:**

1. **Velocity-based spring animation.** Unlike `behavior: 'smooth'`
   (duration + easing), a spring adapts to variable-size streaming
   content. New chunk arrives → `scrollDifference` grows →
   velocity ramps → scroll accelerates → settles. Looks cinematic;
   hides jitter.
2. **Text-selection guard.** Every frame checks
   `window.getSelection().getRangeAt(0).commonAncestorContainer.contains(scrollRef.current)`
   — if the user is selecting text inside the scroller, do not pin.
   This is the single biggest UX win for a chat where people quote
   assistant output.
3. **Programmatic scroll token (`ignoreScrollToTop`).** Instead of a
   rAF-cleared flag, the programmatic setter stamps the value it's
   writing on the scroll state. `handleScroll` checks `if (scrollTop
   === state.ignoreScrollToTop) return`. Race-free regardless of main
   thread contention.
4. **Content-shrink anchoring.** On negative resize, if the user was
   near-bottom, forcibly clamp `scrollTop` to
   `scrollHeight - 1 - clientHeight` and set `escapedFromLock = false`.
   We `return` today.
5. **`initial: 'instant' | 'smooth' | false`.** First-render behavior
   is a first-class config. `'instant'` does exactly what our
   `useLayoutEffect` does, but with the library's scroll-anchoring
   math — no need for the settle gate.

**API surface:**

```tsx
// Component
<StickToBottom className="..." resize="smooth" initial="instant">
  <StickToBottom.Content>{messages.map(...)}</StickToBottom.Content>
</StickToBottom>

// Hook (for virtualizer integration)
const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
  initial: 'instant',
  resize: 'smooth',
  damping: 0.7,
  stiffness: 0.05,
})

// Context for scroll-button child
const { isAtBottom, scrollToBottom } = useStickToBottomContext()
```

**Fit with our virtualizer:** hook API returns `scrollRef` + `contentRef`
as ref callbacks — identical shape to our `useAutoScroll()` return. Drop-in
for `VirtualizedMessageList`.

### 2.2 assistant-ui `useThreadViewportAutoScroll`

Has a known bug (issue #1916) where `autoScroll={true}` blocks user
scroll-up during streaming — exactly the problem our wheel/touch listener
workaround solves. Our approach here is *more correct* than assistant-ui's.
Nothing to learn; confirms our wheel/touch race-winner design.

### 2.3 Vercel AI SDK Elements `<Conversation>`

```tsx
<Conversation contextRef={ref} instance={inst}>
  <ConversationContent>...</ConversationContent>
  <ConversationScrollButton />
</Conversation>
```

Thin wrapper over `use-stick-to-bottom` + Radix scroll area. Same
primitive; same `StickToBottomContext`. No novel algorithm.

### 2.4 prompt-kit `<ChatContainer>`

Also wraps `use-stick-to-bottom`. Adds 50vh padding on last message for
breathing room. We should copy this.

### 2.5 Hakim's "simple" approach

Rejects observers/thresholds entirely:
- Scroll on submit, smooth.
- Scroll on first paint, instant.
- Do nothing during reading.
- 50vh padding on last message.

**Why we can't use this:** our messages stream token-by-token over
seconds, not burst-once on submit. Without continuous pin-to-bottom the
text scrolls off-screen. His approach is for latency-dominated chat
(submit → 2s wait → full message), not streaming chat. **But the 50vh
padding idea transfers.**

### 2.6 React Virtuoso `followOutput`

`followOutput: true | 'smooth' | 'auto'`. Accepts a function that returns
the behavior per-update. Comment from the discussion: "smooth mode looks
better visually but might not keep up with very fast updates."
**Already tried & reverted** (commit `4ddb9c6`). Moving on.

### 2.7 TanStack Virtual `shouldAdjustScrollPositionOnItemSizeChange`

**Important find — we don't use this, and we probably should.**

From the library maintainer (discussion #730):

```ts
rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _, instance) => {
  return item.start < instance.scrollOffset &&
         instance.scrollDirection === 'backward'
}
```

Semantics: when an item's measured height changes (streaming delta
grows a message row), adjust scroll position *only if* the change is
happening above the current viewport and the user is scrolling up. This
prevents the classic virtualizer bug where a row that's currently
rendering above you gets taller and shoves your viewport down.

We hit this whenever a user scrolls up, the virtualizer measures rows
above them as it moves, and the 160px estimate resolves to something
larger. The row *above* the viewport growing pushes the user's current
focus down out of place. Configuring this option fixes it at the
virtualizer layer, independent of the pin-to-bottom system.

### 2.8 ChatGPT / Claude.ai (reverse-engineered)

Simple model: pin-to-bottom while streaming, user scroll-up unpins,
small "↓" button pops. No physics, no selection guard. Source of the
Chrome "ChatGPT Auto-Scroll Blocker" extension because even OpenAI's
design annoys some users during long streams. **This is where we are
today.** Not a role model for "doesn't suck."

---

## 3. Recommendation matrix

| Option | Effort | LOC | Known bugs solved | Risks |
|---|---|---|---|---|
| **A. Keep current + fix 12 items piecemeal** | 2–4 weeks cumulative | +200 | 8–12 over time | Same "iteration treadmill" — we've done this 8 times |
| **B. Adopt `use-stick-to-bottom`, keep virtualizer** ★ | 1–2 days | −150 net | 8, 9, 10, 11, 12 in one shot | Library is 3rd-party; pin a version |
| **C. Adopt `use-stick-to-bottom` + configure TanStack `shouldAdjustScrollPositionOnItemSizeChange`** ★★ | 1–2 days | −150 net | 8, 9, 10, 11, 12 + up-scroll shove | Two integration points instead of one |
| **D. Port + fork `use-stick-to-bottom` internals into `conversation.tsx`** | 4–5 days | ~equal | Same as B but no external dep | Why? Library is zero-dep and 12KB |
| **E. Switch to shadcn `<AIConversation>` wholesale** | 3–5 days | −300? | Same as B+C plus styling updates | Touches design system, not just scroll |

**Recommendation: C (★★).**

---

## 4. Proposed migration plan (Option C)

### Phase 1 — Replace `useAutoScroll` internals, keep API shape

- `pnpm add use-stick-to-bottom` in `packages/ai-elements`.
- Rewrite `useAutoScroll()` in `conversation.tsx` as a thin wrapper
  around `useStickToBottom({ initial: 'instant', resize: 'smooth' })`.
  Preserve the `{ scrollRef, contentRef, sentinelRef, isAtBottom,
  scrollToBottom }` context shape so no callers change.
- Delete:
  - `pinnedRef` / `programmaticRef` / `prevHeightRef` /
    `lastScrollTopRef` / `touchStartYRef`
  - `onWheel` / `onTouchStart` / `onTouchMove` listeners
  - The `useLayoutEffect` initial pin (library handles it via
    `initial: 'instant'`)
  - The `ResizeObserver` setup (library owns content observation)
  - The `programmaticRef` race-guard (library uses a scroll-value
    token instead)
- Keep `sentinelRef` as a no-op ref callback for API compat with any
  call-sites still passing one.

### Phase 2 — Remove the settle gate from `VirtualizedMessageList`

- Delete the `isSettled` state + rAF stability loop + `SETTLE_FALLBACK_MS`.
- Delete the `visibility: hidden` wrapper.
- Keep the `scrollToIndex(messages.length - 1, { align: 'end' })` call,
  but trigger it once on mount (replace the `isSettled` effect with a
  plain mount-only effect gated on `messages.length > 0`).
- `use-stick-to-bottom` with `initial: 'instant'` handles the pre-paint
  jump; `scrollToIndex` corrects the virtualizer's estimated-total
  drift afterward. Both are safe to run — the spring animation for
  the corrective delta is imperceptible.

### Phase 3 — Configure TanStack `shouldAdjustScrollPositionOnItemSizeChange`

```ts
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollElRef.current,
  estimateSize: () => 160,
  overscan: 6,
  getItemKey,
  paddingStart: 16,
  paddingEnd: 16,
  gap: 32,
  shouldAdjustScrollPositionOnItemSizeChange: (item, _, instance) =>
    item.start < instance.scrollOffset &&
    instance.scrollDirection === 'backward',
})
```

Prevents rows above the viewport from shoving the user down when they
re-measure during scroll-up through long history.

### Phase 4 — 50vh bottom padding on last message

In `ChatMessageRow` or the virtualizer content wrapper, add CSS:

```css
.chat-message-row:last-child { padding-bottom: 50vh; }
```

(Or Tailwind `last:pb-[50vh]`.) Last assistant chunk no longer hugs the
compose bar; user always has breathing room. Virtualizer's
`measureElement` picks up the new height and sizing stays correct.

### Phase 5 — Verification protocol

Per CLAUDE.md §UI Testing, use `scripts/axi` + the dev stack.

Test cases (run against local orchestrator + a live session):

1. **Stream a long (500+ token) assistant turn.** Confirm smooth
   spring-scroll, not discrete snaps. Record screen, look for jitter.
2. **Mid-stream, swipe up on mobile WebView** (via `axi eval` or real
   device over Tailscale ADB per CLAUDE.md). Confirm immediate unpin,
   stream continues invisibly below, ↓ button appears.
3. **Select text across a streaming assistant message.** Confirm
   selection survives the next delta (this is the library's
   `isSelecting()` check; currently fails).
4. **Rewind mid-thread to message #3.** Confirm scroll lands on the
   new leaf correctly, no "somehow scrolled to top" state.
5. **Branch-navigate between siblings.** Same.
6. **Reconnect after being offline for 30s during streaming.** Snapshot
   arrives; confirm pin-to-bottom survives the burst growth.
7. **Android WebView launch on a 200-message session.** Confirm no
   top→bottom flash, no mid-stream re-fire of initial pin.
8. **Concurrent-commit refire test** (memory: 430ms re-fire) —
   `use-stick-to-bottom`'s internal mount tracking is idempotent; the
   `el.scrollTop === 0` guard we have today is no longer needed.

### Estimated effort

- Phase 1: half day (wrapping library)
- Phase 2: hour (delete settle gate)
- Phase 3: hour (add virtualizer option)
- Phase 4: 15 min
- Phase 5: half day (manual QA across 8 scenarios)
- **Total: 1–2 days**

### Blast radius

- `packages/ai-elements/src/components/conversation.tsx`
  (~180 LOC deleted, ~40 LOC added)
- `apps/orchestrator/src/features/agent-orch/ChatThread.tsx`
  (~60 LOC deleted from settle gate, ~3 LOC added for virtualizer option)
- `packages/ai-elements/package.json` (+1 dep)
- No API changes to call-sites of `useAutoScrollContext()` /
  `<Conversation>` / `<ConversationScrollButton>`.

---

## 5. Open questions

1. **Does `use-stick-to-bottom`'s `ResizeObserver` play nicely with
   `@tanstack/react-virtual`'s `measureElement`?** Both observe the
   content container; both fire on row remeasures. Need a mount test
   that confirms no "ResizeObserver loop completed with undelivered
   notifications" warnings. If it misbehaves, we pass a `targetScrollTop`
   callback that defers to `virtualizer.getTotalSize()` explicitly.
2. **Should we expose a "streaming" mode prop** to swap `resize: 'smooth'`
   for `resize: 'instant'` during active `partial_assistant` deltas?
   Spring animation is gorgeous for a single message growing, but under
   a 60-tokens/sec burst the spring may always be catching up.
   Likely yes; driven off `useDerivedStatus(sessionId) === 'streaming'`.
3. **Do we want the 50vh padding everywhere or only on the active
   session tab?** On a small mobile viewport 50vh is aggressive. Consider
   `min(50vh, 200px)`.

---

## Appendix A — Source map

| What | Where |
|---|---|
| Our current pin-to-bottom hook | `packages/ai-elements/src/components/conversation.tsx:57–234` |
| Our scroll-button component | `packages/ai-elements/src/components/conversation.tsx:~260` |
| Our virtualizer + settle gate | `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:889–1052` |
| Our message row memo comparator | `apps/orchestrator/src/features/agent-orch/ChatThread.tsx:820–858` |

## Appendix B — Sources consulted

- [use-stick-to-bottom (GitHub)](https://github.com/stackblitz-labs/use-stick-to-bottom)
- [use-stick-to-bottom DeepWiki](https://deepwiki.com/stackblitz-labs/use-stick-to-bottom)
- [Vercel AI SDK Elements: Conversation](https://elements.ai-sdk.dev/components/conversation)
- [shadcn AI Conversation](https://www.shadcn.io/ai/conversation)
- [prompt-kit ChatContainer](https://www.prompt-kit.com/docs/chat-container)
- [Intuitive Scrolling for Chatbot Message Streaming (tuffstuff9)](https://tuffstuff9.hashnode.dev/intuitive-scrolling-for-chatbot-message-streaming)
- [Handling scroll for AI chat (Hakim)](https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps)
- [assistant-ui #1916 — autoScroll broken](https://github.com/assistant-ui/assistant-ui/issues/1916)
- [TanStack Virtual #730 — stop autoscroll during AI streaming](https://github.com/TanStack/virtual/discussions/730)
- [React Virtuoso stick-to-bottom](https://virtuoso.dev/stick-to-bottom/)
- [vercel/ai-chatbot #577 — auto-scroll to bottom](https://github.com/vercel/ai-chatbot/issues/577)
