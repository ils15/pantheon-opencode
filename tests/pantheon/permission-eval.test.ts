/**
 * Tests for S1 — Deny-first permission evaluation + PreToolUse-style hooks.
 *
 * permission-eval.ts provides:
 *   - Deny-first evaluation: deny rules checked BEFORE allow rules
 *   - User-deny overrides project-allow: user-level denies cannot be overridden
 *   - PreToolUse hook exit-code semantics: exit 0 → allow, exit 2 → hard deny
 *   - Hook failure modes: missing hook → fail-open, timeout → fail-open
 *   - Config schema: permission.deny[], permission.allow[], permission.hooks
 *
 * Run with: npx tsx tests/pantheon/permission-eval.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  evaluatePermission,
  evaluatePermissionAsync,
  type PermissionConfig,
  type PermissionLevel,
  type PermissionResult,
  type PreToolUseHook,
} from '../../src/pantheon/permission-eval.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

// ─── Config fixtures ───────────────────────────────────────────────────

const EMPTY_CONFIG: PermissionConfig = { deny: [], allow: [] }

const _DENY_FORCE_PUSH: PermissionConfig = {
  deny: ['git push --force:*'],
  allow: [],
}

const DENY_ALL_BASH: PermissionConfig = {
  deny: ['bash(rm -rf *)', 'git push --force:*'],
  allow: ['read:./**'],
}

const _USER_DENY_OVERRIDE: PermissionConfig = {
  deny: ['git push:*'], // user-level deny
  allow: ['git push:origin/**'], // project-level allow
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── (1) Deny-first evaluation ──────────────────────────────────────
  await testAsync('(1) deny-first: deny rules checked before allow', async () => {
    const config: PermissionConfig = {
      deny: ['bash:*'],
      allow: ['bash:echo *'],
    }
    // Even though allow matches, deny was checked first and matched
    const result = evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, false, 'deny matches first → blocked')
    assert.equal(result.reason, 'deny', 'reason should be deny')
  })

  await testAsync('(1b) deny-first: allow when no deny matches', async () => {
    const config: PermissionConfig = {
      deny: ['git push:*'],
      allow: ['bash:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, true, 'no deny match → allow')
    assert.equal(result.reason, 'allow', 'reason should be allow')
  })

  // ── (2) User-deny overrides project-allow ──────────────────────────
  await testAsync('(2) user-deny overrides project-allow', async () => {
    const config: PermissionConfig = {
      deny: ['git push:*'], // user-level
      allow: ['git push:origin/**'], // project-level
    }
    const result = evaluatePermission(config, {
      tool: 'git',
      args: { command: 'push origin main' },
    })
    assert.equal(result.allowed, false, 'user deny cannot be overridden')
    assert.equal(result.reason, 'deny', 'reason should be deny')
  })

  await testAsync('(2b) project-allow when user-deny does not match', async () => {
    const config: PermissionConfig = {
      deny: ['git push:*'],
      allow: ['git:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'git',
      args: { command: 'pull origin main' },
    })
    assert.equal(result.allowed, true, 'deny does not match → allow')
  })

  // ── (3) Config schema: tool:pattern matching ───────────────────────
  await testAsync('(3a) tool:pattern format — deny matches', async () => {
    const result = evaluatePermission(DENY_ALL_BASH, {
      tool: 'bash',
      args: { command: 'rm -rf /tmp/test' },
    })
    assert.equal(result.allowed, false, 'bash(rm -rf:*) matches')
  })

  await testAsync('(3b) tool:pattern format — allow matches', async () => {
    const result = evaluatePermission(DENY_ALL_BASH, {
      tool: 'read',
      args: { filePath: './src/index.ts' },
    })
    assert.equal(result.allowed, true, 'read:./** matches')
  })

  await testAsync('(3c) no match → deny by default (implicit deny)', async () => {
    const result = evaluatePermission(DENY_ALL_BASH, {
      tool: 'edit',
      args: { filePath: './src/index.ts' },
    })
    assert.equal(result.allowed, false, 'no allow rule matches → denied')
  })

  await testAsync('(3d) empty config → deny all', async () => {
    const result = evaluatePermission(EMPTY_CONFIG, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, false, 'empty config → deny all')
  })

  // ── (4) PreToolUse hook exit-code semantics ────────────────────────
  await testAsync('(4a) hook exit 0 → allow', async () => {
    const hook: PreToolUseHook = async () => ({ code: 0, stdout: '', stderr: '' })
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, true, 'hook exit 0 → allow')
  })

  await testAsync('(4b) hook exit 2 → hard deny (cannot be overridden)', async () => {
    const hook: PreToolUseHook = async () => ({
      code: 2,
      stdout: '',
      stderr: 'unsafe command',
    })
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, false, 'hook exit 2 → hard deny')
    assert.equal(result.reason, 'hook_deny', 'reason should be hook_deny')
  })

  await testAsync('(4c) hook exit 2 blocks even when allow matches', async () => {
    const hook: PreToolUseHook = async () => ({
      code: 2,
      stdout: '',
      stderr: 'blocked by policy',
    })
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'ls' },
    })
    assert.equal(result.allowed, false, 'hook exit 2 overrides allow')
    assert.equal(result.reason, 'hook_deny', 'reason is hook_deny')
  })

  await testAsync('(4d) hook exit 1 → deny (soft block)', async () => {
    const hook: PreToolUseHook = async () => ({
      code: 1,
      stdout: '',
      stderr: 'warning: suspicious',
    })
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'echo test' },
    })
    assert.equal(result.allowed, false, 'hook exit 1 → deny')
    assert.equal(result.reason, 'hook_deny', 'reason should be hook_deny')
  })

  // ── (5) Missing hook → fail-open ───────────────────────────────────
  await testAsync('(5) missing hook script → fail-open (allow)', async () => {
    const hook: PreToolUseHook = async () => ({
      code: 1,
      stdout: '',
      stderr: 'No such file or directory',
      missing: true,
    })
    // Simulate missing hook by returning non-zero with ENOENT-like stderr
    // The permission evaluator should treat this as fail-open
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'ls' },
    })
    // Missing hook = fail-open, so even though hook returns exit 1,
    // the permission check falls through to the allow/deny config
    assert.equal(result.allowed, true, 'missing hook → fail-open → allow from config')
  })

  await testAsync('(5b) hook throw → fail-open', async () => {
    const hook: PreToolUseHook = async () => {
      throw new Error('ENOENT: no such file')
    }
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    const result = await evaluatePermissionAsync(config, {
      tool: 'bash',
      args: { command: 'ls' },
    })
    assert.equal(result.allowed, true, 'hook throw → fail-open → allow from config')
  })

  // ── (6) Order: deny check → hook check ─────────────────────────────
  await testAsync('(6) deny blocks before hook runs', async () => {
    let hookCalled = false
    const hook: PreToolUseHook = async () => {
      hookCalled = true
      return { code: 0, stdout: '', stderr: '' }
    }
    const config: PermissionConfig = {
      deny: ['bash:*'],
      allow: [],
      hooks: { preToolUse: hook },
    }
    const result = evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'echo test' },
    })
    assert.equal(result.allowed, false, 'deny blocks before hook')
    assert.equal(hookCalled, false, 'hook should not run when deny matches')
  })

  // ── (7) No hooks configured → pure config evaluation ───────────────
  await testAsync('(7) no hooks → config-only evaluation', async () => {
    const config: PermissionConfig = {
      deny: [],
      allow: ['read:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'read',
      args: { filePath: './anything' },
    })
    assert.equal(result.allowed, true, 'no hooks → config result')
  })

  // ── (8) Wildcard deny ──────────────────────────────────────────────
  await testAsync('(8) wildcard deny blocks all tools', async () => {
    const config: PermissionConfig = {
      deny: ['*:'],
      allow: ['read:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'read',
      args: { filePath: './anything' },
    })
    assert.equal(result.allowed, false, 'wildcard deny blocks everything')
  })

  // ── (9) Pattern matching on args ───────────────────────────────────
  await testAsync('(9a) deny pattern matches tool+args combo', async () => {
    const config: PermissionConfig = {
      deny: ['bash(rm -rf *)'],
      allow: ['bash:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'rm -rf /tmp' },
    })
    assert.equal(result.allowed, false, 'bash(rm -rf:*) matches')
  })

  await testAsync('(9b) deny pattern does not match different args', async () => {
    const config: PermissionConfig = {
      deny: ['bash(rm -rf *)'],
      allow: ['bash:*'],
    }
    const result = evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'echo hello' },
    })
    assert.equal(result.allowed, true, 'bash(rm -rf:*) does not match echo')
  })

  // ── (10) Hook gets tool info ───────────────────────────────────────
  await testAsync('(10) hook receives tool name and args', async () => {
    let receivedTool = ''
    let receivedArgs: unknown = null
    const hook: PreToolUseHook = async (tool, args) => {
      receivedTool = tool
      receivedArgs = args
      return { code: 0, stdout: '', stderr: '' }
    }
    const config: PermissionConfig = {
      deny: [],
      allow: ['bash:*'],
      hooks: { preToolUse: hook },
    }
    evaluatePermission(config, {
      tool: 'bash',
      args: { command: 'ls -la' },
    })
    assert.equal(receivedTool, 'bash', 'hook receives tool name')
    assert.deepEqual(receivedArgs, { command: 'ls -la' }, 'hook receives args')
  })

  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
