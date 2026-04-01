import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function TextPart({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="text-sm prose prose-sm prose-invert max-w-none">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <div className="relative group">
              <pre className="bg-muted/50 rounded-lg p-3 overflow-x-auto text-xs">
                {children}
              </pre>
              <CopyButton getText={() => {
                // Extract text content from code block children
                const el = (children as any)?.props?.children
                return typeof el === 'string' ? el : ''
              }} />
            </div>
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className
            if (isInline) {
              return (
                <code className="bg-muted/50 rounded px-1 py-0.5 text-xs" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-xs">{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
      {streaming && (
        <span className="inline-block w-2 h-4 bg-foreground animate-pulse ml-0.5" />
      )}
    </div>
  )
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-muted rounded px-2 py-1 text-muted-foreground hover:text-foreground"
      onClick={() => {
        const text = getText()
        if (text) {
          (globalThis as any).navigator?.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}
