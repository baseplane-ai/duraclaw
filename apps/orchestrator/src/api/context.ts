import type { Env } from '~/lib/types'

export type ApiAppEnv = {
  Bindings: Env
  Variables: {
    userId: string
    role: string
    /**
     * GH#122 B-AUTH-1: set by `projectMetadataAuth` middleware so
     * downstream guards (`requireProjectMember`) can short-circuit on
     * `DOCS_RUNNER_SECRET` bearer-auth requests without re-doing the
     * timing-safe compare. `true` ⇒ bearer-authed (bypass project
     * membership checks); `false` ⇒ cookie-authed user session.
     */
    bearerAuth: boolean
  }
}
