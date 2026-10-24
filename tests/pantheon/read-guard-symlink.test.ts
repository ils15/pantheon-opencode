/**
 * Zeus read guard — symlink resolution (#272).
 *
 * `zeusReadGuard` matches a path STRING: it is pure and synchronous and shared
 * by V1 and V2. Before this fix a path that only reaches a denied root after
 * `realpath` passed, e.g. `docs/link → ../src`, while `pantheon_bounded_read`
 * already refused the same path via `lstat` + `realpath`.
 *
 * The fix is at the CALL SITES: they pass a resolver (`createGuardPathResolver`)
 * so the guard also checks the symlink-resolved form. These tests cover
 *   - the resolver itself (relative/absolute, `..`, non-existent tail,
 *     loop → fail closed), and
 *   - the V1 registration path: the REAL plugin factory, driven through its
 *     `chat.params` + `tool.execute.before` hooks. V2's registration path is
 *     covered in plugin-v2-contract.test.ts.
 *
 * Run with: npx tsx tests/pantheon/read-guard-symlink.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { useTmpProjectDir } from './helpers/tmp-dir.ts'

// The V1 plugin's shared board persists under the RELATIVE `.pantheon/board`
// path, so isolate cwd BEFORE the plugin module (and `getSharedBoard`) loads.
const projectRoot = useTmpProjectDir('pantheon-read-guard-symlink-')

const results: { name: string; passed: boolean; error?: string }[] = []

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (error: unknown) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function main(): Promise<void> {
  // ─── Fixture: a real project tree with real symlinks ──────────────────
  // docs/link  → ../src      (escape into a DENIED root)
  // docs/self  → .           (allowed root, still readable)
  // docs/loop  → loop        (resolution failure → fail closed)
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  mkdirSync(join(projectRoot, 'src', '.pantheon'), { recursive: true })
  mkdirSync(join(projectRoot, '.pantheon'), { recursive: true })
  mkdirSync(join(projectRoot, 'memories'), { recursive: true })
  mkdirSync(join(projectRoot, 'docs'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'plugin.ts'), 'export const x = 1\n')
  writeFileSync(join(projectRoot, 'src', '.pantheon', 'secret.ts'), 'secret\n')
  writeFileSync(join(projectRoot, '.pantheon', 'routing.yml'), 'routing: true\n')
  writeFileSync(join(projectRoot, 'memories', 'notes.md'), '# notes\n')
  writeFileSync(join(projectRoot, 'docs', 'PLAN.md'), '# plan\n')
  symlinkSync('../src', join(projectRoot, 'docs', 'link'))
  symlinkSync('../src/.pantheon/secret.ts', join(projectRoot, 'docs', 'alias'))
  symlinkSync('plugin.ts', join(projectRoot, 'src', 'readme.md'))
  symlinkSync('../src/missing.ts', join(projectRoot, 'docs', 'broken'))
  symlinkSync('.', join(projectRoot, 'docs', 'self'))
  symlinkSync('loop', join(projectRoot, 'docs', 'loop'))

  const { createGuardPathResolver, resolveGuardPathForCheck } = await import(
    '../../src/pantheon/guard-path.ts'
  )
  const { zeusReadGuard } = await import('../../src/pantheon/delegation-enforce.ts')

  const resolve = createGuardPathResolver(projectRoot)
  const guard = (tool: string, args: Record<string, unknown>, agent = 'zeus') => {
    zeusReadGuard(tool, args, agent, resolve)
  }

  // ─── Resolver ────────────────────────────────────────────────────────

  await test('resolver: a link into a denied root resolves to the code root', () => {
    assert.equal(resolve('docs/link/plugin.ts').resolved, 'src/plugin.ts')
    assert.equal(resolve('docs/link/plugin.ts').failed, false)
  })

  await test('resolver: only an existing regular file inside the project is annotated safe', () => {
    const file = resolve('docs/PLAN.md')
    assert.equal(file.failed, false)
    assert.equal(file.resolved, 'docs/PLAN.md')
    assert.equal(file.isRegularFile, true)
    assert.equal(file.withinProject, true)

    for (const directory of ['.', projectRoot, '..', '/', process.cwd()]) {
      const result = resolve(directory)
      assert.equal(result.failed, false, `${directory} resolves, but is not an allowed grep target`)
      assert.equal(result.isRegularFile, false, `${directory} is a directory`)
      assert.equal(result.withinProject, directory === '.' || directory === projectRoot)
    }
  })

  await test('resolver: canonical root symlinks and sibling-prefix paths keep correct boundaries', () => {
    const prefixSibling = mkdtempSync(`${projectRoot}-sibling-`)
    const rootAlias = `${projectRoot}-alias`
    try {
      const siblingResult = resolve(prefixSibling)
      assert.equal(siblingResult.withinProject, false)
      assert.equal(siblingResult.isRegularFile, false)

      symlinkSync(projectRoot, rootAlias, 'dir')
      const resolveThroughAlias = createGuardPathResolver(rootAlias)
      const aliasFile = resolveThroughAlias('docs/PLAN.md')
      assert.equal(aliasFile.failed, false)
      assert.equal(aliasFile.resolved, 'docs/PLAN.md')
      assert.equal(aliasFile.withinProject, true)
      assert.equal(aliasFile.isRegularFile, true)
    } finally {
      rmSync(rootAlias, { force: true })
      rmSync(prefixSibling, { recursive: true, force: true })
    }
  })

  await test('resolver: a link to an allowed root stays inside the project', () => {
    assert.equal(resolve('docs/self/PLAN.md').resolved, 'docs/PLAN.md')
  })

  await test('resolver: `..` traversal resolves before matching', () => {
    // Harmless lexically (`docs/../src` does not match `^src/`), denied after
    // resolution — `..` is another spelling of the same source tree.
    assert.equal(resolve('docs/../src/plugin.ts').resolved, 'src/plugin.ts')
  })

  await test('resolver: a non-existent tail keeps its deepest existing ancestor', () => {
    const resolution = resolve('docs/link/missing/nested.ts')
    assert.equal(resolution.failed, false)
    assert.equal(resolution.resolved, 'src/missing/nested.ts')
  })

  await test('resolver: a dangling symlink is a resolution failure', () => {
    assert.equal(resolve('docs/broken').failed, true)
    assert.equal(resolve('docs/broken').resolved, undefined)
  })

  await test('resolver: a missing regular-file target is not annotated safe', () => {
    const result = resolve('docs/not-created.md')
    assert.equal(result.failed, false)
    assert.equal(result.isRegularFile, false)
  })

  await test('resolver: paths beyond 64 components fail closed', () => {
    assert.equal(resolve(Array.from({ length: 65 }, () => 'x').join('/')).failed, true)
  })

  await test('resolver: an absolute path is resolved too', () => {
    assert.equal(
      resolveGuardPathForCheck(join(projectRoot, 'docs', 'link', 'plugin.ts'), projectRoot)
        .resolved,
      'src/plugin.ts',
    )
  })

  await test('resolver: a symlink loop is a resolution failure, not a path', () => {
    assert.equal(resolve('docs/loop').failed, true)
    assert.equal(resolve('docs/loop/x.ts').failed, true)
  })

  // ─── Pure predicate, unchanged for three-argument callers ─────────────

  await test('pure predicate: without a resolver the string form is all that is checked', () => {
    // This is the pre-#272 behaviour the guard MUST keep when no resolver is
    // supplied: non-Zeus agents and three-argument callers depend on it. The
    // hole is closed where it belongs — at the call sites below.
    zeusReadGuard('read', { filePath: 'docs/link/plugin.ts' }, 'zeus')
  })

  // ─── Guard + resolver: read / glob / grep ─────────────────────────────

  await test('guard: Zeus is denied `read` through a link into src/', () => {
    assert.throws(() => guard('read', { filePath: 'docs/link/plugin.ts' }), /delegate to @apollo/)
  })

  await test('guard: an allowed suffix on a symlink into source does not bypass resolution', () => {
    assert.throws(() => guard('read', { filePath: 'src/readme.md' }), /delegate to @apollo/)
  })

  await test('guard: nested src/.pantheon is denied while project-root exceptions remain readable', () => {
    assert.throws(
      () => guard('read', { filePath: 'src/.pantheon/secret.ts' }),
      /delegate to @apollo/,
    )
    assert.throws(() => guard('read', { filePath: 'docs/alias' }), /delegate to @apollo/)
    guard('read', { filePath: '.pantheon/routing.yml' })
    guard('read', { filePath: 'memories/notes.md' })
  })

  await test('guard: Zeus is denied `glob` through a link into src/', () => {
    assert.throws(() => guard('glob', { pattern: 'docs/link/**/*.ts' }), /delegate to @apollo/)
  })

  await test('guard: glob patterns with wildcard traversal fail closed, docs exact paths remain safe', () => {
    for (const pattern of ['**/*.ts', '*/*/*.ts', 'docs/*/**/*.ts']) {
      assert.throws(() => guard('glob', { pattern }), /delegate to @apollo/, pattern)
    }
    guard('glob', { pattern: 'docs/PLAN.md' })
  })

  await test('guard: direct grep/glob path arguments resolve before exceptions', () => {
    assert.throws(
      () => guard('grep', { path: 'docs/alias', pattern: 'secret' }),
      /delegate to @apollo/,
    )
    assert.throws(
      () => guard('glob', { path: 'docs/alias', pattern: 'docs/PLAN.md' }),
      /delegate to @apollo/,
    )
  })

  await test('guard: Zeus is denied `grep` whose path is a link into src/', () => {
    assert.throws(
      () => guard('grep', { path: 'docs/link', pattern: 'TODO' }),
      /delegate to @apollo/,
    )
  })

  await test('guard: Zeus grep denies project, ancestor, root, and outside directories', () => {
    for (const path of ['.', projectRoot, '..', '/', process.cwd()]) {
      assert.throws(() => guard('grep', { path, pattern: 'TODO' }), /delegate to @apollo/, path)
    }
  })

  await test('guard: an absolute link target outside the project is denied', () => {
    assert.throws(
      () => guard('read', { filePath: join(projectRoot, 'docs', 'link', 'plugin.ts') }),
      /delegate to @apollo/,
    )
  })

  await test('guard: a non-existent path under a link into src/ is denied', () => {
    assert.throws(
      () => guard('read', { filePath: 'docs/link/missing/nested.ts' }),
      /delegate to @apollo/,
    )
  })

  await test('guard: an unresolvable path (symlink loop) is denied, not allowed', () => {
    assert.throws(() => guard('read', { filePath: 'docs/loop/x.ts' }), /delegate to @apollo/)
  })

  await test('guard: a dangling symlink is denied while a missing source path stays denied', () => {
    assert.throws(() => guard('read', { filePath: 'docs/broken' }), /delegate to @apollo/)
    assert.throws(() => guard('read', { filePath: 'src/not-present.ts' }), /delegate to @apollo/)
  })

  await test('guard: a link to an ALLOWED root is still readable', () => {
    guard('read', { filePath: 'docs/self/PLAN.md' })
    guard('grep', { path: 'docs/self/PLAN.md', pattern: 'plan' })
  })

  await test('guard: a non-Zeus agent is unaffected by symlink resolution', () => {
    for (const agent of ['hermes', 'apollo', undefined]) {
      zeusReadGuard('read', { filePath: 'docs/link/plugin.ts' }, agent, resolve)
    }
  })

  // ─── V1 registration path (the real plugin factory) ──────────────────

  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const { default: plugin } = await import('../../src/plugin.ts')
  const client = {
    session: {
      list: async () => ({ data: [], error: undefined }),
      todo: async () => ({ data: [], error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
      children: async () => ({ data: [], error: undefined }),
      create: async () => ({ data: { id: 'child' }, error: undefined }),
      promptAsync: async () => ({ data: {}, error: undefined }),
    },
  }
  const hooks = (await plugin({
    client,
    directory: projectRoot,
    worktree: projectRoot,
  } as never)) as unknown as {
    'chat.params': (input: { sessionID: string; agent: string }) => Promise<void>
    'tool.execute.before': (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => Promise<void>
  }

  const sessionID = `ses-read-guard-symlink-${Date.now()}`

  /** Drive V1's chain and return the denial message, if any. */
  const denial = async (tool: string, args: Record<string, unknown>): Promise<string | null> => {
    try {
      await hooks['tool.execute.before']({ tool, sessionID, callID: `call-${tool}` }, { args })
      return null
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  await test('V1 path: Zeus is denied symlinks and allowed-suffix aliases into src/', async () => {
    await hooks['chat.params']({ sessionID, agent: 'zeus' })
    for (const [tool, args] of [
      ['read', { filePath: 'docs/link/plugin.ts' }],
      ['read', { filePath: 'src/readme.md' }],
      ['glob', { pattern: 'docs/link/**/*.ts' }],
      ['grep', { path: 'docs/link', pattern: 'TODO' }],
      ['read', { filePath: 'src/.pantheon/secret.ts' }],
      ['read', { filePath: 'docs/alias' }],
      ['grep', { path: 'docs/alias', pattern: 'secret' }],
      ['glob', { path: 'docs/alias', pattern: 'docs/PLAN.md' }],
    ] as const) {
      const message = await denial(tool, args)
      assert.ok(message !== null, `Zeus must not ${tool} through docs/link — delegate to @apollo`)
      assert.match(message, /delegate to @apollo/)
    }
  })

  await test('V1 path: wildcard globs fail closed while exact docs paths remain readable', async () => {
    await hooks['chat.params']({ sessionID, agent: 'zeus' })
    for (const pattern of ['**/*.ts', '*/*/*.ts', 'docs/*/**/*.ts']) {
      const message = await denial('glob', { pattern })
      assert.ok(message !== null, `wildcard glob ${pattern} must be denied`)
      assert.match(message, /delegate to @apollo/)
    }
    assert.equal(await denial('glob', { pattern: 'docs/PLAN.md' }), null)
    assert.equal(await denial('read', { filePath: '.pantheon/routing.yml' }), null)
    assert.equal(await denial('read', { filePath: 'memories/notes.md' }), null)
  })

  await test('V1 path: Zeus grep requires an explicit path and rejects all include filters', async () => {
    await hooks['chat.params']({ sessionID, agent: 'zeus' })
    for (const args of [
      { pattern: 'secret' },
      { path: '', pattern: 'secret' },
      { path: '..', pattern: 'secret' },
      { path: 'docs/PLAN.md', pattern: 'secret', include: 'plugin.ts' },
    ]) {
      const message = await denial('grep', args)
      assert.ok(message !== null, `Zeus grep must deny ${JSON.stringify(args)}`)
      assert.match(message, /delegate to @apollo/)
    }

    assert.equal(
      await denial('grep', { path: 'docs/PLAN.md', pattern: 'secret' }),
      null,
      'an exact docs path with an ordinary query remains readable',
    )

    await hooks['chat.params']({ sessionID, agent: 'hermes' })
    assert.equal(
      await denial('grep', { pattern: 'secret' }),
      null,
      'non-Zeus grep without a path remains unchanged',
    )
    assert.equal(
      await denial('grep', { path: '..', pattern: 'secret' }),
      null,
      'non-Zeus grep with a parent path remains unchanged',
    )
    await hooks['chat.params']({ sessionID, agent: 'zeus' })
  })

  await test('V1 path: a non-existent tail, dangling symlink, and loop are denied', async () => {
    for (const args of [
      { filePath: 'docs/link/missing/nested.ts' },
      { filePath: 'docs/broken' },
      { filePath: 'src/not-present.ts' },
      { filePath: 'docs/loop/x.ts' },
    ]) {
      const message = await denial('read', args)
      assert.ok(message !== null, `${JSON.stringify(args)} must be denied`)
      assert.match(message, /delegate to @apollo/)
    }
  })

  await test('V1 path: a link to an allowed root is readable and non-Zeus is unaffected', async () => {
    assert.equal(await denial('read', { filePath: 'docs/self/PLAN.md' }), null)
    assert.equal(await denial('glob', { pattern: 'docs/PLAN.md' }), null)
    await hooks['chat.params']({ sessionID, agent: 'hermes' })
    assert.equal(await denial('read', { filePath: 'docs/link/plugin.ts' }), null)
  })

  // ─── Summary ─────────────────────────────────────────────────────────

  const failed = results.filter((result) => !result.passed)
  console.log('')
  for (const result of results) {
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`,
    )
  }
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`)
}

try {
  await main()
} finally {
  rmSync(projectRoot, { recursive: true, force: true })
}

if (results.some((result) => !result.passed)) process.exitCode = 1
