import handler from '@tanstack/react-start/server-entry'
import { SessionDO } from './agents/session-do'
import { WorktreeRegistry } from './agents/worktree-registry'
import { setCloudflareEnv } from './lib/cf-env'
import type { Env } from './lib/types'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    setCloudflareEnv(env)
    return (handler.fetch as Function)(request, env, ctx)
  },
}

export { SessionDO, WorktreeRegistry }
