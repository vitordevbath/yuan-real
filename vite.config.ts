import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['yuan-real.svg'],
      manifest: {
        name: 'Yuan Real',
        short_name: 'Yuan Real',
        description: 'Conversor entre Yuan Chinês e Real Brasileiro com referência PTAX do Banco Central.',
        lang: 'pt-BR',
        theme_color: '#101110',
        background_color: '#101110',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: []
      }
    })
  ],
  test: {
    environment: 'node'
  }
})
