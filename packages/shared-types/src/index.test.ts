import { describe, expect, test } from 'bun:test'
import type {
  ContextUsageEvent,
  ExecuteCommand,
  GatewayCommand,
  GatewayEvent,
  GetContextUsageCommand,
  InterruptCommand,
  ProjectInfo,
  RateLimitEvent,
  ResultEvent,
  ResumeCommand,
  RewindCommand,
  RewindResultEvent,
  SessionInitEvent,
  SessionState,
  SessionStateChangedEvent,
  SessionSummary,
  SetModelCommand,
  SetPermissionModeCommand,
  StopTaskCommand,
  TaskNotificationEvent,
  TaskProgressEvent,
  TaskStartedEvent,
} from './index'

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

  test('SessionState uses project and project_path fields', () => {
    const state: SessionState = {
      id: '123',
      userId: 'user-1',
      project: 'dev1',
      project_path: '/data/projects/dev1',
      status: 'idle',
      model: null,
      prompt: 'test',
      created_at: '',
      updated_at: '',
      duration_ms: null,
      total_cost_usd: null,
      result: null,
      error: null,
      num_turns: null,
      sdk_session_id: null,
      summary: null,
      pending_question: null,
      pending_permission: null,
    }
    expect(state.userId).toBe('user-1')
    expect(state.project).toBe('dev1')
    expect(state.project_path).toBe('/data/projects/dev1')
  })

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
      created_at: '',
      updated_at: '',
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

  test('RewindCommand accepts dry_run field', () => {
    const cmd: RewindCommand = {
      type: 'rewind',
      session_id: 'sess-1',
      message_id: 'msg-1',
      dry_run: true,
    }
    expect(cmd.dry_run).toBe(true)
  })

  test('new command types are part of GatewayCommand union', () => {
    const interrupt: GatewayCommand = { type: 'interrupt', session_id: 's1' }
    const getCtx: GatewayCommand = { type: 'get-context-usage', session_id: 's1' }
    const setModel: GatewayCommand = {
      type: 'set-model',
      session_id: 's1',
      model: 'claude-haiku-4-6',
    }
    const setPerm: GatewayCommand = {
      type: 'set-permission-mode',
      session_id: 's1',
      mode: 'acceptEdits',
    }
    const stopTask: GatewayCommand = { type: 'stop-task', session_id: 's1', task_id: 't1' }

    expect(interrupt.type).toBe('interrupt')
    expect(getCtx.type).toBe('get-context-usage')
    expect(setModel.type).toBe('set-model')
    expect(setPerm.type).toBe('set-permission-mode')
    expect(stopTask.type).toBe('stop-task')
  })

  test('InterruptCommand has correct shape', () => {
    const cmd: InterruptCommand = { type: 'interrupt', session_id: 'sess-1' }
    expect(cmd.type).toBe('interrupt')
    expect(cmd.session_id).toBe('sess-1')
  })

  test('SetModelCommand model is optional', () => {
    const cmd: SetModelCommand = { type: 'set-model', session_id: 'sess-1' }
    expect(cmd.model).toBeUndefined()
  })

  test('SetPermissionModeCommand accepts all valid modes', () => {
    const modes = [
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
      'dontAsk',
      'auto',
    ] as const
    for (const mode of modes) {
      const cmd: SetPermissionModeCommand = { type: 'set-permission-mode', session_id: 's1', mode }
      expect(cmd.mode).toBe(mode)
    }
  })

  test('new event types are part of GatewayEvent union', () => {
    const ctxUsage: GatewayEvent = {
      type: 'context_usage',
      session_id: 's1',
      usage: { totalTokens: 1000 },
    }
    const rewindResult: GatewayEvent = {
      type: 'rewind_result',
      session_id: 's1',
      can_rewind: true,
      files_changed: ['/tmp/test.ts'],
      insertions: 5,
      deletions: 2,
    }
    const stateChanged: GatewayEvent = {
      type: 'session_state_changed',
      session_id: 's1',
      state: 'running',
    }
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

    expect(ctxUsage.type).toBe('context_usage')
    expect(rewindResult.type).toBe('rewind_result')
    expect(stateChanged.type).toBe('session_state_changed')
    expect(rateLimit.type).toBe('rate_limit')
    expect(taskStarted.type).toBe('task_started')
    expect(taskProgress.type).toBe('task_progress')
    expect(taskNotification.type).toBe('task_notification')
  })

  test('SessionStateChangedEvent accepts all valid states', () => {
    const states = ['idle', 'running', 'requires_action'] as const
    for (const state of states) {
      const event: SessionStateChangedEvent = {
        type: 'session_state_changed',
        session_id: 's1',
        state,
      }
      expect(event.state).toBe(state)
    }
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

  test('RewindResultEvent error and files_changed are optional', () => {
    const event: RewindResultEvent = {
      type: 'rewind_result',
      session_id: 's1',
      can_rewind: false,
    }
    expect(event.can_rewind).toBe(false)
    expect(event.error).toBeUndefined()
    expect(event.files_changed).toBeUndefined()
  })

  test('ContextUsageEvent carries opaque usage payload', () => {
    const event: ContextUsageEvent = {
      type: 'context_usage',
      session_id: 's1',
      usage: {
        totalTokens: 5000,
        maxTokens: 100000,
        percentage: 5,
        model: 'claude-sonnet-4-6',
        categories: [{ name: 'system', tokens: 1000 }],
      },
    }
    expect((event.usage as any).totalTokens).toBe(5000)
    expect((event.usage as any).model).toBe('claude-sonnet-4-6')
  })

  test('StopTaskCommand requires task_id', () => {
    const cmd: StopTaskCommand = { type: 'stop-task', session_id: 's1', task_id: 'task-abc' }
    expect(cmd.task_id).toBe('task-abc')
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

  test('SessionState includes summary field', () => {
    const state: SessionState = {
      id: '123',
      userId: 'user-1',
      project: 'dev1',
      project_path: '/data/projects/dev1',
      status: 'idle',
      model: null,
      prompt: 'test',
      created_at: '',
      updated_at: '',
      duration_ms: null,
      total_cost_usd: null,
      result: null,
      error: null,
      num_turns: null,
      sdk_session_id: null,
      summary: 'Migrated database schema',
      pending_question: null,
      pending_permission: null,
    }
    expect(state.summary).toBe('Migrated database schema')
  })
})
