// Re-export protocol types from shared package
export type {
  AbortCommand,
  AnswerCommand,
  AskUserEvent,
  AssistantEvent,
  ContentBlock,
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
  RewindCommand,
  SessionContext,
  SessionInitEvent,
  StopCommand,
  StoppedEvent,
  StreamInputCommand,
  ToolResultEvent,
} from '@duraclaw/shared-types'

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  project: string | null
}
