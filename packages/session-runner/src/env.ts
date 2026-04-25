/**
 * Build a clean environment for SDK child processes.
 * Strips CLAUDECODE* vars to prevent the SDK from detecting a nested session.
 *
 * Also forces ENABLE_TOOL_SEARCH=100 ("standard" mode) so the SDK does NOT
 * mark AskUserQuestion (and other `shouldDefer:true` tools) as deferred.
 *
 * Why: claude-agent-sdk@0.2.98 defaults to "tst" (tool-search) mode via
 * B57(). In tst mode, AskUserQuestion's schema is stripped from the system
 * prompt and the tool only appears as a name in <available-deferred-tools>.
 * The model has to call ToolSearch first or guess the schema. Guessed
 * schemas fail strict-Zod validation (`AHY = L.strictObject({...}).refine(…)`)
 * with `<tool_use_error>InputValidationError…</tool_use_error>` and the agent
 * narrates "AskUserQuestion is failing — tool error". With the kata Stop
 * hook re-nudging on uncommitted work, this becomes a 14× "Blocked on user."
 * loop. Forcing standard mode ships the full AskUserQuestion schema in the
 * prompt every turn, so model calls validate cleanly and canUseTool fires.
 */
export function buildCleanEnv(): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('CLAUDECODE')) continue
    if (key === 'CLAUDE_CODE_ENTRYPOINT') continue
    clean[key] = value
  }
  // Override any inherited value — we always want standard (non-deferred)
  // tool mode for our runner so AskUserQuestion's schema ships in-prompt.
  clean.ENABLE_TOOL_SEARCH = '100'
  return clean
}
