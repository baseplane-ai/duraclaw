import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { createAuth } from './auth'
import { getCloudflareEnv } from './cf-env'

export const getSession = createServerFn({ method: 'GET' }).handler(async () => {
  const headers = getRequestHeaders()
  const env = getCloudflareEnv()
  const auth = createAuth(env)
  const session = await auth.api.getSession({ headers })
  return session
})
