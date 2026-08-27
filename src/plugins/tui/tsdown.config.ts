import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  entry: { tui: 'src/index.tsx', server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  define: {
    __PANTHEON_VERSION__: JSON.stringify(pkg.version),
  },
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
