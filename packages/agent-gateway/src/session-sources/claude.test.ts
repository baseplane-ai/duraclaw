import { describe, expect, it, vi } from 'vitest'
import type { SdkSessionInfo } from '../types.js'
import { ClaudeSessionSource } from './claude.js'

// Mock the sessions-list module
vi.mock('../sessions-list.js', () => ({
  listSdkSessions: vi.fn(),
}))

// Import after mock setup so the mock takes effect
const { listSdkSessions } = await import('../sessions-list.js')
const mockedListSdkSessions = listSdkSessions as ReturnType<typeof vi.fn>

function makeSdkSession(overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    session_id: 'sess-abc-123',
    user: 'testuser',
    branch: 'main',
    project_dir: '/data/projects/my-project',
    workflow_id: 'wf-1',
    started_at: '2026-04-10T10:00:00Z',
    last_activity: '2026-04-10T12:00:00Z',
    summary: 'Implemented feature X',
    tag: 'v1',
    ...overrides,
  }
}

describe('ClaudeSessionSource', () => {
  it('has agent set to claude', () => {
    const source = new ClaudeSessionSource()
    expect(source.agent).toBe('claude')
  })

  it('has a description mentioning .claude/sessions/', () => {
    const source = new ClaudeSessionSource()
    expect(source.description).toContain('.claude/sessions/')
  })

  describe('discoverSessions', () => {
    it('calls listSdkSessions with projectPath and default limit of 50', async () => {
      mockedListSdkSessions.mockResolvedValue([])
      const source = new ClaudeSessionSource()

      await source.discoverSessions('/data/projects/dev1')

      expect(mockedListSdkSessions).toHaveBeenCalledWith('/data/projects/dev1', 50)
    })

    it('passes custom limit to listSdkSessions', async () => {
      mockedListSdkSessions.mockResolvedValue([])
      const source = new ClaudeSessionSource()

      await source.discoverSessions('/data/projects/dev1', { limit: 10 })

      expect(mockedListSdkSessions).toHaveBeenCalledWith('/data/projects/dev1', 10)
    })

    it('maps SdkSessionInfo fields to DiscoveredSession', async () => {
      const sdk = makeSdkSession()
      mockedListSdkSessions.mockResolvedValue([sdk])
      const source = new ClaudeSessionSource()

      const [result] = await source.discoverSessions('/data/projects/dev1')

      expect(result.sdk_session_id).toBe('sess-abc-123')
      expect(result.agent).toBe('claude')
      expect(result.project_dir).toBe('/data/projects/my-project')
      expect(result.project).toBe('my-project')
      expect(result.branch).toBe('main')
      expect(result.started_at).toBe('2026-04-10T10:00:00Z')
      expect(result.last_activity).toBe('2026-04-10T12:00:00Z')
      expect(result.summary).toBe('Implemented feature X')
      expect(result.tag).toBe('v1')
      expect(result.title).toBeNull()
      expect(result.message_count).toBeNull()
      expect(result.user).toBe('testuser')
    })

    it('maps empty user string to null', async () => {
      const sdk = makeSdkSession({ user: '' })
      mockedListSdkSessions.mockResolvedValue([sdk])
      const source = new ClaudeSessionSource()

      const [result] = await source.discoverSessions('/tmp/proj')

      expect(result.user).toBeNull()
    })

    it('derives project name from basename of project_dir', async () => {
      const sdk = makeSdkSession({ project_dir: '/home/ubuntu/code/baseplane-dev3' })
      mockedListSdkSessions.mockResolvedValue([sdk])
      const source = new ClaudeSessionSource()

      const [result] = await source.discoverSessions('/tmp/proj')

      expect(result.project).toBe('baseplane-dev3')
    })

    it('filters by since when provided', async () => {
      const old = makeSdkSession({
        session_id: 'old',
        last_activity: '2026-04-01T00:00:00Z',
      })
      const recent = makeSdkSession({
        session_id: 'recent',
        last_activity: '2026-04-11T00:00:00Z',
      })
      mockedListSdkSessions.mockResolvedValue([old, recent])
      const source = new ClaudeSessionSource()

      const results = await source.discoverSessions('/tmp/proj', {
        since: '2026-04-10T00:00:00Z',
      })

      expect(results).toHaveLength(1)
      expect(results[0].sdk_session_id).toBe('recent')
    })

    it('returns all sessions when since is not provided', async () => {
      const a = makeSdkSession({ session_id: 'a' })
      const b = makeSdkSession({ session_id: 'b' })
      mockedListSdkSessions.mockResolvedValue([a, b])
      const source = new ClaudeSessionSource()

      const results = await source.discoverSessions('/tmp/proj')

      expect(results).toHaveLength(2)
    })

    it('returns empty array when listSdkSessions returns empty', async () => {
      mockedListSdkSessions.mockResolvedValue([])
      const source = new ClaudeSessionSource()

      const results = await source.discoverSessions('/tmp/proj')

      expect(results).toEqual([])
    })

    it('preserves null tag from SdkSessionInfo', async () => {
      const sdk = makeSdkSession({ tag: null })
      mockedListSdkSessions.mockResolvedValue([sdk])
      const source = new ClaudeSessionSource()

      const [result] = await source.discoverSessions('/tmp/proj')

      expect(result.tag).toBeNull()
    })
  })
})
