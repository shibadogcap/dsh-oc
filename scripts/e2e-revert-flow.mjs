#!/usr/bin/env node
// E2E of the OpenCode 2.x revert flow against a live bridge.
//
//   node scripts/e2e-revert-flow.mjs --bridge http://127.0.0.1:41800
//
// The flow is the one the official TUI and the OpenChamber UI run:
//
//   1. stage a boundary  -> the session record carries the boundary
//   2. clear the boundary -> the record drops it again
//   3. stage and commit  -> the transcript is cut at the boundary
//   4. prompt again       -> the new turn lands in the same session
//
// The cut is exclusive: the boundary message and everything after it are
// dropped, and the messages before it keep their ids.
//
// The transcript holds assistant messages between the user messages the
// prompts mint (a real model answers them), so the checks count user messages
// and compare the whole transcript against its own prefix: whatever survived
// must be exactly the part before the boundary, assistant replies included.
import { writeFileSync } from 'node:fs'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const bridge = option('--bridge', 'http://127.0.0.1:41800').replace(/\/$/, '')
const out = option('--out', '/tmp/dsh-oc-revert-e2e.txt')
const settle = Number(option('--settle', '1500'))
const waitLimit = Number(option('--wait', '30000'))

async function call(method, path, body) {
  const response = await fetch(bridge + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`)
}

const created = await call('POST', '/api/session', { agent: 'minimal' })
if (created.status !== 200) {
  console.error(`session create -> ${created.status}`)
  process.exit(1)
}
const sessionId = created.body.data.id

const transcript = async () => (await call('GET', `/api/session/${sessionId}/message`)).body.data ?? []
const idsOf = (messages) => messages.map((message) => message.id)
const userIDs = (messages) => messages.filter((message) => message.type === 'user').map((message) => message.id)

/** Poll the transcript until `predicate` holds or the wait budget runs out. */
async function until(predicate) {
  const started = Date.now()
  let messages = await transcript()
  while (!predicate(messages) && Date.now() - started < waitLimit) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    messages = await transcript()
  }
  return messages
}

/**
 * Wait for the transcript to settle. Committing a revert forks the session and
 * repoints the bridge's alias, so one read can still return the outgoing
 * projection (the boundary message dropped, its reply not yet); the settled
 * view is the one a client renders.
 */
async function settled() {
  const started = Date.now()
  let previous
  while (Date.now() - started < waitLimit) {
    const messages = await transcript()
    const key = idsOf(messages).join(',')
    if (key === previous) return messages
    previous = key
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return transcript()
}

for (const [index, id] of ['u1', 'u2', 'u3'].entries()) {
  await call('POST', `/api/session/${sessionId}/prompt`, { id, text: `turn ${index + 1}` })
  await new Promise((resolve) => setTimeout(resolve, settle))
}

// Reverting is a client action on an idle session, so let the turns finish
// before cutting: a boundary committed mid-stream would race the reply the
// turn is still writing.
const idle = await call('POST', `/api/session/${sessionId}/wait`, {})
check('the session reached idle', idle.status === 204, `status=${idle.status}`)

const beforeRevert = await settled()
const beforeRevertIDs = idsOf(beforeRevert)
check(
  'three prompts recorded',
  userIDs(beforeRevert).join(',') === 'u1,u2,u3',
  idsOf(beforeRevert).join(','),
)

// 1. stage
const stage = await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u2' })
check('stage answered 200', stage.status === 200, JSON.stringify(stage.body?.data))
const record = (await call('GET', `/api/session/${sessionId}`)).body.data
check('the session record carries the boundary', record?.revert?.messageID === 'u2', JSON.stringify(record?.revert))

// 2. clear
const cleared = await call('DELETE', `/api/session/${sessionId}/revert`)
check('clear answered 204', cleared.status === 204)
const clearedRecord = (await call('GET', `/api/session/${sessionId}`)).body.data
check('the session record drops the boundary', clearedRecord?.revert === undefined)

// 3. stage and commit. The transcript must keep exactly the part of the
// pre-revert transcript that precedes the boundary: assistant replies included,
// the boundary and everything after it dropped.
const boundaryAt = beforeRevertIDs.indexOf('u2')
const surviving = beforeRevertIDs.slice(0, boundaryAt)
await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u2' })
const commit = await call('POST', `/api/session/${sessionId}/revert/commit`)
check('commit answered 204', commit.status === 204)
const afterRevert = await settled()
const afterRevertIDs = idsOf(afterRevert)
check(
  'the transcript is cut at the boundary',
  afterRevertIDs.join(',') === surviving.join(','),
  `${afterRevertIDs.join(',')} (expected ${surviving.join(',')})`,
)
check('the surviving message keeps its id', afterRevertIDs.includes('u1'), afterRevertIDs.join(','))

// 4. the next prompt lands in the same session
await call('POST', `/api/session/${sessionId}/prompt`, { id: 'u4', text: 'after the revert' })
const afterPrompt = await until((messages) => userIDs(messages).includes('u4'))
const afterPromptIDs = idsOf(afterPrompt)
check('the new turn is in the same session', afterPromptIDs.includes('u4'), afterPromptIDs.join(','))
check(
  'the reverted messages stayed gone',
  !afterPromptIDs.includes('u2') && !afterPromptIDs.includes('u3'),
  afterPromptIDs.join(','),
)
await call('POST', `/api/session/${sessionId}/wait`, {})

// 5. a second revert in the same session
const beforeSecond = idsOf(await settled())
const secondBoundaryAt = beforeSecond.indexOf('u4')
const secondSurviving = secondBoundaryAt < 0 ? beforeSecond : beforeSecond.slice(0, secondBoundaryAt)
await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u4' })
await call('POST', `/api/session/${sessionId}/revert/commit`)
const afterSecondIDs = idsOf(await settled())
check(
  'a second revert cuts again',
  !afterSecondIDs.includes('u4') && afterSecondIDs.includes('u1'),
  afterSecondIDs.join(','),
)
check(
  'the second cut matches the prefix',
  secondBoundaryAt < 0 || afterSecondIDs.join(',') === secondSurviving.join(','),
  `${afterSecondIDs.join(',')} (expected ${secondSurviving.join(',')})`,
)

// 6. the session is published under the id the client knows
const list = (await call('GET', '/api/session')).body.data
const published = list.filter((item) => item.id === sessionId)
check('the session keeps its id in the list', published.length === 1, `count=${published.length}`)

const failed = results.filter((entry) => !entry.ok)
const summary = [
  `${results.length - failed.length}/${results.length} revert checks passed`,
  failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.map((entry) => entry.label).join(', ')})`,
  '',
].join('\n')
console.log('')
console.log(summary.trim())
writeFileSync(out, `${summary}\n`)
process.exit(failed.length === 0 ? 0 : 1)
