import type { DiscoveredSession, SessionSource } from './types.js'

export class CodexSessionSource implements SessionSource {
  readonly agent = 'codex'
  readonly description = 'Codex sessions (stub -- not yet implemented)'

  async available(): Promise<boolean> {
    return false
  }

  async discoverSessions(
    _projectPath: string,
    _opts?: { since?: string; limit?: number },
  ): Promise<DiscoveredSession[]> {
    return []
  }
}
