import type { AdapterCapabilities, AgentAdapter } from './types.js'

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  listNames(): string[] {
    return Array.from(this.adapters.keys())
  }

  async listCapabilities(): Promise<AdapterCapabilities[]> {
    return Promise.all(Array.from(this.adapters.values()).map((a) => a.getCapabilities()))
  }
}
