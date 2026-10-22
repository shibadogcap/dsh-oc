/**
 * Lazy resolution of the official opencode binary from the npm platform
 * packages (`@opencode/cli-<platform>-<arch>[-baseline][-musl]`): install the
 * matching package, copy its binary into the dsh opencode cache, verify the
 * version, and return the cached path.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { OPENCODE_BIN_ENV, OPENCODE_VERSION } from '../index.js'
import type { OpenCodeAssetsManifest } from '../types.js'
import { npmPackageNameFor } from './binary.js'
import { resolvePlatform, type PlatformSelection } from './platform.js'

const MIRROR_ENV = 'DSH_OC_OPENCODE_MIRROR'
const GITHUB_PREFIX = 'https://github.com/'

/** Response subset needed by the downloader; lets tests inject a fake fetch. */
export interface FetchLikeResponse {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Fetch injection; the default is Node's global fetch with proxy support. */
export type FetchLike = (
  input: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<FetchLikeResponse>

/** Injectable filesystem/command operations for tests. */
export interface DownloadOpenCodeOptions {
  env?: Record<string, string | undefined>
  home?: string
  version?: string
  platform?: PlatformSelection
  manifest?: OpenCodeAssetsManifest
  key?: string
  fetchImpl?: FetchLike
  spawnSyncImpl?: typeof spawnSync
  probe?: (bin: string) => string | undefined
  installNpmPackage?: (packageName: string, version: string, targetDir: string) => Promise<boolean>
}

/** A download whose integrity check failed; this is the retryable failure. */
class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrityError'
  }
}

/**
 * Rewrite a GitHub asset URL through `DSH_OC_OPENCODE_MIRROR` when set.
 * @param url - the manifest asset URL.
 * @param env - environment mapping.
 * @returns the URL to request.
 */
export function resolveAssetUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const mirror = env[MIRROR_ENV]
  if (mirror === undefined || mirror.trim().length === 0 || !url.startsWith(GITHUB_PREFIX)) return url
  return `${mirror.replace(/\/+$/, '')}/${url.slice(GITHUB_PREFIX.length)}`
}

/**
 * Resolve, install and cache the opencode binary from npm platform packages.
 * @param options - overrides for tests and non-default homes.
 * @returns the absolute path of the cached executable.
 */
export async function downloadOpenCode(options: DownloadOpenCodeOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const home = options.home ?? resolveDshHome(undefined, env)
  const version = options.version ?? OPENCODE_VERSION
  const platform = options.platform ?? resolvePlatform()
  const key = options.key ?? platform.key
  const spawnImpl = options.spawnSyncImpl ?? spawnSync
  const probe = options.probe ?? defaultProbe
  const exists = existsSync

  const target = join(home, 'opencode', 'bin', version, platform.executableName)
  if (exists(target)) {
    try {
      verifyVersion(target, version, probe)
      return target
    } catch {
      // Existing cache is wrong/stale; replace it below.
    }
  }

  const candidates = platform.candidates && platform.candidates.length > 0 ? platform.candidates : [key]
  let lastError: unknown
  for (const candidate of candidates) {
    const packageName = npmPackageNameFor(candidate)
    const tmpBase = join(home, 'opencode', 'tmp')
    const archivePath = join(tmpBase, randomUUID())
    void archivePath
    const installDir = join(home, 'opencode', 'packages', candidate)
    mkdirSync(tmpBase, { recursive: true })
    try {
      let installed = false
      if (options.installNpmPackage !== undefined) {
        installed = await options.installNpmPackage(packageName, version, installDir)
        if (installed) {
          const src = join(installDir, 'node_modules', packageName, 'bin', platform.executableName)
          if (exists(src)) {
            mkdirSync(dirname(target), { recursive: true })
            if (exists(target)) rmSync(target, { force: true })
            try {
              linkSync(src, target)
            } catch {
              // Fall back to copy when hard links are unavailable.
              const { copyFileSync } = await import('node:fs')
              copyFileSync(src, target)
            }
            chmodSync(target, 0o755)
          }
        }
      } else {
        const temp = join(tmpBase, randomUUID())
        mkdirSync(temp, { recursive: true })
        try {
          const result = spawnImpl(
            'npm',
            [
              'install',
              '--ignore-scripts',
              '--no-save',
              '--no-audit',
              '--no-fund',
              '--loglevel=error',
              '--prefix',
              temp,
              `${packageName}@${version}`,
            ],
            { stdio: 'ignore', windowsHide: true, timeout: 120_000 } as never,
          )
          if (result.error === undefined && result.status === 0) {
            const src = join(temp, 'node_modules', packageName, 'bin', platform.executableName)
            if (exists(src)) {
              mkdirSync(dirname(target), { recursive: true })
              if (exists(target)) rmSync(target, { force: true })
              try {
                linkSync(src, target)
              } catch {
                const { copyFileSync } = await import('node:fs')
                copyFileSync(src, target)
              }
              chmodSync(target, 0o755)
              installed = true
            }
          }
          // Fall back to pnpm if npm failed.
          if (!installed) {
            const pnpmResult = spawnImpl(
              'pnpm',
              ['install', '--ignore-scripts', '--no-save', '--dir', temp, `${packageName}@${version}`],
              { stdio: 'ignore', windowsHide: true, timeout: 120_000 } as never,
            )
            if (pnpmResult.error === undefined && pnpmResult.status === 0) {
              const src = join(temp, 'node_modules', packageName, 'bin', platform.executableName)
              if (exists(src)) {
                mkdirSync(dirname(target), { recursive: true })
                if (exists(target)) rmSync(target, { force: true })
                try {
                  linkSync(src, target)
                } catch {
                  const { copyFileSync } = await import('node:fs')
                  copyFileSync(src, target)
                }
                chmodSync(target, 0o755)
                installed = true
              }
            }
          }
        } finally {
          rmSync(temp, { recursive: true, force: true })
        }
      }

      if (!installed || !exists(target)) {
        throw new Error(`failed to install ${packageName}@${version}`)
      }
      verifyVersion(target, version, probe)
      rmSync(tmpBase, { recursive: true, force: true })
      return target
    } catch (error) {
      lastError = error
      rmSync(tmpBase, { recursive: true, force: true })
      continue
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Failed to download opencode ${version} (asset ${key}): ${message}\n`
      + `You can recover by:\n`
      + `  - setting ${OPENCODE_BIN_ENV} to an absolute path of a working opencode binary,\n`
      + `  - running: dsh plugin --profile oc add opencode-ai@2.1.0 (or @opencode/cli@2.1.0)\n`
      + `  - or manually downloading the @opencode/cli platform package and placing the executable at ${target}`,
  )
}

function readAssetsManifest(): OpenCodeAssetsManifest {
  throw new Error('opencode-assets.json has been removed; resolve from npm platform packages')
}

// Keep the old helper exported for compatibility with callers/tests.
export { readAssetsManifest }

function verifyVersion(bin: string, version: string, probe?: (bin: string) => string | undefined): void {
  const probeImpl = probe ?? defaultProbe
  let output: string | undefined
  try {
    output = probeImpl(bin)
  } catch {
    output = undefined
  }
  if (output === undefined || !output.includes(version)) {
    throw new Error(
      `extracted binary at ${bin} did not report opencode ${version} (got ${JSON.stringify(output)})`,
    )
  }
}

function defaultProbe(bin: string): string | undefined {
  try {
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.error !== undefined || result.status !== 0) return undefined
    return String(result.stdout ?? '')
  } catch {
    return undefined
  }
}