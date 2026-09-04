#!/usr/bin/env node
/** Validate the immutable inputs used by the GitHub Release → Zenodo workflow. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from './version-check.mjs'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function validateHttpsUrl(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`)
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    /%(?![0-9A-Fa-f]{2})/.test(value) ||
    /[\s{}\\|^`]/.test(value)
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials.`)
  }
  return url
}

export function zenodoTemplateUrl(template, id, name = 'Zenodo URL template') {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Zenodo deposition id is invalid.')
  if (typeof template !== 'string' || !template.includes('{id}'))
    throw new Error(`${name} must contain the {id} placeholder.`)
  return validateHttpsUrl(template.replaceAll('{id}', String(id)), name).href
}

export function zenodoDepositionUrl(depositionsUrl, id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Zenodo deposition id is invalid.')
  if (typeof depositionsUrl !== 'string')
    throw new Error('ZENODO_DEPOSITIONS_URL must be an absolute HTTPS URL.')
  const base = validateHttpsUrl(depositionsUrl, 'ZENODO_DEPOSITIONS_URL')
  if (base.search || base.hash)
    throw new Error('ZENODO_DEPOSITIONS_URL must not contain a query or fragment.')
  return new URL(`${base.pathname.replace(/\/$/, '')}/${id}`, base.origin).href
}

export function validateZenodoConfiguration({
  depositionsUrl,
  filesUrlTemplate,
  publishUrlTemplate,
  creatorName,
}) {
  const base = validateHttpsUrl(depositionsUrl, 'ZENODO_DEPOSITIONS_URL')
  for (const [name, template] of [
    ['ZENODO_FILES_URL_TEMPLATE', filesUrlTemplate],
    ['ZENODO_PUBLISH_URL_TEMPLATE', publishUrlTemplate],
  ]) {
    if (
      typeof template !== 'string' ||
      !template.includes('{id}') ||
      template.replaceAll('{id}', '').match(/[{}]/) ||
      template.includes('{{') ||
      template.includes('}}')
    ) {
      throw new Error(`${name} must be an HTTPS URL template containing the {id} placeholder.`)
    }
    const url = new URL(zenodoTemplateUrl(template, 1, name))
    if (url.origin !== base.origin) throw new Error(`${name} must use the Zenodo depositions host.`)
  }
  if (typeof creatorName !== 'string' || !creatorName.trim())
    throw new Error('ZENODO_CREATOR_NAME must not be empty.')
  return true
}

export function validateZenodoRelease(root, tag) {
  if (!/^v/.test(tag)) throw new Error('Release tag must start with v.')
  const version = tag.slice(1)
  if (!SEMVER.test(version)) throw new Error('Release tag is not valid semver.')
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (packageJson.name !== 'pantheon-opencode' || packageJson.version !== version) {
    throw new Error('Release tag does not match package.json.')
  }
  const manifests = compareVersions(root)
  if (!manifests.ok) throw new Error('Release manifests are out of sync.')
  const citationPath = join(root, 'CITATION.cff')
  const citation = { present: existsSync(citationPath), version: null }
  if (citation.present) {
    const match = readFileSync(citationPath, 'utf8').match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (!match) throw new Error('CITATION.cff is missing its version field.')
    citation.version = match[1]
    if (citation.version !== version)
      throw new Error('CITATION.cff version differs from the release tag.')
  }
  return { tag, version, citation }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  try {
    validateZenodoConfiguration({
      depositionsUrl: process.env.ZENODO_DEPOSITIONS_URL,
      filesUrlTemplate: process.env.ZENODO_FILES_URL_TEMPLATE,
      publishUrlTemplate: process.env.ZENODO_PUBLISH_URL_TEMPLATE,
      creatorName: process.env.ZENODO_CREATOR_NAME,
    })
    console.log(JSON.stringify(validateZenodoRelease(process.cwd(), process.env.RELEASE_TAG ?? '')))
  } catch (error) {
    console.error(`zenodo validation: ${error.message}`)
    process.exit(1)
  }
}
