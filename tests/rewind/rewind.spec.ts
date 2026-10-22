import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSnapshots, unifiedDiff } from '../../src/rewind/index.js'

// The rewind plugin keeps the file copies dsh has no seam for. The transcript
// half is dsh's `sessionController.fork`, so only the file half is tested here.
//
// The snapshots are grouped per turn, because OpenCode's revert rolls back the
// files of the turns *after* the boundary message.
describe('rewind: the file snapshot half', () => {
  it('restores the content a turn changed', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'before\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'after\n')
      expect(readFileSync(file, 'utf8')).toBe('after\n')

      const restored = files.restore('s1', { turn: 0, includeTurn: true })
      expect(restored).toEqual(['a.ts'])
      expect(readFileSync(file, 'utf8')).toBe('before\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('removes a file the turn created', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'new.ts')
      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'created\n')
      files.restore('s1', { turn: 0, includeTurn: true })
      expect(() => readFileSync(file, 'utf8')).toThrow()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('keeps the first capture when a path changes twice', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'first\n')
      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'second\n')
      files.capture('s1', file)
      writeFileSync(file, 'third\n')
      files.restore('s1', { turn: 0, includeTurn: true })
      expect(readFileSync(file, 'utf8')).toBe('first\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rolls back only the turns after the boundary', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'v0\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'v1\n')
      files.beginTurn('s1', 2)
      files.capture('s1', file)
      writeFileSync(file, 'v2\n')

      // A boundary in turn 1 keeps turn 1 and rolls back turn 2 only.
      files.restore('s1', { turn: 1, includeTurn: false })
      expect(readFileSync(file, 'utf8')).toBe('v1\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rolls the boundary turn back when the boundary is a user prompt', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'v0\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'v1\n')

      // A user prompt is followed by its own turn's assistant reply, so the
      // files that turn changed roll back with it.
      files.restore('s1', { turn: 1, includeTurn: true })
      expect(readFileSync(file, 'utf8')).toBe('v0\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('puts the files back when the staged revert is cleared', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'before\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'after\n')

      files.restore('s1', { turn: 0, includeTurn: true })
      expect(readFileSync(file, 'utf8')).toBe('before\n')
      const putBack = files.unstage('s1')
      expect(putBack).toEqual(['a.ts'])
      expect(readFileSync(file, 'utf8')).toBe('after\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('drops the undo state when the revert is committed', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'before\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'after\n')

      files.restore('s1', { turn: 0, includeTurn: true })
      files.commit('s1')
      expect(files.unstage('s1')).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe('before\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('ignores a path outside the session directory', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-oc-outside-'))
    try {
      const file = join(outside, 'a.ts')
      writeFileSync(file, 'outside\n')
      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      expect(files.restore('s1', { turn: 0, includeTurn: true })).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe('outside\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports the diff of every file a later turn changed', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const file = join(work, 'a.ts')
      writeFileSync(file, 'one\ntwo\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', file)
      writeFileSync(file, 'one\nTWO\n')

      const diffs = files.diffsAfter('s1', { turn: 0, includeTurn: true })
      expect(diffs).toHaveLength(1)
      expect(diffs[0]?.file).toBe('a.ts')
      expect(diffs[0]?.status).toBe('modified')
      expect(diffs[0]?.additions).toBe(1)
      expect(diffs[0]?.deletions).toBe(1)
      expect(diffs[0]?.patch).toContain('--- a/a.ts')
      expect(diffs[0]?.patch).toContain('-two')
      expect(diffs[0]?.patch).toContain('+TWO')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('reports a created file as added and a removed file as deleted', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-rewind-'))
    try {
      const created = join(work, 'new.ts')
      const removed = join(work, 'gone.ts')
      writeFileSync(removed, 'here\n')

      const files = new FileSnapshots()
      files.setDirectory('s1', work)
      files.beginTurn('s1', 1)
      files.capture('s1', created)
      files.capture('s1', removed)
      writeFileSync(created, 'now\n')
      rmSync(removed)

      const diffs = files.diffsAfter('s1', { turn: 0, includeTurn: true })
      const byFile = new Map(diffs.map((diff) => [diff.file, diff]))
      expect(byFile.get('new.ts')?.status).toBe('added')
      expect(byFile.get('gone.ts')?.status).toBe('deleted')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('rewind: the diff builder', () => {
  it('reports nothing for identical content', () => {
    const diff = unifiedDiff('a.ts', 'same\n', 'same\n')
    expect(diff.patch).toBe('')
    expect(diff.additions).toBe(0)
    expect(diff.deletions).toBe(0)
  })

  it('counts the added and removed lines', () => {
    // The diff is one coarse hunk between the first and the last changed
    // line, the same shape the bridge's own file-change diffs use.
    const diff = unifiedDiff('a.ts', 'a\nb\n', 'a\nB\n')
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
    expect(diff.patch).toContain('-b')
    expect(diff.patch).toContain('+B')
  })
})
