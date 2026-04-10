/**
 * Tool display utilities — human-readable names and result summaries
 * for compact tool call chips (GH#1910)
 */

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Discovery
  'discovery-resolveEntity': 'Resolved entity',
  'discovery-getEntityList': 'Listed entities',
  'discovery-getWorkspaceSummary': 'Got workspace summary',
  // DataForge
  'dataforge-data-query': 'Queried data',
  'dataforge-data-count': 'Counted records',
  'dataforge-data-get': 'Retrieved record',
  'dataforge-data-create': 'Created record',
  'dataforge-data-update': 'Updated record',
  'dataforge-data-delete': 'Deleted record',
  'dataforge-validation-preview': 'Validated data',
  'dataforge-entity-merge': 'Merged entities',
  // Search
  'entity-search': 'Searched entities',
  // Knowledge
  'knowledge-search': 'Searched knowledge',
  'knowledge-getRelated': 'Found related items',
  'knowledge-getGraph': 'Got knowledge graph',
  // Relationships
  'relationship-create': 'Created relationship',
  'relationship-update': 'Updated relationship',
  'relationship-delete': 'Removed relationship',
  // Workflows
  'workflow-pause': 'Paused workflow',
  'workflow-resume': 'Resumed workflow',
  'workflow-cancel': 'Cancelled workflow',
  // Pipeline
  'pipeline-get-context': 'Got pipeline context',
  'pipeline-get-workflow-run': 'Got workflow run',
  // Files
  files: 'Accessed files',
}

/** Get a human-readable display name for a tool. Falls back to title-casing the last segment. */
export function getToolDisplayName(toolName: string): string {
  if (!toolName) return 'Tool'

  const mapped = TOOL_DISPLAY_NAMES[toolName]
  if (mapped) return mapped

  // Fallback: take last segment after '-' or '.', title-case it
  const segments = toolName.split(/[-.]/)
  const last = segments[segments.length - 1]
  if (!last) return 'Tool'

  // Convert camelCase to words, then title-case
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Extract a concise summary string from a tool result (tier 2 text). */
export function summarizeToolResult(toolName: string, result: unknown): string {
  if (result == null) return 'Completed'

  const r = result as Record<string, any>

  switch (toolName) {
    case 'dataforge-data-query': {
      const count = r.records?.length ?? r.count ?? 0
      return `${count} record${count !== 1 ? 's' : ''} found`
    }
    case 'dataforge-data-count': {
      const count = r?.count ?? 0
      return `${count} record${count !== 1 ? 's' : ''} matched`
    }
    case 'dataforge-data-get':
      return 'Retrieved record'
    case 'dataforge-data-create':
      return 'Created 1 record'
    case 'dataforge-data-update':
      return 'Updated 1 record'
    case 'dataforge-data-delete':
      return 'Deleted 1 record'
    case 'discovery-resolveEntity':
      return r.entity?.name ? `Found: ${r.entity.name}` : 'Not found'
    case 'discovery-getEntityList': {
      const count = r.entities?.length ?? 0
      return `${count} entit${count !== 1 ? 'ies' : 'y'}`
    }
    case 'entity-search':
    case 'knowledge-search': {
      const count = r.results?.length ?? 0
      return `${count} result${count !== 1 ? 's' : ''}`
    }
    default:
      return 'Completed'
  }
}

/** Extract a concise summary of tool args (tier 2 input text). Returns null if nothing useful. */
export function summarizeToolArgs(toolName: string, args: unknown): string | null {
  if (args == null) return null

  const a = args as Record<string, any>

  if (toolName === 'dataforge-data-query' && a.entity_type) {
    return a.entity_type
  }
  if (toolName === 'dataforge-data-count') {
    return a?.entityType ?? a?.entity_type ?? null
  }
  if (toolName === 'dataforge-data-get' && a.entity_id) {
    return String(a.entity_id).slice(0, 8)
  }
  if ((toolName === 'entity-search' || toolName === 'knowledge-search') && a.query) {
    const q = String(a.query)
    return q.length > 40 ? `${q.slice(0, 40)}…` : q
  }
  if (toolName === 'discovery-resolveEntity' && a.name) {
    return String(a.name)
  }

  return null
}

/** Represents a group of consecutive identical tool calls. */
export interface GroupedToolCall {
  key: string
  toolName: string
  count: number
  calls: Array<{
    toolName: string
    args?: unknown
    result?: unknown
    error?: string | null
  }>
  hasError: boolean
}

/**
 * Groups consecutive tool calls with the same toolName within a single message.
 * TODO(GH#1910): Wire into ToolCallListContent rendering for count > 1 chip labels (e.g. "Updated record (×2)")
 */
export function groupToolCalls(
  toolCalls: Array<{
    toolName: string
    toolCallId?: string
    args?: unknown
    result?: unknown
    error?: string | null
  }>,
): GroupedToolCall[] {
  const groups: GroupedToolCall[] = []

  for (const call of toolCalls) {
    const last = groups[groups.length - 1]
    if (last && last.toolName === call.toolName) {
      last.count++
      last.calls.push(call)
      if (call.error) last.hasError = true
    } else {
      groups.push({
        key: call.toolCallId || `${call.toolName}-${groups.length}`,
        toolName: call.toolName,
        count: 1,
        calls: [call],
        hasError: !!call.error,
      })
    }
  }

  return groups
}
