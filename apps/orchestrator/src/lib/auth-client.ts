import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

const baseURL =
  typeof window === 'undefined' ? 'http://localhost/api/auth' : `${window.location.origin}/api/auth`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient({
  baseURL,
  plugins: [adminClient()],
})

export const { useSession, signIn, signOut, signUp } = authClient
