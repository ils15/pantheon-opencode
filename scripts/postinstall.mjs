#!/usr/bin/env node
/**
 * postinstall.mjs — Pantheon npm post-install hook
 *
 * Runs after `npm install` completes. Validates environment and prints
 * setup instructions. Does NOT install Pantheon platform components.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const REQUIRED_NODE_MAJOR = 18;
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);

try {
  // Validate Node.js version
  if (nodeMajor < REQUIRED_NODE_MAJOR) {
    console.error(`❌ Node.js >= ${REQUIRED_NODE_MAJOR} required (current: ${process.versions.node})`);
    process.exit(1);
  }

  // Validate js-yaml is available
  try {
    await import('js-yaml');
  } catch {
    console.warn('⚠️  js-yaml not found — run `npm install` to install dependencies');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Pantheon OpenCode — npm dependencies installed ✅');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Configure Pantheon:');
  console.log('     npm run setup');
  console.log('     # or: npx pantheon-opencode init');
  console.log('  2. Verify installation:');
  console.log('     npm run doctor');
  console.log('');
} catch (err) {
  console.error(`❌ Post-install check failed: ${err.message}`);
  process.exit(1);
}
