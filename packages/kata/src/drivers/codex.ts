// src/drivers/codex.ts
// OpenAI Codex CLI driver — stub implementation (fleshed out in P1.2)
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

export const codexDriver: Driver = {
  name: 'codex',

  isInstalled(): boolean {
    try {
      execSync('which codex 2>/dev/null', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  },

  async writeHookRegistration(_hookCommand: string): Promise<void> {
    throw new Error('codexDriver.writeHookRegistration not yet implemented (P1.2)')
  },

  async removeHookRegistration(): Promise<void> {
    throw new Error('codexDriver.removeHookRegistration not yet implemented (P1.2)')
  },

  parseHookInput(stdin: string, _event: string): CanonicalHookInput {
    const raw = JSON.parse(stdin) as Record<string, unknown>
    // Codex stdin shape mirrors canonical shape; reverse-map tool_name via toolNameMap
    const nativeToolName = raw.tool_name as string | undefined
    const reverseMap: Record<string, string> = {}
    for (const [canonical, native] of Object.entries(codexDriver.toolNameMap())) {
      if (!(native in reverseMap)) reverseMap[native] = canonical
    }
    const canonicalToolName = nativeToolName != null
      ? (reverseMap[nativeToolName] ?? nativeToolName)
      : undefined
    return {
      event: (raw.hook_event_name ?? _event) as CanonicalHookInput['event'],
      sessionId: (raw.session_id ?? '') as string,
      cwd: (raw.cwd ?? '') as string,
      toolName: canonicalToolName,
      toolInput: raw.tool_input,
      toolResponse: raw.tool_response,
      prompt: raw.prompt as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      model: raw.model as string | undefined,
    }
  },

  formatHookOutput(out: CanonicalHookOutput, event: string): { stdout: string; exitCode: 0 | 2 } {
    // Codex output shapes differ per event (see spec B7)
    if (event === 'PreToolUse') {
      if (out.decision === 'block') {
        return {
          stdout: JSON.stringify({ permissionDecision: 'deny', stopReason: out.reason ?? '' }),
          exitCode: 2,
        }
      }
      return { stdout: '', exitCode: 0 }
    }
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      if (out.additionalContext) {
        return {
          stdout: JSON.stringify({ systemMessage: out.additionalContext, continue: true }),
          exitCode: 0,
        }
      }
    }
    if (event === 'Stop' && out.decision === 'block') {
      return {
        stdout: JSON.stringify({ continue: true, stopReason: out.reason ?? '' }),
        exitCode: 0,
      }
    }
    return { stdout: '', exitCode: 0 }
  },

  hookEventName(canonical): string {
    // Codex event names are identical to canonical names in 0.124
    return canonical
  },

  toolNameMap(): Record<string, string> {
    return {
      Edit: 'apply_patch',
      Write: 'apply_patch',
      MultiEdit: 'apply_patch',
      NotebookEdit: 'apply_patch',
      Bash: 'Bash',
    }
  },

  nativeTaskStore: stubNativeTaskStore,

  skillsDir(scope: 'user' | 'project', cwd?: string): string {
    if (scope === 'user') return join(homedir(), '.agents', 'skills')
    return join(cwd ?? process.cwd(), '.agents', 'skills')
  },

  skillInvocationPrefix(): '$' { return '$' },

  ceremonyFileName(): 'AGENTS.md' { return 'AGENTS.md' },

  detectStopHookFeedback(_text: string): boolean {
    // Codex-specific stop feedback prefix TBD — graceful degrade: return false
    return false
  },

  async hasActiveBackgroundAgents(_sessionId: string): Promise<boolean> {
    // Graceful degrade per spec B24
    return false
  },
}
