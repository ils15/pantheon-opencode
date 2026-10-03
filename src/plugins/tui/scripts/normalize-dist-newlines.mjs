import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await normalize(path)
    } else {
      const contents = await readFile(path)
      if (contents.length > 0 && contents.at(-1) !== 0x0a) {
        await writeFile(path, Buffer.concat([contents, Buffer.from('\n')]))
      }
    }
  }
}

await normalize(fileURLToPath(new URL('../dist/', import.meta.url)))
