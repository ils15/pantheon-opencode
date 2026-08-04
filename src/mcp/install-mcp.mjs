#!/usr/bin/env node
/**
 * Package entry point for the canonical MCP installer.
 *
 * The implementation lives in scripts/install-mcp.mjs. Keeping this file as
 * a launcher prevents the two historical catalog copies from diverging.
 */

import { fileURLToPath } from 'node:url'
import { main } from '../../scripts/install-mcp.mjs'

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
