export function ReasoningPart({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <details className="rounded-lg border border-border/50 overflow-hidden">
      <summary className="px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer bg-muted/30 hover:bg-muted/50 transition-colors">
        {streaming ? 'Thinking...' : 'Thought process'}
        {streaming && (
          <span className="inline-block w-1.5 h-3 bg-muted-foreground animate-pulse ml-1" />
        )}
      </summary>
      <pre className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
        {text}
      </pre>
    </details>
  )
}
