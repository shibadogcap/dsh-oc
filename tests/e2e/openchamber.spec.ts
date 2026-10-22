import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// The OpenChamber UI boots by calling a fixed set of bridge routes. This test
// drives a live bridge through exactly those calls, plus the prompt flow the
// UI runs when the user sends a message. It is skipped when no bridge is
// listening, so the unit suite still runs on a machine without dsh.
const bridge = process.env.DSH_OC_E2E_BRIDGE ?? 'http://127.0.0.1:41800'

async function bridgeReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${bridge}/api/info`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

describe('e2e: the OpenChamber UI bootstrap against a live bridge', () => {
  // The bootstrap drives two dozen HTTP calls against a live bridge; the
  // default 5s timeout is too tight when the suite runs in parallel.
  it('answers every bootstrap call and the prompt flow', async (context) => {
    if (!await bridgeReachable()) {
      context.skip()
      return
    }
    const output = execFileSync(
      process.execPath,
      ['scripts/e2e-openchamber-bootstrap.mjs', '--bridge', bridge, '--out', '/tmp/dsh-oc-bootstrap-e2e.txt'],
      { encoding: 'utf8' },
    )
    expect(output).toBe('')
  }, 60_000)
})
