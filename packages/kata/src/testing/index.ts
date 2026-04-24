/**
 * Testing Utilities for Workflow Management
 *
 * Provides mock systems for testing hooks, session state,
 * and workflow transitions in isolation.
 *
 * @example
 * ```typescript
 * import {
 *   createMockSession,
 *   SessionFixtures,
 *   runHook,
 *   ToolInputs,
 *   assertThat,
 *   ModeEnforcementScenarios,
 * } from '@baseplane/workflow-management/testing'
 *
 * // Create isolated test session
 * const session = await createMockSession({
 *   initialState: SessionFixtures.planningMode()
 * })
 *
 * // Run a hook with mock input
 * const result = await runHook({
 *   hookType: 'PreToolUse',
 *   stdinData: ToolInputs.read('/path/to/file.ts'),
 *   cwd: session.sessionDir,
 * })
 *
 * // Assert expected behavior
 * assertThat(result).isAllowed().completedIn(1000)
 *
 * // Cleanup
 * await session.cleanup()
 * ```
 */

// Test assertions
export {
  AssertionError,
  assertAllowed,
  assertBlocked,
  assertDuration,
  assertJsonContains,
  assertJsonOutput,
  assertLinkedIssue,
  assertMode,
  assertPhaseInHistory,
  assertSessionType,
  assertThat,
  assertTodosWritten,
  assertWorkflowId,
  HookResultAssertion,
  SessionStateAssertion,
} from './assertions'

// Mock hook execution
export {
  type HookInput,
  type HookResult,
  type HookType,
  runHook,
  ToolInputs,
  UserPromptInputs,
} from './mock-hooks'
// Mock session state management
export {
  createMockSession,
  type MockSession,
  type MockSessionOptions,
  SessionFixtures,
} from './mock-session'

// Pre-built test scenarios
export {
  BeadCloseScenarios,
  FileWritingScenarios,
  getAllowingScenarios,
  getAllScenarios,
  getBlockingScenarios,
  getScenariosByHook,
  ModeEnforcementScenarios,
  NativeTasksGateScenarios,
  PostToolUseScenarios,
  StopHookScenarios,
  type TestScenario,
  UserPromptSubmitScenarios,
} from './test-fixtures'
