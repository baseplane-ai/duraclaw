// Re-export protocol types from shared package
export type {
  GatewayCommand,
  GatewayEvent,
  ExecuteCommand,
  ResumeCommand,
  StreamInputCommand,
  PermissionResponseCommand,
  AbortCommand,
  AnswerCommand,
  SessionInitEvent,
  PartialAssistantEvent,
  AssistantEvent,
  ToolResultEvent,
  AskUserEvent,
  PermissionRequestEvent,
  FileChangedEvent,
  ResultEvent,
  ErrorEvent,
  WorktreeInfo,
  SessionContext,
} from '@duraclaw/shared-types'

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  worktree: string | null
}
