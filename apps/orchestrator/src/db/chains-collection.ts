/**
 * @deprecated GH#116 P1.3 transitional re-export shim. The canonical
 * file is now `~/db/arcs-collection.ts`; this module exists only so
 * client code that still does `import { chainsCollection } from
 * '~/db/chains-collection'` keeps resolving until the P1.4 client
 * sweep retargets every importer to `~/db/arcs-collection`. Removed
 * outright in P5.
 *
 * Note: `chainsCollection` exported here is now an alias for
 * `arcsCollection` — its row shape is `ArcSummary`, not the legacy
 * `ChainSummary`. Client subscribers reading legacy chain fields
 * (`issueNumber`, `column`, `kataMode`, etc.) will see runtime
 * undefineds; that breakage is the explicit hand-off to P1.4 (which
 * rewrites the consumers to read `ArcSummary` shape).
 */
export { arcsCollection, chainsCollection } from './arcs-collection'
