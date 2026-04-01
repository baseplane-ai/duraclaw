import { useState } from 'react'
import { Badge, Button } from '../ui'
import { cn } from '~/lib/utils'

interface ToolPartProps {
  toolName: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean }
  onApprove: (toolCallId: string) => void
  onDeny: (toolCallId: string) => void
}

const STATE_LABELS: Record<string, { text: string; className: string }> = {
  'input-streaming': { text: 'running...', className: 'text-warning animate-pulse' },
  'input-available': { text: 'ready', className: 'text-warning' },
  'approval-requested': { text: 'needs approval', className: 'text-warning font-medium' },
  'approval-responded': { text: 'approved', className: 'text-muted-foreground' },
  'output-available': { text: 'completed', className: 'text-success' },
  'output-error': { text: 'error', className: 'text-destructive' },
  'output-denied': { text: 'denied', className: 'text-muted-foreground' },
}

export function ToolPart({
  toolName,
  toolCallId,
  state,
  input,
  output,
  errorText,
  onApprove,
  onDeny,
}: ToolPartProps) {
  const [expanded, setExpanded] = useState(false)
  const label = STATE_LABELS[state] ?? { text: state, className: 'text-muted-foreground' }
  const needsApproval = state === 'approval-requested'

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
      >
        <span className={cn('transition-transform text-[10px]', expanded && 'rotate-90')}>
          &#9654;
        </span>
        <Badge variant="outline" className="text-xs">
          {toolName}
        </Badge>
        <span className={label.className}>{label.text}</span>
      </button>

      {needsApproval && (
        <div className="px-3 py-2 border-t border-border bg-warning/5 flex gap-2">
          <Button
            size="sm"
            onClick={() => onApprove(toolCallId)}
            className="bg-success hover:bg-success/90 text-white"
          >
            Allow
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onDeny(toolCallId)}
          >
            Deny
          </Button>
        </div>
      )}

      {expanded && (
        <div className="p-3 space-y-2 border-t border-border">
          {input != null && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
              <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {output != null && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Output</div>
              <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
          {errorText && (
            <div>
              <div className="text-xs font-medium text-destructive mb-1">Error</div>
              <pre className="text-xs bg-destructive/10 rounded p-2">{errorText}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
