import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { tui: 'src/index.tsx', server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  plugins: [
    solid({
      solid: {
        moduleName: '@opentui/solid',
        generate: 'universal',
      },
    }),
  ],
  deps: {
    neverBundle: [/^@opencode-ai\//, /^@opentui\//, /^solid-js/],
  },
})
