import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { Badge, Button } from '../ui'

interface ToolPartProps {
  approval?: { approved?: boolean; id: string }
  errorText?: string
  input?: unknown
  onApprove: (toolCallId: string) => void
  onDeny: (toolCallId: string) => void
  output?: unknown
  state: string
  toolCallId: string
  toolName: string
}

interface ToolHighlights {
  command?: string
  filePath?: string
  newString?: string
  oldString?: string
}

const STATE_LABELS: Record<string, { className: string; text: string }> = {
  'approval-requested': { text: 'needs approval', className: 'font-medium text-warning' },
  'approval-responded': { text: 'approved', className: 'text-muted-foreground' },
  'input-available': { text: 'ready', className: 'text-warning' },
  'input-streaming': { text: 'running...', className: 'animate-pulse text-warning' },
  'output-available': { text: 'completed', className: 'text-success' },
  'output-denied': { text: 'denied', className: 'text-muted-foreground' },
  'output-error': { text: 'error', className: 'text-destructive' },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

export function getToolHighlights(input: unknown): ToolHighlights {
  if (!isRecord(input)) return {}

  return {
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof input.file_path === 'string' ? { filePath: input.file_path } : {}),
    ...(typeof input.old_string === 'string' ? { oldString: input.old_string } : {}),
    ...(typeof input.new_string === 'string' ? { newString: input.new_string } : {}),
  }
}

function renderValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function ToolPart({
  errorText,
  input,
  onApprove,
  onDeny,
  output,
  state,
  toolCallId,
  toolName,
}: ToolPartProps) {
  const needsApproval = state === 'approval-requested'
  const [expanded, setExpanded] = useState(needsApproval)
  const label = STATE_LABELS[state] ?? { className: 'text-muted-foreground', text: state }
  const highlights = getToolHighlights(input)

  useEffect(() => {
    if (needsApproval) {
      setExpanded(true)
    }
  }, [needsApproval])

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-background/60"
      data-testid="tool-part"
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-3 text-left text-xs font-medium transition-colors hover:bg-muted/50"
        data-testid="tool-part-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className={cn('text-[10px] transition-transform', expanded && 'rotate-90')}>
          &#9654;
        </span>
        <Badge className="text-xs" variant="outline">
          {toolName}
        </Badge>
        <span className={label.className}>{label.text}</span>
      </button>

      {(highlights.command || highlights.filePath) && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap gap-3">
            {highlights.command && (
              <span className="truncate" data-testid="tool-command">
                Command: <span className="text-foreground">{highlights.command}</span>
              </span>
            )}
            {highlights.filePath && (
              <span className="truncate" data-testid="tool-file-path">
                File: <span className="text-foreground">{highlights.filePath}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {needsApproval && (
        <div className="border-t border-border bg-warning/5 px-3 py-3">
          <div className="mb-3 space-y-1">
            <p className="text-sm font-medium">Approve {toolName}</p>
            <p className="text-xs text-muted-foreground">
              Review the requested command or file target before the session continues.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="min-h-11 bg-success text-white hover:bg-success/90"
              onClick={() => onApprove(toolCallId)}
              type="button"
            >
              Allow
            </Button>
            <Button
              className="min-h-11"
              onClick={() => onDeny(toolCallId)}
              type="button"
              variant="destructive"
            >
              Deny
            </Button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="space-y-3 border-t border-border p-3">
          {(highlights.oldString || highlights.newString) && (
            <div className="grid gap-3 lg:grid-cols-2">
              {highlights.oldString && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Previous</div>
                  <pre className="max-h-48 overflow-auto rounded-xl bg-muted/30 p-3 text-xs">
                    {highlights.oldString}
                  </pre>
                </div>
              )}
              {highlights.newString && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Requested</div>
                  <pre className="max-h-48 overflow-auto rounded-xl bg-muted/30 p-3 text-xs">
                    {highlights.newString}
                  </pre>
                </div>
              )}
            </div>
          )}

          {input != null && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
              <pre className="max-h-48 overflow-auto rounded-xl bg-muted/30 p-3 text-xs">
                {renderValue(input)}
              </pre>
            </div>
          )}

          {output != null && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Output</div>
              <pre className="max-h-48 overflow-auto rounded-xl bg-muted/30 p-3 text-xs">
                {renderValue(output)}
              </pre>
            </div>
          )}

          {errorText && (
            <div>
              <div className="mb-1 text-xs font-medium text-destructive">Error</div>
              <pre className="rounded-xl bg-destructive/10 p-3 text-xs">{errorText}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
