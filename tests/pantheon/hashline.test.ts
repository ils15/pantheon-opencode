/**
 * Tests for Hashline (Wave 2, PR #46) — hash-anchored edits.
 *
 * The read tool's output is augmented with per-line sha256-truncated tags
 * (`12#XJ|content`); a structural `hashline_edit` tool anchors edits to those
 * tags instead of fragile line numbers. ALL refs are validated against the
 * ORIGINAL snapshot before any write, applied bottom-up, and mismatches
 * return an error-as-text with a re-tagged excerpt + Did-you-mean — never a
 * partial write.
 *
 * Pure Node runtime (node:crypto) — no opencode SDK needed. Covers:
 *   - hashTag seeding rules (alnum → content tag; blank/symbol → lineNumber)
 *   - formatTaggedLine / isTaggedLine idempotency
 *   - read-enhancer transform (both prefix formats, truncation, idempotency)
 *   - ref regex validation
 *   - all four edit ops + bottom-up snapshot resolution + mismatch safety
 *   - enforcement: hashline_edit denied in read-only sessions
 *   - golden sanity: sha256 tag stable across runs
 *
 * Run with: npx tsx tests/pantheon/hashline.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createEnforcementGuard,
  DEFAULT_BLOCKED_TOOLS,
  readOnlyRegistry,
} from '../../src/pantheon/delegation-enforce.ts'
import {
  buildMismatchError,
  formatTaggedLine,
  HASHLINE_REF_RE,
  isTaggedLine,
  suggestLineForHash,
} from '../../src/pantheon/hashline/core.ts'
import { createReadEnhancer } from '../../src/pantheon/hashline/read-enhancer.ts'
import { createHashlineEditTool } from '../../src/pantheon/hashline/tool.ts'
import { HASHLINE_DICT, hashTag } from '../../src/pantheon/hashline/xxhash.ts'

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

const CTX = { sessionID: 'ses_hl', directory: '/tmp', worktree: '/tmp', agent: 'zeus' }

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── hashTag: seeding + determinism ───────────────────────────────────
  await testAsync(
    'hashTag: alnum line → deterministic content-only tag (same content = same tag)',
    async () => {
      const a = hashTag('const x = 1', 3)
      const b = hashTag('const x = 1', 99)
      assert.equal(a, b, 'alnum lines use seed 0 → tag independent of line number')
      assert.equal(hashTag('const x = 1', 3), a, 'repeated call is deterministic')
      assert.equal(a.length, 2, 'tag is exactly 2 chars')
    },
  )

  await testAsync('hashTag: blank lines get distinct tags (seed = lineNumber)', async () => {
    assert.notEqual(hashTag('', 2), hashTag('', 5), 'blank lines must not collide')
    assert.notEqual(
      hashTag('   ', 1),
      hashTag('', 4),
      'whitespace-only lines seed by line number too',
    )
  })

  await testAsync('hashTag: symbol-only lines get distinct tags (seed = lineNumber)', async () => {
    assert.notEqual(hashTag('---', 1), hashTag('---', 7), 'symbol lines must not collide')
  })

  await testAsync('hashTag: tag chars come from HASHLINE_DICT (16-char alphabet)', async () => {
    for (const c of hashTag('any content', 1)) {
      assert.ok(HASHLINE_DICT.includes(c), `char ${c} must be in the hashline alphabet`)
    }
    assert.equal(HASHLINE_DICT.length, 16)
    assert.equal(new Set(HASHLINE_DICT.split('')).size, 16, 'alphabet has no duplicates')
  })

  // ── formatTaggedLine / isTaggedLine ──────────────────────────────────
  await testAsync('formatTaggedLine + isTaggedLine: format and idempotency', async () => {
    const tagged = formatTaggedLine(12, 'export const y = 2')
    assert.equal(tagged, `12#${hashTag('export const y = 2', 12)}|export const y = 2`)
    assert.equal(isTaggedLine(tagged), true)
    assert.equal(isTaggedLine('12: not tagged'), false)
    assert.equal(isTaggedLine('12| also not tagged'), false)
  })

  // ── read-enhancer ────────────────────────────────────────────────────
  await testAsync('read-enhancer: colon prefix (N: content) gets tagged', async () => {
    const enhancer = createReadEnhancer()
    const out = { title: 'read', output: '   1: first line\n  12: second line\n', metadata: {} }
    await enhancer({ tool: 'read', sessionID: 's', callID: 'c', args: {} }, out)
    assert.equal(
      out.output,
      `1#${hashTag('first line', 1)}|first line\n12#${hashTag('second line', 12)}|second line\n`,
    )
  })

  await testAsync('read-enhancer: pipe prefix (N| content) gets tagged', async () => {
    const enhancer = createReadEnhancer()
    const out = { title: 'read', output: '1|alpha\n2| beta\n', metadata: {} }
    await enhancer({ tool: 'read', sessionID: 's', callID: 'c', args: {} }, out)
    assert.equal(out.output, `1#${hashTag('alpha', 1)}|alpha\n2#${hashTag('beta', 2)}|beta\n`)
  })

  await testAsync('read-enhancer: truncated/skip lines are left untouched', async () => {
    const enhancer = createReadEnhancer()
    const raw = '1|kept\n... 500 more lines\n2|also kept\n'
    const out = { title: 'read', output: raw, metadata: {} }
    await enhancer({ tool: 'read', sessionID: 's', callID: 'c', args: {} }, out)
    assert.ok(out.output.includes('... 500 more lines'), 'truncation marker must survive')
    assert.ok(out.output.includes(`1#${hashTag('kept', 1)}|kept`))
    assert.ok(out.output.includes(`2#${hashTag('also kept', 2)}|also kept`))
  })

  await testAsync('read-enhancer: already-tagged lines are skipped (idempotent)', async () => {
    const enhancer = createReadEnhancer()
    const tagged = `12#${hashTag('x', 12)}|x`
    const out = { title: 'read', output: `${tagged}\n`, metadata: {} }
    await enhancer({ tool: 'read', sessionID: 's', callID: 'c', args: {} }, out)
    assert.equal(out.output, `${tagged}\n`, 'tagged line must not be re-tagged')
  })

  await testAsync('read-enhancer: non-read tools are untouched', async () => {
    const enhancer = createReadEnhancer()
    const raw = '1: untouched\n'
    const out = { title: 'webfetch', output: raw, metadata: {} }
    await enhancer({ tool: 'webfetch', sessionID: 's', callID: 'c', args: {} }, out)
    assert.equal(out.output, raw, 'webfetch output must pass through unchanged')
  })

  // ── ref regex ────────────────────────────────────────────────────────
  await testAsync(
    'ref regex: accepts "12#XJ", rejects lowercase/off-alphabet/1-char/3-char',
    async () => {
      const m = HASHLINE_REF_RE.exec('12#XJ')
      assert.ok(m, 'valid ref must match')
      assert.equal(m[1], '12')
      assert.equal(m[2], 'XJ')
      for (const bad of ['12#xj', '12#AA', '12#Z', '12#ZPM', 'x#XJ', '12#XJ ', '12#XJ|']) {
        assert.ok(!HASHLINE_REF_RE.test(bad), `"${bad}" must be rejected`)
      }
    },
  )

  // ── tool ops ─────────────────────────────────────────────────────────
  await testAsync(
    'tool: replace/append/prepend/delete apply on tmp files with metadata',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'hashline-ops-'))
      try {
        const file = join(tmp, 'ops.txt')
        writeFileSync(file, 'a\nb\nc\nd\n')
        const tool = createHashlineEditTool()
        const res = await tool.execute(
          {
            file,
            edits: [
              { op: 'append', ref: `2#${hashTag('b', 2)}`, content: 'X' },
              { op: 'prepend', ref: `4#${hashTag('d', 4)}`, content: 'Y' },
              { op: 'replace', ref: `1#${hashTag('a', 1)}`, lines: ['A1', 'A2'] },
              { op: 'delete', ref: `3#${hashTag('c', 3)}` },
            ],
          },
          CTX,
        )
        assert.equal(readFileSync(file, 'utf8'), 'A1\nA2\nb\nX\nY\nd\n')
        const meta = typeof res === 'string' ? {} : (res.metadata ?? {})
        assert.equal(meta.firstChangedLine, 1)
        assert.equal(meta.changedCount, 4)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'tool: bottom-up snapshot — adjacent edits resolve ORIGINAL numbering',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'hashline-bottomup-'))
      try {
        const file = join(tmp, 'b.txt')
        writeFileSync(file, 'a\nb\nc\nd\ne\n')
        const tool = createHashlineEditTool()
        // Replace line 2 with TWO lines AND line 3 — both refs from the ORIGINAL
        // snapshot. Applied bottom-up: line 3 first, then line 2. A top-down
        // implementation would corrupt the result (X2 would be replaced by Y).
        const res = await tool.execute(
          {
            file,
            edits: [
              { op: 'replace', ref: `2#${hashTag('b', 2)}`, lines: ['X1', 'X2'] },
              { op: 'replace', ref: `3#${hashTag('c', 3)}`, lines: ['Y'] },
            ],
          },
          CTX,
        )
        assert.equal(readFileSync(file, 'utf8'), 'a\nX1\nX2\nY\nd\ne\n')
        const meta = typeof res === 'string' ? {} : (res.metadata ?? {})
        assert.equal(meta.firstChangedLine, 2, 'first changed line is the lower of the two refs')
        assert.equal(meta.changedCount, 2)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'tool: mismatch → error-as-text with >>>, 2-line context, Did-you-mean; NO partial write',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'hashline-mismatch-'))
      try {
        const file = join(tmp, 'm.txt')
        const original = 'a\nb\nc\nd\ne\nf\n'
        writeFileSync(file, original)
        const tool = createHashlineEditTool()
        const actualTag = hashTag('c', 3)
        const wrongTag = actualTag[0] === 'Z' ? `P${actualTag[1]}` : `Z${actualTag[1]}`
        assert.notEqual(wrongTag, actualTag, 'wrong tag must differ from the actual tag')

        const res = await tool.execute(
          {
            file,
            edits: [
              { op: 'replace', ref: `1#${hashTag('a', 1)}`, lines: ['patched'] },
              { op: 'replace', ref: `3#${wrongTag}`, lines: ['boom'] },
            ],
          },
          CTX,
        )
        assert.equal(typeof res, 'string', 'mismatch must be returned as error TEXT, not metadata')
        const err = res as string
        assert.ok(err.includes('>>>'), 'excerpt must mark the mismatched line with >>>')
        assert.ok(err.includes('Did you mean'), 'error must suggest the corrected ref')
        assert.ok(err.includes(`3#${actualTag}`), 'suggestion must carry the real tag')
        assert.ok(err.includes('3#'), 'excerpt must include line 3')
        assert.ok(err.includes('2#') && err.includes('4#'), 'excerpt must include 2-line context')
        assert.equal(
          readFileSync(file, 'utf8'),
          original,
          'failed validation must NOT write anything',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('core: buildMismatchError + suggestLineForHash shapes', async () => {
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5']
    const err = buildMismatchError(
      '/tmp/x.txt',
      '3#ZZ',
      { line: 3, tag: 'AB', content: 'l3' },
      lines,
    )
    assert.ok(err.includes('/tmp/x.txt'))
    assert.ok(err.includes('>>>3#AB|l3'), 'target line re-tagged with the ACTUAL tag + marker')
    assert.equal(suggestLineForHash(3, 'AB'), 'Did you mean "3#AB"?')
  })

  // ── enforcement ──────────────────────────────────────────────────────
  await testAsync('enforcement: hashline_edit is blocked in read-only sessions', async () => {
    assert.equal(
      DEFAULT_BLOCKED_TOOLS.has('hashline_edit'),
      true,
      'read-only apollo must not bypass enforcement via hashline_edit',
    )
    readOnlyRegistry.clear()
    readOnlyRegistry.register('ses_ro_hl', { agent: 'apollo' })
    const guard = createEnforcementGuard({
      getReadOnlySessions: () => readOnlyRegistry.sessionIDs(),
    })
    let threw: Error | null = null
    try {
      await guard({ tool: 'hashline_edit', sessionID: 'ses_ro_hl', callID: 'c1' })
    } catch (e: unknown) {
      threw = e instanceof Error ? e : new Error(String(e))
    }
    assert.ok(threw, 'hashline_edit must throw in a read-only session')
    assert.match(threw.message, /read-only/i)
  })

  // ── golden sanity ────────────────────────────────────────────────────
  await testAsync('golden: sha256 tag is stable across runs (same input → same tag)', async () => {
    const input = 'the quick brown fox jumps over the lazy dog'
    const first = hashTag(input, 1)
    const second = hashTag(input, 1)
    assert.equal(first, second, 'same input must produce the same tag')
    assert.equal(first.length, 2)
    assert.equal(/^[ZPMQVRWSNKTXJBYH]{2}$/.test(first), true, 'tag matches the golden alphabet')
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
