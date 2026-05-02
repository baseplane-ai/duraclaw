// Cross-platform toast wrapper.
//
// Web: thin re-export of `sonner`'s `toast` (the existing app-wide toast
// surface; <Toaster /> is mounted in routes/__root.tsx).
//
// Native (RN/Expo): falls back to `Alert.alert(title, msg)` since
// `sonner` is web-only (its Toaster mounts portal nodes into document.body).
// Native UX is plain modal alerts in this iteration; an upgrade path to
// `react-native-toast-message` (or a custom Animated toast) is filed as
// a future follow-up — see GH#157 §1 (B3 cross-cutting infra).
//
// Implementation note — NO top-level await:
//   Metro historically does not support TLA, and TLA in a module
//   shared with the Cloudflare Worker bundle would also break the
//   Worker loader. We dispatch via a synchronous `require('sonner')`
//   gated by `Platform.OS === 'web'`. Metro statically parses the
//   if-branch but skips it at runtime on native (Platform.OS is
//   constant-folded by babel-preset-expo). Vite resolves require() as
//   a synchronous import on web. The cost is loading sonner eagerly on
//   web, which is fine — it's already in the web bundle today.

import { Alert, Platform } from 'react-native'

export type ToastApi = {
  success: (msg: string) => void
  error: (msg: string) => void
  info: (msg: string) => void
}

let webSonnerToast: ToastApi | null = null
if (Platform.OS === 'web') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  webSonnerToast = require('sonner').toast as ToastApi
}

export const toast: ToastApi = {
  success: (msg) =>
    Platform.OS === 'web' ? webSonnerToast?.success(msg) : Alert.alert('Success', msg),
  error: (msg) => (Platform.OS === 'web' ? webSonnerToast?.error(msg) : Alert.alert('Error', msg)),
  info: (msg) => (Platform.OS === 'web' ? webSonnerToast?.info(msg) : Alert.alert('', msg)),
}
