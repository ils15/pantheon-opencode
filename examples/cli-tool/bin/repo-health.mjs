#!/usr/bin/env node
/**
 * Fast-path CLI built by @talos and @hermes.
 * Zero-dependency, sub-second execution, diagnostic health report.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function checkRepoHealth(targetDir = process.cwd()) {
  const issues = []
  let score = 100

  // 1. Git clean status check
  try {
    const gitStatus = execSync('git status --porcelain', {
      cwd: targetDir,
      encoding: 'utf8',
    }).trim()
    if (gitStatus.length > 0) {
      const changedFiles = gitStatus.split('\n').length
      issues.push(`Aviso: ${changedFiles} arquivo(s) modificados ou não rastreados no Git`)
      score -= Math.min(20, changedFiles * 5)
    }
  } catch {
    issues.push('Alerta: Diretório não é um repositório Git válido')
    score -= 40
  }

  // 2. Package manifest check
  const pkgPath = join(targetDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (!pkg.scripts?.test) {
        issues.push('Aviso: package.json não define o script "test"')
        score -= 15
      }
      if (!pkg.description || pkg.description.trim() === '') {
        issues.push('Aviso: package.json não possui descrição')
        score -= 5
      }
    } catch {
      issues.push('Erro: package.json possui sintaxe JSON inválida')
      score -= 30
    }
  } else {
    issues.push('Aviso: package.json não encontrado na raiz')
    score -= 20
  }

  // 3. README check
  if (!existsSync(join(targetDir, 'README.md'))) {
    issues.push('Aviso: README.md não encontrado')
    score -= 15
  }

  const finalScore = Math.max(0, score)
  const status = finalScore >= 80 ? 'EXCELENTE' : finalScore >= 50 ? 'REGULAR' : 'CRÍTICO'

  return {
    score: finalScore,
    status,
    issues,
    timestamp: new Date().toISOString(),
  }
}

if (process.argv[1]?.endsWith('repo-health.mjs')) {
  const result = checkRepoHealth()
  const isJson = process.argv.includes('--json')

  if (isJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('\n🏥 Pantheon Repo Health Diagnostic')
    console.log('──────────────────────────────────────')
    console.log(`Pontuação Geral: ${result.score}/100 [${result.status}]`)
    if (result.issues.length === 0) {
      console.log('✅ Nenhuma inconsistência encontrada. Repositório saudável!')
    } else {
      console.log('\nApontamentos:')
      for (const issue of result.issues) {
        console.log(`  • ${issue}`)
      }
    }
    console.log('')
  }
}
