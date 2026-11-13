import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import fs from 'fs'

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, './package.json'), 'utf-8'))
// White-label: the PWA manifest is generated from public/brand.json (replaces the old apply-brand manifest step).
const brand = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, './public/brand.json'), 'utf-8'))
const navy: string = brand.theme?.navy ?? '#0D1B2A'

const originOf = (u?: string) => {
  try { return u ? new URL(u).origin : '' } catch { return '' }
}

/**
 * Content-Security-Policy via <meta> (built from YOUR env origins). Opt-in: set VITE_CSP=on on the build.
 * Turn it on in STAGING first and watch the browser console for "Refused to ..." before enabling in production.
 * (frame-ancestors / X-Frame-Options are sent as real headers by vercel.json — they cannot be set from a meta tag.)
 */
function cspPlugin(env: Record<string, string>): Plugin {
  const api = originOf(env.VITE_API_BASE_URL)
  const sb = originOf(env.VITE_SUPABASE_URL)
  const wss = sb.replace(/^https:/, 'wss:')
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${api}`.trim(), // api origin: plugin bundles are import()-ed from the backend
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${sb} ${api}`.trim(),
    `connect-src 'self' ${sb} ${wss} ${api}`.replace(/\s+/g, ' ').trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'cobratex-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(env.VITE_CSP === 'on' ? [cspPlugin(env)] : []),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'sw',
        filename: 'sw.ts',
        registerType: 'prompt', // the new version waits for the user (UpdateBars in src/cloud/updates.tsx)
        injectRegister: false, // src/main.tsx already registers /sw.js in production
        manifestFilename: 'manifest.webmanifest',
        manifest: {
          id: '/',
          name: `${brand.appName} | ${brand.appNameEn}`,
          short_name: brand.appName,
          description: brand.tagline || brand.appName,
          lang: 'ar',
          dir: 'rtl',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          background_color: navy,
          theme_color: navy,
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2}'],
          globIgnores: ['plugins/**'], // plugin bundles must stay updatable
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      sourcemap: false, // never ship source maps to clients (they would expose original TS sources)
      target: 'es2022',
    },
    esbuild: { legalComments: 'none' },
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
  }
})
