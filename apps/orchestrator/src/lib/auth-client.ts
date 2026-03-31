import { createAuthClient } from 'better-auth/react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient()

export const { useSession, signIn, signOut, signUp } = authClient
