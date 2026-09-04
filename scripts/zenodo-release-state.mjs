const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/
const MARKER_PATTERN =
  /<!-- zenodo-deposition:(?:id=(\d+);)?(?:doi=([^;\s]+);)?state=(pending|created|published)(?:;claim=([^\s]+))? -->/

export function extractZenodoDoi(response) {
  if (!response || typeof response !== 'object') return null
  const candidates = [response.doi, response.metadata?.doi, response.links?.doi]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && DOI_PATTERN.test(candidate.trim())) return candidate.trim()
  }
  return null
}

export function validateZenodoResponse(response, { requireDoi = false } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Zenodo response must be a JSON object.')
  }
  if (!Number.isSafeInteger(response.id) || response.id <= 0) {
    throw new Error('Zenodo response did not contain a valid deposition id.')
  }
  const doi = extractZenodoDoi(response)
  if (requireDoi && !doi) throw new Error('Zenodo response did not contain a valid DOI.')
  return { id: response.id, doi }
}

export function parseZenodoMarker(body) {
  const text = String(body ?? '')
  const match = text.match(MARKER_PATTERN)
  if (!match) {
    const legacy = text.match(/<!-- zenodo-deposition-id:(\d+) -->/)
    if (!legacy) return null
    const id = Number(legacy[1])
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('Zenodo marker has an invalid deposition id.')
    return { id, doi: null, state: 'created', claim: null }
  }
  const id = match[1] ? Number(match[1]) : null
  if (match[1] && (!Number.isSafeInteger(id) || id <= 0))
    throw new Error('Zenodo marker has an invalid deposition id.')
  if (match[2] && !DOI_PATTERN.test(match[2])) throw new Error('Zenodo marker has an invalid DOI.')
  return { id, doi: match[2] ?? null, state: match[3], claim: match[4] ?? null }
}

export function zenodoMarker({ id = null, doi = null, state, claim = null }) {
  if (!['pending', 'created', 'published'].includes(state))
    throw new Error('Zenodo marker state is invalid.')
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0))
    throw new Error('Zenodo marker id is invalid.')
  if (doi !== null && !DOI_PATTERN.test(doi)) throw new Error('Zenodo marker DOI is invalid.')
  if (state !== 'pending' && id === null)
    throw new Error('Created or published Zenodo markers require an id.')
  return `<!-- zenodo-deposition:${id === null ? '' : `id=${id};`}${doi === null ? '' : `doi=${doi};`}state=${state}${claim === null ? '' : `;claim=${claim}`} -->`
}
