import { describe, expect, test } from 'bun:test'
import type {
  ExecuteCommand,
  GatewayCommand,
  ProjectInfo,
  ResultEvent,
  ResumeCommand,
  SessionInitEvent,
  SessionState,
  SessionSummary,
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
