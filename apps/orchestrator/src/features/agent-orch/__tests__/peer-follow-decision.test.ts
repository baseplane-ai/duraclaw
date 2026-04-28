/**
 * @vitest-environment node
 *
 * Regression: sidebar click → URL flap loop between two session ids.
 *
 * AgentOrchPage runs two effects against `searchSessionId` (URL) and
 * `activeSessionId` (local):
 *   - deep-link: URL → setActive(URL)
 *   - peer-follow: when activeSessionId moves on a peer device, push it
 *     into the URL.
 *
 * NavSessions's sidebar click only updates the URL; the deep-link effect
 * catches up one render later. The original peer-follow effect treated
 * any `activeSessionId !== searchSessionId` divergence as peer-driven
 * and immediately navigated URL back to the stale active id — deep-link
 * bounced it forward — and the URL ping-ponged between the two ids
 * forever (page eventually crashed under the re-render storm).
 *
 * `shouldFollowActiveToUrl` ignores divergences caused purely by URL
 * change (`prevActive === active`) so the deep-link effect alone owns
 * sidebar-click sync.
 */

import { describe, expect, it } from 'vitest'
import { shouldFollowActiveToUrl } from '../peer-follow-decision'

describe('shouldFollowActiveToUrl', () => {
  it('returns false before cold-start has run', () => {
    expect(
      shouldFollowActiveToUrl({
        prevActive: null,
        active: 'sess-A',
        searchSessionId: 'sess-A',
        coldStarted: false,
      }),
    ).toBe(false)
  })

  it('returns false when there is no active session', () => {
    expect(
      shouldFollowActiveToUrl({
        prevActive: 'sess-A',
        active: null,
        searchSessionId: 'sess-A',
        coldStarted: true,
      }),
    ).toBe(false)
  })

  it('does NOT navigate when only the URL changed (sidebar-click loop fix)', () => {
    // User clicked sess-B in the sidebar. URL flipped to B but
    // activeSessionId is still A — deep-link effect will set it to B
    // next render. Peer-follow must stay quiet so it doesn't bounce
    // the URL back to A.
    expect(
      shouldFollowActiveToUrl({
        prevActive: 'sess-A',
        active: 'sess-A',
        searchSessionId: 'sess-B',
        coldStarted: true,
      }),
    ).toBe(false)
  })

  it('navigates when activeSessionId changed and URL is stale (peer-driven)', () => {
    // A peer device's replaceTab swap advanced our local active marker
    // from A to B; the URL is still A.
    expect(
      shouldFollowActiveToUrl({
        prevActive: 'sess-A',
        active: 'sess-B',
        searchSessionId: 'sess-A',
        coldStarted: true,
      }),
    ).toBe(true)
  })

  it('does NOT navigate when activeSessionId changed but URL already matches', () => {
    // TabBar click path: openTab(B) sets active=B AND navigate fires in
    // the same commit, so the divergence resolves in one render.
    expect(
      shouldFollowActiveToUrl({
        prevActive: 'sess-A',
        active: 'sess-B',
        searchSessionId: 'sess-B',
        coldStarted: true,
      }),
    ).toBe(false)
  })
})
