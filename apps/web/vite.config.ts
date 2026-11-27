import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig, lazyPlugins } from 'vite-plus'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  envDir: '../..',
  server: {
    port: 3000,
  },
  ssr: {
    noExternal: ['@convex-dev/better-auth'],
  },
  build: {
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (
          log.message.includes('"node:fs/promises" has been externalized') &&
          log.message.includes('fumadocs-mdx/dist/runtime/server.js')
        )
          return
        defaultHandler(level, log)
      },
      output: {
        codeSplitting: {
          groups: [{ name: 'icons', test: /[\\/]@phosphor-icons[\\/]/ }],
        },
      },
    },
  },
  plugins: lazyPlugins(() => [
    fumadocsMdx(),
    tailwindcss(),
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart(),
    viteReact(),
  ]),
})
