#!/usr/bin/env node
/**
 * pantheon-init.mjs — Pantheon OpenCode CLI entry point
 *
 * Usage: npx pantheon-opencode init [options]
 *
 * Thin CLI wrapper that parses arguments and delegates to
 * installOpenCode() from scripts/install/opencode.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIRED_NODE_MAJOR = 18;
if (parseInt(process.versions.node.split('.')[0], 10) < REQUIRED_NODE_MAJOR) {
  console.error(`❌ Node.js >= ${REQUIRED_NODE_MAJOR} required (current: ${process.versions.node})`);
  process.exit(1);
}

function printUsage() {
  console.log('Pantheon OpenCode — Multi-agent orchestration platform');
  console.log('');
  console.log('Usage:');
  console.log('  npx pantheon-opencode init              # Install globally');
  console.log('  npx pantheon-opencode init --project    # Install in project');
  console.log('  npx pantheon-opencode init --dry-run    # Preview only');
  console.log('  npx pantheon-opencode init --no-mcp       # Skip MCP + venv');
  console.log('  npx pantheon-opencode init --force        # Overwrite + recreate venv');
  console.log('  npx pantheon-opencode init --doctor       # Run health check after install');
  console.log('  npx pantheon-opencode init --interactive  # Force interactive TUI mode');
  console.log('  npx pantheon-opencode init --headless     # Force non-interactive mode');
  console.log('  npx pantheon-opencode init -y             # Skip confirmations, use defaults');
  console.log('  npx pantheon-opencode --help              # Show this help');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (args.includes('--help')) { printUsage(); process.exit(0); }

  if (command === 'init' || !command) {
    const isProject = args.includes('--project');
    const isDryRun = args.includes('--dry-run');
    const skipMCP = args.includes('--no-mcp');
    const forceReinstall = args.includes('--force');
    const runDoctor = args.includes('--doctor');
    const forceInteractive = args.includes('--interactive');
    const forceHeadless = args.includes('--headless');
    const autoYes = args.includes('--yes') || args.includes('-y');

    const components = ['agents', 'skills', 'instructions', 'commands', 'plugins'];
    if (!skipMCP) components.push('runtime');

    // Version info
    let version = '?';
    try {
      const pkgPath = path.join(ROOT, 'package.json');
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '?';
    } catch { /* use default */ }

    console.log('');
    if (!forceInteractive || isDryRun) {
      console.log(`Pantheon OpenCode v${version} — ${isDryRun ? 'DRY RUN' : 'Installing...'}`);
      console.log('');
    }

    try {
      const { installOpenCode } = await import('../scripts/install/opencode.mjs');
      const target = isProject ? process.cwd() : undefined;
      await installOpenCode(target, isDryRun, forceReinstall, components, {
        interactive: forceInteractive,
        headless: forceHeadless,
        yes: autoYes,
      });
    } catch (err) {
      console.error(`❌ Installation failed: ${err.message}\n   Run with --no-mcp to skip Python dependencies:\n     npx pantheon-opencode init --no-mcp\n   Or retry with --force to recreate the venv:\n     npx pantheon-opencode init --force`);
      process.exit(1);
    }

    if (runDoctor && !isDryRun) {
      console.log('');
      console.log('  Running health check...');
      try {
        const { spawnSync } = await import('child_process');
        const doctorScript = path.join(ROOT, 'scripts', 'doctor.mjs');
        spawnSync(process.execPath, [doctorScript], { stdio: 'inherit', cwd: ROOT });
      } catch {
        console.log('  ⚠️  Could not run doctor.mjs');
      }
    }

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅ Pantheon OpenCode v${version} installed!`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('  Next steps:');
    console.log('  1. Verify installation:');
    console.log('     npx pantheon-opencode doctor');
    console.log('  2. Launch your AI coding tool (OpenCode, Claude Code, Cursor, etc.)');
    console.log('  3. Invoke agents with @agent-name in chat');
    console.log('  4. For project-local install:');
    console.log('     npx pantheon-opencode init --project');
    console.log('');

    return;
  }

  printUsage();
  process.exit(1);
}

main().catch(err => { console.error('Error:', err.stack); process.exit(1); });
