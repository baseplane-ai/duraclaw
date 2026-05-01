import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { dbReady } from '~/db/db-instance'
import { evictOldMessages } from '~/db/messages-collection'
import { installAriaHiddenPatch } from '~/lib/aria-hidden-patch'
import { authClientReady } from '~/lib/auth-client'
import { initMobileUpdater } from '~/lib/mobile-updater'
import { initNativePushDeepLink } from '~/lib/native-push-deep-link'
import { installNativeFetchInterceptor } from '~/lib/platform'
import { installReactOffscreenPatch } from '~/lib/react-offscreen-patch'
import { getRouter } from './router'

installAriaHiddenPatch()
installReactOffscreenPatch()

async function bootstrap() {
  // Block React mount until OPFS persistence has resolved.
  // Otherwise *-collection modules import a null persistence handle
  // and fall into the non-persisted branch (B-CLIENT-1).
  // Also await the auth client — on Capacitor the better-auth-capacitor
  // wrapper is loaded via dynamic import; on web this resolves in one
  // microtask. The Proxy-based `authClient` / `useSession` exports throw
  // if accessed before this resolves.
  await Promise.all([dbReady, authClientReady])

  // Patch globalThis.fetch on native (Capacitor or Expo) so every API
  // call includes the bearer token. On Capacitor: token from
  // @capacitor/preferences via better-auth-capacitor/client. On Expo:
  // token from expo-secure-store via auth-client-expo. Must run after
  // authClientReady so both native modules (whichever is active) are
  // resolved by the dispatcher.
  await installNativeFetchInterceptor()

  // Register the native push tap listener BEFORE React mounts so the
  // Capacitor plugin's retainUntilConsumed buffer hands us the cold-start
  // tap event the instant subscription resolves — well ahead of
  // AgentOrchPage's cold-start "restore last-active tab" effect.
  // Fire-and-forget: the dynamic import shouldn't block React mount.
  void initNativePushDeepLink()

  try {
    evictOldMessages()
  } catch {
    // ignore — collection may be empty/uninitialised
  }

  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Missing #root mount point')
  }

  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  )

  void initMobileUpdater()
}

void bootstrap()
