// src/drivers/claude.ts
// Claude Code driver — stub implementation (fleshed out in P1.2)
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { CanonicalHookInput, CanonicalHookOutput, Driver, NativeTask, NativeTaskStore } from './types.js'

const stubNativeTaskStore: NativeTaskStore = {
  async read(_taskId: string): Promise<NativeTask | null> { return null },
  async write(_task: NativeTask): Promise<void> {},
  async list(): Promise<NativeTask[]> { return [] },
  async refreshDriverState(_sessionId: string): Promise<void> {},
}

export const claudeDriver: Driver = {
  name: 'claude',

  isInstalled(): boolean {
    try {
      execSync('which claude 2>/dev/null', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  },

  async writeHookRegistration(_hookCommand: string): Promise<void> {
    throw new Error('claudeDriver.writeHookRegistration not yet implemented (P1.2)')
  },

  async removeHookRegistration(): Promise<void> {
    throw new Error('claudeDriver.removeHookRegistration not yet implemented (P1.2)')
  },

  parseHookInput(stdin: string, _event: string): CanonicalHookInput {
    const raw = JSON.parse(stdin) as Record<string, unknown>
    return {
      event: (raw.hook_event_name ?? _event) as CanonicalHookInput['event'],
      sessionId: (raw.session_id ?? '') as string,
      cwd: (raw.cwd ?? '') as string,
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input,
      toolResponse: raw.tool_response,
      prompt: raw.prompt as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      model: raw.model as string | undefined,
    }
  },

  formatHookOutput(out: CanonicalHookOutput, _event: string): { stdout: string; exitCode: 0 | 2 } {
    // Claude reads decision from JSON body; exitCode always 0
    return { stdout: JSON.stringify(out), exitCode: 0 }
  },

  hookEventName(canonical): string {
    // Claude event names are identical to canonical names
    return canonical
  },

  toolNameMap(): Record<string, string> {
    // Claude tool names ARE canonical — identity map
    return {}
  },

  nativeTaskStore: stubNativeTaskStore,

  skillsDir(scope: 'user' | 'project', cwd?: string): string {
    if (scope === 'user') return join(homedir(), '.claude', 'skills')
    return join(cwd ?? process.cwd(), '.claude', 'skills')
  },

  skillInvocationPrefix(): '/' { return '/' },

  ceremonyFileName(): 'CLAUDE.md' { return 'CLAUDE.md' },

  detectStopHookFeedback(text: string): boolean {
    const trimmed = text.trimStart()
    return (
      trimmed.startsWith('Stop hook feedback:') ||
      trimmed.startsWith('Session has incomplete work:')
    )
  },

  async hasActiveBackgroundAgents(_sessionId: string): Promise<boolean> {
    // Real implementation in P1.2 — reads ~/.claude/projects/.../*.jsonl
    return false
  },
}
