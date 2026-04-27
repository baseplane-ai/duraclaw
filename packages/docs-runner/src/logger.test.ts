import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from './logger.js'

describe('createLogger', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>
  let lines: string[]

  beforeEach(() => {
    lines = []
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as unknown as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  it('emits a single line with ts, level, event fields', () => {
    const log = createLogger()
    log.info('startup.enumeration_complete', { files: 3 })
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith('\n')).toBe(true)
    expect(lines[0].split('\n')).toHaveLength(2) // body + trailing newline
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(typeof parsed.ts).toBe('string')
    expect(parsed.level).toBe('info')
    expect(parsed.event).toBe('startup.enumeration_complete')
    expect(parsed.files).toBe(3)
  })

  it('attaches base fields (projectId) to every emit', () => {
    const log = createLogger({ projectId: 'proj-123' })
    log.warn('token.rotated', { pipelines: 2 })
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed.projectId).toBe('proj-123')
    expect(parsed.pipelines).toBe(2)
    expect(parsed.event).toBe('token.rotated')
  })

  it('serialises Error to {message, stack} and never raw', () => {
    const log = createLogger()
    const err = new Error('boom')
    log.error('pipeline.start_failed', { err, file: 'a.md' })
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed.err).toEqual({ message: 'boom', stack: err.stack })
    expect(parsed.file).toBe('a.md')
    // The raw Error must not have leaked through under any other key.
    expect(parsed.err).not.toBeInstanceOf(Error)
  })

  it('levels emit the correct level value', () => {
    const log = createLogger()
    log.debug('e.debug')
    log.info('e.info')
    log.warn('e.warn')
    log.error('e.error')
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level)
    expect(levels).toEqual(['debug', 'info', 'warn', 'error'])
  })
})
