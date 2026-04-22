import { cn } from '~/lib/utils'

type MainProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  fluid?: boolean
  ref?: React.Ref<HTMLElement>
}

export function Main({ fixed, className, fluid, ...props }: MainProps) {
  return (
    <main
      id="content"
      data-layout={fixed ? 'fixed' : 'auto'}
      className={cn(
        'px-4 py-6',

        // If layout is fixed, make the main container flex and grow.
        // `min-h-0` is load-bearing: without it, a flex item's implicit
        // `min-height: auto` equals its content size, so MAIN grows with
        // its children (the conversation list) instead of being bounded
        // by the viewport. The chain of `min-h-0 + overflow-hidden` is
        // what lets the descendant `overflow-y: auto` scroll container
        // engage and actually scroll internally — without it `clientHeight`
        // resolves to `scrollHeight` and auto-scroll has nothing to scroll.
        fixed && 'flex min-h-0 grow flex-col overflow-hidden',

        // If layout is not fluid, set the max-width
        !fluid && '@7xl/content:mx-auto @7xl/content:w-full @7xl/content:max-w-7xl',
        className,
      )}
      {...props}
    />
  )
}
