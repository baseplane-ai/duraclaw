/**
 * ConnectedPeersChip (GH#27 P1.7 WU-A)
 *
 * Renders a horizontal chip row of awareness peers attached to the
 * docs Y.Doc. Two visual styles:
 *   - `kind === 'human'` → user name + colored dot.
 *   - `kind === 'docs-runner'` → monitor icon + hostname (so users
 *     can see which VPS is mirroring this doc).
 *
 * The BlockNote cursor overlay is intentionally NOT filtered here —
 * docs-runner peers don't set a selection, so no cursor renders for
 * them. See DocsEditor for the mirror-side comment.
 */

import { Monitor } from 'lucide-react'

// Awareness-sourced color values arrive over the wire from arbitrary
// peers; render them only after validating they're a 6-digit hex color.
// This keeps the inline `style={{ backgroundColor }}` write safe from
// CSS-injection payloads (e.g. `red; background: url(...)`).
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
function safeColor(c: unknown, fallback = '#9ca3af'): string {
  return typeof c === 'string' && HEX_COLOR_RE.test(c) ? c : fallback
}

export interface ConnectedPeer {
  clientId: number
  kind?: string
  name?: string
  color?: string
  host?: string
  version?: string
}

export interface ConnectedPeersChipProps {
  peers: ConnectedPeer[]
}

export function ConnectedPeersChip({ peers }: ConnectedPeersChipProps) {
  if (peers.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="connected-peers-chip">
      {peers.map((p) => {
        if (p.kind === 'docs-runner') {
          const label = p.host ?? 'docs-runner'
          return (
            <span
              key={`runner-${p.clientId}`}
              data-testid={`peer-runner-${p.clientId}`}
              className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground text-xs"
              title={p.version ? `${label} (v${p.version})` : label}
            >
              <Monitor className="size-3" aria-hidden />
              <span className="truncate">{label}</span>
            </span>
          )
        }
        // Default: render as a human peer (covers `kind === 'human'`
        // and any unknown kinds — better to surface than to hide).
        const name = p.name ?? 'Anonymous'
        const color = safeColor(p.color)
        return (
          <span
            key={`human-${p.clientId}`}
            data-testid={`peer-human-${p.clientId}`}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <span className="truncate">{name}</span>
          </span>
        )
      })}
    </div>
  )
}
