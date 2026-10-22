import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// The official OpenCode 2.1.0 client calls 137 routes. Every one of them
// must be answered by the bridge, or the OpenChamber UI sees a transport
// error instead of data. `scripts/check-client-routes.mjs` compares the two
// surfaces; this test fails the build when they drift apart.
describe('contract: the bridge answers every route the official client calls', () => {
  it('registers no missing client route', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/check-client-routes.mjs'],
      { encoding: 'utf8' },
    )
    expect(output).toContain('missing: 0')
  })
})
