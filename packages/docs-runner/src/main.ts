/**
 * docs-runner executable entrypoint (GH#27 P1.3 work-unit D).
 *
 * MUST import jsdom-bootstrap first — `@blocknote/server-util` evaluates
 * DOM globals at module-load time.
 *
 * 5-argv contract: `docs-runner <projectId> <cmdFile> <pidFile> <exitFile> <metaFile>`.
 *
 * The cmd-file is JSON of shape `DocsRunnerCommand` (defined inline below
 * until the P1.5 config.ts arrives). Failures during cmd-file read or argv
 * parse write a failed exit-file and exit non-zero before any DOM/state
 * is constructed.
 */

import './jsdom-bootstrap.js'

import { spawnSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicOverwrite, atomicWriteOnce } from './atomic.js'
import { createBlockNoteEditor } from './blocknote-bridge.js'
import { configPath, DEFAULT_CONFIG_YAML, loadConfig } from './config.js'
import { HashStore } from './content-hash.js'
import { FilePipeline, type FilePipelineState } from './file-pipeline.js'
import { globToRegExp } from './glob-match.js'
import { type HealthFileEntry, HealthServer, type HealthSnapshot } from './health-server.js'
import { Watcher } from './watcher.js'
import { SuppressedWriter } from './writer.js'

const META_INTERVAL_MS = 10_000
const META_FAILURE_LIMIT = 5
const SIGTERM_GRACE_MS = 2_000
const STARTUP_FILES_GRACE_MS = 30_000
const DEFAULT_HEALTH_PORT = 9878
const VERSION = '0.1.0'

interface DocsRunnerCommand {
  type: 'docs-runner'
  projectId: string
  docsWorktreePath: string
  callbackBase: string
  bearer: string
  watch?: string[]
  ignored?: string[]
  healthPort?: number
}

interface Argv {
  projectId: string
  cmdFile: string
  pidFile: string
  exitFile: string
  metaFile: string
}

interface MetaSnapshot {
  state: 'running' | 'aborted' | 'completed' | 'failed'
  last_activity_ts: number
  files: number
  reconnects: number
}

/**
 * `docs-runner init <docsWorktreePath>` — bootstrap helper run by humans
 * during project setup. Writes a default `duraclaw-docs.yaml` and, if the
 * target directory isn't already a git worktree, creates one via
 * `git worktree add <path> main` from the caller's cwd.
 *
 * Idempotent re: the config file — refuses to overwrite an existing one
 * (exit 0, stderr warn). Exits non-zero only if the worktree spawn fails
 * or the path arg is missing.
 */
export async function runInit(docsWorktreePath: string): Promise<never> {
  const resolved = path.resolve(docsWorktreePath)

  // Bootstrap worktree if missing. Treat the directory as "already a
  // worktree" if `<path>/.git` exists (file form for linked worktrees,
  // dir form for the primary checkout).
  const gitMarker = path.join(resolved, '.git')
  const dirExists = fsSync.existsSync(resolved)
  const isWorktree = dirExists && fsSync.existsSync(gitMarker)
  if (!isWorktree) {
    const result = spawnSync('git', ['worktree', 'add', resolved, 'main'], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    if (result.status !== 0) {
      const code = typeof result.status === 'number' ? result.status : 1
      process.stderr.write(
        `[docs-runner] git worktree add failed (exit ${code}) for path=${resolved}\n`,
      )
      process.exit(code)
    }
  }

  const cfgPath = configPath(resolved)
  if (fsSync.existsSync(cfgPath)) {
    process.stderr.write(
      `[docs-runner] config already exists, refusing to overwrite (${cfgPath})\n`,
    )
    process.exit(0)
  }

  await fs.writeFile(cfgPath, DEFAULT_CONFIG_YAML)
  process.stdout.write(`[docs-runner] initialized docs worktree at ${resolved}\n`)
  process.exit(0)
}

export function parseArgv(args: string[]): Argv {
  if (args.length !== 5) {
    process.stderr.write(
      `[docs-runner] expected 5 positional args, got ${args.length}\n` +
        'usage: docs-runner <projectId> <cmd-file> <pid-file> <exit-file> <meta-file>\n',
    )
    process.exit(2)
  }
  return {
    projectId: args[0],
    cmdFile: args[1],
    pidFile: args[2],
    exitFile: args[3],
    metaFile: args[4],
  }
}

async function writeExitAndExit(
  exitFile: string,
  payload: Record<string, unknown>,
  code: number,
): Promise<never> {
  try {
    const outcome = await atomicWriteOnce(exitFile, JSON.stringify(payload))
    if (outcome === 'already_exists') {
      console.warn(`[docs-runner] exit file already present, skipping (${exitFile})`)
    }
  } catch (err) {
    console.error(`[docs-runner] failed to write exit file: ${(err as Error).message}`)
  }
  process.exit(code)
}

/**
 * Recursively walk `root`, returning paths (relative to `root`, posix
 * separators) that match at least one `patternRx` and no `ignoredRx`.
 *
 * Plain `fs.readdir` recursion — no external deps. Handles symlink loops
 * by tracking visited absolute paths.
 */
async function discoverFiles(
  root: string,
  patternRx: RegExp[],
  ignoredRx: RegExp[],
): Promise<string[]> {
  const out: string[] = []
  const visited = new Set<string>()

  async function walk(absDir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (rel === '' || rel.startsWith('..')) continue
      if (ignoredRx.some((rx) => rx.test(rel))) continue
      if (entry.isDirectory()) {
        if (visited.has(abs)) continue
        visited.add(abs)
        await walk(abs)
      } else if (entry.isFile()) {
        if (patternRx.some((rx) => rx.test(rel))) {
          out.push(rel)
        }
      }
    }
  }

  await walk(path.resolve(root))
  return out
}

async function startInChunks<T>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize)
    await Promise.all(slice.map(fn))
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] === 'init') {
    if (rawArgs.length < 2) {
      process.stderr.write(
        '[docs-runner] missing path argument\n' + 'usage: docs-runner init <docs-worktree-path>\n',
      )
      process.exit(2)
    }
    await runInit(rawArgs[1])
    return
  }

  const argv = parseArgv(rawArgs)
  const startTime = Date.now()

  // --- Step 2: read cmd-file ---
  let cmd: DocsRunnerCommand | null = null
  let parseErr: Error | null = null
  try {
    const raw = await fs.readFile(argv.cmdFile, 'utf8')
    cmd = JSON.parse(raw) as DocsRunnerCommand
  } catch (err) {
    parseErr = err instanceof Error ? err : new Error(String(err))
  }
  if (!cmd) {
    return writeExitAndExit(
      argv.exitFile,
      {
        state: 'failed',
        exit_code: 1,
        error: `cmd-file unreadable: ${parseErr?.message ?? 'unknown'}`,
      },
      1,
    )
  }

  if (cmd.type !== 'docs-runner') {
    return writeExitAndExit(
      argv.exitFile,
      {
        state: 'failed',
        exit_code: 1,
        error: `cmd-file unreadable: unsupported cmd.type=${(cmd as { type?: string }).type}`,
      },
      1,
    )
  }

  // --- Step 4: write pid-file ---
  const pidPayload = {
    pid: process.pid,
    projectId: argv.projectId,
    started_at: Date.now(),
  }
  await fs.writeFile(argv.pidFile, JSON.stringify(pidPayload))

  // --- Step 5: top-level state ---
  const meta: MetaSnapshot = {
    state: 'running',
    last_activity_ts: Date.now(),
    files: 0,
    reconnects: 0,
  }

  // --- Step 5a: load per-worktree file config (watch / exclude / tombstone). ---
  // Cmd-file overrides file-config; file-config replaces hardcoded defaults.
  // ENOENT → loadConfig already returns DEFAULT_CONFIG with a single warn.
  let fileConfig: Awaited<ReturnType<typeof loadConfig>>['config']
  try {
    const loaded = await loadConfig(cmd.docsWorktreePath)
    fileConfig = loaded.config
  } catch (err) {
    return writeExitAndExit(
      argv.exitFile,
      {
        state: 'failed',
        exit_code: 1,
        error: `config invalid: ${(err as Error).message}`,
      },
      1,
    )
  }

  // Connect-concurrency env override (DOCS_RUNNER_CONNECT_CONCURRENCY).
  // Read inside main() so re-runs in tests pick up env changes.
  const START_CONCURRENCY = (() => {
    const v = process.env.DOCS_RUNNER_CONNECT_CONCURRENCY
    const n = v ? Number.parseInt(v, 10) : NaN
    return Number.isFinite(n) && n > 0 ? n : 8
  })()

  let editor: ReturnType<typeof createBlockNoteEditor>
  const hashStore = new HashStore(cmd.docsWorktreePath)
  const writer = new SuppressedWriter(cmd.docsWorktreePath)
  const pipelines = new Map<string, FilePipeline>()
  const fileStates = new Map<string, FilePipelineState>()
  const fileErrors = new Map<string, number>()
  let watcher: Watcher | null = null
  let healthServer: HealthServer | null = null
  let metaTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveMetaFailures = 0

  // Cmd-file overrides file-config (which itself replaces hardcoded defaults
  // from `loadConfig`'s DEFAULT_CONFIG when duraclaw-docs.yaml is absent).
  const watchPatterns = cmd.watch ?? fileConfig.watch
  const ignoredPatterns = cmd.ignored ?? fileConfig.exclude
  const patternRx = watchPatterns.map(globToRegExp)
  const ignoredRx = ignoredPatterns.map(globToRegExp)

  async function startupFailure(err: Error): Promise<never> {
    console.error(`[docs-runner] startup failed: ${err.stack ?? err.message}`)
    if (metaTimer) clearInterval(metaTimer)
    try {
      await healthServer?.stop()
    } catch {
      /* best-effort */
    }
    try {
      await watcher?.stop()
    } catch {
      /* best-effort */
    }
    try {
      await Promise.all([...pipelines.values()].map((p) => p.stop()))
    } catch {
      /* best-effort */
    }
    return writeExitAndExit(argv.exitFile, { state: 'failed', exit_code: 1, error: err.message }, 1)
  }

  // Local non-null binding so the closures below don't need `cmd!`.
  const cfg = cmd

  // Token-rotation handler is assigned inside the try-block (after
  // `makePipeline` is in scope). `onTerminate` captures the var via
  // closure, so the runtime value is the assigned function by the time any
  // pipeline can fire a terminal event.
  let handleTokenRotation: () => Promise<void> = async () => {
    /* assigned inside try-block */
  }

  try {
    editor = createBlockNoteEditor()
    await hashStore.load()

    // --- Step 6: discover initial files + start a FilePipeline per match ---
    const initialFiles = await discoverFiles(cfg.docsWorktreePath, patternRx, ignoredRx)

    const makePipeline = (relPath: string): FilePipeline => {
      const p = new FilePipeline({
        rootPath: cfg.docsWorktreePath,
        relPath,
        projectId: cfg.projectId,
        callbackBase: cfg.callbackBase,
        bearer: cfg.bearer,
        hashStore,
        writer,
        editor,
        onTerminate: (reason) => {
          console.warn(`[docs-runner] pipeline terminated relPath=${relPath} reason=${reason}`)
          if (reason === 'document_deleted') {
            // The DO confirmed the doc is gone. Drop the entry.
            pipelines.delete(relPath)
            fileStates.delete(relPath)
            fileErrors.delete(relPath)
          } else if (reason === 'token_rotated') {
            handleTokenRotation().catch((err) => {
              console.error(`[docs-runner] token-rotation handler threw: ${(err as Error).message}`)
            })
          }
          // For all non-`document_deleted` reasons, count this as a per-file
          // error so the health snapshot reflects it.
          if (reason !== 'document_deleted') {
            fileErrors.set(relPath, (fileErrors.get(relPath) ?? 0) + 1)
          }
        },
        onStateChange: (state) => {
          fileStates.set(relPath, state)
          // Reset the per-file error counter only on successful sync.
          if (state === 'syncing') fileErrors.set(relPath, 0)
          meta.last_activity_ts = Date.now()
        },
      })
      pipelines.set(relPath, p)
      fileStates.set(relPath, 'starting')
      return p
    }

    // --- Token rotation: on 4410 from any pipeline, re-read DOCS_RUNNER_SECRET
    // from env and force-reconnect ALL live pipelines with the new bearer
    // (shared-bearer rotation semantics, spec p4). Singleton-guarded so
    // concurrent 4410s on multiple files only run the cycle once.
    let rotationInFlight: Promise<void> | null = null
    handleTokenRotation = async (): Promise<void> => {
      if (rotationInFlight) return rotationInFlight
      rotationInFlight = (async () => {
        const fresh = process.env.DOCS_RUNNER_SECRET
        if (!fresh) {
          console.error('[docs-runner] token-rotation: DOCS_RUNNER_SECRET unset; cannot reconnect')
          return
        }
        cfg.bearer = fresh
        console.warn(
          '[docs-runner] token-rotation: re-read DOCS_RUNNER_SECRET; reconnecting all pipelines',
        )
        const entries = [...pipelines.entries()]
        for (const [relPath, p] of entries) {
          try {
            await p.stop()
          } catch {
            /* best-effort */
          }
          pipelines.delete(relPath)
          const fresh2 = makePipeline(relPath)
          try {
            await fresh2.start()
          } catch (err) {
            console.error(
              `[docs-runner] reconnect after rotation failed relPath=${relPath}: ${(err as Error).message}`,
            )
            fileStates.set(relPath, 'error')
          }
        }
      })()
      try {
        await rotationInFlight
      } finally {
        rotationInFlight = null
      }
    }

    await startInChunks(initialFiles, START_CONCURRENCY, async (relPath) => {
      const p = makePipeline(relPath)
      try {
        await p.start()
      } catch (err) {
        console.error(
          `[docs-runner] pipeline start failed relPath=${relPath}: ${(err as Error).message}`,
        )
        fileStates.set(relPath, 'error')
      }
    })
    meta.files = pipelines.size

    // --- Step 7: watcher ---
    watcher = new Watcher({
      rootPath: cfg.docsWorktreePath,
      patterns: watchPatterns,
      ignored: ignoredPatterns,
      writer,
      onChange: (relPath) => {
        const pipeline = pipelines.get(relPath)
        if (!pipeline) return
        pipeline.onLocalChange().catch((err) => {
          console.error(
            `[docs-runner] onLocalChange threw relPath=${relPath}: ${(err as Error).message}`,
          )
        })
      },
      onAdd: (relPath) => {
        let pipeline = pipelines.get(relPath)
        if (!pipeline) {
          pipeline = makePipeline(relPath)
          pipeline
            .start()
            .then(() => pipeline?.onLocalAdd())
            .then(() => {
              meta.files = pipelines.size
            })
            .catch((err) => {
              console.error(
                `[docs-runner] dynamic add failed relPath=${relPath}: ${(err as Error).message}`,
              )
              fileStates.set(relPath, 'error')
            })
          return
        }
        pipeline.onLocalAdd().catch((err) => {
          console.error(
            `[docs-runner] onLocalAdd threw relPath=${relPath}: ${(err as Error).message}`,
          )
        })
      },
      onUnlink: (relPath) => {
        const pipeline = pipelines.get(relPath)
        if (!pipeline) return
        pipeline
          .onLocalUnlink()
          .catch((err) => {
            console.error(
              `[docs-runner] onLocalUnlink threw relPath=${relPath}: ${(err as Error).message}`,
            )
          })
          .finally(() => {
            pipelines.delete(relPath)
            fileStates.set(relPath, 'tombstoned')
            meta.files = pipelines.size
          })
      },
    })
    await watcher.start()

    // --- Step 8: health server ---
    const snapshot = (): HealthSnapshot => {
      let syncing = 0
      let disconnected = 0
      let tombstoned = 0
      let errors = 0
      const per_file: HealthFileEntry[] = []
      const now = Date.now()
      for (const [relPath, st] of fileStates.entries()) {
        if (st === 'syncing') syncing++
        else if (st === 'disconnected') disconnected++
        else if (st === 'tombstoned') tombstoned++
        else if (st === 'error') errors++
        per_file.push({
          path: relPath,
          state: st,
          last_sync_ts: meta.last_activity_ts,
          error_count: fileErrors.get(relPath) ?? 0,
        })
      }
      const watcherAlive = watcher?.isAlive() ?? false
      const filesEmptyTooLong = meta.files === 0 && now - startTime > STARTUP_FILES_GRACE_MS
      let status: HealthSnapshot['status'] = 'ok'
      if (!watcherAlive || filesEmptyTooLong) status = 'down'
      else if (disconnected > 0) status = 'degraded'
      return {
        status,
        version: VERSION,
        uptime_ms: now - startTime,
        files: meta.files,
        syncing,
        disconnected,
        tombstoned,
        errors,
        reconnects: meta.reconnects,
        per_file,
      }
    }
    healthServer = new HealthServer({
      port: cfg.healthPort ?? DEFAULT_HEALTH_PORT,
      snapshot,
    })
    await healthServer.start()

    // --- Step 9: meta-file dumper ---
    const flushMeta = async () => {
      try {
        await atomicOverwrite(argv.metaFile, JSON.stringify(meta))
        consecutiveMetaFailures = 0
      } catch (err) {
        consecutiveMetaFailures++
        console.error(
          `[docs-runner] meta write failed (${consecutiveMetaFailures}/${META_FAILURE_LIMIT}): ${(err as Error).message}`,
        )
        if (consecutiveMetaFailures >= META_FAILURE_LIMIT) {
          console.error('[docs-runner] meta write failure limit reached — triggering shutdown')
          process.kill(process.pid, 'SIGTERM')
        }
      }
    }
    await flushMeta()
    metaTimer = setInterval(flushMeta, META_INTERVAL_MS)
  } catch (err) {
    return startupFailure(err instanceof Error ? err : new Error(String(err)))
  }

  // --- Step 10: SIGTERM handler ---
  let forcedExit = false
  let shuttingDown = false
  const sigtermHandler = () => {
    if (shuttingDown) return
    shuttingDown = true
    console.warn('[docs-runner] SIGTERM received — shutting down')
    meta.state = 'aborted'

    const watchdog = setTimeout(async () => {
      if (forcedExit) return
      forcedExit = true
      try {
        await atomicOverwrite(argv.metaFile, JSON.stringify(meta))
      } catch {
        /* best-effort */
      }
      try {
        const outcome = await atomicWriteOnce(
          argv.exitFile,
          JSON.stringify({
            state: 'aborted',
            exit_code: 1,
            duration_ms: Date.now() - startTime,
          }),
        )
        if (outcome === 'already_exists') {
          console.warn('[docs-runner] exit file already present, skipping')
        }
      } catch (err) {
        console.error(`[docs-runner] force-exit write failed: ${(err as Error).message}`)
      }
      process.exit(1)
    }, SIGTERM_GRACE_MS)
    watchdog.unref()

    ;(async () => {
      try {
        await watcher?.stop()
      } catch {
        /* best-effort */
      }
      try {
        await Promise.all([...pipelines.values()].map((p) => p.stop()))
      } catch {
        /* best-effort */
      }
      // Reap hash-store entries for tombstoned files so they don't linger
      // across restarts (spec p4: "Reap hash-store + connection-state on
      // process exit"). Best-effort — don't block exit on persistence errors.
      try {
        for (const [relPath, st] of fileStates.entries()) {
          if (st === 'tombstoned') {
            try {
              await hashStore.delete(relPath)
            } catch (err) {
              console.warn(
                `[docs-runner] hash-store reap failed relPath=${relPath}: ${(err as Error).message}`,
              )
            }
          }
        }
      } catch {
        /* best-effort */
      }
      try {
        await healthServer?.stop()
      } catch {
        /* best-effort */
      }
      if (metaTimer) clearInterval(metaTimer)
      try {
        await atomicOverwrite(argv.metaFile, JSON.stringify(meta))
      } catch {
        /* best-effort */
      }
      if (forcedExit) return
      forcedExit = true
      clearTimeout(watchdog)
      const payload = {
        state: 'aborted',
        exit_code: 0,
        duration_ms: Date.now() - startTime,
      }
      try {
        const outcome = await atomicWriteOnce(argv.exitFile, JSON.stringify(payload))
        if (outcome === 'already_exists') {
          console.warn('[docs-runner] exit file already present, skipping')
        }
      } catch (err) {
        console.error(`[docs-runner] exit-file write failed: ${(err as Error).message}`)
      }
      process.exit(0)
    })().catch((err) => {
      console.error(`[docs-runner] graceful shutdown threw: ${(err as Error).message}`)
    })
  }
  process.on('SIGTERM', sigtermHandler)
  process.on('SIGINT', sigtermHandler)
}

// Only auto-run when invoked as a script — keeps `import { parseArgv } from
// './main.js'` cheap for tests. We detect "is the entrypoint" by comparing
// `process.argv[1]` to this file's URL path. Bun + Node both populate
// argv[1] with the resolved path of the script being run.
const isEntry = (() => {
  try {
    const here = new URL(import.meta.url).pathname
    const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
    return arg1 === here
  } catch {
    return false
  }
})()

if (isEntry) {
  main().catch((err) => {
    console.error(`[docs-runner] fatal in main(): ${(err as Error).stack ?? err}`)
    process.exit(1)
  })
}
