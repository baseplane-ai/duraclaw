// Re-export protocol types from shared package
export type {
  AbortCommand,
  AnswerCommand,
  AskUserEvent,
  AssistantEvent,
  ErrorEvent,
  ExecuteCommand,
  FileChangedEvent,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  KataStateEvent,
  PartialAssistantEvent,
  PermissionRequestEvent,
  PermissionResponseCommand,
  ProjectInfo,
  ResultEvent,
  ResumeCommand,
  SessionContext,
  SessionInitEvent,
  StreamInputCommand,
  ToolResultEvent,
} from '@duraclaw/shared-types'

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  project: string | null
}
