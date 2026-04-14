/**
 * Load turnCounter and currentTurnMessageId from assistant_config.
 * Must be called AFTER Session table initialization (e.g. getPathLength())
 * to ensure the assistant_config table exists.
 */
export function loadTurnState(
  sql: <T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[],
  pathLength: number,
): { turnCounter: number; currentTurnMessageId: string | null } {
  let turnCounter = 0
  let currentTurnMessageId: string | null = null

  const configRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'turnCounter'
  `
  if (configRows.length > 0) {
    turnCounter = Number.parseInt(configRows[0].value, 10) || 0
  } else {
    // First use or data loss — seed from path length to avoid ID collisions
    turnCounter = pathLength + 1
  }

  const turnIdRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'currentTurnMessageId'
  `
  if (turnIdRows.length > 0 && turnIdRows[0].value !== '') {
    currentTurnMessageId = turnIdRows[0].value
  }

  return { turnCounter, currentTurnMessageId }
}
