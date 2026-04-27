/**
 * JSON-lines structured logger for the docs-runner (P1.9).
 *
 * All logs go to stdout (systemd-friendly — journalctl preserves stdout
 * lines verbatim and parses JSON when `Format=json`). One log line per
 * `JSON.stringify({...})` call; never multi-line.
 *
 * Field set: `{ ts, level, event, ...attrs }`. `event` is a dotted
 * snake_case string identifying the call-site (e.g.
 * `pipeline.start_failed`, `token.rotated`, `shutdown.signal_received`).
 * `err` (when present) is `{ message, stack }` — never the raw Error.
 *
 * Levels: 'debug' | 'info' | 'warn' | 'error'. The legacy
 * `console.warn` / `console.error` call-sites in main.ts and file-pipeline.ts
 * are migrated incrementally; new code uses `log.event(...)`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogAttrs {
  file?: string
  sessionId?: string
  projectId?: string
  err?: unknown
  [k: string]: unknown
}

function serializeErr(err: unknown): { message: string; stack?: string } | undefined {
  if (err == null) return undefined
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  return { message: String(err) }
}

export interface Logger {
  debug(event: string, attrs?: LogAttrs): void
  info(event: string, attrs?: LogAttrs): void
  warn(event: string, attrs?: LogAttrs): void
  error(event: string, attrs?: LogAttrs): void
}

export function createLogger(base: Pick<LogAttrs, 'projectId'> = {}): Logger {
  const emit = (level: LogLevel, event: string, attrs?: LogAttrs) => {
    const { err, ...rest } = attrs ?? {}
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...base,
      ...rest,
    }
    const serialized = serializeErr(err)
    if (serialized) payload.err = serialized
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }
  return {
    debug: (e, a) => emit('debug', e, a),
    info: (e, a) => emit('info', e, a),
    warn: (e, a) => emit('warn', e, a),
    error: (e, a) => emit('error', e, a),
  }
}
