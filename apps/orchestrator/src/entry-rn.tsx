// GH#131 P2 — Metro/RNW entry for the smoke-bundle CI gate.
//
// NOT a shipped artifact. Vite's `entry-client.tsx` remains the
// production web entry. This file exists so `metro build` (invoked
// from `scripts/check-metro-bundle.sh`) can prove that the same
// orchestrator source tree resolves under a Metro+react-native
// target — the concrete proof that P2's renderer swap unlocks P3.
//
// AppRegistry.runApplication requires a DOM rootTag, so the call is
// guarded on `typeof document !== 'undefined'`. Native (P3) will use
// a different entry path that skips this guard.

import '@expo/metro-runtime'
import { RouterProvider } from '@tanstack/react-router'
import { AppRegistry } from 'react-native'
import { getRouter } from './router'

function App() {
  return <RouterProvider router={getRouter()} />
}

AppRegistry.registerComponent('Orchestrator', () => App)

if (typeof document !== 'undefined') {
  const rootTag = document.getElementById('root')
  if (rootTag) {
    AppRegistry.runApplication('Orchestrator', { rootTag })
  }
}
