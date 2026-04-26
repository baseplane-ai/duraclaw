/**
 * Barrel re-export — all message-part helpers now live in
 * `session-do/message-parts.ts`. This file preserves the import path
 * for test suites and external consumers.
 */
export {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  fingerprintAssistantContent,
  isAssistantContentEmpty,
  mergeFinalAssistantParts,
  partialAssistantToParts,
  upsertParts,
  upsertToolPart,
} from './session-do/message-parts'
