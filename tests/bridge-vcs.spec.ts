import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { vcsBase, vcsDiff, vcsInfo, vcsStatus } from '../src/bridge/vcs.js'
import { fakeApi } from './helpers.js'

// dsh owns the working copy, so the bridge only reads git state. These tests run
// real git in a temporary repository: the sidebar branch label and the diff
// viewer's working/branch/committed modes depend on the shapes matching.
const servers: BridgeServerHandle[] = []
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-vcs-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim()
  git('init', '-b', 'main')
  writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return { dir, git }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('vcs: read-only git state', () => {
  it('reports the branch and the default branch', () => {
    const { dir } = repository()
    expect(vcsInfo(dir)).toEqual({
      provider: 'git',
      branch: { current: 'main', default: 'main' },
    })
  })

  it('reports nothing outside a worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-novcs-'))
    expect(vcsInfo(dir)).toBeUndefined()
    expect(vcsBase(dir)).toBeUndefined()
    expect(vcsStatus(dir)).toEqual([])
    expect(vcsDiff(dir, 'working', undefined, 3)).toEqual([])
  })

  it('lists modified and untracked files with line counts', () => {
    const { dir } = repository()
    writeFileSync(join(dir, 'tracked.txt'), 'one\nTWO\n')
    writeFileSync(join(dir, 'fresh.txt'), 'alpha\nbeta\n')
    const status = vcsStatus(dir)
    const tracked = status.find((entry) => entry.file === 'tracked.txt')
    const fresh = status.find((entry) => entry.file === 'fresh.txt')
    expect(tracked).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(fresh).toMatchObject({ status: 'added' })
  })

  it('returns per-file patches for the working mode, untracked files included', () => {
    const { dir } = repository()
    writeFileSync(join(dir, 'tracked.txt'), 'one\nTWO\n')
    writeFileSync(join(dir, 'fresh.txt'), 'alpha\n')
    const diffs = vcsDiff(dir, 'working', undefined, 3)
    const tracked = diffs.find((entry) => entry.file === 'tracked.txt')
    const fresh = diffs.find((entry) => entry.file === 'fresh.txt')
    expect(tracked?.patch).toContain('+TWO')
    expect(tracked?.status).toBe('modified')
    expect(fresh?.patch).toContain('+alpha')
    expect(fresh?.status).toBe('added')
  })

  it('bases branch and committed diffs on the merge base', () => {
    const { dir, git } = repository()
    const root = git('rev-parse', 'HEAD')
    const base = vcsBase(dir)
    expect(base).toEqual({ name: 'main', ref: root, source: 'default' })
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\nthree\n')
    git('commit', '-am', 'second')
    const committed = vcsDiff(dir, 'committed', root, 3)
    expect(committed.map((entry) => entry.file)).toEqual(['tracked.txt'])
    expect(committed[0]?.patch).toContain('+three')
  })

  it('serves the branch through the HTTP route', async () => {
    const { dir } = repository()
    const router = createBridgeRouter(fakeApi(), { cwd: dir })
    const server = await startBridgeServer(router)
    servers.push(server)
    const body = (await (await fetch(`${server.url}/api/vcs`)).json()) as {
      data: { branch: { current: string } } | null
    }
    expect(body.data?.branch.current).toBe('main')
  })
})
