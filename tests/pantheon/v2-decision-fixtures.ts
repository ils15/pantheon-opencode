/**
 * Synthetic fixtures for the V2 decision offline harness.
 *
 * These are hand-written shapes, not recorded traffic. The only exceptions are
 * the two host shapes copied from measured probes and labelled as such:
 *
 *   - `HOST_PROMPT_PAYLOAD_F08` — prompt hook payload with the literal
 *     `"undefined"` strings measured in PROBE-B (F-08).
 *   - `HOST_EVENT_ENVELOPES_F13` — envelopes shaped like the measured
 *     `{ id, created, type, durable, data }` carrier (F-13).
 *
 * No real prompt, response, session or user content is included.
 */

import type { AskQuestion, RankCandidate } from '../../src/pantheon/v2-decision-contracts.ts'
import type { HostEventEnvelope } from '../../src/pantheon/v2-decision-events.ts'

/** Measured prompt-hook payload shape (F-08). */
export const HOST_PROMPT_PAYLOAD_F08 = {
  sessionID: 'ses_fixture_0001',
  messageID: 'msg_fixture_0001',
  prompt: {
    text: 'synthetic fixture prompt',
    files: [],
    agents: 'undefined',
    skills: 'undefined',
  },
  metadata: {},
  delivery: 'prompt',
} as const

/** A second measured-shape payload used to prove isolation between records. */
export const HOST_PROMPT_PAYLOAD_F08_NESTED = {
  sessionID: 'ses_fixture_0002',
  prompt: { skills: 'undefined', agents: 'undefined', files: [] },
  metadata: { nested: { keep: true } },
} as const

/** Measured envelope shape (F-13): type + data.sessionID, no legacy field. */
export const HOST_EVENT_ENVELOPES_F13: readonly HostEventEnvelope[] = [
  {
    id: 'evt_0001',
    created: 1_700_000_000_000,
    type: 'session.execution.started',
    durable: false,
    data: { sessionID: 'ses_fixture_0001' },
  },
  {
    id: 'evt_0002',
    created: 1_700_000_000_001,
    type: 'session.execution.succeeded',
    durable: true,
    data: { sessionID: 'ses_fixture_0001' },
  },
  {
    id: 'evt_0003',
    created: 1_700_000_000_002,
    type: 'session.compaction.ended',
    durable: true,
    data: { sessionID: 'ses_fixture_0002' },
  },
  {
    id: 'evt_0004',
    created: 1_700_000_000_003,
    type: 'session.execution.succeeded',
    durable: true,
    data: {},
  },
]

export const VALID_CHOICE: AskQuestion = {
  mode: 'choice',
  id: 'fixture-choice',
  text: 'Pick one option.',
  labels: ['alpha', 'beta "quoted"', 'gamma'],
}

export const VALID_NOUL: AskQuestion = {
  mode: 'noul',
  id: 'fixture-noul',
  text: 'Proceed?',
}

export const VALID_SCORE: AskQuestion = {
  mode: 'score',
  id: 'fixture-score',
  text: 'Rate the change.',
  levels: 5,
}

export const VALID_REFUSAL: AskQuestion = {
  mode: 'refusal',
  id: 'fixture-refusal',
  text: 'Decline if evidence is missing.',
}

export const INVALID_QUESTIONS: readonly { name: string; question: unknown; code: string }[] = [
  { name: 'null', question: null, code: 'INVALID_SHAPE' },
  { name: 'array', question: [], code: 'INVALID_SHAPE' },
  { name: 'unknown mode', question: { mode: 'rank', id: 'q', text: 't' }, code: 'UNKNOWN_MODE' },
  { name: 'missing id', question: { mode: 'noul', text: 't' }, code: 'MISSING_ID' },
  { name: 'unsafe id', question: { mode: 'noul', id: 'has space', text: 't' }, code: 'MISSING_ID' },
  { name: 'empty text', question: { mode: 'noul', id: 'q', text: '  ' }, code: 'MISSING_TEXT' },
  {
    name: 'zero labels',
    question: { mode: 'choice', id: 'q', text: 't', labels: [] },
    code: 'EMPTY_LABELS',
  },
  {
    name: 'labels not array',
    question: { mode: 'choice', id: 'q', text: 't', labels: 'a,b' },
    code: 'EMPTY_LABELS',
  },
  {
    name: 'duplicate labels',
    question: { mode: 'choice', id: 'q', text: 't', labels: ['a', 'a'] },
    code: 'DUPLICATE_LABEL',
  },
  {
    name: 'duplicate after trim',
    question: { mode: 'choice', id: 'q', text: 't', labels: ['a', ' a '] },
    code: 'DUPLICATE_LABEL',
  },
  {
    name: 'control character label',
    question: { mode: 'choice', id: 'q', text: 't', labels: ['a\nb'] },
    code: 'INVALID_LABEL',
  },
  {
    name: 'empty label',
    question: { mode: 'choice', id: 'q', text: 't', labels: [''] },
    code: 'INVALID_LABEL',
  },
  {
    name: 'too many labels',
    question: {
      mode: 'choice',
      id: 'q',
      text: 't',
      labels: Array.from({ length: 256 }, (_, index) => `label-${index}`),
    },
    code: 'TOO_MANY_LABELS',
  },
  {
    name: 'levels below minimum',
    question: { mode: 'score', id: 'q', text: 't', levels: 1 },
    code: 'INVALID_LEVELS',
  },
  {
    name: 'levels above maximum',
    question: { mode: 'score', id: 'q', text: 't', levels: 11 },
    code: 'INVALID_LEVELS',
  },
  {
    name: 'levels not integer',
    question: { mode: 'score', id: 'q', text: 't', levels: 4.5 },
    code: 'INVALID_LEVELS',
  },
]

export const RANK_CANDIDATES: readonly RankCandidate[] = [
  { id: 'zeta', score: 0.4, justification: 'fewer supporting facts' },
  { id: 'alpha', score: 0.9, justification: 'two independent facts' },
  { id: 'beta', score: 0.9, justification: 'two independent facts' },
]

export const INVALID_RANK_CANDIDATES: readonly { name: string; candidates: unknown }[] = [
  { name: 'not array', candidates: {} },
  { name: 'empty', candidates: [] },
  { name: 'missing id', candidates: [{ score: 1, justification: 'x' }] },
  { name: 'unsafe id', candidates: [{ id: 'a b', score: 1, justification: 'x' }] },
  {
    name: 'duplicate id',
    candidates: [
      { id: 'a', score: 1, justification: 'x' },
      { id: 'a', score: 2, justification: 'y' },
    ],
  },
  {
    name: 'non-finite score',
    candidates: [{ id: 'a', score: Number.POSITIVE_INFINITY, justification: 'x' }],
  },
  {
    name: 'empty justification',
    candidates: [{ id: 'a', score: 1, justification: ' ' }],
  },
]

/** Hostile telemetry records. No value from these may survive sanitisation. */
export const HOSTILE_TELEMETRY: readonly unknown[] = [
  {
    point: 'P1',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    prompt: 'user typed a secret password',
    response: 'model answered with private content',
    user: 'someone@example.test',
    messages: [{ role: 'user', content: 'secret' }],
    apiKey: 'sk-live-not-a-real-key',
    text: 'free-form content',
  },
  {
    point: 'P2',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    'my secret field': 'must never be echoed',
  },
  {
    point: 'P3',
    decision: 'choice',
    reason: 'user said: my password is hunter2',
  },
]
