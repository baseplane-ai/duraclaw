// src/drivers/codex.ts
// OpenAI Codex CLI driver — stub implementation (fleshed out in P1.2)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { CanonicalHookInput, CanonicalHookOutput, Driver, NativeTask, NativeTaskStore } from './types.js'

// Codex hooks.json uses the same nested structure as Claude's settings.json
interface HookEntry {
  matcher?: string
  hooks?: Array<{ type: string; command: string; timeout?: number }>
}
interface CodexHooksFile {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

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

  async writeHookRegistration(hookCommand: string): Promise<void> {
    const bin = `"${hookCommand}"`
    // Codex hooks.json uses the same nested format as Claude's settings.json:
    // { hooks: { EventName: [{ matcher?, hooks: [{ type, command, timeout? }] }] } }
    const kataHooks: Record<string, HookEntry[]> = {
      SessionStart: [{ hooks: [{ type: 'command', command: `${bin} hook session-start --driver=codex` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${bin} hook user-prompt --driver=codex` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${bin} hook stop-conditions --driver=codex`, timeout: 30 }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: `${bin} hook pre-tool-use --driver=codex`, timeout: 30 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: `${bin} hook post-tool-use --driver=codex` }] }],
    }

    const hooksPath = join(homedir(), '.codex', 'hooks.json')
    let fileContent: CodexHooksFile = {}
    if (existsSync(hooksPath)) {
      try {
        fileContent = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CodexHooksFile
      } catch { /* ignore parse errors */ }
    }

    const existing = fileContent.hooks ?? {}
    const kataMarker = /\bhook (session-start|user-prompt|stop-conditions|pre-tool-use|post-tool-use)\b/
    const merged: Record<string, HookEntry[]> = {}
    const allEvents = new Set([...Object.keys(existing), ...Object.keys(kataHooks)])

    for (const event of allEvents) {
      const existingEntries = existing[event] ?? []
      const newEntries = kataHooks[event] ?? []
      // Keep non-kata entries
      const nonKata = existingEntries.filter((entry) =>
        !entry.hooks?.some((h) => typeof h.command === 'string' && kataMarker.test(h.command)),
      )
      merged[event] = [...nonKata, ...newEntries]
    }

    mkdirSync(join(homedir(), '.codex'), { recursive: true })
    writeFileSync(hooksPath, `${JSON.stringify({ ...fileContent, hooks: merged }, null, 2)}\n`, 'utf-8')
  },

  async removeHookRegistration(): Promise<void> {
    const hooksPath = join(homedir(), '.codex', 'hooks.json')
    if (!existsSync(hooksPath)) return

    let fileContent: CodexHooksFile = {}
    try {
      fileContent = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CodexHooksFile
    } catch { return }

    const existing = fileContent.hooks ?? {}
    const kataMarker = /\bhook (session-start|user-prompt|stop-conditions|pre-tool-use|post-tool-use)\b/
    const cleaned: Record<string, HookEntry[]> = {}

    for (const [event, entries] of Object.entries(existing)) {
      const kept = entries.filter((entry) =>
        !entry.hooks?.some((h) => typeof h.command === 'string' && kataMarker.test(h.command)),
      )
      if (kept.length > 0) cleaned[event] = kept
    }

    writeFileSync(hooksPath, `${JSON.stringify({ ...fileContent, hooks: Object.keys(cleaned).length > 0 ? cleaned : undefined }, null, 2)}\n`, 'utf-8')
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
