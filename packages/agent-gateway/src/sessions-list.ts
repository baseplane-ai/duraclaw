import { stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { SdkSessionInfo } from './types.js'

interface SessionInfoFile {
  session_id: string
  user: string
  branch: string
  project_dir: string
  workflow_id: string
  started_at: string
  summary?: string
  tag?: string | null
}

/**
 * List SDK sessions found on disk for a project.
 * Uses the SDK's listSessions first (catches forked sessions), with disk scan as fallback.
 */
export async function listSdkSessions(projectPath: string, limit = 20): Promise<SdkSessionInfo[]> {
  // Try SDK listSessions first — it handles forked sessions and internal session storage
  try {
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
    const sdkSessions = await listSessions({ dir: projectPath })
    if (Array.isArray(sdkSessions) && sdkSessions.length > 0) {
      const results: SdkSessionInfo[] = sdkSessions.map((s: any) => ({
        session_id: s.sessionId ?? s.session_id ?? '',
        user: s.user ?? '',
        branch: s.branch ?? '',
        project_dir: s.projectDir ?? s.project_dir ?? projectPath,
        workflow_id: s.workflowId ?? s.workflow_id ?? '',
        started_at: s.startedAt ?? s.started_at ?? '',
        last_activity: s.lastActivity ?? s.last_activity ?? s.startedAt ?? '',
        summary: s.summary ?? '',
        tag: s.tag ?? null,
      }))
      results.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1))
      return results.slice(0, limit)
    }
  } catch {
    // SDK listSessions not available — fall back to disk scan
  }

  // Fallback: scan .claude/sessions/*/session-info.json
  const sessionsDir = nodePath.join(projectPath, '.claude', 'sessions')
  const glob = new Bun.Glob('*/session-info.json')
  const results: SdkSessionInfo[] = []

  for await (const match of glob.scan({ cwd: sessionsDir, onlyFiles: true })) {
    try {
      const fullPath = nodePath.join(sessionsDir, match)
      const info: SessionInfoFile = await Bun.file(fullPath).json()
      const sessionDir = nodePath.dirname(fullPath)
      const dirStat = await stat(sessionDir)

      results.push({
        session_id: info.session_id,
        user: info.user ?? '',
        branch: info.branch ?? '',
        project_dir: info.project_dir ?? projectPath,
        workflow_id: info.workflow_id ?? '',
        started_at: info.started_at ?? '',
        last_activity: dirStat.mtime.toISOString(),
        summary: info.summary ?? '',
        tag: info.tag ?? null,
      })
    } catch {
      // Skip malformed or unreadable entries
    }
  }

  // Sort by last_activity descending
  results.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1))

  return results.slice(0, limit)
}
