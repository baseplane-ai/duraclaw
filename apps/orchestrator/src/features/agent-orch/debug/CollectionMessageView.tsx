/**
 * Minimal message renderer for the /debug/session-collection prototype route.
 *
 * - Reads messages directly from useCodingAgentCollection (collection-backed).
 * - Memoizes each row and stamps dom.painted on first text change so the
 *   lag-probe captures ws-to-paint delta per id.
 * - Renders a live footer with p50/p95/max lag and a tiny send form.
 *
 * Intentionally ugly: the point of this route is to prove the render path,
 * not to be pretty. Production styling / ai-elements stays out of scope.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionMessage, SessionMessagePart } from '~/lib/types'
import { getLagStats, type LagStats, markDomPainted } from './lag-probe'

interface CollectionMessageViewProps {
  sessionId: string
  messages: SessionMessage[]
  isHydrated: boolean
  isConnecting: boolean
  onSend: (text: string) => Promise<{ ok: boolean; error?: string }>
}

export function CollectionMessageView(props: CollectionMessageViewProps) {
  const { sessionId, messages, isHydrated, isConnecting, onSend } = props
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400 font-mono flex items-center gap-3">
        <span>session: {sessionId}</span>
        <span>
          hydrated: {String(isHydrated)} · connecting: {String(isConnecting)} · rows:{' '}
          {messages.length}
        </span>
      </div>

      <ol className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-sm">
        {messages.map((m) => (
          <MessageRow key={m.id} msg={m} />
        ))}
        {messages.length === 0 && (
          <li className="text-neutral-500 italic">
            (no messages — waiting for cache or WS hydration)
          </li>
        )}
      </ol>

      <LagReadout />

      <form
        className="border-t border-neutral-800 p-2 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!draft.trim() || sending) return
          setSending(true)
          setError(null)
          const r = await onSend(draft)
          setSending(false)
          if (r.ok) setDraft('')
          else setError(r.error ?? 'send failed')
        }}
      >
        <input
          className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Send a test message…"
          disabled={sending}
        />
        <button
          type="submit"
          className="px-3 py-1 rounded bg-neutral-200 text-neutral-900 text-sm disabled:opacity-50"
          disabled={sending || !draft.trim()}
        >
          {sending ? '…' : 'Send'}
        </button>
        {error && <span className="text-red-400 text-xs self-center">{error}</span>}
      </form>
    </div>
  )
}

/** Renders one row and stamps dom.painted on every content-text change. */
const MessageRow = memo(function MessageRow({ msg }: { msg: SessionMessage }) {
  const textSignature = useMemo(() => partsSignature(msg.parts), [msg.parts])
  const prevSignatureRef = useRef<string>('')

  useLayoutEffect(() => {
    if (prevSignatureRef.current !== textSignature) {
      prevSignatureRef.current = textSignature
      markDomPainted(msg.id)
    }
  }, [msg.id, textSignature])

  return (
    <li className="border border-neutral-800 rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500 mb-1">
        {msg.role} · {msg.id}
      </div>
      <div className="whitespace-pre-wrap break-words">{renderParts(msg.parts)}</div>
    </li>
  )
})

function renderParts(parts: SessionMessagePart[]): string {
  if (!Array.isArray(parts)) return ''
  const out: string[] = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const kind = (p as { type?: string }).type
    if (kind === 'text' && typeof (p as { text?: unknown }).text === 'string') {
      out.push((p as { text: string }).text)
    } else if (kind) {
      out.push(`[${kind}]`)
    }
  }
  return out.join('')
}

function partsSignature(parts: SessionMessagePart[]): string {
  if (!Array.isArray(parts)) return ''
  let len = 0
  let lastText = ''
  for (const p of parts) {
    if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
      const t = (p as { text?: string }).text ?? ''
      len += t.length
      lastText = t
    }
  }
  return `${parts.length}:${len}:${lastText.slice(-16)}`
}

/** Polls the lag probe every 500 ms and renders p50/p95/max live. */
function LagReadout() {
  const [stats, setStats] = useState<LagStats>(() => getLagStats())
  useEffect(() => {
    const id = setInterval(() => setStats(getLagStats()), 500)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-400 font-mono">
      lag (ws→paint): n={stats.count} p50={stats.p50Ms.toFixed(1)}ms p95=
      {stats.p95Ms.toFixed(1)}ms max={stats.maxMs.toFixed(1)}ms
    </div>
  )
}
