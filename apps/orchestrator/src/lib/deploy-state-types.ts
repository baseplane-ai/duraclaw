export type PhaseStatusKind = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type WorkerStatusKind = 'pending' | 'deploying' | 'deployed' | 'failed' | 'skipped'
export type LogLevel = 'info' | 'warn' | 'error'
export type DeployStatus =
  | 'idle'
  | 'queued'
  | 'pulling'
  | 'installing'
  | 'checking'
  | 'deploying'
  | 'health_checking'
  | 'done'
  | 'failed'
export type HistoryStatus = 'done' | 'failed'

export interface PhaseStatus {
  status: PhaseStatusKind
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
}

export interface WorkerHealth {
  healthy: boolean
  statusCode?: number | null
  error?: string | null
}

export interface WorkerStatus {
  name: string
  status: WorkerStatusKind
  retries: number
  error?: string | null
  health?: WorkerHealth | null
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
}

export interface CurrentDeploy {
  status: DeployStatus
  commit_sha: string
  branch: string
  environment: string
  started_at: string
  finished_at?: string | null
  trigger: string
  push_author: string
  commit_message: string
  phases: Record<string, PhaseStatus>
  workers: WorkerStatus[]
  logs: LogEntry[]
  error?: string | null
  slack_thread_ts?: string | null
  worktree_name?: string | null
}

export interface QueuedDeploy {
  commit_sha: string
  before_sha: string
  branch: string
  environment: string
  trigger: string
  push_author: string
  commit_message: string
  queued_at: string
  worktree_path?: string | null
}

export interface DeployHistoryEntry {
  commit_sha: string
  branch: string
  environment: string
  status: HistoryStatus
  started_at: string
  finished_at: string
  duration_seconds: number
  workers_deployed: number
  workers_total: number
  trigger: string
  push_author: string
  commit_message: string
  error?: string | null
}

export interface DeployServerInfo {
  pid: number
  started_at: string
  port: number
  version: string
}

export interface DeployState {
  current: CurrentDeploy
  queue: QueuedDeploy[]
  history: DeployHistoryEntry[]
  server: DeployServerInfo
}

export const PHASE_ORDER: readonly string[] = [
  'pulling',
  'installing',
  'linting',
  'type_checking',
  'detecting',
  'deploying',
  'health_checking',
]

export const PHASE_LABEL: Record<string, string> = {
  pulling: 'Pull',
  installing: 'Install',
  linting: 'Lint',
  type_checking: 'Typecheck',
  detecting: 'Detect',
  deploying: 'Deploy',
  health_checking: 'Health',
}
