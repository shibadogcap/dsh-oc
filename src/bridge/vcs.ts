/**
 * Read-only git state for the OpenCode UI.
 *
 * dsh owns the working copy, so the bridge never writes to it: every command
 * here is a query (`rev-parse`, `status`, `diff`, `merge-base`, `branch`). A
 * directory that is not inside a worktree yields `undefined`/empty results, and
 * the UI hides the git section, which is what it does for a non-repository.
 *
 * The shapes match the OpenCode 2.1.0 client (`VcsInfo`, `VcsBase`,
 * `VcsFileStatus`, `FileDiffInfo`) so the sidebar branch label and the diff
 * viewer's working/branch/committed modes work.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface GitVcsInfo {
  provider: string
  branch: { current?: string; default?: string }
}

export interface GitVcsBase {
  name: string
  ref: string
  source: 'reflog' | 'default'
}

export interface GitFileStatus {
  file: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

export interface GitFileDiff extends GitFileStatus {
  patch: string
}

/** Per-command budget: the UI asks on open and after each turn. */
const TIMEOUT_MS = 5_000
const MAX_BUFFER = 16 * 1024 * 1024
/** Cap the response so one huge diff cannot stall the TUI. */
const MAX_FILES = 200
const MAX_UNTRACKED_BYTES = 256 * 1024

interface GitResult {
  ok: boolean
  out: string
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error !== undefined || result.status !== 0) return { ok: false, out: '' }
  return { ok: true, out: result.stdout ?? '' }
}

/** Resolve the location the client asked about, or the bridge cwd. */
export function vcsDirectory(requested: string | null | undefined, cwd: string): string {
  const candidate = requested !== null && requested !== undefined && requested !== '' ? requested : cwd
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
  try {
    return statSync(absolute).isDirectory() ? absolute : cwd
  } catch {
    return cwd
  }
}

export function isGitWorktree(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true'
}

function branchName(cwd: string): string | undefined {
  const name = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  if (name === '' || name === 'HEAD') {
    // Detached HEAD: the short commit is the only useful label.
    const short = git(cwd, ['rev-parse', '--short', 'HEAD']).out.trim()
    return short === '' ? undefined : short
  }
  return name
}

function defaultBranch(cwd: string): string | undefined {
  const remote = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out.trim()
  if (remote !== '') return remote.replace(/^[^/]+\//, '')
  for (const name of ['main', 'master']) {
    if (git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name
  }
  return undefined
}

/** `GET /api/vcs` — `null` outside a worktree, like the official server. */
export function vcsInfo(cwd: string): GitVcsInfo | undefined {
  if (!isGitWorktree(cwd)) return undefined
  const current = branchName(cwd)
  const fallback = defaultBranch(cwd)
  return {
    provider: 'git',
    branch: {
      ...(current === undefined ? {} : { current }),
      ...(fallback === undefined ? {} : { default: fallback }),
    },
  }
}

/**
 * `GET /api/vcs/base` — the ref the diff viewer compares against.
 *
 * The default branch's merge base is what "branch" and "committed" mean for a
 * working tree; a repository without a default branch falls back to its first
 * commit so the modes still show the whole history instead of nothing.
 */
export function vcsBase(cwd: string): GitVcsBase | undefined {
  if (!isGitWorktree(cwd)) return undefined
  const name = defaultBranch(cwd)
  if (name !== undefined) {
    const merged = git(cwd, ['merge-base', 'HEAD', name]).out.trim()
    if (merged !== '') return { name, ref: merged, source: 'default' }
  }
  const root = git(cwd, ['rev-list', '--max-parents=0', 'HEAD']).out.trim().split('\n')[0]
  if (root === undefined || root === '') return undefined
  return { name: 'root', ref: root, source: 'reflog' }
}

/** `GET /api/vcs/branch` — local branches, the base picker's list. */
export function vcsBranches(cwd: string): string[] {
  if (!isGitWorktree(cwd)) return []
  const out = git(cwd, ['branch', '--format=%(refname:short)']).out
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_FILES)
}

interface ChangedFile {
  file: string
  status: 'added' | 'deleted' | 'modified'
}

/** `git status --porcelain` for tracked changes, untracked files included. */
function changedFiles(cwd: string): ChangedFile[] {
  const out = git(cwd, ['status', '--porcelain=v1']).out
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let file = line.slice(3)
    // Renames and copies are reported as `old -> new`; the new path is what the
    // UI can open.
    const arrow = file.indexOf(' -> ')
    if (arrow >= 0) file = file.slice(arrow + 4)
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)
    const status = code.includes('A') || code === '??'
      ? 'added'
      : code.includes('D')
        ? 'deleted'
        : 'modified'
    files.push({ file, status })
    if (files.length >= MAX_FILES) break
  }
  return files
}

/** Path → added/deleted line counts from `git diff --numstat`. */
function numstat(cwd: string, args: readonly string[]): Map<string, { additions: number; deletions: number }> {
  const out = git(cwd, ['diff', '--numstat', ...args]).out
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of out.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = Number.parseInt(parts[0] ?? '', 10)
    const deletions = Number.parseInt(parts[1] ?? '', 10)
    counts.set(parts[2] as string, {
      additions: Number.isNaN(additions) ? 0 : additions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
    })
  }
  return counts
}

/** `GET /api/vcs/status` — the changed-file list with line counts. */
export function vcsStatus(cwd: string): GitFileStatus[] {
  if (!isGitWorktree(cwd)) return []
  const counts = numstat(cwd, ['HEAD'])
  return changedFiles(cwd).map(({ file, status }) => {
    const count = counts.get(file)
    return {
      file,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      status,
    }
  })
}

function diffArgs(
  cwd: string,
  mode: 'working' | 'branch' | 'committed',
  base: string | undefined,
  context: number,
): string[] | undefined {
  const unified = `--unified=${Number.isFinite(context) && context >= 0 ? Math.min(context, 50) : 3}`
  const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok
  if (mode === 'working') {
    // Unstaged and staged changes against the last commit; a repository without
    // commits compares the index instead.
    return [...(head ? ['HEAD'] : []), unified]
  }
  const ref = base ?? vcsBase(cwd)?.ref
  if (ref === undefined) return undefined
  if (mode === 'branch') return [`${ref}...HEAD`, unified]
  return [ref, unified]
}

/**
 * `GET /api/vcs/diff` — per-file patches for the diff viewer.
 *
 * Working mode also lists untracked files, which git's diff never reports; they
 * are rendered as an all-added patch so a new file shows up where the user
 * expects it.
 */
export function vcsDiff(
  cwd: string,
  mode: 'working' | 'branch' | 'committed',
  base: string | undefined,
  context: number,
): GitFileDiff[] {
  if (!isGitWorktree(cwd)) return []
  const args = diffArgs(cwd, mode, base, context)
  if (args === undefined) return []
  const nameStatus = git(cwd, ['diff', '--name-status', ...args]).out
  const files: ChangedFile[] = []
  for (const line of nameStatus.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const code = (parts[0] ?? '').slice(0, 1)
    const file = parts[parts.length - 1] as string
    files.push({
      file,
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
    })
    if (files.length >= MAX_FILES) break
  }
  const counts = numstat(cwd, args)
  const diffs: GitFileDiff[] = files.map(({ file, status }) => {
    const patch = git(cwd, ['diff', ...args, '--', file]).out
    const count = counts.get(file)
    return {
      file,
      patch,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      status,
    }
  })
  if (mode === 'working') {
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).out
    for (const file of untracked.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)) {
      if (diffs.length >= MAX_FILES) break
      const patch = untrackedPatch(cwd, file)
      if (patch === undefined) continue
      const lines = patch.split('\n').length - 1
      diffs.push({ file, patch, additions: lines, deletions: 0, status: 'added' })
    }
  }
  return diffs
}

/** An all-added patch for an untracked text file, or undefined when unreadable. */
function untrackedPatch(cwd: string, file: string): string | undefined {
  try {
    const absolute = resolve(cwd, file)
    const info = statSync(absolute)
    if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return undefined
    const text = readFileSync(absolute, 'utf8')
    if (text.includes('\u0000')) return undefined
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return [
      `--- /dev/null`,
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n')
  } catch {
    return undefined
  }
}
