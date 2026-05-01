// Production native entry — Expo SDK 55 + React Navigation root.
//
// This file evolved from the P2 Metro-smoke entry (which only proved
// the source tree resolved under react-native-web). On the Expo native
// build (Metro + JSC/Hermes on Android) this is the actual cold-start
// path: AppRegistry → bootstrap() → NavigationContainer.
//
// Cold-start ordering (matches entry-client.tsx on web):
//   1. Block on dbReady + authClientReady (op-sqlite handle + auth client).
//   2. Install the bearer-token fetch interceptor.
//   3. Initialize the FCM cold-start tap handler BEFORE React mount —
//      messaging().getInitialNotification() must run synchronously
//      relative to the AppRegistry mount so the pendingDeepLink slot
//      is populated by the time AgentOrchContent's mount effect
//      drains it.
//   4. Mount NativeNavigationRoot. The `isAuthenticated` decision is
//      delegated to a React hook that reads useSession() against the
//      fully-resolved auth client.

// MUST be the very first import: installs globalThis.crypto.getRandomValues
// polyfill (Hermes has no crypto API by default; op-sqlite + many libs depend
// on it). Imported before anything else so subsequent module evaluation can
// rely on globalThis.crypto. Web/Vite gets the browser's native crypto and
// this import is no-op-ish on web (the polyfill detects existing impl).
import 'react-native-get-random-values'
import '@expo/metro-runtime'
import { useEffect, useState } from 'react'
import { ActivityIndicator, AppRegistry, View } from 'react-native'
import { dbReady } from '~/db/db-instance'
import { authClientReady, useSession } from '~/lib/auth-client'
import { initNativePushDeepLink } from '~/lib/native-push-deep-link'
import { installNativeFetchInterceptor } from '~/lib/platform'
import { NativeNavigationRoot } from '~/native/navigation'

let bootstrapped = false
const bootstrapPromise: Promise<void> = (async () => {
  try {
    await Promise.all([dbReady, authClientReady])
    await installNativeFetchInterceptor()
    // Fire-and-forget: getInitialNotification() must resolve before the
    // first render reads consumePendingDeepLink, but we don't block the
    // whole bootstrap on it (the resolution is typically <50 ms after
    // bridge-ready and the cold-start tap handler retains the slot for
    // later drain channels regardless).
    void initNativePushDeepLink()
    bootstrapped = true
  } catch (err) {
    console.error('[entry-rn] bootstrap failed:', err)
  }
})()

function Splash() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  )
}

function RootApp() {
  const [ready, setReady] = useState(bootstrapped)
  useEffect(() => {
    if (ready) return
    let cancelled = false
    bootstrapPromise.then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [ready])

  // useSession is a thin Proxy on the resolved auth client; it throws
  // until authClientReady resolves. Guard with `ready`.
  const session = ready ? useSession() : null
  const isAuthenticated = Boolean((session as { data?: { user?: unknown } } | null)?.data?.user)

  if (!ready) return <Splash />
  return <NativeNavigationRoot isAuthenticated={isAuthenticated} />
}

// AppRegistry.runApplication requires a DOM rootTag on web (RNW). On
// Metro/native the `main` component is mounted by MainActivity via
// AppRegistry.registerComponent(...) directly — no runApplication call.
// The `typeof document !== 'undefined'` guard preserves the P2 smoke
// path for the Metro-bundle CI gate on web.
AppRegistry.registerComponent('main', () => RootApp)
AppRegistry.registerComponent('Orchestrator', () => RootApp)

if (typeof document !== 'undefined') {
  const rootTag = document.getElementById('root')
  if (rootTag) {
    AppRegistry.runApplication('Orchestrator', { rootTag })
  }
}
