import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('PWA shell foundation', () => {
  describe('index.html meta tags', () => {
    const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8')

    it('includes theme-color meta tag', () => {
      expect(html).toContain('<meta name="theme-color" content="#09090b" />')
    })

    it('includes description meta tag', () => {
      expect(html).toContain(
        '<meta name="description" content="Claude Code session orchestrator" />',
      )
    })

    it('includes favicon.ico link', () => {
      expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />')
    })

    it('includes 192x192 PNG icon link', () => {
      expect(html).toContain(
        '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />',
      )
    })

    it('includes apple-touch-icon link', () => {
      expect(html).toContain(
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
      )
    })

    it('does not include manual manifest link (vite-plugin-pwa injects it)', () => {
      expect(html).not.toContain('rel="manifest"')
    })
  })

  describe('PWA icon assets', () => {
    const iconsDir = path.resolve(__dirname, '../public/icons')

    it('icon-192.png exists and is a valid PNG', () => {
      const buf = readFileSync(path.join(iconsDir, 'icon-192.png'))
      // PNG magic bytes: 137 80 78 71
      expect(buf[0]).toBe(137)
      expect(buf[1]).toBe(80)
      expect(buf[2]).toBe(78)
      expect(buf[3]).toBe(71)
    })

    it('icon-512.png exists and is a valid PNG', () => {
      const buf = readFileSync(path.join(iconsDir, 'icon-512.png'))
      expect(buf[0]).toBe(137)
      expect(buf[1]).toBe(80)
    })

    it('icon-512-maskable.png exists and is a valid PNG', () => {
      const buf = readFileSync(path.join(iconsDir, 'icon-512-maskable.png'))
      expect(buf[0]).toBe(137)
      expect(buf[1]).toBe(80)
    })
  })

  describe('vite config PWA plugin', () => {
    const configSource = readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf-8')

    it('imports VitePWA', () => {
      expect(configSource).toContain("import { VitePWA } from 'vite-plugin-pwa'")
    })

    it('uses injectManifest strategy', () => {
      expect(configSource).toContain("strategies: 'injectManifest'")
    })

    it('points to sw.ts source file', () => {
      expect(configSource).toContain("filename: 'sw.ts'")
    })

    it('uses prompt registerType (user-initiated reload)', () => {
      expect(configSource).toContain("registerType: 'prompt'")
    })

    it('configures standalone display mode', () => {
      expect(configSource).toContain("display: 'standalone'")
    })

    it('includes all three icon sizes', () => {
      expect(configSource).toContain('icon-192.png')
      expect(configSource).toContain('icon-512.png')
      expect(configSource).toContain('icon-512-maskable.png')
    })

    it('VitePWA appears before cloudflare() in plugins array', () => {
      const vitePwaIndex = configSource.indexOf('VitePWA(')
      const cloudflareIndex = configSource.indexOf('cloudflare()')
      expect(vitePwaIndex).toBeGreaterThan(-1)
      expect(cloudflareIndex).toBeGreaterThan(-1)
      expect(vitePwaIndex).toBeLessThan(cloudflareIndex)
    })
  })
})
