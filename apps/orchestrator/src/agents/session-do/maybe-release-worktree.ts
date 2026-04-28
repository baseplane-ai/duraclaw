import { releaseWorktreeOnClose } from '~/lib/release-worktree-on-close'
import type { SessionDOContext } from './types'

/**
 * GH#115 §B-LIFECYCLE-2: best-effort worktree release on a terminal
 * status transition. Wraps the helper in `ctx.ctx.waitUntil` +
 * try/catch so a D1 hiccup doesn't block the close path. The cron
 * janitor in `apps/orchestrator/src/api/scheduled.ts:runWorktreesJanitor`
 * is the always-on safety net if this ever fails or is skipped.
 *
 * Call from every terminal status transition — `stopped`, `error`,
 * stop / abort / forceStop RPCs, the runaway-interrupt path, the
 * gateway-disconnect recovery transition, and the early-fail "no
 * gateway URL" branch. Do NOT call from intermediate `result` events:
 * the runner stays alive between turns and `active_callback_token`
 * is preserved (see comment in gateway-event-handler.ts result case).
 */
export function maybeReleaseWorktreeOnTerminal(ctx: SessionDOContext): void {
  const worktreeId = ctx.state.worktreeId
  if (!worktreeId) return
  const sessionId = ctx.do.name
  ctx.ctx.waitUntil(
    releaseWorktreeOnClose(ctx.do.d1, sessionId, worktreeId).catch((err) => {
      console.error(
        `[SessionDO:${ctx.ctx.id}] release-on-close (worktreeId=${worktreeId}) failed:`,
        err,
      )
    }),
  )
}
