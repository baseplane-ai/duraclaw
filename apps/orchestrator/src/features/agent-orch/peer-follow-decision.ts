/**
 * Decide whether AgentOrchPage's peer-follow watcher should push the
 * local `active` session id into the URL on this render.
 *
 * Two effects in `AgentOrchContent` watch the same pair of values:
 *   - deep-link: `searchSessionId` (URL) → `setActive`
 *   - peer-follow: `activeSessionId` (local) → URL
 *
 * The peer-follow effect exists to handle peer-device tab swaps —
 * useTabSync's `computeFollowMap` advances `activeSessionId` locally
 * when a peer's `replaceTab` swaps the row's session id, and without
 * this watcher the URL would stay pinned to the stale id.
 *
 * The trap: NavSessions's sidebar click only updates the URL — the
 * deep-link effect catches `activeSessionId` up one render later.
 * If peer-follow treats every `active !== search` divergence as
 * peer-driven, it navigates the URL back to the stale active id;
 * deep-link bounces it forward; URL flaps between the two ids
 * forever and the page crashes under the re-render storm.
 *
 * The fix: only fire when `activeSessionId` itself changed since the
 * last render. A pure URL change leaves prevActive === active, so the
 * watcher stays quiet and the deep-link effect alone reconciles.
 */
export function shouldFollowActiveToUrl(args: {
  prevActive: string | null
  active: string | null
  searchSessionId: string | null
  coldStarted: boolean
}): boolean {
  if (!args.coldStarted) return false
  if (!args.active) return false
  if (args.prevActive === args.active) return false
  if (args.active === args.searchSessionId) return false
  return true
}
