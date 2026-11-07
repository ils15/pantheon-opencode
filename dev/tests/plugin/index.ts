import { appendFileSync } from 'node:fs'

const SKILL_ID = 'pickleball-basics'

function collection(value: unknown): Record<string, unknown>[] {
  const data =
    value !== null && typeof value === 'object' && 'data' in value
      ? (value as { data: unknown }).data
      : value
  if (Array.isArray(data)) return data.filter(isRecord)
  if (!isRecord(data)) return []
  if (Array.isArray(data.resources)) return data.resources.filter(isRecord)
  return Object.values(data).flatMap((entry) =>
    Array.isArray(entry) ? entry.filter(isRecord) : isRecord(entry) ? [entry] : [],
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asDomain(value: unknown): Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : {}
}

function matchesSkill(skill: Record<string, unknown>): boolean {
  return [skill.id, skill.name, skill.path].some(
    (value) => typeof value === 'string' && value.includes(SKILL_ID),
  )
}

function writeEvidence(record: Record<string, unknown>): void {
  const evidencePath = process.env.PICKLEBALL_EVIDENCE_PATH
  if (!evidencePath) return
  appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

async function measureHostOperation(
  operation: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const started = process.hrtime.bigint()
  let status = 'pass'
  let evidence: Record<string, unknown> = {}
  try {
    evidence = await run()
    if (evidence.ok !== true) status = 'blocked'
  } catch (error) {
    status = 'blocked'
    evidence = { errorKind: error instanceof Error ? error.name : 'UnknownError' }
  }
  writeEvidence({
    hostVersion: process.env.PICKLEBALL_HOST_VERSION ?? 'unknown',
    operation,
    mode: 'host',
    durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    status,
    ...evidence,
  })
}

export default {
  id: 'pickleball-test-harness',
  async setup(input: unknown) {
    const ctx = asDomain(input)
    const skill = asDomain(ctx.skill)
    await measureHostOperation('skills.registry.seed', async () => {
      const transform = skill.transform
      if (typeof transform !== 'function') {
        return { ok: false, capability: 'ctx.skill.transform' }
      }
      const skillPath = process.env.PICKLEBALL_SKILL_PATH
      if (!skillPath) return { ok: false, capability: 'private synthetic skill path' }
      await transform.call(skill, (editor: unknown) => {
        const mutableEditor = asDomain(editor)
        const add = mutableEditor.add
        if (typeof add !== 'function') throw new TypeError('host skill editor has no add method')
        add.call(mutableEditor, {
          id: SKILL_ID,
          name: SKILL_ID,
          description: 'Synthetic local pickleball practice skill for host testing.',
          path: skillPath,
          content: 'Synthetic practice note: serve deep and recover to a ready position.',
        })
      })
      return { ok: true, fixture: SKILL_ID, seedMode: 'host-registry-transform' }
    })

    await measureHostOperation('skills.list', async () => {
      const list = skill.list
      if (typeof list !== 'function') {
        return {
          ok: false,
          capability: 'ctx.skill.list',
          observedDomainType: typeof ctx.skill,
          observedMethodType: typeof list,
        }
      }
      const result: unknown = await list.call(skill)
      const skills = collection(result)
      const fixtureFound = skills.some(matchesSkill)
      return {
        ok: fixtureFound,
        fixtureFound,
        skillCount: skills.length,
        firstSkillFields: skills[0] ? Object.keys(skills[0]).sort() : [],
      }
    })

    const mcp = asDomain(ctx.mcp)
    const capabilityStarted = process.hrtime.bigint()
    const experimental = asDomain(ctx.experimental)
    const generate = asDomain(experimental.generate)
    const decisionAPI = generate.decisions
    const capabilityDurationMs = Number(process.hrtime.bigint() - capabilityStarted) / 1_000_000
    writeEvidence({
      hostVersion: process.env.PICKLEBALL_HOST_VERSION ?? 'unknown',
      operation: 'decisions.capability',
      mode: 'host',
      durationMs: capabilityDurationMs,
      status: typeof decisionAPI === 'function' ? 'available' : 'unsupported',
      invoked: false,
    })

    const readCapabilityStarted = process.hrtime.bigint()
    const resourceApi = asDomain(mcp.resource)
    const readAvailable = typeof resourceApi.read === 'function'
    const readCapabilityDurationMs =
      Number(process.hrtime.bigint() - readCapabilityStarted) / 1_000_000
    writeEvidence({
      hostVersion: process.env.PICKLEBALL_HOST_VERSION ?? 'unknown',
      operation: 'mcp.resources.read',
      mode: 'host',
      durationMs: readCapabilityDurationMs,
      status: readAvailable ? 'available-not-invoked' : 'unsupported',
      invoked: false,
    })

    return {}
  },
}
