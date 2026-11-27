import { isBuiltin } from 'node:module'
import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

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
