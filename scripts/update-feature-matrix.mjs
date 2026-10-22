#!/usr/bin/env node
// Regenerate the auto-tracked section of docs/FEATURES.md from the bridge
// route registry, test files and git history. The manually maintained status
// matrix above the markers is preserved verbatim.
//
// Usage: node scripts/update-feature-matrix.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function git(args, cwd = root) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function collectFiles(dir, base = dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, base))
    } else if (entry.isFile()) {
      files.push({ path: full.slice(base.length + 1), full })
    }
  }
  return files
}

function lastCommit(file) {
  return git(['log', '-1', '--format=%h %s', '--', file])
}

function parseRoutes() {
  const router = readFileSync(join(root, 'src', 'bridge', 'router.ts'), 'utf8')
  const stubs = readFileSync(join(root, 'src', 'bridge', 'stubs.ts'), 'utf8')
  const routes = []
  for (const match of router.matchAll(/register\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    routes.push({ method: match[1], path: match[2], kind: match[3], source: 'src/bridge/router.ts' })
  }
  for (const match of router.matchAll(/for \(const bare of \[([^\]]*)\]\)/g)) {
    const paths = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
    for (const path of paths) {
      routes.push({ method: 'GET', path, kind: 'json', source: 'src/bridge/router.ts' })
    }
  }
  for (const match of stubs.matchAll(/jsonRoute\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    routes.push({ method: match[1], path: match[2], kind: 'json', source: 'src/bridge/stubs.ts' })
  }
  routes.sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path))
  return routes
}

function testCount(source) {
  return (source.match(/\bit\(/g) ?? []).length + (source.match(/\btest\(/g) ?? []).length
}

const routes = parseRoutes()
const tests = collectFiles(join(root, 'tests'))
  .filter((file) => file.path.endsWith('.spec.ts'))
  .map((file) => ({
    path: `tests/${file.path}`,
    count: testCount(readFileSync(file.full, 'utf8')),
    commit: lastCommit(`tests/${file.path}`),
  }))
  .sort((a, b) => a.path.localeCompare(b.path))

const srcFiles = collectFiles(join(root, 'src'))
  .filter((file) => file.path.endsWith('.ts'))
  .map((file) => ({
    path: `src/${file.path}`,
    commit: lastCommit(`src/${file.path}`),
  }))
  .sort((a, b) => a.path.localeCompare(b.path))

const scriptFiles = collectFiles(join(root, 'scripts'))
  .filter((file) => file.path.endsWith('.mjs') || file.path.endsWith('.sh'))
  .map((file) => ({
    path: `scripts/${file.path}`,
    commit: lastCommit(`scripts/${file.path}`),
  }))
  .sort((a, b) => a.path.localeCompare(b.path))

const head = git(['rev-parse', '--short', 'HEAD']) || 'unknown'
const headDate = git(['log', '-1', '--format=%cs']) || ''
const routeRows = routes
  .map((route) => `| \`${route.method}\` | \`${route.path}\` | ${route.kind} | \`${route.source}\` |`)
  .join('\n')
const testRows = tests
  .map((test) => `| \`${test.path}\` | ${test.count} | ${test.commit || '—'} |`)
  .join('\n')
const sourceRows = [...srcFiles, ...scriptFiles]
  .map((file) => `| \`${file.path}\` | ${file.commit || '—'} |`)
  .join('\n')

const startMarker = '<!-- FEATURES:AUTO:START -->'
const endMarker = '<!-- FEATURES:AUTO:END -->'

// The auto-tracked block is generated in the language of the document it lands
// in, so the English default, the Japanese and the Chinese files stay in step.
const LABELS = {
  en: {
    title: 'Auto-tracked (generated)',
    note: `Run \`pnpm run features:update\` to regenerate. Generated at HEAD: \`${head}\` (${headDate}).`,
    routesTitle: 'Route registry',
    routesNote: 'Routes registered by `src/bridge/router.ts` and `src/bridge/stubs.ts`. '
      + '`/command`, `/skill`, `/reference`, `/integration` and their `/api/*` twins are registered '
      + 'dynamically in a `for` loop in the route sources, so this table lists the resolved literals '
      + 'plus the stub routes.',
    routeHeader: '| Method | Route | Kind | Source |',
    testsTitle: 'Test coverage',
    testHeader: '| Test file | Cases | Last updated |',
    sourcesTitle: 'Key implementation, last updated',
    sourceHeader: '| File | Last updated |',
  },
  ja: {
    title: '自動追跡（スクリプト生成）',
    note: `\`pnpm run features:update\` で再生成します。生成時の HEAD: \`${head}\`（${headDate}）。`,
    routesTitle: 'ルート登録表',
    routesNote: '`src/bridge/router.ts` と `src/bridge/stubs.ts` が登録するルートです。'
      + '`/command`、`/skill`、`/reference`、`/integration` とその `/api/*` 対のルートは'
      + 'ルート定義側の `for` ループで動的に登録されるため、この表には解決済みのリテラルと'
      + ' stub ルートを載せています。',
    routeHeader: '| Method | Route | Kind | ソース |',
    testsTitle: 'テストカバレッジ',
    testHeader: '| テストファイル | ケース数 | 最終更新 |',
    sourcesTitle: '主要実装の最終更新',
    sourceHeader: '| ファイル | 最終更新 |',
  },
  zh: {
    title: '自动追踪（脚本生成）',
    note: `运行 \`pnpm run features:update\` 重新生成。生成时 HEAD：\`${head}\`（${headDate}）。`,
    routesTitle: '路由注册表',
    routesNote: '来自 `src/bridge/router.ts` 与 `src/bridge/stubs.ts` 的注册路由；'
      + '`for` 循环展开的 `/command`、`/skill`、`/reference`、`/integration` 及 `/api/*` 对偶路由'
      + '会在路由源码中以 `register` 动态注册，此处列出已解析的字面量 + stub 路由。',
    routeHeader: '| Method | Route | Kind | 来源 |',
    testsTitle: '测试覆盖',
    testHeader: '| 测试文件 | 用例数 | 最后更新 |',
    sourcesTitle: '关键实现最后更新',
    sourceHeader: '| 文件 | 最后更新 |',
  },
}

function autoBlock(language) {
  const labels = LABELS[language]
  return `<!-- FEATURES:AUTO:START -->
## ${labels.title}

> ${labels.note}

### ${labels.routesTitle}

${labels.routesNote}

${labels.routeHeader}
|---|---|---|---|
${routeRows}

### ${labels.testsTitle}

${labels.testHeader}
|---|---|---|
${testRows}

### ${labels.sourcesTitle}

${labels.sourceHeader}
|---|---|
${sourceRows}
<!-- FEATURES:AUTO:END -->`
}

for (const [language, suffix] of [['en', ''], ['ja', '.ja'], ['zh', '.zh']]) {
  const path = join(root, 'docs', `FEATURES${suffix}.md`)
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    continue
  }
  const block = autoBlock(language)
  const startIndex = content.indexOf(startMarker)
  const endIndex = content.indexOf(endMarker)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    content = `${content.trimEnd()}\n\n${block.trimEnd()}\n`
  } else {
    const prefix = content.slice(0, startIndex)
    const suffixText = content.slice(endIndex + endMarker.length).trim()
    content = `${prefix}${block.trimEnd()}\n${suffixText === '' ? '' : `\n${suffixText}\n`}`
  }
  writeFileSync(path, content)
  console.log(`updated docs/FEATURES${suffix}.md (${routes.length} routes, ${tests.length} test files)`)
}
