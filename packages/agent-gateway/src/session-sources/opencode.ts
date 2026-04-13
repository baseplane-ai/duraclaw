import type { DiscoveredSession, SessionSource } from './types.js'

export class OpenCodeSessionSource implements SessionSource {
  readonly agent = 'opencode'
  readonly description = 'OpenCode sessions (stub -- not yet implemented)'

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
