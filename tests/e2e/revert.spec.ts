import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// The OpenCode 2.x revert flow against a live bridge: stage a boundary, clear
// it, commit it, and prompt again. The cut is exclusive, so the boundary
// message and everything after it are dropped while the messages before it
// keep their ids. The test is skipped when no bridge is listening, so the
// unit suite still runs on a machine without dsh.
const bridge = process.env.DSH_OC_E2E_BRIDGE ?? 'http://127.0.0.1:41800'

async function bridgeReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${bridge}/api/info`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

describe('e2e: the OpenCode revert flow against a live bridge', () => {
  it('stages, clears and commits a revert boundary', async (context) => {
    if (!await bridgeReachable()) {
      context.skip()
      return
    }
    // The flow waits for three model turns, so the default timeout is too
    // tight when the suite runs in parallel.
    execFileSync(
      process.execPath,
      ['scripts/e2e-revert-flow.mjs', '--bridge', bridge, '--out', '/tmp/dsh-oc-revert-e2e.txt'],
      { encoding: 'utf8' },
    )
  }, 120_000)
})
