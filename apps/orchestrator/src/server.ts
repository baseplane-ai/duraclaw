import handler from '@tanstack/react-start/server-entry'
import { SessionDO } from './agents/session-do'
import { WorktreeRegistry } from './agents/worktree-registry'

export default {
  fetch: handler.fetch,
}

export { SessionDO, WorktreeRegistry }
