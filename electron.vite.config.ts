import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react(), {
      name: 'development-csp', apply: 'serve',
      transformIndexHtml: html => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
    }],
    build: { minify: 'esbuild' }
  }
})
