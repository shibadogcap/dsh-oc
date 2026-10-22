#!/usr/bin/env node
// Check the documentation language set.
//
//   node scripts/check-docs-i18n.mjs
//
// English is the default language; Japanese and Chinese sit next to it. This
// script keeps the three in step: every document that should have a language
// variant has one, the switcher line at the top is the expected one, English
// files contain no CJK, and every relative link resolves.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The expected language set per document. `en+ja+zh` documents came from the
// Chinese originals; `en+ja` documents were Japanese from the start.
const expected = {
  'README.md': 'en+ja+zh',
  'AGENTS.md': 'en+ja+zh',
  'CONTRIBUTING.md': 'en+ja+zh',
  'docs/CHANGELOG.md': 'en+ja+zh',
  'docs/FEATURES.md': 'en+ja+zh',
  'docs/MANUAL-TEST.md': 'en+ja+zh',
  'docs/PLAN.md': 'en+ja+zh',
  'docs/PROTOCOL.md': 'en+ja+zh',
  'docs/RELEASE.md': 'en+ja+zh',
  'docs/ROADMAP.md': 'en+ja+zh',
  'docs/ACCEPTANCE.md': 'en+ja',
  'docs/COMPAT.md': 'en+ja',
  'docs/HANDOVER.md': 'en+ja',
  'docs/OPENCHAMBER.md': 'en+ja',
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/
const problems = []

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

function variant(file, language) {
  return file.replace(/\.md$/, `.${language}.md`)
}

/** The first line each language's file must start with. */
function expectedHeader(file, language, languages) {
  // Header links are relative to the file's own directory.
  const name = file.split('/').pop()
  const parts = []
  if (language !== 'en') parts.push(`[English](${name})`)
  else parts.push('English')
  if (languages.includes('ja')) {
    parts.push(language === 'ja' ? '日本語' : `[日本語](${variant(name, 'ja')})`)
  }
  if (languages.includes('zh')) {
    parts.push(language === 'zh' ? '中文' : `[中文](${variant(name, 'zh')})`)
  }
  return `*${parts.join(' · ')}*`
}

/** Relative markdown links, ignoring images and absolute URLs. */
function relativeLinks(markdown) {
  const links = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      if (/^(?:[a-z]+:|\/|#)/i.test(target)) continue
      links.push(target.split('#')[0])
    }
  }
  return links
}

function checkLinks(file) {
  const base = dirname(join(root, file))
  for (const link of relativeLinks(read(file))) {
    if (link.length === 0) continue
    if (!existsSync(resolve(base, link))) {
      problems.push(`${file}: link does not resolve: ${link}`)
    }
  }
}

const languagesOf = (file) => expected[file].split('+')

for (const [file, set] of Object.entries(expected)) {
  const languages = set.split('+')
  if (!existsSync(join(root, file))) {
    problems.push(`${file}: missing (English default)`)
    continue
  }
  const english = read(file)
  const header = english.split('\n', 1)[0]
  if (header !== expectedHeader(file, 'en', languages)) {
    problems.push(`${file}: English header is ${JSON.stringify(header)}, expected ${JSON.stringify(expectedHeader(file, 'en', languages))}`)
  }
  const body = english.split('\n').slice(1).join('\n')
  if (CJK.test(body)) {
    const line = body.split('\n').findIndex((value) => CJK.test(value)) + 2
    problems.push(`${file}: English file contains CJK at line ${line}`)
  }
  checkLinks(file)

  for (const language of languages.filter((value) => value !== 'en')) {
    const target = variant(file, language)
    if (!existsSync(join(root, target))) {
      problems.push(`${target}: missing (${language} variant of ${file})`)
      continue
    }
    const text = read(target)
    const first = text.split('\n', 1)[0]
    if (first !== expectedHeader(file, language, languages)) {
      problems.push(`${target}: header is ${JSON.stringify(first)}, expected ${JSON.stringify(expectedHeader(file, language, languages))}`)
    }
    checkLinks(target)
  }
}

// Every other markdown file under docs/ must at least be listed above, so a
// new document cannot silently skip its translations.
for (const entry of readdirSync(join(root, 'docs'))) {
  if (!entry.endsWith('.md')) continue
  if (/\.(ja|zh)\.md$/.test(entry)) continue
  const file = `docs/${entry}`
  if (file === 'docs/perf' || file.startsWith('docs/perf/')) continue
  if (expected[file] === undefined) problems.push(`${file}: not listed in check-docs-i18n.mjs`)
}

// Perf reports are archival: English plus the Chinese original, no Japanese.
for (const entry of readdirSync(join(root, 'docs', 'perf'))) {
  if (!entry.endsWith('.md') || /\.(ja|zh)\.md$/.test(entry)) continue
  const file = `docs/perf/${entry}`
  if (!existsSync(join(root, file.replace(/\.md$/, '.zh.md')))) {
    problems.push(`${file}: missing the Chinese original (${relative(root, join(root, file.replace(/\.md$/, '.zh.md')))})`)
  }
  if (CJK.test(read(file).split('\n').slice(1).join('\n'))) {
    problems.push(`${file}: English file contains CJK`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`)
  console.error(`\n${problems.length} documentation language problem(s)`)
  process.exit(1)
}

const documents = Object.keys(expected).length
console.log(`documentation languages: ${documents} documents checked, all variants present, headers and links consistent`)
