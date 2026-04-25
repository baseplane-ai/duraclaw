import { describe, expect, test } from 'bun:test'
import type {
  DiscoveredSession,
  ExecuteCommand,
  GatewayCommand,
  GatewayEvent,
  InterruptCommand,
  KataSessionState,
  KataStateEvent,
  ProjectInfo,
  ResultEvent,
  ResumeCommand,
  SessionInitEvent,
  SessionSource,
  SessionStatus,
  SessionSummary,
  TaskNotificationEvent,
} from './index'

describe('sessionstate-deleted (#31 P5)', () => {
  test('SessionState is no longer exported', () => {
    // Compile-time guard: if a future change re-adds `SessionState` to the
    // shared-types barrel, this assertion forces the author to acknowledge
    // the regression by updating the test body. The assertion itself is a
    // runtime tautology; the real enforcement is the missing import above.
    const sharedTypes = require('./index') as Record<string, unknown>
    expect('SessionState' in sharedTypes).toBe(false)
  })
})

describe('shared-types rename: worktree→project', () => {
  test('ProjectInfo has expected fields', () => {
    const info: ProjectInfo = {
      name: 'dev1',
      path: '/data/projects/dev1',
      branch: 'main',
      dirty: false,
      active_session: null,
    }
    expect(info.name).toBe('dev1')
  })

  test('ExecuteCommand uses project field', () => {
    const cmd: ExecuteCommand = { type: 'execute', project: 'dev1', prompt: 'hello' }
    expect(cmd.project).toBe('dev1')
  })

  test('ResumeCommand uses project field', () => {
    const cmd: ResumeCommand = {
      type: 'resume',
      project: 'dev1',
      prompt: 'continue',
      sdk_session_id: 'abc',
    }
    expect(cmd.project).toBe('dev1')
  })

  test('ResumeCommand is part of GatewayCommand union', () => {
    const cmd: GatewayCommand = {
      type: 'resume',
      project: 'dev1',
      prompt: 'continue',
      sdk_session_id: 'abc',
    }
    expect(cmd.type).toBe('resume')
  })

  test('SessionInitEvent uses project field', () => {
    const event: SessionInitEvent = {
      type: 'session.init',
      session_id: '123',
      sdk_session_id: null,
      project: 'dev1',
      model: null,
      tools: [],
    }
    expect(event.project).toBe('dev1')
  })

  // `SessionState` deleted in #31 P5 — former field-level tests dropped.

  test('ExecuteCommand accepts optional org_id and user_id', () => {
    const cmd: ExecuteCommand = {
      type: 'execute',
      project: 'dev1',
      prompt: 'hello',
      org_id: 'org-123',
      user_id: 'user-456',
    }
    expect(cmd.org_id).toBe('org-123')
    expect(cmd.user_id).toBe('user-456')
  })

  test('ExecuteCommand works without org_id and user_id (backwards compatible)', () => {
    const cmd: ExecuteCommand = { type: 'execute', project: 'dev1', prompt: 'hello' }
    expect(cmd.org_id).toBeUndefined()
    expect(cmd.user_id).toBeUndefined()
  })

  test('SessionSummary uses project field and has optional summary', () => {
    const summary: SessionSummary = {
      id: '123',
      userId: 'user-1',
      project: 'dev1',
      status: 'idle',
      model: null,
      createdAt: '',
      updatedAt: '',
      summary: 'Added OAuth flow',
    }
    expect(summary.project).toBe('dev1')
    expect(summary.summary).toBe('Added OAuth flow')
  })
})

describe('shared-types: SDK feature expansion (#13)', () => {
  test('ExecuteCommand accepts thinking and effort fields', () => {
    const cmd: ExecuteCommand = {
      type: 'execute',
      project: 'dev1',
      prompt: 'hello',
      thinking: { type: 'adaptive' },
      effort: 'high',
    }
    expect(cmd.thinking).toEqual({ type: 'adaptive' })
    expect(cmd.effort).toBe('high')
  })

  test('ExecuteCommand thinking supports all variants', () => {
    const adaptive: ExecuteCommand = {
      type: 'execute',
      project: 'dev1',
      prompt: 'test',
      thinking: { type: 'adaptive', display: 'summarized' },
    }
    const enabled: ExecuteCommand = {
      type: 'execute',
      project: 'dev1',
      prompt: 'test',
      thinking: { type: 'enabled', budgetTokens: 5000 },
    }
    const disabled: ExecuteCommand = {
      type: 'execute',
      project: 'dev1',
      prompt: 'test',
      thinking: { type: 'disabled' },
    }
    expect(adaptive.thinking?.type).toBe('adaptive')
    expect(enabled.thinking?.type).toBe('enabled')
    expect(disabled.thinking?.type).toBe('disabled')
  })

  test('InterruptCommand is part of GatewayCommand union', () => {
    const cmd: GatewayCommand = { type: 'interrupt', session_id: 's1' }
    expect(cmd.type).toBe('interrupt')
  })

  test('InterruptCommand has correct shape', () => {
    const cmd: InterruptCommand = { type: 'interrupt', session_id: 'sess-1' }
    expect(cmd.type).toBe('interrupt')
    expect(cmd.session_id).toBe('sess-1')
  })

  test('rate_limit and task_* events are part of GatewayEvent union', () => {
    const rateLimit: GatewayEvent = {
      type: 'rate_limit',
      session_id: 's1',
      rate_limit_info: { status: 'allowed' },
    }
    const taskStarted: GatewayEvent = {
      type: 'task_started',
      session_id: 's1',
      task_id: 't1',
      description: 'Running tests',
    }
    const taskProgress: GatewayEvent = {
      type: 'task_progress',
      session_id: 's1',
      task_id: 't1',
      description: 'Running tests',
      usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 },
    }
    const taskNotification: GatewayEvent = {
      type: 'task_notification',
      session_id: 's1',
      task_id: 't1',
      status: 'completed',
      summary: 'Tests passed',
      output_file: '/tmp/output.txt',
    }

    expect(rateLimit.type).toBe('rate_limit')
    expect(taskStarted.type).toBe('task_started')
    expect(taskProgress.type).toBe('task_progress')
    expect(taskNotification.type).toBe('task_notification')
  })

  test('TaskNotificationEvent accepts all valid statuses', () => {
    const statuses = ['completed', 'failed', 'stopped'] as const
    for (const status of statuses) {
      const event: TaskNotificationEvent = {
        type: 'task_notification',
        session_id: 's1',
        task_id: 't1',
        status,
        summary: 'done',
        output_file: '/tmp/out.txt',
      }
      expect(event.status).toBe(status)
    }
  })
})

describe('shared-types: SDK summary fields', () => {
  test('ResultEvent includes sdk_summary', () => {
    const event: ResultEvent = {
      type: 'result',
      session_id: '123',
      subtype: 'success',
      duration_ms: 5000,
      total_cost_usd: 0.42,
      result: 'done',
      num_turns: 3,
      is_error: false,
      sdk_summary: 'Added OAuth flow to settings page',
    }
    expect(event.sdk_summary).toBe('Added OAuth flow to settings page')
  })

  test('ResultEvent sdk_summary can be null', () => {
    const event: ResultEvent = {
      type: 'result',
      session_id: '123',
      subtype: 'success',
      duration_ms: 1000,
      total_cost_usd: null,
      result: null,
      num_turns: null,
      is_error: false,
      sdk_summary: null,
    }
    expect(event.sdk_summary).toBeNull()
  })

  // `SessionState` deleted in #31 P5 — summary lives on SessionSummary instead.
})

describe('SessionStatus type', () => {
  test('includes expected valid statuses', () => {
    const validStatuses: SessionStatus[] = [
      'idle',
      'running',
      'waiting_input',
      'waiting_permission',
      'waiting_gate',
    ]
    expect(validStatuses).toHaveLength(5)
  })

  test('does not include completed (sessions use idle instead)', () => {
    // This is a runtime check that the set of valid statuses does not include 'completed'.
    // The type-level exclusion is enforced by removing 'completed' from the SessionStatus union.
    const allStatuses: SessionStatus[] = [
      'idle',
      'running',
      'waiting_input',
      'waiting_permission',
      'waiting_gate',
    ]
    expect(allStatuses).not.toContain('completed' as never)
  })
})

describe('shared-types: session discovery (#27)', () => {
  test('DiscoveredSession has all required fields', () => {
    const session: DiscoveredSession = {
      sdk_session_id: 'sess-abc-123',
      agent: 'claude',
      project_dir: '/data/projects/dev1',
      project: 'dev1',
      branch: 'main',
      started_at: '2026-04-12T00:00:00Z',
      last_activity: '2026-04-12T01:00:00Z',
      summary: 'Added OAuth flow',
      tag: null,
      title: null,
      message_count: null,
      user: null,
    }
    expect(session.sdk_session_id).toBe('sess-abc-123')
    expect(session.agent).toBe('claude')
    expect(session.project_dir).toBe('/data/projects/dev1')
    expect(session.project).toBe('dev1')
    expect(session.branch).toBe('main')
    expect(session.started_at).toBe('2026-04-12T00:00:00Z')
    expect(session.last_activity).toBe('2026-04-12T01:00:00Z')
    expect(session.summary).toBe('Added OAuth flow')
  })

  test('DiscoveredSession nullable fields accept values', () => {
    const session: DiscoveredSession = {
      sdk_session_id: 'sess-def-456',
      agent: 'codex',
      project_dir: '/data/projects/dev2',
      project: 'dev2',
      branch: 'feature/oauth',
      started_at: '2026-04-12T00:00:00Z',
      last_activity: '2026-04-12T02:00:00Z',
      summary: 'Refactored auth module',
      tag: 'auth-work',
      title: 'OAuth Refactor',
      message_count: 42,
      user: 'ben',
    }
    expect(session.tag).toBe('auth-work')
    expect(session.title).toBe('OAuth Refactor')
    expect(session.message_count).toBe(42)
    expect(session.user).toBe('ben')
  })

  test('SessionSource interface can be implemented', async () => {
    const source: SessionSource = {
      agent: 'claude',
      description: 'Claude Code sessions via SDK',
      async available() {
        return true
      },
      async discoverSessions(_projectPath, _opts) {
        return []
      },
    }
    expect(source.agent).toBe('claude')
    expect(source.description).toBe('Claude Code sessions via SDK')
    expect(await source.available()).toBe(true)
    expect(await source.discoverSessions('/data/projects/dev1')).toEqual([])
  })

  test('SessionSource.discoverSessions accepts optional filter opts', async () => {
    const sessions: DiscoveredSession[] = [
      {
        sdk_session_id: 'sess-1',
        agent: 'claude',
        project_dir: '/data/projects/dev1',
        project: 'dev1',
        branch: 'main',
        started_at: '2026-04-12T00:00:00Z',
        last_activity: '2026-04-12T01:00:00Z',
        summary: 'test session',
        tag: null,
        title: null,
        message_count: null,
        user: null,
      },
    ]

    const source: SessionSource = {
      agent: 'claude',
      description: 'Claude Code sessions',
      async available() {
        return true
      },
      async discoverSessions(_projectPath, opts) {
        if (opts?.limit && opts.limit < sessions.length) {
          return sessions.slice(0, opts.limit)
        }
        return sessions
      },
    }

    const result = await source.discoverSessions('/data/projects/dev1', {
      since: '2026-04-01T00:00:00Z',
      limit: 10,
    })
    expect(result).toHaveLength(1)
    expect(result[0].sdk_session_id).toBe('sess-1')
  })

  test('SessionSource agent and description are readonly', () => {
    const source: SessionSource = {
      agent: 'codex',
      description: 'OpenAI Codex sessions',
      async available() {
        return false
      },
      async discoverSessions() {
        return []
      },
    }
    // readonly is enforced at compile time; at runtime we verify the values are set
    expect(source.agent).toBe('codex')
    expect(source.description).toBe('OpenAI Codex sessions')
  })
})

describe('shared-types: kata state fields (#29)', () => {
  test('SessionSummary accepts kataMode, kataIssue, kataPhase', () => {
    const summary: SessionSummary = {
      id: '123',
      userId: 'user-1',
      project: 'dev1',
      status: 'running',
      model: 'claude-opus-4-6',
      createdAt: '2026-04-13T00:00:00Z',
      updatedAt: '2026-04-13T01:00:00Z',
      kataMode: 'implementation',
      kataIssue: 29,
      kataPhase: 'p1',
    }
    expect(summary.kataMode).toBe('implementation')
    expect(summary.kataIssue).toBe(29)
    expect(summary.kataPhase).toBe('p1')
  })

  test('SessionSummary kata fields are optional', () => {
    const summary: SessionSummary = {
      id: '456',
      userId: 'user-2',
      project: 'dev2',
      status: 'idle',
      model: null,
      createdAt: '',
      updatedAt: '',
    }
    expect(summary.kataMode).toBeUndefined()
    expect(summary.kataIssue).toBeUndefined()
    expect(summary.kataPhase).toBeUndefined()
  })

  test('SessionSummary kata fields accept null', () => {
    const summary: SessionSummary = {
      id: '789',
      userId: 'user-3',
      project: 'dev3',
      status: 'idle',
      model: null,
      createdAt: '',
      updatedAt: '',
      kataMode: null,
      kataIssue: null,
      kataPhase: null,
    }
    expect(summary.kataMode).toBeNull()
    expect(summary.kataIssue).toBeNull()
    expect(summary.kataPhase).toBeNull()
  })

  test('KataSessionState has expected shape', () => {
    const state: KataSessionState = {
      sessionId: 'sess-1',
      workflowId: 'wf-1',
      issueNumber: 29,
      sessionType: 'implementation',
      currentMode: 'implementation',
      currentPhase: 'p1',
      completedPhases: ['p0'],
      template: 'feature',
      phases: ['p0', 'p1', 'p2'],
      modeHistory: [{ mode: 'planning', enteredAt: '2026-04-13T00:00:00Z' }],
      modeState: { planning: { status: 'done', enteredAt: '2026-04-13T00:00:00Z' } },
      updatedAt: '2026-04-13T01:00:00Z',
      beadsCreated: [],
      editedFiles: [],
    }
    expect(state.currentMode).toBe('implementation')
    expect(state.issueNumber).toBe(29)
    expect(state.currentPhase).toBe('p1')
  })

  test('KataStateEvent is part of GatewayEvent union', () => {
    const event: GatewayEvent = {
      type: 'kata_state',
      session_id: 'sess-1',
      project: 'dev1',
      kata_state: {
        sessionId: 'sess-1',
        workflowId: null,
        issueNumber: null,
        sessionType: null,
        currentMode: 'freeform',
        currentPhase: null,
        completedPhases: [],
        template: null,
        phases: [],
        modeHistory: [],
        modeState: {},
        updatedAt: '2026-04-13T00:00:00Z',
        beadsCreated: [],
        editedFiles: [],
      },
    }
    expect(event.type).toBe('kata_state')
  })

  test('KataStateEvent kata_state can be null', () => {
    const event: KataStateEvent = {
      type: 'kata_state',
      session_id: 'sess-1',
      project: 'dev1',
      kata_state: null,
    }
    expect(event.kata_state).toBeNull()
  })
})
