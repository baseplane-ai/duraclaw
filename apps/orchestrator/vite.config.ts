import path from 'node:path'
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import agents from 'agents/vite'

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    agents(),
    cloudflare(),
    react(),
    tailwindcss(),
  ],
})
