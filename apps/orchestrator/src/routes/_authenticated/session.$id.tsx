import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Compat redirect from the legacy /session/:id path-param route to the
 * canonical /?session=:id search-param form.
 *
 * The dashboard (`/`) owns session selection via a `?session=X` search param.
 * Having a parallel path-param route caused subtle bugs:
 *   - soft nav between /session/$id and /?session=X was getting swallowed on
 *     Android Chrome standalone PWA resumes from freeze-dry
 *   - duplicated "select session" logic across two routes
 *
 * Keeping this route as a pure redirect preserves any stale bookmarks /
 * external links pointing at /session/:id.
 */
export const Route = createFileRoute('/_authenticated/session/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/', search: { session: params.id } })
  },
})
