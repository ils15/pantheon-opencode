/** Build an execution order with paired control/candidate runs interleaved. */
export function buildRunPlan(runsPerScenario, scenarios, pairedOptions = null) {
  const order = []
  for (let run = 1; run <= runsPerScenario; run += 1) {
    for (const scenario of scenarios) {
      if (pairedOptions === null) {
        order.push({ scenario, arm: null, agent: 'zeus', pair: run })
        continue
      }
      order.push({
        scenario,
        arm: 'control',
        agent: pairedOptions.controlRootAgent,
        pair: run,
      })
      order.push({
        scenario,
        arm: 'candidate',
        agent: pairedOptions.rootAgent,
        pair: run,
      })
    }
  }
  return order
}
