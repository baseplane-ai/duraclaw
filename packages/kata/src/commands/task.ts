// kata task - Manage session tasks via CLI
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDriver } from '../drivers/index.js'
import type { NativeTask } from '../drivers/types.js'
import {
  readCanonicalTask,
  readCanonicalTasks,
  writeCanonicalTask,
} from '../native-tasks/canonical-store.js'
import { findProjectDir, getStateFilePath } from '../session/lookup.js'
import { readState } from '../state/reader.js'

/**
 * Resolve session ID from --session=ID flag or by finding the most recent session.
 */
function resolveSessionId(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith('--session=')) return arg.slice('--session='.length)
  }

  const projectDir = findProjectDir()
  const sessionsDir = join(projectDir, '.kata', 'sessions')
  if (!existsSync(sessionsDir)) {
    process.stderr.write('kata task: no active session in cwd (run kata enter <mode> first)\n')
    process.exitCode = 3
    throw new Error('no session')
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
  let latest = { id: '', mtime: 0 }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const stateFile = join(sessionsDir, e.name, 'state.json')
      const { mtimeMs } = statSync(stateFile)
      if (mtimeMs > latest.mtime) latest = { id: e.name, mtime: mtimeMs }
    } catch {
      /* skip */
    }
  }

  if (!latest.id) {
    process.stderr.write('kata task: no active session in cwd (run kata enter <mode> first)\n')
    process.exitCode = 3
    throw new Error('no session')
  }
  return latest.id
}

/**
 * kata task list [--json] [--session=ID]
 */
async function taskList(args: string[]): Promise<void> {
  const sessionId = resolveSessionId(args)
  const tasks = readCanonicalTasks(sessionId)

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`)
    return
  }

  // Markdown output
  for (const t of tasks) {
    const check = t.status === 'completed' ? 'x' : ' '
    const status = t.status === 'completed' ? '' : ` (${t.status})`
    const blocked =
      t.blockedBy.length > 0 ? ` [blocked by #${t.blockedBy.join(', #')}]` : ''
    process.stdout.write(`- [${check}] #${t.id} ${t.subject}${status}${blocked}\n`)
  }
}

/**
 * kata task get <id> [--session=ID]
 */
async function taskGet(args: string[]): Promise<void> {
  const sessionId = resolveSessionId(args)
  const taskId = args.find((a) => !a.startsWith('--'))
  if (!taskId) {
    process.stderr.write('Usage: kata task get <id>\n')
    process.exitCode = 1
    return
  }

  const t = readCanonicalTask(sessionId, taskId)
  if (!t) {
    const all = readCanonicalTasks(sessionId)
    const validIds = all.map((x) => x.id).join(', ')
    process.stderr.write(`kata task: unknown task id: ${taskId} (valid ids: ${validIds})\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`${JSON.stringify(t, null, 2)}\n`)
}

/**
 * kata task update <id> --status=<pending|in_progress|completed> [--json] [--session=ID]
 */
async function taskUpdate(args: string[]): Promise<void> {
  const sessionId = resolveSessionId(args)
  const taskId = args.find((a) => !a.startsWith('--'))
  if (!taskId) {
    process.stderr.write(
      'Usage: kata task update <id> --status=<pending|in_progress|completed>\n',
    )
    process.exitCode = 2
    return
  }

  let newStatus: string | undefined
  for (const arg of args) {
    if (arg.startsWith('--status=')) newStatus = arg.slice('--status='.length)
  }

  const validStatuses = ['pending', 'in_progress', 'completed']
  if (newStatus && !validStatuses.includes(newStatus)) {
    process.stderr.write(
      `kata task: invalid status '${newStatus}' (allowed: ${validStatuses.join('|')})\n`,
    )
    process.exitCode = 2
    return
  }

  const t = readCanonicalTask(sessionId, taskId)
  if (!t) {
    const all = readCanonicalTasks(sessionId)
    const validIds = all.map((x) => x.id).join(', ')
    process.stderr.write(`kata task: unknown task id: ${taskId} (valid ids: ${validIds})\n`)
    process.exitCode = 1
    return
  }

  if (newStatus) {
    t.status = newStatus as NativeTask['status']
  }

  writeCanonicalTask(sessionId, t)

  // Fan out to driver's native task store
  try {
    const stateFile = await getStateFilePath(sessionId)
    const state = await readState(stateFile)
    const driver = getDriver((state.driver ?? 'claude') as 'claude' | 'codex')
    await driver.nativeTaskStore.refreshDriverState(sessionId)
  } catch {
    /* best-effort */
  }

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(t, null, 2)}\n`)
  } else {
    process.stdout.write(`kata task: updated #${taskId} → ${t.status}\n`)
  }
}

/**
 * kata task <list|get|update> [args...]
 */
export async function task(args: string[]): Promise<void> {
  const subcommand = args[0]
  const subArgs = args.slice(1)

  try {
    switch (subcommand) {
      case 'list':
        await taskList(subArgs)
        break
      case 'get':
        await taskGet(subArgs)
        break
      case 'update':
        await taskUpdate(subArgs)
        break
      default:
        process.stderr.write('Usage: kata task <list|get|update>\n')
        process.exitCode = 1
    }
  } catch {
    // resolveSessionId throws on no-session; exitCode already set
    if (process.exitCode) return
    throw new Error('unexpected error in kata task')
  }
}
