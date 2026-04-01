export function FilePart({ path, tool, timestamp }: { path: string; tool: string; timestamp?: string }) {
  const filename = path.split('/').pop() ?? path

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-xs bg-muted/20">
      <span className="text-muted-foreground">File changed:</span>
      <code className="font-medium">{filename}</code>
      <span className="text-muted-foreground">via {tool}</span>
    </div>
  )
}
