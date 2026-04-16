/** Minimal tagged-template SQL interface used by extracted helper functions. */
export type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

/**
 * Load turnCounter and currentTurnMessageId from assistant_config.
 * Must be called AFTER Session table initialization (e.g. getPathLength())
 * to ensure the assistant_config table exists.
 */
export function loadTurnState(
  sql: SqlFn,
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

/**
 * Validate a gateway token against stored token and TTL.
 * Returns true if the token is valid and not expired, false otherwise.
 * The token is NOT consumed on use — it remains valid until its TTL expires,
 * allowing reconnects to reuse the same callback URL.
 */
export function validateGatewayToken(sql: SqlFn, token: string | null): boolean {
  if (!token) return false
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token'`]
    if (rows.length === 0 || rows[0].value !== token) return false

    // Check TTL
    const expiresRows = [
      ...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token_expires'`,
    ]
    if (expiresRows.length > 0 && Number(expiresRows[0].value) < Date.now()) {
      // Token expired — clean up
      sql`DELETE FROM kv WHERE key IN ('gateway_token', 'gateway_token_expires')`
      return false
    }

    return true
  } catch {
    return false
  }
}

/** Read the persisted gateway connection ID from SQLite kv table. */
export function getGatewayConnectionId(sql: SqlFn): string | null {
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_conn_id'`]
    return rows.length > 0 ? rows[0].value : null
  } catch {
    return null
  }
}

/**
 * Build the callback URL that the gateway should dial back to.
 * Returns null if required configuration is missing.
 */
export function buildGatewayCallbackUrl(
  workerPublicUrl: string,
  doId: string,
  token: string,
): string {
  const wsScheme = workerPublicUrl.startsWith('https') ? 'wss' : 'ws'
  const wsBase = workerPublicUrl.replace(/^https?:/, `${wsScheme}:`)
  return `${wsBase}/agents/session-agent/${doId}?role=gateway&token=${token}`
}

/**
 * Build the gateway HTTP start URL from a gateway WebSocket URL.
 */
export function buildGatewayStartUrl(gatewayUrl: string): string {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  return `${httpBase}/sessions/start`
}
