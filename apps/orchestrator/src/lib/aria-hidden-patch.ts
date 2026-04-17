/**
 * Swap `aria-hidden="true"` for `inert` when the node being hidden contains
 * the currently focused element. Chrome blocks aria-hidden in that case and
 * logs an issue ("Blocked aria-hidden on an element because its descendant
 * retained focus"). Radix UI 1.x uses `hideOthers` from the aria-hidden
 * package, which prefers the attribute over inert; this observer converts
 * those cases to the inert form that Chrome accepts.
 */
export function installAriaHiddenPatch(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (!('inert' in HTMLElement.prototype)) return () => {}

  const patched = new WeakSet<Element>()

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'attributes' || m.attributeName !== 'aria-hidden') continue
      const el = m.target as HTMLElement
      const val = el.getAttribute('aria-hidden')

      if (val === 'true') {
        const active = document.activeElement
        if (active && active !== el && el.contains(active)) {
          patched.add(el)
          el.removeAttribute('aria-hidden')
          el.setAttribute('inert', '')
        }
      } else if (patched.has(el)) {
        patched.delete(el)
        el.removeAttribute('inert')
      }
    }
  })

  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ['aria-hidden'],
  })

  return () => observer.disconnect()
}
