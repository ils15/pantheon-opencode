import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Seed an offline runtime whose interpreter passes the installer's health probes. */
export function seedHealthyRuntime(target) {
  const bin = join(target, '.venv', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'python3'),
    `#!/bin/sh
if [ "$1" = "-c" ]; then
  case "$2" in
    *FTS5=True*) printf 'SQLite 3.40.1 FTS5=True\\n' ;;
    *FastMCP*) printf 'mcp=2.2.0 fastmcp=4.1.2 fastmcp.server.app\\n' ;;
    *pantheon_home*) printf '/tmp/pantheon-test-home\\n' ;;
  esac
fi
exit 0
`,
    { mode: 0o755 },
  )
  writeFileSync(join(bin, 'pip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}
