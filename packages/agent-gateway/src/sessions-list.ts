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
}

/**
 * List SDK sessions found on disk for a project.
 * Scans .claude/sessions/* /session-info.json and returns them sorted by last activity (newest first).
 */
export async function listSdkSessions(projectPath: string, limit = 20): Promise<SdkSessionInfo[]> {
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
      })
    } catch {
      // Skip malformed or unreadable entries
    }
  }

  // Sort by last_activity descending
  results.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1))

  return results.slice(0, limit)
}
