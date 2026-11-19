/**
 * Deterministic Polyglot Stack Auto-Detector (`stack-detector.mjs`).
 *
 * Inspects workspace manifests (`package.json`, `pyproject.toml`, `requirements.txt`,
 * `Cargo.toml`, `go.mod`) and recommends tailored project specialists and
 * domain convention docs for `/pantheon-forge` and `pantheon-init`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Inspect workspace manifests and return detected stacks and specialist suggestions.
 * @param {string} workspaceDir
 */
export function detectRepositoryStacks(workspaceDir) {
  const root = resolve(workspaceDir)
  const stacks = []
  const suggestedSpecialists = []
  const suggestedDocs = new Set()

  // 1. Node.js / TypeScript
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const frameworks = []
      for (const fw of [
        'typescript',
        'react',
        'next',
        'solid-js',
        'vue',
        'fastify',
        'express',
        'hono',
        'prisma',
      ]) {
        if (fw in deps) frameworks.push(fw)
      }
      const testRunner =
        'vitest' in deps
          ? 'npx vitest run'
          : 'jest' in deps
            ? 'npx jest'
            : pkg.scripts?.test
              ? 'npm test'
              : 'node --test'
      const linter = 'biome' in deps || '@biomejs/biome' in deps ? 'npx biome check' : 'npx eslint'
      stacks.push({
        id: 'node-typescript',
        manifest: 'package.json',
        frameworks,
        testRunner,
        linter,
      })
      const uiFrameworks = frameworks.filter((f) =>
        ['react', 'next', 'solid-js', 'vue'].includes(f),
      )
      if (uiFrameworks.length > 0) {
        suggestedSpecialists.push({
          name: 'frontend-ui-specialist',
          archetype: 'frontend',
          description: `UI/component specialist tailored to ${uiFrameworks.join(', ')}`,
          stack: ['TypeScript', ...frameworks],
          testCommand: testRunner,
          suggestedDocs: ['src/instructions/', 'tsconfig.json'],
        })
      } else {
        suggestedSpecialists.push({
          name: 'node-service-specialist',
          archetype: 'backend',
          description: `Node/TypeScript backend specialist using ${testRunner}`,
          stack: ['Node.js', 'TypeScript', ...frameworks],
          testCommand: testRunner,
          suggestedDocs: ['tsconfig.json', 'package.json'],
        })
      }
      suggestedDocs.add('package.json')
    } catch {
      /* ignore malformed package.json */
    }
  }

  // 2. Python
  const pyProjPath = join(root, 'pyproject.toml')
  const reqPath = join(root, 'requirements.txt')
  if (existsSync(pyProjPath) || existsSync(reqPath)) {
    const rawPy = [
      existsSync(pyProjPath) ? readFileSync(pyProjPath, 'utf8') : '',
      existsSync(reqPath) ? readFileSync(reqPath, 'utf8') : '',
    ]
      .join('\n')
      .toLowerCase()
    const frameworks = []
    for (const fw of ['fastapi', 'django', 'flask', 'sqlalchemy', 'pydantic', 'pytest']) {
      if (rawPy.includes(fw)) frameworks.push(fw)
    }
    const testRunner = rawPy.includes('pytest') ? 'pytest -q' : 'python3 -m unittest'
    const linter = rawPy.includes('ruff') ? 'ruff check' : 'pyright'
    const pyManifest = existsSync(pyProjPath) ? 'pyproject.toml' : 'requirements.txt'
    stacks.push({
      id: 'python',
      manifest: pyManifest,
      frameworks,
      testRunner,
      linter,
    })
    suggestedSpecialists.push({
      name: 'python-api-specialist',
      archetype: frameworks.includes('sqlalchemy') ? 'data' : 'backend',
      description: `Python specialist tailored to ${frameworks.join(', ') || 'pyproject.toml'}`,
      stack: ['Python', ...frameworks],
      testCommand: testRunner,
      suggestedDocs: [pyManifest],
    })
    suggestedDocs.add(pyManifest)
  }

  // 3. Go
  const goModPath = join(root, 'go.mod')
  if (existsSync(goModPath)) {
    const rawGo = readFileSync(goModPath, 'utf8').toLowerCase()
    const frameworks = ['gin', 'echo', 'fiber', 'chi'].filter((fw) => rawGo.includes(fw))
    stacks.push({
      id: 'go',
      manifest: 'go.mod',
      frameworks,
      testRunner: 'go test ./...',
      linter: 'gofmt / go vet',
    })
    suggestedSpecialists.push({
      name: 'go-systems-specialist',
      archetype: 'backend',
      description: `Go service & concurrency specialist (${frameworks.join(', ') || 'stdlib'})`,
      stack: ['Go', ...frameworks],
      testCommand: 'go test ./...',
      suggestedDocs: ['go.mod'],
    })
    suggestedDocs.add('go.mod')
  }

  // 4. Rust
  const cargoPath = join(root, 'Cargo.toml')
  if (existsSync(cargoPath)) {
    const rawCargo = readFileSync(cargoPath, 'utf8').toLowerCase()
    const frameworks = ['tokio', 'axum', 'actix-web', 'serde', 'sqlx'].filter((fw) =>
      rawCargo.includes(fw),
    )
    stacks.push({
      id: 'rust',
      manifest: 'Cargo.toml',
      frameworks,
      testRunner: 'cargo test',
      linter: 'cargo clippy',
    })
    suggestedSpecialists.push({
      name: 'rust-core-specialist',
      archetype: 'backend',
      description: `Rust systems & safety specialist (${frameworks.join(', ') || 'Cargo'})`,
      stack: ['Rust', ...frameworks],
      testCommand: 'cargo test',
      suggestedDocs: ['Cargo.toml'],
    })
    suggestedDocs.add('Cargo.toml')
  }

  return {
    stacks,
    suggestedSpecialists,
    suggestedDocs: Array.from(suggestedDocs),
  }
}
