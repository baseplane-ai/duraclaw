import { Slot } from '@radix-ui/react-slot'
import { styled, View } from '@tamagui/core'
import { PanelLeftIcon } from 'lucide-react'
import * as React from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Separator } from '~/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip'
import { useIsMobile } from '~/hooks/use-mobile'
import { cn } from '~/lib/utils'

// GH#125 P1b — Tamagui port of the shadcn Sidebar (23 subcomponents,
// previously 705 LOC + cva). The sidebar's collapse/expand machinery
// is fundamentally driven by Tailwind data-attribute cascade selectors
// (`group-data-[collapsible=icon]:...`, `peer-data-[size=sm]/menu-button:...`)
// that Tamagui v2-rc.41's compiler cannot extract. Those selector patterns
// remain in the className escape hatch via `cn()`.
//
// What this migration changes:
//  - Each subcomponent's outer element is now a `styled(View)` shell so
//    the API surface matches the rest of the P1a primitives (Button,
//    Card, Skeleton, etc.). Token-driven values (radii, gap, padding)
//    use $-prefixed Tamagui tokens.
//  - `cva` + `class-variance-authority` is removed — `SidebarMenuButton`
//    composes its variants via a hand-rolled string builder
//    (`menuButtonClasses`).
//  - `--sidebar-width` / `--sidebar-width-icon` CSS-var arbitrary-calc
//    patterns reference the new Tamagui `space.sidebarWidth*` tokens
//    (see apps/orchestrator/src/tamagui.config.ts). The CSS-var values
//    are still set inline on the wrapper so existing Tailwind classes
//    (`w-(--sidebar-width)` etc.) continue to resolve — Tailwind's
//    arbitrary-value syntax is the only way to express the cascade
//    without rebuilding the entire collapse/expand state machine.

const SIDEBAR_COOKIE_NAME = 'sidebar_state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = '16rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

type SidebarContextProps = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }

  return context
}

const SidebarWrapperShell = styled(View, {
  name: 'SidebarWrapper',
  display: 'flex',
  flexDirection: 'row',
  width: '100%',
})

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open],
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed'

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <SidebarWrapperShell
          data-slot="sidebar-wrapper"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper min-h-svh has-data-[variant=inset]:bg-sidebar',
            className,
          )}
          {...(props as React.ComponentProps<typeof SidebarWrapperShell>)}
        >
          {children}
        </SidebarWrapperShell>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

const SidebarInnerShell = styled(View, {
  name: 'SidebarInner',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
})

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (collapsible === 'none') {
    return (
      <SidebarInnerShell
        data-slot="sidebar"
        className={cn('w-(--sidebar-width) bg-sidebar text-sidebar-foreground', className)}
        {...(props as React.ComponentProps<typeof SidebarInnerShell>)}
      >
        {children}
      </SidebarInnerShell>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[inset-inline,width] duration-200 ease-linear md:flex',
          side === 'left'
            ? 'start-0 group-data-[collapsible=offcanvas]:-start-[calc(var(--sidebar-width))]'
            : 'end-0 group-data-[collapsible=offcanvas]:-end-[calc(var(--sidebar-width))]',
          // Adjust the padding for floating and inset variants.
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-e group-data-[side=right]:border-s',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn('size-7', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

const SidebarRailShell = styled(View, {
  name: 'SidebarRail',
  render: 'button',
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 20,
  width: 16,
  cursor: 'pointer',
})

function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar()

  return (
    <SidebarRailShell
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      // `title` lives outside Tamagui's StackStyle; spread via props cast.
      {...({ title: 'Toggle Sidebar' } as { title: string })}
      className={cn(
        'hidden -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-end-4 group-data-[side=right]:start-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:start-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-end-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-start-2',

        // RTL support
        'rtl:translate-x-1/2',
        'rtl:in-data-[side=left]:cursor-e-resize rtl:in-data-[side=right]:cursor-w-resize',
        'rtl:[[data-side=left][data-state=collapsed]_&]:cursor-w-resize rtl:[[data-side=right][data-state=collapsed]_&]:cursor-e-resize',
        className,
      )}
      {...(props as React.ComponentProps<typeof SidebarRailShell>)}
    />
  )
}

const SidebarInsetShell = styled(View, {
  name: 'SidebarInset',
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  width: '100%',
  // `min-h-0` lets the viewport-sized sidebar-wrapper (min-h-svh)
  // actually constrain this inset container. Without it, flex items
  // default to `min-height: auto` = content size, so this wrapper
  // grows with its children (MAIN + conversation list), defeating
  // every downstream `overflow-y: auto` container. The conversation
  // auto-scroll machinery relies on that descendant scroll being
  // bounded — otherwise `clientHeight === scrollHeight` and there's
  // nothing to scroll through.
  minHeight: 0,
  backgroundColor: '$background',
})

function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarInsetShell
      data-slot="sidebar-inset"
      className={cn(
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2',
        className,
      )}
      {...(props as React.ComponentProps<typeof SidebarInsetShell>)}
    />
  )
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('h-8 w-full bg-background shadow-none', className)}
      {...props}
    />
  )
}

const SidebarHeaderShell = styled(View, {
  name: 'SidebarHeader',
  display: 'flex',
  flexDirection: 'column',
  gap: '$2',
  padding: '$2',
})

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarHeaderShell
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof SidebarHeaderShell>)}
    />
  )
}

const SidebarFooterShell = styled(View, {
  name: 'SidebarFooter',
  display: 'flex',
  flexDirection: 'column',
  gap: '$2',
  padding: '$2',
})

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarFooterShell
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof SidebarFooterShell>)}
    />
  )
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  )
}

const SidebarContentShell = styled(View, {
  name: 'SidebarContent',
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  gap: '$2',
  // overflow:'auto' not in StackStyle's overflow enum (hidden|visible|scroll).
  // Apply via className escape hatch alongside the data-attribute cascade.
})

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarContentShell
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn('overflow-auto group-data-[collapsible=icon]:overflow-hidden', className)}
      {...(props as React.ComponentProps<typeof SidebarContentShell>)}
    />
  )
}

const SidebarGroupShell = styled(View, {
  name: 'SidebarGroup',
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
  paddingHorizontal: '$2',
  paddingVertical: '$1',
})

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarGroupShell
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof SidebarGroupShell>)}
    />
  )
}

const SidebarGroupLabelShell = styled(View, {
  name: 'SidebarGroupLabel',
  display: 'flex',
  flexDirection: 'row',
  height: 32,
  flexShrink: 0,
  alignItems: 'center',
  borderRadius: '$md',
  paddingHorizontal: '$2',
})

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const labelClassName = cn(
    'text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
    'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
    className,
  )
  if (asChild) {
    return (
      <Slot
        data-slot="sidebar-group-label"
        data-sidebar="group-label"
        className={labelClassName}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <SidebarGroupLabelShell
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={labelClassName}
      {...(props as React.ComponentProps<typeof SidebarGroupLabelShell>)}
    />
  )
}

const SidebarGroupActionShell = styled(View, {
  name: 'SidebarGroupAction',
  render: 'button',
  position: 'absolute',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  borderRadius: '$md',
  padding: 0,
  cursor: 'pointer',
})

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const actionClassName = cn(
    'end-3 top-3.5 aspect-square text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
    // Increases the hit area of the button on mobile.
    'after:absolute after:-inset-2 md:after:hidden',
    'group-data-[collapsible=icon]:hidden',
    className,
  )
  if (asChild) {
    return (
      <Slot
        data-slot="sidebar-group-action"
        data-sidebar="group-action"
        className={actionClassName}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <SidebarGroupActionShell
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={actionClassName}
      {...(props as React.ComponentProps<typeof SidebarGroupActionShell>)}
    />
  )
}

const SidebarGroupContentShell = styled(View, {
  name: 'SidebarGroupContent',
  width: '100%',
})

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarGroupContentShell
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('text-sm', className)}
      {...(props as React.ComponentProps<typeof SidebarGroupContentShell>)}
    />
  )
}

const SidebarMenuShell = styled(View, {
  name: 'SidebarMenu',
  render: 'ul',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
  gap: 2,
})

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <SidebarMenuShell
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof SidebarMenuShell>)}
    />
  )
}

const SidebarMenuItemShell = styled(View, {
  name: 'SidebarMenuItem',
  render: 'li',
  position: 'relative',
})

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <SidebarMenuItemShell
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item', className)}
      {...(props as React.ComponentProps<typeof SidebarMenuItemShell>)}
    />
  )
}

// GH#125 P1b — replaces the cva()-built sidebarMenuButtonVariants. The
// data-attribute cascade selectors here can't be expressed via Tamagui
// `styled()` variants without the compiler reaching into them, so the
// variant catalog stays as plain class strings composed by hand.
const SIDEBAR_MENU_BUTTON_BASE =
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-start text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pe-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0'

const SIDEBAR_MENU_BUTTON_VARIANTS = {
  variant: {
    default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    outline:
      'bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]',
  },
  size: {
    default: 'h-8 text-sm',
    sm: 'h-7 text-xs',
    lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
  },
} as const

type SidebarMenuButtonVariant = keyof typeof SIDEBAR_MENU_BUTTON_VARIANTS.variant
type SidebarMenuButtonSize = keyof typeof SIDEBAR_MENU_BUTTON_VARIANTS.size

function menuButtonClasses(variant: SidebarMenuButtonVariant, size: SidebarMenuButtonSize): string {
  return cn(
    SIDEBAR_MENU_BUTTON_BASE,
    SIDEBAR_MENU_BUTTON_VARIANTS.variant[variant],
    SIDEBAR_MENU_BUTTON_VARIANTS.size[size],
  )
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
  variant?: SidebarMenuButtonVariant
  size?: SidebarMenuButtonSize
}) {
  const Comp = asChild ? Slot : 'button'
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(menuButtonClasses(variant, size), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        {...tooltip}
      />
    </Tooltip>
  )
}

const SidebarMenuActionShell = styled(View, {
  name: 'SidebarMenuAction',
  render: 'button',
  position: 'absolute',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  borderRadius: '$md',
  padding: 0,
  cursor: 'pointer',
})

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  showOnHover?: boolean
}) {
  const menuActionClassName = cn(
    'end-1 top-1.5 aspect-square text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
    // Increases the hit area of the button on mobile.
    'after:absolute after:-inset-2 md:after:hidden',
    'peer-data-[size=sm]/menu-button:top-1',
    'peer-data-[size=default]/menu-button:top-1.5',
    'peer-data-[size=lg]/menu-button:top-2.5',
    'group-data-[collapsible=icon]:hidden',
    showOnHover &&
      'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground data-[state=open]:opacity-100 md:opacity-0',
    className,
  )
  if (asChild) {
    return (
      <Slot
        data-slot="sidebar-menu-action"
        data-sidebar="menu-action"
        className={menuActionClassName}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <SidebarMenuActionShell
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={menuActionClassName}
      {...(props as React.ComponentProps<typeof SidebarMenuActionShell>)}
    />
  )
}

const SidebarMenuBadgeShell = styled(View, {
  name: 'SidebarMenuBadge',
  pointerEvents: 'none',
  position: 'absolute',
  display: 'flex',
  flexDirection: 'row',
  height: 20,
  minWidth: 20,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '$md',
  paddingHorizontal: 4,
  userSelect: 'none',
})

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <SidebarMenuBadgeShell
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'end-1 text-xs font-medium text-sidebar-foreground tabular-nums',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...(props as React.ComponentProps<typeof SidebarMenuBadgeShell>)}
    />
  )
}

const SidebarMenuSkeletonShell = styled(View, {
  name: 'SidebarMenuSkeleton',
  display: 'flex',
  flexDirection: 'row',
  height: 32,
  alignItems: 'center',
  gap: '$2',
  borderRadius: '$md',
  paddingHorizontal: '$2',
})

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  }, [])

  return (
    <SidebarMenuSkeletonShell
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn(className)}
      {...(props as React.ComponentProps<typeof SidebarMenuSkeletonShell>)}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </SidebarMenuSkeletonShell>
  )
}

const SidebarMenuSubShell = styled(View, {
  name: 'SidebarMenuSub',
  render: 'ul',
  marginHorizontal: '$2',
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 2,
  borderLeftWidth: 1,
  borderLeftColor: '$border',
  paddingHorizontal: 6,
  paddingVertical: 0,
})

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <SidebarMenuSubShell
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'translate-x-px border-sidebar-border',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...(props as React.ComponentProps<typeof SidebarMenuSubShell>)}
    />
  )
}

const SidebarMenuSubItemShell = styled(View, {
  name: 'SidebarMenuSubItem',
  render: 'li',
  position: 'relative',
})

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <SidebarMenuSubItemShell
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item', className)}
      {...(props as React.ComponentProps<typeof SidebarMenuSubItemShell>)}
    />
  )
}

const SidebarMenuSubButtonShell = styled(View, {
  name: 'SidebarMenuSubButton',
  render: 'a',
  display: 'flex',
  // GH#125 follow-up: Tamagui `styled(View)` defaults to flexDirection:
  // 'column' (RN semantics). Without an explicit row direction the chevron,
  // label-stack <div>, and trailing count <span> children stack vertically
  // and get clipped by overflow:hidden, so only the leading icon is visible.
  flexDirection: 'row',
  height: 24,
  minWidth: 0,
  alignItems: 'center',
  gap: 6,
  overflow: 'hidden',
  borderRadius: '$md',
  paddingHorizontal: 6,
  cursor: 'pointer',
})

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean
  size?: 'sm' | 'md'
  isActive?: boolean
}) {
  const subButtonClassName = cn(
    '-translate-x-px text-sidebar-foreground ring-sidebar-ring outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-inherit',
    'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
    size === 'sm' && 'text-xs',
    size === 'md' && 'text-sm',
    'group-data-[collapsible=icon]:hidden',
    className,
  )
  if (asChild) {
    return (
      <Slot
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size={size}
        data-active={isActive}
        className={subButtonClassName}
        {...(props as React.ComponentProps<typeof Slot>)}
      />
    )
  }
  return (
    <SidebarMenuSubButtonShell
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={subButtonClassName}
      {...(props as React.ComponentProps<typeof SidebarMenuSubButtonShell>)}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
