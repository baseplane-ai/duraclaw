#!/usr/bin/env bun
/**
 * GH#122 P1.1 — Post-migration backfill of `projects.projectId`.
 *
 * Reads every projectMetadata row with non-null originUrl, computes
 * `projectId = await deriveProjectId(originUrl)`, and UPDATEs the
 * matching `projects` row (matched by projects.name = projectMetadata.projectName).
 *
 * Idempotent: re-running on already-populated rows produces the same
 * UPDATE statements with the same values (no-op semantically).
 *
 * Usage:
 *   pnpm backfill:project-ids                   # apply against the configured D1 (local)
 *   pnpm backfill:project-ids -- --dry-run      # print SQL without executing
 *   pnpm backfill:project-ids -- --remote       # target remote D1 (default: local)
 */

import { spawnSync } from 'node:child_process'
import { deriveProjectId } from '../packages/shared-types/src/entity-id'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const remote = args.has('--remote')
const dbName = process.env.D1_DB ?? 'duraclaw-auth'
const orchDir = `${import.meta.dir}/../apps/orchestrator`

function d1Exec(sql: string): { stdout: string; ok: boolean } {
  const flags = ['d1', 'execute', dbName, '--json', '--command', sql]
  if (remote) flags.push('--remote')
  else flags.push('--local')
  const out = spawnSync('npx', ['wrangler', ...flags], { cwd: orchDir, encoding: 'utf8' })
  return { stdout: out.stdout, ok: out.status === 0 }
}

function parseRows<T>(stdout: string): T[] {
  // wrangler --json wraps results in an array of {results: [...], success, meta}
  const parsed = JSON.parse(stdout)
  return parsed[0]?.results ?? []
}

async function main() {
  const sel = d1Exec(
    'SELECT projectId, projectName, originUrl FROM projectMetadata WHERE originUrl IS NOT NULL',
  )
  if (!sel.ok) {
    console.error('SELECT failed:', sel.stdout)
    process.exit(1)
  }
  const rows = parseRows<{ projectId: string; projectName: string; originUrl: string }>(sel.stdout)
  console.log(`Found ${rows.length} projectMetadata rows with originUrl`)

  let applied = 0
  for (const r of rows) {
    const computedId = await deriveProjectId(r.originUrl)
    if (computedId !== r.projectId) {
      // projectMetadata.projectId disagrees with sha256(originUrl) — log and skip.
      console.warn(
        `SKIP ${r.projectName}: projectMetadata.projectId=${r.projectId} but sha256(originUrl)=${computedId}`,
      )
      continue
    }
    const sql = `UPDATE projects SET projectId='${computedId}' WHERE name='${r.projectName.replace(/'/g, "''")}'`
    if (dryRun) {
      console.log(sql)
    } else {
      const res = d1Exec(sql)
      if (!res.ok) {
        console.error(`UPDATE failed for ${r.projectName}:`, res.stdout)
        continue
      }
      applied += 1
      console.log(`OK ${r.projectName} -> ${computedId}`)
    }
  }
  console.log(`${dryRun ? 'Would update' : 'Updated'} ${applied}/${rows.length} rows`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
