import { Agent, type Connection, callable } from 'agents'
import { runMigrations } from '~/lib/do-migrations'
import type { Env } from '~/lib/types'
import { USER_SETTINGS_MIGRATIONS } from './user-settings-do-migrations'

// ── Types ────────────────────────────────────────────────────────

export interface TabRecord {
  id: string
  project: string
  sessionId: string
  title: string
}

export interface UserSettingsState {
  tabs: TabRecord[]
  activeTabId: string | null
}

const DEFAULT_STATE: UserSettingsState = {
  tabs: [],
  activeTabId: null,
}

// ── DO ───────────────────────────────────────────────────────────

export class UserSettingsDO extends Agent<Env, UserSettingsState> {
  initialState = DEFAULT_STATE
  private initialized = false

  private ensureInit() {
    if (this.initialized) return
    this.initialized = true
    runMigrations(this.ctx.storage.sql, USER_SETTINGS_MIGRATIONS)
    this.loadStateFromSql()
  }

  async onStart() {
    this.ensureInit()
  }

  onConnect(connection: Connection) {
    this.ensureInit()
    connection.send(JSON.stringify({ type: 'state', state: this.state }))
  }

  /** HTTP API for TanStack DB queryCollection sync */
  async onRequest(request: Request): Promise<Response> {
    try {
      this.ensureInit()
      const url = new URL(request.url)

      // GET /tabs — list all tabs
      if (request.method === 'GET' && url.pathname === '/tabs') {
        return Response.json({ tabs: this.state.tabs })
      }

      // POST /tabs — add, upsert, or reorder tabs
      if (request.method === 'POST' && url.pathname === '/tabs') {
        const body = (await request.json()) as {
          action?: string
          id?: string
          project?: string
          sessionId?: string
          title?: string
          tabId?: string
          orderedIds?: string[]
        }
        if (body.action === 'reorder' && body.orderedIds) {
          this.reorderTabs(body.orderedIds)
          return Response.json({ tabs: this.state.tabs })
        }
        if (body.action === 'addNew' && body.project && body.sessionId) {
          this.addNewTab(body.project, body.sessionId, body.title, body.id)
        } else if (body.action === 'switch' && body.tabId && body.sessionId) {
          this.switchTabSession(body.tabId, body.sessionId, body.title)
        } else if (body.project && body.sessionId) {
          this.addTab(body.project, body.sessionId, body.title, body.id)
        }
        return Response.json({ tabs: this.state.tabs })
      }

      // PATCH /tabs/:id — update sessionId and/or title
      if (request.method === 'PATCH' && url.pathname.startsWith('/tabs/')) {
        const tabId = url.pathname.slice('/tabs/'.length)
        const body = (await request.json()) as {
          sessionId?: string
          title?: string
        }
        if (body.sessionId) {
          this.switchTabSession(tabId, body.sessionId, body.title)
        } else if (body.title) {
          this.updateTabTitle(tabId, body.title)
        }
        return Response.json({ tabs: this.state.tabs })
      }

      // DELETE /tabs/:id — remove tab
      if (request.method === 'DELETE' && url.pathname.startsWith('/tabs/')) {
        const tabId = url.pathname.slice('/tabs/'.length)
        const result = this.removeTab(tabId)
        return Response.json(result)
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      )
    }

    return super.onRequest(request)
  }

  // ── State persistence ──────────────────────────────────────────

  private loadStateFromSql() {
    const tabRows = this.ctx.storage.sql
      .exec(`SELECT id, project, session_id, title FROM tabs ORDER BY position ASC`)
      .toArray() as Array<{ id: string; project: string; session_id: string; title: string }>

    const tabs: TabRecord[] = tabRows.map((r) => ({
      id: r.id,
      project: r.project,
      sessionId: r.session_id,
      title: r.title,
    }))

    const activeRow = this.ctx.storage.sql
      .exec(`SELECT value FROM tab_state WHERE key = 'activeTabId'`)
      .toArray() as Array<{ value: string | null }>
    const activeTabId = activeRow[0]?.value ?? null

    this.setState({ tabs, activeTabId })
  }

  private persistTabs() {
    const { tabs, activeTabId } = this.state
    const now = new Date().toISOString()

    this.ctx.storage.sql.exec(`DELETE FROM tabs`)
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]
      this.ctx.storage.sql.exec(
        `INSERT INTO tabs (id, project, session_id, title, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        t.id,
        t.project,
        t.sessionId,
        t.title,
        i,
        now,
      )
    }

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO tab_state (key, value) VALUES ('activeTabId', ?)`,
      activeTabId,
    )
  }

  // ── RPC methods ────────────────────────────────────────────────

  @callable()
  addTab(project: string, sessionId: string, title?: string, clientId?: string): TabRecord[] {
    this.ensureInit()
    const { tabs } = this.state

    // If session already has a tab, activate it
    const bySession = tabs.find((t) => t.sessionId === sessionId)
    if (bySession) {
      const newTabs =
        title && title !== bySession.title
          ? tabs.map((t) => (t.id === bySession.id ? { ...t, title } : t))
          : tabs
      this.setState({ ...this.state, tabs: newTabs, activeTabId: bySession.id })
      this.persistTabs()
      return this.state.tabs
    }

    // If project already has a tab, replace its session
    const byProject = tabs.find((t) => t.project === project)
    if (byProject) {
      const newTabs = tabs.map((t) =>
        t.id === byProject.id ? { ...t, sessionId, title: title || sessionId.slice(0, 12) } : t,
      )
      this.setState({ ...this.state, tabs: newTabs, activeTabId: byProject.id })
      this.persistTabs()
      return this.state.tabs
    }

    // New tab — use client-provided ID if available for consistency
    const id = clientId || crypto.randomUUID().slice(0, 8)
    const newTab: TabRecord = { id, project, sessionId, title: title || sessionId.slice(0, 12) }
    const newTabs = [...tabs, newTab]
    this.setState({ ...this.state, tabs: newTabs, activeTabId: id })
    this.persistTabs()
    return this.state.tabs
  }

  @callable()
  addNewTab(project: string, sessionId: string, title?: string, clientId?: string): TabRecord[] {
    this.ensureInit()
    const id = clientId || crypto.randomUUID().slice(0, 8)
    const newTab: TabRecord = { id, project, sessionId, title: title || sessionId.slice(0, 12) }
    const newTabs = [...this.state.tabs, newTab]
    this.setState({ ...this.state, tabs: newTabs, activeTabId: id })
    this.persistTabs()
    return this.state.tabs
  }

  @callable()
  switchTabSession(tabId: string, sessionId: string, title?: string): TabRecord[] {
    this.ensureInit()
    const newTabs = this.state.tabs.map((t) =>
      t.id === tabId ? { ...t, sessionId, title: title || sessionId.slice(0, 12) } : t,
    )
    this.setState({ ...this.state, tabs: newTabs })
    this.persistTabs()
    return this.state.tabs
  }

  @callable()
  removeTab(tabId: string): { tabs: TabRecord[]; activeTabId: string | null } {
    this.ensureInit()
    const { tabs, activeTabId } = this.state
    const newTabs = tabs.filter((t) => t.id !== tabId)
    let newActive = activeTabId
    if (activeTabId === tabId) {
      const idx = tabs.findIndex((t) => t.id === tabId)
      newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
    }
    this.setState({ ...this.state, tabs: newTabs, activeTabId: newActive })
    this.persistTabs()

    return { tabs: this.state.tabs, activeTabId: this.state.activeTabId }
  }

  @callable()
  setActiveTab(tabId: string): string | null {
    this.ensureInit()
    this.setState({ ...this.state, activeTabId: tabId })
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO tab_state (key, value) VALUES ('activeTabId', ?)`,
      tabId,
    )
    return tabId
  }

  @callable()
  updateTabTitle(tabId: string, title: string): TabRecord[] {
    this.ensureInit()
    const newTabs = this.state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t))
    this.setState({ ...this.state, tabs: newTabs })
    this.persistTabs()
    return this.state.tabs
  }

  @callable()
  reorderTabs(orderedIds: string[]): TabRecord[] {
    this.ensureInit()
    const byId = new Map(this.state.tabs.map((t) => [t.id, t]))
    const reordered: TabRecord[] = []
    const seen = new Set<string>()
    for (const id of orderedIds) {
      const t = byId.get(id)
      if (t) {
        reordered.push(t)
        seen.add(id)
      }
    }
    // Append any tabs not in the provided list (safety net)
    for (const t of this.state.tabs) {
      if (!seen.has(t.id)) reordered.push(t)
    }
    this.setState({ ...this.state, tabs: reordered })
    this.persistTabs()
    return this.state.tabs
  }
}
