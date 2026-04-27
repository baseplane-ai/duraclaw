// src/drivers/types.ts
// Driver abstraction types for kata session drivers (claude, codex, etc.)

import type { NativeTask } from '../commands/enter/task-factory.js'

export type { NativeTask }

export interface CanonicalHookInput {
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'
  sessionId: string
  cwd: string
  toolName?: string         // canonical tool name
  toolInput?: unknown
  toolResponse?: unknown    // PostToolUse only
  prompt?: string           // UserPromptSubmit only
  stopHookActive?: boolean  // Stop only
  transcriptPath?: string   // Stop / SessionStart
  model?: string
}

export interface CanonicalHookOutput {
  decision?: 'block' | 'allow' | 'ask'
  reason?: string
  systemMessage?: string
  additionalContext?: string
}

export interface NativeTaskStore {
  read(taskId: string): Promise<NativeTask | null>
  write(task: NativeTask): Promise<void>
  list(): Promise<NativeTask[]>
  refreshDriverState(sessionId: string): Promise<void>
}

export interface Driver {
  name: 'claude' | 'codex'
  isInstalled(): boolean
  writeHookRegistration(hookCommand: string): Promise<void>
  removeHookRegistration(): Promise<void>
  parseHookInput(stdin: string, event: string): CanonicalHookInput
  formatHookOutput(out: CanonicalHookOutput, event: string): { stdout: string; exitCode: 0 | 2 }
  hookEventName(canonical: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'): string
  toolNameMap(): Record<string, string>
  nativeTaskStore: NativeTaskStore
  skillsDir(scope: 'user' | 'project', cwd?: string): string
  skillInvocationPrefix(): '/' | '$'
  ceremonyFileName(): 'CLAUDE.md' | 'AGENTS.md'
  detectStopHookFeedback(text: string): boolean
  hasActiveBackgroundAgents(sessionId: string): Promise<boolean>
}
