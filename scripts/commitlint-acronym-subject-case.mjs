/**
 * commitlint plugin — acronym-aware subject case.
 *
 * Why this exists
 * ---------------
 * `@commitlint/config-conventional` ships
 *   subject-case: [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']]
 * where commitlint's `sentence-case` is only `upperFirst(subject)` — so ANY
 * subject whose first character is uppercase "is" sentence-case. That is why
 * the squash subject of PR #519 (`fix(release): OIDC-capable dist-tag writes`)
 * passed `Commit Lint` on its four commits and then failed on `main`, where the
 * PR title becomes the squash commit's subject.
 *
 * There is no rule-level `ignores`/regex option on the built-in `subject-case`
 * rule (`@commitlint/rules/lib/subject-case.js` accepts only `when` + `case`),
 * and a commitlint rule can only add failures, never rescue one. So the
 * supported extension point is a plugin rule that replaces the built-in check.
 *
 * Policy this rule enforces (a squash subject is prose, not a headline):
 *   1. A multi-word subject may not be Title Case — every word starting with an
 *      uppercase letter — unless every word is a known acronym.
 *   2. A subject that is entirely uppercase is rejected for the same reason;
 *      a known acronym is the exception (`fix(ci): OIDC` is legitimate).
 *   3. Everything else passes: lowercase prose and a normal sentence start are
 *      both fine, and an acronym anywhere in the subject is tolerated.
 *
 * `subject-empty` and `subject-full-stop` still own their own failures.
 */

/** Acronyms tolerated as an all-caps subject. */
export const DEFAULT_ACRONYMS = Object.freeze([
  'ADR',
  'API',
  'AST',
  'CI',
  'CLI',
  'DOI',
  'GH',
  'HTTP',
  'HTTPS',
  'JSON',
  'JWT',
  'MCP',
  'MFA',
  'OIDC',
  'PR',
  'RPC',
  'SDK',
  'SLSA',
  'SQL',
  'SSH',
  'TDD',
  'TLS',
  'TUI',
  'URI',
  'URL',
  'YAML',
])

const WORD_SPLIT_RE = /\s+/u
const EDGE_NON_LETTER_RE = /^[^\p{L}]+|[^\p{L}]+$/gu
const HAS_LETTER_RE = /\p{L}/u
const UPPER_FIRST_RE = /^\p{Lu}/u

/** Letter-only words of a subject, punctuation trimmed. */
export function subjectWords(subject) {
  return String(subject)
    .split(WORD_SPLIT_RE)
    .map((word) => word.replace(EDGE_NON_LETTER_RE, ''))
    .filter((word) => HAS_LETTER_RE.test(word))
}

/**
 * @param {{ subject?: string }} parsed commitlint-parsed commit
 * @param {'always' | 'never'} [when] commitlint rule applicability
 * @param {string[]} [acronyms] tolerated all-caps tokens
 * @returns {[boolean, string?]} commitlint rule result
 */
export function acronymSubjectCase(parsed, when = 'always', acronyms = DEFAULT_ACRONYMS) {
  const subject = typeof parsed?.subject === 'string' ? parsed.subject.trim() : ''
  // An empty subject belongs to `subject-empty`; never double-report it here.
  if (!subject) return [true]

  const allow = Array.isArray(acronyms) && acronyms.length > 0 ? acronyms : DEFAULT_ACRONYMS
  const allowed = new Set(allow.map((acronym) => String(acronym).toUpperCase()))
  const words = subjectWords(subject)

  const titleCase = words.length > 0 && words.every((word) => UPPER_FIRST_RE.test(word))
  const allAcronyms = words.length > 0 && words.every((word) => allowed.has(word.toUpperCase()))
  const violates = titleCase && !allAcronyms

  const passed = when === 'never' ? violates : !violates
  if (passed) return [true]
  return [
    false,
    'subject must not be Title Case or ALL CAPS; keep prose lowercase and list known acronyms (OIDC, API, CLI, …) instead',
  ]
}

export default {
  rules: {
    'acronym-subject-case': acronymSubjectCase,
  },
}
