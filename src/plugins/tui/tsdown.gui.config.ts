import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

const GUI_EXTERNALS = new Set([
  'electron',
  'effect',
  'solid-js',
  'solid-js/web',
  'solid-js/store',
  '@opencode/plugin/gui',
  '@opencode/plugin/gui/main',
  '@opencode/plugin/gui/file',
  '@opencode/plugin/gui/review',
  '@opencode/plugin/gui/browser',
  '@opencode/plugin/rpc',
  '@opencode/schema/rpc',
  '@opencode/client',
  '@opencode/client/effect',
  '@opencode/client/solid',
])

export default defineConfig({
  entry: {
    'gui-experimental': 'src/gui.tsx',
  },
  format: ['cjs'],
  platform: 'node',
  outDir: 'dist',
  clean: false,
  outExtensions: () => ({ js: '.cjs' }),
  dts: false,
  target: 'node26.3.0',
  define: {
    __PANTHEON_VERSION__: JSON.stringify(pkg.version),
  },
  deps: {
    neverBundle: (id) =>
      GUI_EXTERNALS.has(id) ||
      isBuiltin(id) ||
      id.startsWith('@opencode/plugin/') ||
      id === '@opencode/client' ||
      id.startsWith('@opencode/client/') ||
      id.startsWith('@opencode/schema/'),
  },
  plugins: [
    solid({
      solid: {
        generate: 'dom',
        hydratable: false,
      },
    }),
  ],
})
