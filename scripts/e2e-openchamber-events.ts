#!/usr/bin/env bun
// Decisive event-layer E2E: feed the bridge's SSE stream through OpenChamber's
// OWN wire-event reducer and check that it produces real sync events.
//
//   bun scripts/e2e-openchamber-events.ts --bridge http://127.0.0.1:41800
//
// The reducer is the code path the OpenChamber UI runs for every event it
// receives. If it returns meaningful SyncEvents, the UI has what it needs to
// render live updates.
import { translateWireEvent } from '/data/dsh-ocplus/openchamber/packages/ui/src/lib/opencode/events.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]!
}

const bridge = option('--bridge', 'http://127.0.0.1:41800').replace(/\/$/, '')
const settleMs = Number(option('--settle', '8000'))

const controller = new AbortController()
const response = await fetch(`${bridge}/api/event`, {
  headers: { accept: 'text/event-stream' },
  signal: controller.signal,
})
if (!response.ok) {
  console.error(`event stream -> ${response.status}`)
  process.exit(1)
}
const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

const wireTypes: string[] = []
const syncTypes: string[] = []
let syncPayloads: string[] = []
/** Every sync event with its properties, so the revert patches can be read. */
const syncEvents: Array<{ type: string; properties: any }> = []

const decode = (frame: string): void => {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data: ')) continue
    let parsed: any
    try {
      parsed = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    const type = parsed?.type ?? parsed?.payload?.type
    if (typeof type !== 'string') continue
    wireTypes.push(type)
    let sync: ReturnType<typeof translateWireEvent>
    try {
      sync = translateWireEvent(parsed)
    } catch (error) {
      syncPayloads.push(`THREW ${type}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const event of sync) {
      syncTypes.push(event.type)
      syncEvents.push({ type: event.type, properties: event.properties })
      if (syncPayloads.length < 12) {
        syncPayloads.push(`${event.type} ${JSON.stringify(event.properties).slice(0, 120)}`)
      }
    }
  }
}

const pump = (async () => {
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        decode(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
      }
    }
  } catch {
    // The stream is aborted at the end of the run.
  }
})()

await new Promise((resolve) => setTimeout(resolve, 500))

// Create a session and prompt it, so the bridge produces a full turn.
const created = await fetch(`${bridge}/api/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: 'minimal' }),
})
const session = (await created.json()).data
await fetch(`${bridge}/api/session/${session.id}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'msg_events_1', text: 'events please' }),
})

await new Promise((resolve) => setTimeout(resolve, settleMs))

// The revert flow: stage a boundary, clear it, then stage and commit it.
// The three `session.revert.*` events are what the OpenChamber UI needs to
// show the boundary marker and trim the transcript.
const messages = await fetch(`${bridge}/api/session/${session.id}/message`).then((r) => r.json())
const boundary = messages?.data?.[0]?.id
if (typeof boundary === 'string') {
  const stage = await fetch(`${bridge}/api/session/${session.id}/revert/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: boundary }),
  })
  console.log(`revert stage -> ${stage.status}`)
  await fetch(`${bridge}/api/session/${session.id}/revert`, { method: 'DELETE' })
  await fetch(`${bridge}/api/session/${session.id}/revert/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: boundary }),
  })
  const commit = await fetch(`${bridge}/api/session/${session.id}/revert/commit`, { method: 'POST' })
  console.log(`revert commit -> ${commit.status}`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
} else {
  console.log('revert stage -> SKIPPED (no message id in the transcript)')
}

controller.abort()
await pump

const uniqueWire = [...new Set(wireTypes)].sort()
const uniqueSync = [...new Set(syncTypes)].sort()

console.log(`wire event types (${uniqueWire.length}):`)
for (const type of uniqueWire) console.log(`  ${type}`)
console.log('')
console.log(`OpenChamber sync events (${uniqueSync.length}):`)
for (const type of uniqueSync) console.log(`  ${type}`)
console.log('')
console.log('sample sync events:')
for (const payload of syncPayloads) console.log(`  ${payload}`)

const understood = uniqueSync.filter((type) => type !== 'session.status')
const ok = understood.length > 0

// The reducer maps `session.revert.staged` and `session.revert.cleared` to a
// `session.patched` that carries the revert marker, and
// `session.revert.committed` to its own sync event. Both have to show up,
// otherwise the OpenChamber UI never learns about the boundary.
const revertPatches = syncEvents.filter(
  (event) => event.type === 'session.patched' && event.properties?.patch?.revert !== undefined,
)
const staged = revertPatches.filter((event) => event.properties.patch.revert !== null)
const cleared = revertPatches.filter((event) => event.properties.patch.revert === null)
const committed = syncEvents.filter((event) => event.type === 'session.revert.committed')

const missingRevert: string[] = []
if (staged.length === 0) missingRevert.push('session.revert.staged')
if (cleared.length === 0) missingRevert.push('session.revert.cleared')
if (committed.length === 0) missingRevert.push('session.revert.committed')
if (missingRevert.length > 0) {
  console.log('')
  console.log(`missing revert sync events: ${missingRevert.join(', ')}`)
} else {
  console.log('')
  console.log(`revert sync events: staged=${staged.length} cleared=${cleared.length} committed=${committed.length}`)
}

console.log('')
console.log(ok && missingRevert.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(ok && missingRevert.length === 0 ? 0 : 1)
