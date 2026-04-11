/**
 * StreamingText — Shows accumulated streaming text during an assistant turn,
 * then switches to final markdown when complete.
 */

import { MessageResponse } from '@duraclaw/ai-elements'

interface StreamingTextProps {
  streamingContent: string
  finalContent?: unknown[]
}

export function StreamingText({ streamingContent, finalContent }: StreamingTextProps) {
  if (finalContent && finalContent.length > 0) {
    const textBlocks = finalContent.filter((b: unknown) => (b as { type: string }).type === 'text')
    const text = textBlocks.map((b: unknown) => (b as { text?: string }).text || '').join('\n')
    if (text) {
      return <MessageResponse>{text}</MessageResponse>
    }
  }

  if (!streamingContent) return null

  return (
    <div className="whitespace-pre-wrap font-mono text-sm">
      {streamingContent}
      <span className="inline-block h-4 w-0.5 animate-pulse bg-foreground" />
    </div>
  )
}
