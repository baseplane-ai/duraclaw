// Canonical native-task store — source of truth for all task state.
// Lives at .kata/sessions/{sessionId}/native-tasks/{taskId}.json
// Every write fans out to the active driver's nativeTaskStore.refreshDriverState()
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProjectDir } from '../session/lookup.js'
import type { NativeTask } from '../drivers/types.js'

/**
 * Get the canonical native tasks directory for a session.
 * Path: <projectRoot>/.kata/sessions/{sessionId}/native-tasks/
 */
export function getCanonicalTasksDir(sessionId: string): string {
  const projectDir = findProjectDir()
  return join(projectDir, '.kata', 'sessions', sessionId, 'native-tasks')
}

/**
 * Read a single task from the canonical store.
 */
export function readCanonicalTask(sessionId: string, taskId: string): NativeTask | null {
  const dir = getCanonicalTasksDir(sessionId)
  const filePath = join(dir, `${taskId}.json`)
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as NativeTask
  } catch {
    return null
  }
}

/**
 * Write a single task to the canonical store.
 */
export function writeCanonicalTask(sessionId: string, task: NativeTask): void {
  const dir = getCanonicalTasksDir(sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf-8')
}

/**
 * Read all tasks from the canonical store for a session.
 */
export function readCanonicalTasks(sessionId: string): NativeTask[] {
  const dir = getCanonicalTasksDir(sessionId)
  if (!existsSync(dir)) return []
  const tasks: NativeTask[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const content = readFileSync(join(dir, entry), 'utf-8')
      tasks.push(JSON.parse(content) as NativeTask)
    } catch { /* skip invalid */ }
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id))
}

/**
 * Clear all tasks from the canonical store for a session.
 */
export function clearCanonicalTasks(sessionId: string): void {
  const dir = getCanonicalTasksDir(sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
}

/**
 * Write all tasks to the canonical store (bulk write used by kata enter).
 */
export function writeCanonicalTasks(sessionId: string, tasks: NativeTask[]): void {
  clearCanonicalTasks(sessionId)
  const dir = getCanonicalTasksDir(sessionId)
  mkdirSync(dir, { recursive: true })
  for (const task of tasks) {
    writeFileSync(join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf-8')
  }
}
