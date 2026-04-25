/**
 * GH#92 P1.1 — type-level tests for the extended ExitFile / MetaFile /
 * SessionStateSnapshot unions and the new caam-tracked fields.
 *
 * Vitest runs each `it` with a real assertion on the (constant) value to
 * force tsc into exercising the union type. No runtime behaviour is
 * being verified — type assignability IS the test. If the underlying
 * union literals get narrowed accidentally these tests fail at
 * typecheck time BEFORE the vitest run.
 */
import { describe, expect, it } from 'vitest'
import { resolveSessionState } from './session-state.js'
import type { ExitFile, MetaFile, SessionStateSnapshot } from './types.js'

describe('GH#92 caam exit/meta type extensions', () => {
  it('ExitFile.state accepts all rate_limited* literals', () => {
    const a: ExitFile = { state: 'rate_limited', exit_code: 0, duration_ms: 100 }
    const b: ExitFile = { state: 'rate_limited_no_rotate', exit_code: 0, duration_ms: 100 }
    const c: ExitFile = { state: 'rate_limited_no_profile', exit_code: 0, duration_ms: 100 }
    // Legacy values still assign — no regression.
    const d: ExitFile = { state: 'completed', exit_code: 0, duration_ms: 100 }
    const e: ExitFile = { state: 'aborted', exit_code: 0, duration_ms: 100 }
    expect([a.state, b.state, c.state, d.state, e.state]).toEqual([
      'rate_limited',
      'rate_limited_no_rotate',
      'rate_limited_no_profile',
      'completed',
      'aborted',
    ])
  })

  it('MetaFile allows claude_profile, rotation, and rate_limit_earliest_clear_ts', () => {
    const m: MetaFile = {
      sdk_session_id: 'sdk-1',
      last_activity_ts: Date.now(),
      last_event_seq: 42,
      cost: { input_tokens: 1, output_tokens: 2, usd: 0.001 },
      model: 'claude-3-5-sonnet-latest',
      turn_count: 3,
      state: 'rate_limited',
      claude_profile: 'work2',
      rotation: { from: 'work1', to: 'work2' },
      rate_limit_earliest_clear_ts: Date.now() + 60_000,
    }
    expect(m.claude_profile).toBe('work2')
    expect(m.rotation?.from).toBe('work1')
    expect(m.rotation?.to).toBe('work2')
    expect(typeof m.rate_limit_earliest_clear_ts).toBe('number')
  })

  it('MetaFile allows null caam fields (dev-box default)', () => {
    const m: MetaFile = {
      sdk_session_id: null,
      last_activity_ts: null,
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
      state: 'running',
      claude_profile: null,
      rotation: null,
    }
    expect(m.claude_profile).toBeNull()
    expect(m.rotation).toBeNull()
  })

  it('SessionStateSnapshot surfaces rate_limited* literals through', () => {
    const snap: SessionStateSnapshot = {
      session_id: 'sess-1',
      state: 'rate_limited_no_profile',
      sdk_session_id: 'sdk-1',
      last_activity_ts: Date.now(),
      last_event_seq: 1,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
      claude_profile: null,
      rotation: null,
    }
    expect(snap.state).toBe('rate_limited_no_profile')
  })

  it('resolveSessionState passes exit.state through verbatim (incl. new literals)', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh92-caam-test-'))
    const sid = 'sess-x'
    const exitPath = path.join(dir, `${sid}.exit`)
    const metaPath = path.join(dir, `${sid}.meta.json`)
    await fs.writeFile(
      exitPath,
      JSON.stringify({ state: 'rate_limited', exit_code: 0, duration_ms: 10 }),
    )
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        sdk_session_id: 'sdk-x',
        last_activity_ts: Date.now(),
        last_event_seq: 0,
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        model: 'claude-3-5-sonnet-latest',
        turn_count: 0,
        state: 'rate_limited',
        claude_profile: 'work2',
        rotation: { from: 'work1', to: 'work2' },
      }),
    )
    const res = await resolveSessionState(dir, sid, () => false)
    await fs.rm(dir, { recursive: true, force: true })
    expect(res.found).toBe(true)
    if (!res.found) throw new Error('unreachable')
    expect(res.state.state).toBe('rate_limited')
    expect(res.state.claude_profile).toBe('work2')
    expect(res.state.rotation).toEqual({ from: 'work1', to: 'work2' })
  })
})
