import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadOpenCode, resolveAssetUrl } from '../../src/tui/download.ts'
import type { PlatformSelection } from '../../src/tui/platform.ts'

const linuxPlatform: PlatformSelection = {
  platform: 'linux',
  arch: 'x64',
  musl: false,
  avx2: true,
  candidates: ['linux-x64'],
  key: 'linux-x64',
  extension: '.tar.gz',
  executableName: 'opencode',
}

const homes: string[] = []

beforeEach(() => {})

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-home-'))
  homes.push(home)
  return home
}

describe('downloadOpenCode', () => {
  it('installs, caches and returns the binary path', async () => {
    const home = newHome()
    const install = async (packageName: string, version: string, targetDir: string) => {
      const bin = join(targetDir, 'node_modules', packageName, 'bin', 'opencode')
      mkdirSync(join(targetDir, 'node_modules', packageName, 'bin'), { recursive: true })
      writeFileSync(bin, '#!/bin/sh\nprintf "opencode 2.1.0\\n"\n')
      chmodSync(bin, 0o755)
      return true
    }

    const target = await downloadOpenCode({
      env: { DSH_HOME: home },
      version: '2.1.0',
      platform: linuxPlatform,
      installNpmPackage: install,
    })

    expect(target).toBe(join(home, 'opencode', 'bin', '2.1.0', 'opencode'))
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })

  it('uses a preinstalled cache when present', async () => {
    const home = newHome()
    const target = join(home, 'opencode', 'bin', '2.1.0', 'opencode')
    mkdirSync(join(home, 'opencode', 'bin', '2.1.0'), { recursive: true })
    writeFileSync(target, '#!/bin/sh\nprintf "opencode 2.1.0\\n"\n')
    chmodSync(target, 0o755)

    const install = async () => false
    const result = await downloadOpenCode({
      env: { DSH_HOME: home },
      version: '2.1.0',
      platform: linuxPlatform,
      installNpmPackage: install,
    })
    expect(result).toBe(target)
  })

  it('throws and includes recovery suggestions on failure', async () => {
    const home = newHome()
    const install = async () => false
    await expect(
      downloadOpenCode({
        env: { DSH_HOME: home },
        version: '2.1.0',
        platform: linuxPlatform,
        installNpmPackage: install,
      }),
    ).rejects.toThrow(/DSH_OC_OPENCODE_BIN/)
  })
})

describe('resolveAssetUrl', () => {
  it('leaves non-GitHub and unmirrored URLs unchanged', () => {
    expect(resolveAssetUrl('https://example.com/x.tar.gz', {})).toBe('https://example.com/x.tar.gz')
    expect(resolveAssetUrl('https://github.com/a/b', { DSH_OC_OPENCODE_MIRROR: '' })).toBe('https://github.com/a/b')
  })

  it('normalizes a trailing slash on the mirror base', () => {
    expect(resolveAssetUrl('https://github.com/a/b', { DSH_OC_OPENCODE_MIRROR: 'https://mirror/' }))
      .toBe('https://mirror/a/b')
  })
})