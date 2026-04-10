// Re-export protocol types from shared package
export type {
  AbortCommand,
  AnswerCommand,
  AskUserEvent,
  AssistantEvent,
  ContentBlock,
  ContextUsageEvent,
  ErrorEvent,
  ExecuteCommand,
  FileChangedEvent,
  GatewayCommand,
  GatewayEvent,
  GetContextUsageCommand,
  InterruptCommand,
  KataSessionState,
  KataStateEvent,
  PartialAssistantEvent,
  PermissionRequestEvent,
  PermissionResponseCommand,
  ProjectInfo,
  RateLimitEvent,
  ResultEvent,
  ResumeCommand,
  RewindCommand,
  RewindResultEvent,
  SdkSessionInfo,
  SessionContext,
  SessionStateChangedEvent,
  SetModelCommand,
  SetPermissionModeCommand,
  StopCommand,
  StoppedEvent,
  StopTaskCommand,
  StreamInputCommand,
  TaskNotificationEvent,
  TaskProgressEvent,
  TaskStartedEvent,
  ToolResultEvent,
} from '@duraclaw/shared-types'

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  project: string | null
}

/**
 * Gateway-local extension of SessionContext with SDK-specific fields.
 * Not in shared-types because the orchestrator (CF Workers) cannot depend on the Agent SDK.
 */
export interface GatewaySessionContext {
  sessionId: string
  orgId: string | null
  userId: string | null
  abortController: AbortController
  pendingAnswer: {
    resolve: (answers: Record<string, string>) => void
    reject: (err: Error) => void
  } | null
  pendingPermission: {
    resolve: (allowed: boolean) => void
    reject: (err: Error) => void
  } | null
  messageQueue: {
    push: (msg: {
      role: 'user'
      content: string | import('@duraclaw/shared-types').ContentBlock[]
    }) => void
    done: () => void
  } | null
  /** SDK Query object — available after session.init, null before */
  query: import('@anthropic-ai/claude-agent-sdk').Query | null
  /** Queue for commands received before Query is available */
  commandQueue: Array<
    | import('@duraclaw/shared-types').InterruptCommand
    | import('@duraclaw/shared-types').SetModelCommand
    | import('@duraclaw/shared-types').SetPermissionModeCommand
    | import('@duraclaw/shared-types').GetContextUsageCommand
  >
}
