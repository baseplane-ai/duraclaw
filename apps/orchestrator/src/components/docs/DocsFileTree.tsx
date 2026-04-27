/**
 * DocsFileTree (GH#27 P1.6 WU-C)
 *
 * Left-pane tree of markdown files in the project's docs worktree.
 * Files are grouped into directories by splitting `relPath` on `/`.
 * Click a leaf to select it; the parent route owns the selection state.
 *
 * The `state` field hinted at in the spec (live / cold / dirty) comes from
 * the P1.7 health proxy and is not yet wired here — see TODO below.
 */

import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '~/lib/utils'

export interface DocsFile {
  relPath: string
  lastModified: number
  // TODO(GH#27 p1.7): state: 'live' | 'cold' | 'dirty' — populated by the
  // health proxy. Render a colored dot once available.
  state?: string
}

export interface DocsFileTreeProps {
  files: DocsFile[]
  selected: string | null
  onSelect: (relPath: string) => void
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

export function DocsFileTree({ files, selected, onSelect }: DocsFileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files])

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
}

function TreeNodeView({ node, depth, selected, onSelect }: TreeNodeViewProps) {
  const [open, setOpen] = useState(true)

  if (node.type === 'file') {
    const isSelected = selected === node.file.relPath
    return (
      <button
        type="button"
        data-testid={`docs-tree-file-${node.file.relPath}`}
        onClick={() => onSelect(node.file.relPath)}
        className={cn(
          'flex items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground',
          isSelected && 'bg-accent font-medium text-accent-foreground',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
