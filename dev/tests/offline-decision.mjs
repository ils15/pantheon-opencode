const QUESTIONS = [
  {
    type: 'choice',
    name: 'serve_target',
    options: [
      { value: 'deep', label: 'Deep corner' },
      { value: 'body', label: 'Body' },
    ],
  },
  {
    type: 'score',
    name: 'rally_readiness',
    levels: [{ label: 'developing' }, { label: 'ready' }, { label: 'advanced' }],
  },
  { type: 'predicate', name: 'ready_to_rotate' },
]

const STUB_ANSWERS = [
  { name: 'serve_target', value: 'deep' },
  { name: 'rally_readiness', value: 'ready' },
  { name: 'ready_to_rotate', value: true },
]

/** Validate a small, local typed-decision fixture; this does not call a host or provider. */
export function validateTypedAnswers(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length !== answers.length) {
    return false
  }

  const answersByName = new Map()
  for (const answer of answers) {
    if (
      answer === null ||
      typeof answer !== 'object' ||
      typeof answer.name !== 'string' ||
      answersByName.has(answer.name)
    ) {
      return false
    }
    answersByName.set(answer.name, answer.value)
  }

  for (const question of questions) {
    if (question === null || typeof question !== 'object' || !answersByName.has(question.name)) {
      return false
    }
    const value = answersByName.get(question.name)
    if (question.type === 'choice') {
      const options = Array.isArray(question.options) ? question.options : []
      if (!options.some((option) => option?.value === value)) return false
    } else if (question.type === 'score') {
      const levels = Array.isArray(question.levels) ? question.levels : []
      if (!levels.some((level) => level?.label === value)) return false
    } else if (question.type === 'predicate') {
      if (typeof value !== 'boolean') return false
    } else {
      return false
    }
  }
  return true
}

/** Return redacted evidence for the deterministic `stub/offline` scenario. */
export async function runOfflineDecision(hostVersion = 'not-run') {
  const started = process.hrtime.bigint()
  const valid = validateTypedAnswers(QUESTIONS, STUB_ANSWERS)
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000

  return {
    hostVersion,
    operation: 'decision.typed',
    mode: 'stub/offline',
    durationMs,
    status: valid ? 'pass' : 'fail',
    fixture: 'pickleball',
  }
}
