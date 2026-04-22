import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Folder, Laptop, Moon, Plus, Settings, Sun } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '~/components/ui/command'
import { useSearch } from '~/context/search-provider'
import { useTheme } from '~/context/theme-provider'
import { deriveStatus } from '~/lib/derive-status'
import { apiUrl } from '~/lib/platform'
import { useNow } from '~/lib/use-now'
import { cn } from '~/lib/utils'
import { sidebarData } from './layout/data/sidebar-data'
import { ScrollArea } from './ui/scroll-area'

export function CommandMenu() {
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()

  const [sessions, setSessions] = useState<
    Array<{
      id: string
      title?: string | null
      project: string
      status: string
      // Drizzle returns camelCase keys from `.select().from(agentSessions)`.
      // GH#50: `lastEventTs` is the epoch-ms TTL anchor for client-side
      // `deriveStatus()`.
      lastEventTs?: number | null
    }>
  >([])
  const [projects, setProjects] = useState<Array<{ name: string; branch: string; dirty: boolean }>>(
    [],
  )

  useEffect(() => {
    if (!open) return
    fetch(apiUrl('/api/sessions'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        const d = data as Record<string, unknown> | null
        if (d?.sessions) setSessions((d.sessions as typeof sessions).slice(0, 20))
      })
      .catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    fetch(apiUrl('/api/gateway/projects'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        const list = Array.isArray(data)
          ? data
          : ((data as Record<string, unknown> | null)?.projects ?? [])
        setProjects(list as typeof projects)
      })
      .catch(() => {})
  }, [open])

  const nowTs = useNow()

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen],
  )

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <ScrollArea type="hover" className="h-72 pe-1">
          <CommandEmpty>No results found.</CommandEmpty>
          {sessions.length > 0 && (
            <CommandGroup heading="Recent Sessions">
              {sessions.slice(0, 5).map((s) => {
                // GH#50: TTL-derived status — falls through to `s.status`
                // for rows without a `last_event_ts` (older deployments).
                const derived = deriveStatus(
                  { status: s.status, lastEventTs: s.lastEventTs ?? null },
                  nowTs,
                )
                return (
                  <CommandItem
                    key={s.id}
                    value={`session ${s.title || s.id} ${s.project}`}
                    onSelect={() =>
                      runCommand(() => navigate({ to: '/', search: { session: s.id } }))
                    }
                  >
                    <span
                      className={cn(
                        'mr-2 size-2 rounded-full',
                        derived === 'running'
                          ? 'bg-green-500'
                          : derived === 'waiting_gate'
                            ? 'bg-yellow-500'
                            : 'border border-gray-400',
                      )}
                    />
                    <span className="flex-1 truncate">{s.title || s.id.slice(0, 12)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{s.project}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}
          {projects.length > 0 && (
            <CommandGroup heading="Projects">
              {projects.map((p) => (
                <CommandItem
                  key={p.name}
                  value={`project ${p.name} ${p.branch}`}
                  onSelect={() => runCommand(() => navigate({ to: '/' }))}
                >
                  <Folder className="mr-2 size-4 text-muted-foreground" />
                  <span className="flex-1">{p.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{p.branch}</span>
                  {p.dirty && <span className="ml-1 size-1.5 rounded-full bg-yellow-500" />}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/' }))}>
              <Plus className="mr-2 size-4" /> New session
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/settings' }))}>
              <Settings className="mr-2 size-4" /> Open settings
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          {sidebarData.navGroups.map((group) => (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((navItem, i) => {
                if (navItem.url)
                  return (
                    <CommandItem
                      key={`${navItem.url}-${i}`}
                      value={navItem.title}
                      onSelect={() => {
                        runCommand(() => navigate({ to: navItem.url }))
                      }}
                    >
                      <div className="flex size-4 items-center justify-center">
                        <ArrowRight className="size-2 text-muted-foreground/80" />
                      </div>
                      {navItem.title}
                    </CommandItem>
                  )

                return navItem.items?.map((subItem, i) => (
                  <CommandItem
                    key={`${navItem.title}-${subItem.url}-${i}`}
                    value={`${navItem.title}-${subItem.url}`}
                    onSelect={() => {
                      runCommand(() => navigate({ to: subItem.url }))
                    }}
                  >
                    <div className="flex size-4 items-center justify-center">
                      <ArrowRight className="size-2 text-muted-foreground/80" />
                    </div>
                    {navItem.title} <ChevronRight /> {subItem.title}
                  </CommandItem>
                ))
              })}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => runCommand(() => setTheme('light'))}>
              <Sun /> <span>Light</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme('dark'))}>
              <Moon className="scale-90" />
              <span>Dark</span>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme('system'))}>
              <Laptop />
              <span>System</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
