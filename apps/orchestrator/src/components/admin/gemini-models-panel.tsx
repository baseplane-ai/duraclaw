import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { apiUrl } from '~/lib/platform'

interface GeminiModelRow {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

const ENDPOINT = '/api/admin/gemini-models'

export function GeminiModelsPanel() {
  const [rows, setRows] = useState<GeminiModelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')

  const [draftName, setDraftName] = useState('')
  const [draftContext, setDraftContext] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(apiUrl(ENDPOINT), { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load models (${res.status})`)
        setLoading(false)
        return
      }
      const body = (await res.json()) as { models: GeminiModelRow[] }
      setRows(body.models ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = useCallback(async () => {
    setError('')
    const name = draftName.trim()
    const ctx = Number.parseInt(draftContext, 10)
    if (!name) {
      setError('name is required')
      return
    }
    if (!Number.isFinite(ctx) || ctx <= 0) {
      setError('context_window must be a positive integer')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(apiUrl(ENDPOINT), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, context_window: ctx }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Failed to add (${res.status})`)
        return
      }
      setDraftName('')
      setDraftContext('')
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }, [draftName, draftContext, refresh])

  const handleToggleEnabled = useCallback(
    async (row: GeminiModelRow) => {
      setError('')
      const next = !row.enabled
      try {
        const res = await fetch(apiUrl(`${ENDPOINT}/${encodeURIComponent(row.id)}`), {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? `Failed to update (${res.status})`)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh],
  )

  const handleEditContext = useCallback(
    async (row: GeminiModelRow) => {
      const next = window.prompt(
        `Context window (tokens) for ${row.name}`,
        String(row.contextWindow),
      )
      if (next === null) return
      const parsed = Number.parseInt(next, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('context_window must be a positive integer')
        return
      }
      setError('')
      try {
        const res = await fetch(apiUrl(`${ENDPOINT}/${encodeURIComponent(row.id)}`), {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context_window: parsed }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? `Failed to update (${res.status})`)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (row: GeminiModelRow) => {
      if (!window.confirm(`Delete gemini model '${row.name}'?`)) return
      setError('')
      try {
        const res = await fetch(apiUrl(`${ENDPOINT}/${encodeURIComponent(row.id)}`), {
          method: 'DELETE',
          credentials: 'include',
        })
        if (!res.ok && res.status !== 204) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? `Failed to delete (${res.status})`)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh],
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Google Gemini model catalog. Context window must be entered manually. Sessions started with
        `agent: 'gemini'` receive this list at spawn time and use it for capability advertisement
        and per-turn context-usage math.
      </p>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Context Window (tokens)</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <Input
                placeholder="e.g. auto-gemini-3"
                value={draftName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value)}
              />
            </TableCell>
            <TableCell>
              <Input
                inputMode="numeric"
                placeholder="1000000"
                value={draftContext}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDraftContext(e.target.value)
                }
              />
            </TableCell>
            <TableCell>—</TableCell>
            <TableCell className="text-right">
              <Button onClick={handleAdd} disabled={submitting} size="sm">
                Add
              </Button>
            </TableCell>
          </TableRow>

          {loading ? (
            <TableRow>
              <TableCell colSpan={4} className="text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-sm text-muted-foreground">
                No models configured.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono">{row.name}</TableCell>
                <TableCell className="font-mono">{row.contextWindow.toLocaleString()}</TableCell>
                <TableCell>
                  <Switch checked={row.enabled} onCheckedChange={() => handleToggleEnabled(row)} />
                </TableCell>
                <TableCell className="text-right [&>*+*]:ml-2">
                  <Button size="sm" variant="outline" onClick={() => handleEditContext(row)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleDelete(row)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
