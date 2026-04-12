import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Env } from './types'

// ── D1 migration SQL validation ────────────────────────────────────

const migrationsDir = resolve(__dirname, '../../migrations')

function readMigration(filename: string): string {
  return readFileSync(resolve(migrationsDir, filename), 'utf-8')
}

describe('migration 0002_push_subscriptions', () => {
  const sql = readMigration('0002_push_subscriptions.sql')

  it('creates push_subscriptions table', () => {
    expect(sql).toContain('CREATE TABLE push_subscriptions')
  })

  it('has required columns', () => {
    expect(sql).toContain('id TEXT PRIMARY KEY')
    expect(sql).toContain('user_id TEXT NOT NULL')
    expect(sql).toContain('endpoint TEXT NOT NULL')
    expect(sql).toContain('p256dh TEXT NOT NULL')
    expect(sql).toContain('auth TEXT NOT NULL')
    expect(sql).toContain('user_agent TEXT')
    expect(sql).toContain('created_at TEXT NOT NULL')
  })

  it('has foreign key to users table', () => {
    expect(sql).toContain('REFERENCES users(id) ON DELETE CASCADE')
  })

  it('has unique constraint on user_id + endpoint', () => {
    expect(sql).toContain('UNIQUE(user_id, endpoint)')
  })

  it('defaults created_at to current datetime', () => {
    expect(sql).toContain("DEFAULT (datetime('now'))")
  })
})

describe('migration 0003_user_preferences', () => {
  const sql = readMigration('0003_user_preferences.sql')

  it('creates user_preferences table', () => {
    expect(sql).toContain('CREATE TABLE user_preferences')
  })

  it('has required columns', () => {
    expect(sql).toContain('user_id TEXT NOT NULL')
    expect(sql).toContain('key TEXT NOT NULL')
    expect(sql).toContain('value TEXT NOT NULL')
  })

  it('has composite primary key', () => {
    expect(sql).toContain('PRIMARY KEY (user_id, key)')
  })

  it('has foreign key to users table', () => {
    expect(sql).toContain('REFERENCES users(id) ON DELETE CASCADE')
  })
})

// ── Env type VAPID fields ──────────────────────────────────────────

describe('Env type VAPID fields', () => {
  it('accepts VAPID configuration', () => {
    // Type-level test: verify that VAPID fields exist on Env
    // and are optional (assignable from undefined)
    const partial: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'> = {
      VAPID_PUBLIC_KEY: undefined,
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: undefined,
    }
    expect(partial).toBeDefined()
  })

  it('accepts string values for VAPID fields', () => {
    const configured: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'> = {
      VAPID_PUBLIC_KEY: 'BDUVby4yhIjpZdTQ...',
      VAPID_PRIVATE_KEY: 'zSnqI5SYGfiQvyIS...',
      VAPID_SUBJECT: 'mailto:push@example.com',
    }
    expect(configured.VAPID_PUBLIC_KEY).toBe('BDUVby4yhIjpZdTQ...')
    expect(configured.VAPID_PRIVATE_KEY).toBe('zSnqI5SYGfiQvyIS...')
    expect(configured.VAPID_SUBJECT).toBe('mailto:push@example.com')
  })
})
