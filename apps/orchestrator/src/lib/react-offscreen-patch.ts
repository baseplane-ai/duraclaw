/**
 * React 19 Offscreen workaround for Capacitor Android WebView.
 *
 * ## Problem
 *
 * React 19's concurrent mode uses an internal `hideOrUnhideAllChildren`
 * function that applies `display: none !important` via
 * `style.setProperty('display', 'none', 'important')` on DOM elements
 * inside an Offscreen/Activity subtree whose `memoizedState.baseLanes`
 * is non-null (indicating deferred concurrent work).
 *
 * On Android WebView (Capacitor), the Offscreen's `baseLanes` can get
 * permanently stuck during initial mount — likely a timing edge case in
 * React's concurrent scheduler interacting with the WebView's JS engine.
 * This leaves the entire sidebar-wrapper (and all app content) hidden
 * with `display: none !important` even though TanStack Router reports
 * all matches as `status: 'success'` and `isLoading: false`.
 *
 * ## Fix
 *
 * Patch `CSSStyleDeclaration.prototype.setProperty` to silently drop
 * `setProperty('display', 'none', 'important')` calls. This is safe
 * because:
 *
 * 1. **Only React's Offscreen uses this pattern** — no app code or
 *    dependency uses `display: none !important` as an inline style.
 * 2. **Our app doesn't use `<Activity>`** — Offscreen hiding is purely
 *    React's internal mechanism for Suspense pending states.
 * 3. **Gated by `isNative()`** — the web build is completely unaffected
 *    (Vite tree-shakes the dead branch).
 *
 * Must be called **before** `ReactDOM.createRoot().render()`.
 */

import { isNative } from './platform'

export function installReactOffscreenPatch(): void {
  if (!isNative()) return

  const orig = CSSStyleDeclaration.prototype.setProperty
  CSSStyleDeclaration.prototype.setProperty = function (
    property: string,
    value: string,
    priority?: string,
  ): void {
    if (property === 'display' && value === 'none' && priority === 'important') {
      return
    }
    orig.call(this, property, value, priority ?? '')
  }
}
