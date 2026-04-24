// Enter command modules

export { createDefaultState, type ParsedArgs, parseArgs } from './cli.js'
export {
  buildWorkflowGuidance,
  type PhaseTitle,
  type RequiredTodo,
  type WorkflowGuidance,
} from './guidance.js'
export { createFdNotesFile } from './notes.js'
export { type PlaceholderContext, resolvePlaceholders } from './placeholder.js'
export { findSpecFile, parseSpecYaml } from './spec.js'
export {
  areAllOpenTasksInProgress,
  buildPhaseTasks,
  buildSpecTasks,
  clearNativeTaskFiles,
  countPendingNativeTasks,
  extractVerificationPlan,
  getFirstPendingNativeTask,
  getNativeTasksDir,
  getPendingNativeTaskTitles,
  type NativeTask,
  readNativeTaskFiles,
  type Task,
  type TasksFile,
  writeNativeTaskFiles,
} from './task-factory.js'
export {
  getPhaseTitlesFromTemplate,
  getTemplateReviewerPrompt,
  parseAndValidateTemplatePhases,
  parseTemplateYaml,
} from './template.js'
