#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_REF = /^(?:npm:)?pantheon-opencode(?:@[^/]+)?(?:\/(?:plugin|plugin-v2))?$/
export const SANDBOX_SOURCE_FILES = [
  'bin/pantheon-init.mjs',
  'scripts/install/config-migration.mjs',
  'scripts/install/opencode.mjs',
  'scripts/validate-sandbox-install.mjs',
  'src/plugin-v2.ts',
]

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${error.message}`)
  }
}

function pluginReferences(config) {
  const refs = []
  for (const key of ['plugin', 'plugins']) {
    const value = config?.[key]
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
    for (const entry of entries) {
      if (typeof entry === 'string') refs.push(entry)
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        for (const field of ['package', 'id', 'name', 'path', 'source']) {
          if (typeof entry[field] === 'string') refs.push(entry[field])
        }
      }
    }
  }
  return refs
}

/**
 * Prove that the sandbox is executing the package built from this checkout and
 * that the project config cannot silently load an older npm-cached Pantheon.
 */
export function validateSandboxInstall({ repoDir, installDir, projectConfig, configPaths = [] }) {
  const sourcePackagePath = join(resolve(repoDir), 'package.json')
  const installedPackagePath = join(resolve(installDir), 'package.json')
  const sourcePackage = readJson(sourcePackagePath, 'checkout package manifest')
  const installedPackage = readJson(installedPackagePath, 'sandbox package manifest')
  if (sourcePackage.version !== installedPackage.version) {
    throw new Error(
      `sandbox package version ${installedPackage.version} does not match checkout ${sourcePackage.version}`,
    )
  }

  const sourceHash = createHash('sha256')
  for (const relativePath of SANDBOX_SOURCE_FILES) {
    let source
    let installed
    try {
      source = readFileSync(join(resolve(repoDir), relativePath))
      installed = readFileSync(join(resolve(installDir), relativePath))
    } catch (error) {
      throw new Error(`cannot compare package source ${relativePath}: ${error.message}`)
    }
    if (!source.equals(installed)) {
      throw new Error(`installed package source differs from checkout: ${relativePath}`)
    }
    sourceHash.update(relativePath).update('\0').update(installed).update('\0')
  }

  const expectedPluginPath = resolve(installDir, 'src', 'plugin-v2')
  const allConfigPaths = [...new Set([projectConfig, ...configPaths].map((path) => resolve(path)))]
  let activeProjectPluginCount = 0
  for (const configPath of allConfigPaths) {
    const config = readJson(configPath, 'active OpenCode config')
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`active OpenCode config must be an object: ${configPath}`)
    }
    for (const ref of pluginReferences(config)) {
      const normalized = ref.replaceAll('\\', '/').replace(/\/$/, '')
      if (PACKAGE_REF.test(normalized)) {
        throw new Error(`stale Pantheon package reference in ${configPath}: ${ref}`)
      }
      if (resolve(ref) === expectedPluginPath) {
        if (configPath === resolve(projectConfig)) activeProjectPluginCount += 1
      }
    }
  }
  if (activeProjectPluginCount !== 1) {
    throw new Error(
      `project config must reference the sandbox V2 plugin exactly once; found ${activeProjectPluginCount}: ${resolve(projectConfig)}`,
    )
  }

  return {
    status: 'PASS',
    version: installedPackage.version,
    sourceSha256: sourceHash.digest('hex'),
  }
}

function parseArgs(args) {
  const options = { configPaths: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--config') options.configPaths.push(args[++i])
    else if (['--repo', '--install', '--project-config'].includes(arg))
      options[arg.slice(2).replace('-', '')] = args[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  for (const required of ['repo', 'install', 'projectconfig']) {
    if (!options[required])
      throw new Error(
        `missing required option --${required.replace('projectconfig', 'project-config')}`,
      )
  }
  return {
    repoDir: options.repo,
    installDir: options.install,
    projectConfig: options.projectconfig,
    configPaths: options.configPaths,
  }
}

function main() {
  try {
    const result = validateSandboxInstall(parseArgs(process.argv.slice(2)))
    process.stdout.write(
      `Sandbox install proof: ${result.status} (version ${result.version}, source sha256 ${result.sourceSha256})\n`,
    )
  } catch (error) {
    process.stderr.write(`Sandbox install proof: FAIL — ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
