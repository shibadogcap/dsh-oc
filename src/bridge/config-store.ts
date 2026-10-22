/**
 * The one writable server setting: the default shell.
 *
 * The 2.1.0 client only writes `{ shell }` (`PATCH /api/experimental/config`),
 * and reads the choices from `GET /api/config/shell`. dsh owns models, agents
 * and permissions, so those stay read-only; this file persists the shell choice
 * next to the isolated OpenCode config and nothing else.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface StoredServerConfig {
  shell?: string | null
}

export interface ShellOption {
  path: string
  name: string
  acceptable: boolean
}

/** `$DSH_HOME/opencode/config/opencode.json` — the official server config name. */
export function serverConfigPath(home: string = resolveDshHome(undefined, process.env)): string {
  return join(home, 'opencode', 'config', 'opencode.json')
}

export function readServerConfig(path: string = serverConfigPath()): StoredServerConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const shell = (parsed as { shell?: unknown }).shell
    return typeof shell === 'string' || shell === null ? { shell } : {}
  } catch {
    return {}
  }
}

/** Merge one patch into the stored config and replace the file atomically. */
export function writeServerConfig(
  patch: StoredServerConfig,
  path: string = serverConfigPath(),
): StoredServerConfig {
  const next = { ...readServerConfig(path), ...patch }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return next
}

function acceptable(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** `/etc/shells` plus `$SHELL`, deduplicated, with existence checked. */
export function availableShells(env: NodeJS.ProcessEnv = process.env): ShellOption[] {
  const paths = new Set<string>()
  const current = env.SHELL
  if (current !== undefined && current !== '') paths.add(current)
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const value = line.trim()
      if (value === '' || value.startsWith('#')) continue
      paths.add(value)
    }
  } catch {
    // No /etc/shells (macOS keeps it in /etc/shells too, but be tolerant).
  }
  // Windows has no shell list; the process shell is the only answer.
  return [...paths]
    .filter((path) => existsSync(path) || process.platform === 'win32')
    .map((path) => ({ path, name: basename(path), acceptable: acceptable(path) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export type ShellPatch =
  | { ok: true; shell: string | null }
  | { ok: false; message: string }

/**
 * Validate and persist one `{ shell }` patch.
 *
 * The client only offers shells from `availableShells()`, so a value outside
 * that list means a hand-written request; refusing it keeps the setting
 * meaningful instead of storing a path that cannot run.
 */
export function applyShell(value: unknown): ShellPatch {
  if (value !== null && typeof value !== 'string') {
    return { ok: false, message: 'shell must be a string or null' }
  }
  if (typeof value === 'string') {
    const option = availableShells().find((entry) => entry.path === value)
    if (option === undefined || !option.acceptable) {
      return { ok: false, message: `shell is not available: ${value}` }
    }
  }
  writeServerConfig({ shell: value })
  return { ok: true, shell: value }
}
