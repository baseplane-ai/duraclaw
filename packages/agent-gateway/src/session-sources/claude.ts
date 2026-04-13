import path from 'node:path'
import { listSdkSessions } from '../sessions-list.js'
import type { DiscoveredSession, SessionSource } from './types.js'

export class ClaudeSessionSource implements SessionSource {
  readonly agent = 'claude'
  readonly description = 'Claude Code sessions from .claude/sessions/'

  async available(): Promise<boolean> {
    return true
  }

  async discoverSessions(
    projectPath: string,
    opts?: { since?: string; limit?: number },
  ): Promise<DiscoveredSession[]> {
    const limit = opts?.limit ?? 50
    const sessions = await listSdkSessions(projectPath, limit)

    let results: DiscoveredSession[] = sessions.map((s) => ({
      sdk_session_id: s.session_id,
      agent: 'claude',
      project_dir: s.project_dir,
      project: path.basename(s.project_dir),
      branch: s.branch,
      started_at: s.started_at,
      last_activity: s.last_activity,
      summary: s.summary,
      tag: s.tag,
      title: null,
      message_count: null,
      user: s.user || null,
    }))

    const since = opts?.since
    if (since) {
      results = results.filter((s) => s.last_activity >= since)
    }

    return results
  }
}
