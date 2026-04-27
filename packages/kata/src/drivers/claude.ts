// src/drivers/claude.ts
// Claude Code driver — stub implementation (fleshed out in P1.2)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { CanonicalHookInput, CanonicalHookOutput, Driver, NativeTask, NativeTaskStore } from './types.js'
import { findProjectDir } from '../session/lookup.js'
import { hasActiveBackgroundAgents as checkActiveAgents } from '../commands/hook.js'
import { mergeHooksIntoSettings, type SettingsJson } from '../commands/setup.js'
import { readCanonicalTasks } from '../native-tasks/canonical-store.js'

const claudeNativeTaskStore: NativeTaskStore = {
  async read(_taskId: string): Promise<NativeTask | null> {
    // Individual reads go through canonical store directly
    return null
  },
  async write(_task: NativeTask): Promise<void> {
    // Writes go through canonical store; this is called after canonical write
  },
  async list(): Promise<NativeTask[]> {
    // List goes through canonical store directly
    return []
  },
  async refreshDriverState(sessionId: string): Promise<void> {
    // Mirror canonical tasks to ~/.claude/tasks/{sessionId}/
    const tasks = readCanonicalTasks(sessionId)
    const claudeDir = join(homedir(), '.claude', 'tasks', sessionId)

    // Clear and rewrite
    if (existsSync(claudeDir)) rmSync(claudeDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })

    for (const task of tasks) {
      writeFileSync(
        join(claudeDir, `${task.id}.json`),
        `${JSON.stringify(task, null, 2)}\n`,
        'utf-8',
      )
    }
  },
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

  async writeHookRegistration(hookCommand: string): Promise<void> {
    const bin = `"${hookCommand}"`
    const wmHooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>> = {
      SessionStart: [{ hooks: [{ type: 'command', command: `${bin} hook session-start --driver=claude` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${bin} hook user-prompt --driver=claude` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${bin} hook stop-conditions --driver=claude`, timeout: 30 }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: `${bin} hook pre-tool-use --driver=claude`, timeout: 30 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: `${bin} hook post-tool-use --driver=claude` }] }],
    }

    const settingsPath = join(homedir(), '.claude', 'settings.json')
    let settings: SettingsJson = {}
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as SettingsJson
      } catch { /* ignore parse errors */ }
    }

    const merged = mergeHooksIntoSettings(settings, wmHooks)
    mkdirSync(join(homedir(), '.claude'), { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')
  },

  async removeHookRegistration(): Promise<void> {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return

    let settings: SettingsJson = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as SettingsJson
    } catch { return }

    const existingHooks = settings.hooks ?? {}
    const cleanedHooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>> = {}
    const wmHookPattern = /\bhook (session-start|user-prompt|stop-conditions|mode-gate|task-deps|task-evidence|pre-tool-use|post-tool-use)\b/

    for (const [event, entries] of Object.entries(existingHooks)) {
      const kept = entries.filter((entry) =>
        !entry.hooks?.some((h) => typeof h.command === 'string' && wmHookPattern.test(h.command))
      )
      if (kept.length > 0) cleanedHooks[event] = kept
    }

    const cleaned: SettingsJson = {
      ...settings,
      hooks: Object.keys(cleanedHooks).length > 0 ? cleanedHooks : undefined,
    }
    writeFileSync(settingsPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf-8')
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

  nativeTaskStore: claudeNativeTaskStore,

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

  async hasActiveBackgroundAgents(sessionId: string): Promise<boolean> {
    // Resolve transcript path (same logic as hook.ts resolveTranscriptPath)
    let transcriptPath: string | undefined
    try {
      const projectDir = findProjectDir()
      if (projectDir) {
        const encoded = projectDir.replace(/\//g, '-')
        const transcriptDir = join(homedir(), '.claude', 'projects', encoded)
        const candidate = join(transcriptDir, `${sessionId}.jsonl`)
        if (existsSync(candidate)) {
          transcriptPath = candidate
        } else {
          // Fallback: scan projects dir
          const projectsDir = join(homedir(), '.claude', 'projects')
          if (existsSync(projectsDir)) {
            for (const dir of readdirSync(projectsDir)) {
              const c = join(projectsDir, dir, `${sessionId}.jsonl`)
              if (existsSync(c)) { transcriptPath = c; break }
            }
          }
        }
      }
    } catch { /* ignore */ }
    return checkActiveAgents(transcriptPath)
  },
}
