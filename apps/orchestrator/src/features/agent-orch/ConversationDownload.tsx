import { DownloadIcon } from 'lucide-react'
import { useCallback } from 'react'
import type { SessionMessage } from '~/lib/types'

interface ConversationDownloadProps {
  messages: SessionMessage[]
  sessionId: string
}

function messagesToMarkdown(messages: SessionMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push('## User\n')
      for (const part of msg.parts) {
        if (part.type === 'text') lines.push(part.text || '')
      }
      lines.push('')
    } else if (msg.role === 'assistant') {
      lines.push('## Assistant\n')
      for (const part of msg.parts) {
        if (part.type === 'text') {
          lines.push(part.text || '')
        } else if (part.type === 'reasoning') {
          lines.push('<details><summary>Reasoning</summary>\n')
          lines.push(part.text || '')
          lines.push('\n</details>\n')
        } else if (part.type?.startsWith('tool-')) {
          lines.push(`\`\`\`tool: ${part.toolName || part.type.replace('tool-', '')}\n`)
          lines.push(JSON.stringify(part.input, null, 2))
          if (part.output) {
            lines.push('\n--- output ---\n')
            lines.push(
              typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
            )
          }
          lines.push('\n```\n')
        }
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function ConversationDownload({ messages, sessionId }: ConversationDownloadProps) {
  const handleDownload = useCallback(() => {
    const md = messagesToMarkdown(messages)
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const date = new Date().toISOString().split('T')[0]
    const a = document.createElement('a')
    a.href = url
    a.download = `session-${sessionId}-${date}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [messages, sessionId])

  if (messages.length === 0) return null

  return (
    <button
      type="button"
      onClick={handleDownload}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Download conversation"
      title="Download as Markdown"
    >
      <DownloadIcon className="size-3.5" />
    </button>
  )
}
