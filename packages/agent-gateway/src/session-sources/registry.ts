import type { SessionSource } from './types.js'

export class SessionSourceRegistry {
  private sources = new Map<string, SessionSource>()

  register(source: SessionSource): void {
    this.sources.set(source.agent, source)
  }

  get(agent: string): SessionSource | undefined {
    return this.sources.get(agent)
  }

  listSources(): SessionSource[] {
    return Array.from(this.sources.values())
  }
}
