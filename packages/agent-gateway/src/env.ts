/**
 * Build a clean environment for SDK child processes.
 * Strips CLAUDECODE* vars to prevent the SDK from detecting a nested session.
 */
export function buildCleanEnv(): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('CLAUDECODE')) continue
    if (key === 'CLAUDE_CODE_ENTRYPOINT') continue
    clean[key] = value
  }
  return clean
}
