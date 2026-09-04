import { pathToFileURL } from 'node:url'
import { validateZenodoResponse } from './zenodo-release-state.mjs'

export function zenodoReleaseMarker(tag) {
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error('Release tag is invalid.')
  return `pantheon-opencode-release:${tag}`
}

function depositionDescription(deposition) {
  return [deposition?.metadata?.description, deposition?.description]
    .filter((value) => typeof value === 'string')
    .join('\n')
}

export async function findUniqueZenodoDeposition(
  depositionsUrl,
  token,
  releaseMarker,
  fetchImpl = fetch,
) {
  const url = new URL(depositionsUrl)
  if (url.protocol !== 'https:') throw new Error('Zenodo deposition URL must use HTTPS.')
  if (typeof token !== 'string' || !token) throw new Error('Zenodo token is required.')
  url.searchParams.set('q', releaseMarker)
  const candidates = []
  const visitedUrls = new Set()
  let nextUrl = url
  let expectedTotal = null
  while (nextUrl) {
    const currentUrl = String(nextUrl)
    if (visitedUrls.has(currentUrl)) throw new Error('Zenodo search returned a pagination cycle.')
    visitedUrls.add(currentUrl)
    const response = await fetchImpl(nextUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Zenodo deposition search failed (${response.status}).`)
    const payload = await response.json()
    if (Array.isArray(payload)) {
      throw new Error('Zenodo search returned ambiguous pagination.')
    }
    const page = payload?.hits?.hits
    const total = payload?.hits?.total
    const normalizedTotal =
      Number.isSafeInteger(total) && total >= 0
        ? total
        : Number.isSafeInteger(total?.value) && total.value >= 0
          ? total.value
          : null
    if (!Array.isArray(page) || normalizedTotal === null)
      throw new Error('Zenodo search returned ambiguous pagination.')
    if (expectedTotal !== null && expectedTotal !== normalizedTotal)
      throw new Error('Zenodo search returned inconsistent pagination totals.')
    expectedTotal = normalizedTotal
    candidates.push(...page)
    const rawNext = payload?.links?.next
    if (rawNext === null || rawNext === undefined || rawNext === '') {
      if (candidates.length < expectedTotal)
        throw new Error('Zenodo search ended before all results were examined.')
      nextUrl = null
    } else {
      if (typeof rawNext !== 'string')
        throw new Error('Zenodo search returned an invalid pagination link.')
      let parsedNext
      try {
        parsedNext = new URL(rawNext, url)
      } catch {
        throw new Error('Zenodo search returned an invalid pagination link.')
      }
      if (
        parsedNext.protocol !== 'https:' ||
        parsedNext.origin !== url.origin ||
        parsedNext.pathname !== url.pathname
      )
        throw new Error('Zenodo search returned an unsafe pagination link.')
      nextUrl = parsedNext
    }
  }
  const escapedMarker = releaseMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markerPattern = new RegExp(`(?:^|[^A-Za-z0-9._:-])${escapedMarker}(?![A-Za-z0-9.-])`)
  const matches = candidates.filter((deposition) =>
    markerPattern.test(depositionDescription(deposition)),
  )
  if (matches.length !== 1) {
    throw new Error(
      `Zenodo recovery requires exactly one matching deposition; found ${matches.length}.`,
    )
  }
  return validateZenodoResponse(matches[0])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await findUniqueZenodoDeposition(
      process.env.ZENODO_DEPOSITIONS_URL,
      process.env.ZENODO_TOKEN,
      process.env.RELEASE_MARKER,
    )
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    console.error(`zenodo recovery: ${error.message}`)
    process.exit(1)
  }
}
