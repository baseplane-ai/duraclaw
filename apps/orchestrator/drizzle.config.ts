import type { Config } from 'drizzle-kit'

// NOTE: migrations/meta/_journal.json intentionally contains only the idx-8
// entry (0008_replace_user_preferences). Migrations 0001–0007 predate the
// drizzle-kit-managed journal and were applied via wrangler before the
// schema was tracked here; D1 records applied migrations independently in
// its own `d1_migrations` table, and drizzle-kit's `generate`/`check`
// commands only diff against the latest snapshot (0008_snapshot.json),
// which already reflects the full live schema. Verified with
// `drizzle-kit check` (clean) and `drizzle-kit generate` (no schema
// changes). Do not back-fill 0001–0007 into the journal — doing so would
// cause drizzle-kit to attempt to re-apply them on fresh environments.
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: 'c5b4d822-9bc6-467f-9ad6-7ee779b82e0c',
    token: process.env.CLOUDFLARE_API_TOKEN!,
  },
} satisfies Config
