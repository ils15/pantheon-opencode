import { readFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

async function finalizeDistArtifacts(): Promise<void> {
  const dist = join(__dirname, 'dist')
  const entries = await readdir(dist, { withFileTypes: true })

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async ({ name }) => {
        const path = join(dist, name)
        const contents = await readFile(path, 'utf8')
        const normalized = normalizeHqtuiBundlePaths(name, contents)
        const finalContents = normalized.endsWith('\n') ? normalized : `${normalized}\n`
        if (contents !== finalContents) await writeFile(path, finalContents)
      }),
  )
}

/** Keep Rolldown's vendor source labels stable when a clean build uses a node_modules symlink. */
function normalizeHqtuiBundlePaths(name: string, contents: string): string {
  if (name === 'tui.js') {
    return contents.replace(
      /\/\/#region [^\n]*node_modules\/@profullstack\/hqtui\/dist\//g,
      '//#region ../../../node_modules/@profullstack/hqtui/dist/',
    )
  }
  if (name !== 'tui.js.map') return contents

  const map = JSON.parse(contents) as { sources?: string[]; [key: string]: unknown }
  if (!Array.isArray(map.sources)) return contents
  map.sources = map.sources.map((source) => {
    const packagePath = 'node_modules/@profullstack/hqtui/'
    const packageIndex = source.lastIndexOf(packagePath)
    return packageIndex < 0 ? source : `../../../../${source.slice(packageIndex)}`
  })
  return JSON.stringify(map)
}

export default defineConfig({
  entry: {
    tui: 'src/index.tsx',
    tui: 'src/index.tsx',
    server: 'src/server.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  dts: {
    tsconfig: join(__dirname, 'tsconfig.build.json'),
    entry: ['src/index.tsx', 'src/server.ts'],
  },
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
    neverBundle: [/^@opencode-ai\//, /^@opencode\//, /^@opentui\//, /^solid-js/],
    alwaysBundle: [/^@profullstack\/hqtui$/],
  },
  onSuccess: finalizeDistArtifacts,
})
