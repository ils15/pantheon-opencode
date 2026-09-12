/**
 * strings-locale.test.mjs — installer i18n auto-detection contract.
 *
 * Run: node --test tests/strings-locale.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectLocale, stringsFor } from '../scripts/install/strings.mjs'

test('pt-* locales (LANG, LC_ALL, LC_MESSAGES) select the PT table', () => {
  assert.equal(detectLocale({ LANG: 'pt_BR.UTF-8' }), 'pt')
  assert.equal(detectLocale({ LANG: 'pt_PT' }), 'pt')
  assert.equal(detectLocale({ LANG: 'en_US.UTF-8', LC_ALL: 'pt_BR.UTF-8' }), 'pt')
  assert.equal(detectLocale({ LANG: 'C', LC_MESSAGES: 'pt_BR.UTF-8' }), 'pt')
})

test('non-pt and missing locales select EN', () => {
  assert.equal(detectLocale({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(detectLocale({ LANG: 'es_ES.UTF-8' }), 'en')
  assert.equal(detectLocale({ LANG: 'C.UTF-8' }), 'en')
  assert.equal(detectLocale({}), 'en')
})

test('both tables are complete and structurally identical', () => {
  const en = stringsFor('en')
  const pt = stringsFor('pt')
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort(), 'same key set')
  for (const key of Object.keys(en)) {
    assert.equal(typeof pt[key], typeof en[key], `key ${key} must exist in both tables`)
  }
  // interpolating functions resolve without throwing
  assert.ok(en.installedTitle('1.0').includes('1.0'))
  assert.ok(pt.summaryComponents(2, 3).includes('2'))
  assert.ok(pt.summaryWithErrors('/tmp').includes('/tmp'))
  assert.ok(en.runtimeFailed('boom').includes('boom'))
})

test('unknown locale falls back to EN', () => {
  assert.equal(stringsFor('xx'), stringsFor('en'))
})
