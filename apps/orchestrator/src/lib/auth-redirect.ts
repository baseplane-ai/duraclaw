/**
 * Centralised 401 → /login redirect. Call from auth-failing fetch sites
 * after better-auth has had its chance to refresh. Stores a flag in
 * sessionStorage so /login can show the "Session expired" toast.
 */
export function redirectToLogin(reason: 'expired' | 'unauthorized' = 'expired') {
  try {
    sessionStorage.setItem('auth.redirect.reason', reason)
  } catch {
    // ignore — sessionStorage may be unavailable
  }
  // Use full reload so the auth-client and DB caches are flushed
  if (typeof window !== 'undefined') {
    window.location.href = '/login'
  }
}
