import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// The OpenChamber UI renders live updates by running every wire event through
// its own reducer. This test feeds the bridge's event stream into that
// reducer, using bun to run OpenChamber's TypeScript directly. It is skipped
// when no bridge is listening or bun is unavailable.
const bridge = process.env.DSH_OC_E2E_BRIDGE ?? 'http://127.0.0.1:41800'

async function bridgeReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${bridge}/api/info`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

function bunAvailable(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('e2e: the OpenChamber reducer understands the bridge events', () => {
  it('turns the bridge event stream into real sync events', async (context) => {
    if (!await bridgeReachable() || !bunAvailable()) {
      context.skip()
      return
    }
    const output = execFileSync(
      'bun',
      ['scripts/e2e-openchamber-events.ts', '--bridge', bridge],
      { encoding: 'utf8' },
    )
    expect(output).toContain('RESULT: PASS')
    // The reducer must produce more than a status ping.
    expect(output).toContain('message.updated')
  }, 60_000)
})
