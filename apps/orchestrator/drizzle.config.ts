import type { Config } from 'drizzle-kit'

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
