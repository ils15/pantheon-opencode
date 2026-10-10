/**
 * Opt-in, current-implementation-only microbenchmark. Run with:
 *   npx tsx scripts/bench-secret-scanner.ts
 *
 * Uses 3 warmups and 15 measured samples per size, reporting the median. Each
 * call measures only scanSecretText(safe ASCII input); payload preflight,
 * serialization, hook dispatch, logging, and host execution are excluded. This
 * is not an old-vs-new or Bash-vs-TypeScript comparison and makes no speedup
 * claim.
 */
import { performance } from 'node:perf_hooks'

import { scanSecretText } from '../src/pantheon/secret-scanner.ts'

const WARMUPS = 3
const SAMPLES = 15
const SIZES = [1_024, 10_240, 102_400, 262_144, 1_048_576, 5_242_880] as const

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

console.log('Secret scanner benchmark: current implementation only; no baseline comparison')
console.log(`method: warmups=${WARMUPS}, samples=${SAMPLES}, median of scanSecretText calls`)
console.log('size_bytes,median_scanSecretText_ms')

for (const size of SIZES) {
  const input = 'a'.repeat(size)
  for (let warmup = 0; warmup < WARMUPS; warmup++) scanSecretText(input)

  const durations: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = performance.now()
    scanSecretText(input)
    durations.push(performance.now() - started)
  }

  console.log(`${size},${median(durations).toFixed(3)}`)
}
