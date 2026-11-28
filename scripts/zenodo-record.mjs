#!/usr/bin/env node
/**
 * zenodo-record.mjs — the single source of truth for Pantheon's Zenodo identity.
 *
 * Zenodo mints two kinds of DOI for a GitHub-archived release:
 *
 *   * a **concept DOI** that is stable for the lifetime of the software and
 *     always resolves to the newest archived version, and
 *   * a **version DOI** minted per archive (`.../zenodo.<record id>`), which
 *     cannot be known before the deposit happens.
 *
 * Only the concept DOI belongs in anything that is written *before* a release
 * (a release body, a README, a checklist). A version DOI written at build time
 * is stale on the very next archive, so it is never hardcoded here.
 */

/** Zenodo concept record id shared by every archived Pantheon version. */
export const ZENODO_CONCEPT_RECID = '22650136'

/** Stable, version-independent DOI (`10.5281/zenodo.<conceptrecid>`). */
export const ZENODO_CONCEPT_DOI = `10.5281/zenodo.${ZENODO_CONCEPT_RECID}`

/**
 * Concept-DOI lookup on Zenodo's REST API (InvenioRDM). Following the redirect
 * lands on the concept's **latest** version record, which is exactly what the
 * verifier asserts against — `/<conceptrecid>/versions` 404s on the live API,
 * because the versions listing hangs off a version record id, not a concept id.
 */
export const ZENODO_CONCEPT_RECORD_URL = `https://zenodo.org/api/records/${ZENODO_CONCEPT_RECID}`

/** Canonical citation line appended to every composed release body. */
export const ZENODO_CITATION_FOOTER = `Cite this release via the concept DOI [${ZENODO_CONCEPT_DOI}](https://doi.org/${ZENODO_CONCEPT_DOI}).`
