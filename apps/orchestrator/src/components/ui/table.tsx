import { styled, View } from '@tamagui/core'
import type * as React from 'react'
import { cn } from '~/lib/utils'

// GH#125 P1a — Tamagui port of the shadcn Table family.
//
// Each subcomponent renders a real semantic HTML table element via
// Tamagui's `render: '...'` prop (v2-rc.41). The outer Table wraps in
// a div container for horizontal overflow (preserved behaviour).
//
// Tailwind escape hatch (kept in className via `cn()`):
//  - text typography (text-sm / font-medium / whitespace-nowrap /
//    text-foreground / text-muted-foreground / caption-bottom) — View's
//    StackStyle rejects TextStyle props in v2-rc.41 runtime.
//  - [&_tr]:* / [&_tr:last-child]:* / [&>tr]:last:* descendant-state
//    selectors — Tamagui can't reach these without the compiler.
//  - data-[state=selected]:* / hover:* — same.
//  - [&>[role=checkbox]]:translate-y-[2px] — descendant-attribute
//    composition.
//  - text-start / align-middle — keep in className (Tamagui StackStyle
//    has no text-align, and verticalAlign on table cells is best left
//    to Tailwind for table-specific semantics).

const TableContainerShell = styled(View, {
  name: 'TableContainer',
  position: 'relative',
  width: '100%',
  overflow: 'hidden',
  // overflow-x-auto handled in className escape hatch (StackStyle's
  // overflowX/overflowY pair varies by platform; safer to keep the
  // Tailwind utility for browser-specific scrollbar behaviour).
})

const TableShell = styled(View, {
  name: 'Table',
  render: 'table',
  width: '100%',
})

const TableHeaderShell = styled(View, {
  name: 'TableHeader',
  render: 'thead',
})

const TableBodyShell = styled(View, {
  name: 'TableBody',
  render: 'tbody',
})

const TableFooterShell = styled(View, {
  name: 'TableFooter',
  render: 'tfoot',
  borderTopWidth: 1,
  borderTopColor: '$border',
  backgroundColor: '$muted',
})

const TableRowShell = styled(View, {
  name: 'TableRow',
  render: 'tr',
  borderBottomWidth: 1,
  borderBottomColor: '$border',
})

const TableHeadShell = styled(View, {
  name: 'TableHead',
  render: 'th',
  // GH#125 follow-up — minHeight not height; see SidebarMenuSubButton
  // commit 77364be for the specificity rationale. Wrapping header text
  // (long column titles) couldn't grow the row before this; rows clipped
  // to 40px and visually overlapped neighbours.
  minHeight: 40,
  paddingHorizontal: 8,
})

const TableCellShell = styled(View, {
  name: 'TableCell',
  render: 'td',
  padding: 8,
})

const TableCaptionShell = styled(View, {
  name: 'TableCaption',
  render: 'caption',
  marginTop: 16,
})

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <TableContainerShell data-slot="table-container" className={cn('overflow-x-auto')}>
      <TableShell
        data-slot="table"
        className={cn('caption-bottom text-sm', className)}
        {...(props as React.ComponentProps<typeof TableShell>)}
      />
    </TableContainerShell>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <TableHeaderShell
      data-slot="table-header"
      className={cn('[&_tr]:border-b', className)}
      {...(props as React.ComponentProps<typeof TableHeaderShell>)}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <TableBodyShell
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...(props as React.ComponentProps<typeof TableBodyShell>)}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <TableFooterShell
      data-slot="table-footer"
      className={cn('bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...(props as React.ComponentProps<typeof TableFooterShell>)}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <TableRowShell
      data-slot="table-row"
      className={cn(
        'transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...(props as React.ComponentProps<typeof TableRowShell>)}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <TableHeadShell
      data-slot="table-head"
      className={cn(
        'text-start align-middle font-medium whitespace-nowrap text-foreground [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...(props as React.ComponentProps<typeof TableHeadShell>)}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <TableCellShell
      data-slot="table-cell"
      className={cn(
        'align-middle whitespace-nowrap [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...(props as React.ComponentProps<typeof TableCellShell>)}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <TableCaptionShell
      data-slot="table-caption"
      className={cn('text-sm text-muted-foreground', className)}
      {...(props as React.ComponentProps<typeof TableCaptionShell>)}
    />
  )
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow }
