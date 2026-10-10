/**
 * Opt-in scanner-only microbenchmark. Run with:
 *   npx tsx scripts/bench-secret-scanner.ts
 *
 * Each measured call is only scanSecretText(safe ASCII input); serialization,
 * hook dispatch, logging, and host execution are deliberately excluded.
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

console.log(`Secret scanner benchmark: warmups=${WARMUPS}, samples=${SAMPLES}, scanner-only`)
console.log('size_bytes,median_ms')

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
