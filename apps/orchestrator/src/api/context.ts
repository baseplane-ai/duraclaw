import type { Env } from '~/lib/types'

export type ApiAppEnv = {
  Bindings: Env
  Variables: {
    userId: string
  }
}
