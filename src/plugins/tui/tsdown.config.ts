import { readFileSync } from 'node:fs'
import { appendFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

async function ensureDistArtifactsEndWithNewline(): Promise<void> {
  const dist = join(__dirname, 'dist')
  const entries = await readdir(dist, { withFileTypes: true })

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async ({ name }) => {
        const path = join(dist, name)
        const contents = await readFile(path, 'utf8')
        if (!contents.endsWith('\n')) await appendFile(path, '\n')
      }),
  )
}

export default defineConfig({
  entry: { tui: 'src/index.tsx', server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  dts: {
    tsconfig: join(__dirname, 'tsconfig.build.json'),
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
    neverBundle: [/^@opencode-ai\//, /^@opentui\//, /^solid-js/],
  },
  onSuccess: ensureDistArtifactsEndWithNewline,
})
