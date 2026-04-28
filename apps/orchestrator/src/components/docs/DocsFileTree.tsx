/**
 * DocsFileTree (GH#27 P1.6 WU-C, P1.7 WU-B)
 *
 * Left-pane tree of markdown files in the project's docs worktree.
 * Files are grouped into directories by splitting `relPath` on `/`.
 * Click a leaf to select it; the parent route owns the selection state.
 *
 * Per-file state dots come from the docs-runner's `/health` `per_file`
 * snapshot (proxied via `/api/docs-runners/:projectId/health`). Mapping:
 *   syncing      → green
 *   starting     → gray
 *   disconnected → orange
 *   tombstoned   → red (also strikethrough — handled by `tombstoned` prop)
 *   error        → red
 *   missing/unknown → no dot
 */

import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '~/lib/utils'

export type DocsFileState = 'syncing' | 'starting' | 'disconnected' | 'tombstoned' | 'error'

export interface DocsFile {
  relPath: string
  lastModified: number
}

export interface DocsFileTreeProps {
  files: DocsFile[]
  selected: string | null
  onSelect: (relPath: string) => void
  /**
   * relPaths whose owning DO has broadcast a `tombstone-pending` awareness
   * signal. The tree renders strikethrough on these rows so the user
   * sees the pending soft-delete (B10/B20). Defaults to an empty set.
   */
  tombstoned?: Set<string>
  /**
   * Per-file connection state from the docs-runner health proxy. Drives
   * the colored dot next to each file. Map keyed by `relPath`. Missing
   * entries render no dot.
   */
  fileStates?: Map<string, DocsFileState> | Record<string, DocsFileState>
}

interface TreeDir {
  type: 'dir'
  name: string
  path: string
  children: TreeNode[]
}

interface TreeFile {
  type: 'file'
  name: string
  file: DocsFile
}

type TreeNode = TreeDir | TreeFile

function buildTree(files: DocsFile[]): TreeNode[] {
  const root: TreeDir = { type: 'dir', name: '', path: '', children: [] }

  // Stable: iterate in lexicographic order so directories come out grouped.
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))

  for (const file of sorted) {
    const parts = file.relPath.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let cursor: TreeDir = root
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]
      const childPath = cursor.path ? `${cursor.path}/${segment}` : segment
      let next = cursor.children.find((c): c is TreeDir => c.type === 'dir' && c.name === segment)
      if (!next) {
        next = { type: 'dir', name: segment, path: childPath, children: [] }
        cursor.children.push(next)
      }
      cursor = next
    }
    const fileName = parts[parts.length - 1]
    cursor.children.push({ type: 'file', name: fileName, file })
  }

  // Within each directory, dirs first then files (each already sorted by
  // the upstream sort).
  function reorder(node: TreeDir) {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const c of node.children) {
      if (c.type === 'dir') reorder(c)
    }
  }
  reorder(root)
  return root.children
}

const EMPTY_TOMBSTONED: ReadonlySet<string> = new Set()

function lookupState(
  fileStates: DocsFileTreeProps['fileStates'],
  relPath: string,
): DocsFileState | undefined {
  if (!fileStates) return undefined
  if (fileStates instanceof Map) return fileStates.get(relPath)
  return (fileStates as Record<string, DocsFileState>)[relPath]
}

const STATE_DOT_CLASSES: Record<DocsFileState, string> = {
  syncing: 'bg-green-500',
  starting: 'bg-gray-400',
  disconnected: 'bg-orange-500',
  tombstoned: 'bg-red-500',
  error: 'bg-red-500',
}

function StateDot({ state }: { state: DocsFileState }) {
  return (
    <span
      data-testid={`docs-tree-state-dot-${state}`}
      title={state}
      className={cn('size-2 shrink-0 rounded-full', STATE_DOT_CLASSES[state])}
    />
  )
}

export function DocsFileTree({
  files,
  selected,
  onSelect,
  tombstoned,
  fileStates,
}: DocsFileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files])
  const tombs = tombstoned ?? EMPTY_TOMBSTONED

  if (files.length === 0) {
    return (
      <div className="p-4 text-muted-foreground text-sm">
        No markdown files found in the docs worktree.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 p-2 text-sm">
      {tree.map((node) => (
        <TreeNodeView
          key={node.type === 'dir' ? `d:${node.path}` : `f:${node.file.relPath}`}
          node={node}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          tombstoned={tombs}
          fileStates={fileStates}
        />
      ))}
    </div>
  )
}

interface TreeNodeViewProps {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (relPath: string) => void
  tombstoned: ReadonlySet<string>
  fileStates?: DocsFileTreeProps['fileStates']
}

function TreeNodeView({
  node,
  depth,
  selected,
  onSelect,
  tombstoned,
  fileStates,
}: TreeNodeViewProps) {
  const [open, setOpen] = useState(true)

  if (node.type === 'file') {
    const isSelected = selected === node.file.relPath
    const isTombstoned = tombstoned.has(node.file.relPath)
    const state = lookupState(fileStates, node.file.relPath)
    return (
      <button
        type="button"
        data-testid={`docs-tree-file-${node.file.relPath}`}
        data-tombstoned={isTombstoned ? '1' : undefined}
        data-state={state}
        onClick={() => onSelect(node.file.relPath)}
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground',
          isSelected && 'bg-accent font-medium text-accent-foreground',
          isTombstoned && 'text-muted-foreground line-through',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
        {state && <StateDot state={state} />}
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        data-testid={`docs-tree-dir-${node.path}`}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.type === 'dir' ? `d:${child.path}` : `f:${child.file.relPath}`}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              tombstoned={tombstoned}
              fileStates={fileStates}
            />
          ))}
        </div>
      )}
    </div>
  )
}
