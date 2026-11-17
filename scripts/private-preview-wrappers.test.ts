import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { build } from 'vite'
import { privatePreviewWrappers, readPreviewWrappers, registerPreviewWrappers } from './private-preview-wrappers'
let temp: string, repo: string, registry: string, wrappers: string
const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
const names = ['first-run-access.html', 'personal-github-setup.html']
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-build-'))
  repo = path.join(temp, 'repo'); fs.mkdirSync(repo)
  git(repo, ['init', '-q']); fs.writeFileSync(path.join(repo, 'index.html'), '<html><body>Application</body></html>')
  git(repo, ['add', 'index.html']); git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  wrappers = path.join(temp, 'private/wrappers'); fs.mkdirSync(wrappers, { recursive: true })
  registry = path.join(temp, 'private/build-wrappers.json')
  for (const name of names) fs.writeFileSync(path.join(wrappers, name), '<html>Sign in before opening this preview.</html>')
  fs.writeFileSync(path.join(wrappers, 'unregistered-access.html'), 'NOT APPROVED')
  fs.writeFileSync(path.join(temp, 'private/secret.json'), '{"token":"PRIVATE_FIXTURE_TOKEN"}')
  registerPreviewWrappers(repo, names, registry)
})
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }))
it('clean build and staging copies restore only reviewed HTML, including setup wrappers', async () => {
  const outDir = path.join(temp, 'staging')
  fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, 'stale.txt'), 'remove')
  await build({ configFile: false, root: repo, logLevel: 'silent', plugins: [privatePreviewWrappers(registry)], build: { outDir, emptyOutDir: true } })
  expect(fs.readdirSync(outDir).sort()).toEqual(['index.html', ...names].sort())
  for (const name of names) expect(fs.readFileSync(path.join(outDir, name))).toEqual(fs.readFileSync(path.join(wrappers, name)))
  const published = path.join(temp, 'published'); fs.cpSync(outDir, published, { recursive: true })
  expect(fs.readdirSync(published).sort()).toEqual(fs.readdirSync(outDir).sort())
  expect(fs.readFileSync(registry, 'utf8')).not.toContain('PRIVATE_FIXTURE_TOKEN')
})
it('includes canonical worktrees but excludes independent clones, source exports and fresh profiles', () => {
  const worktree = path.join(temp, 'worktree'); git(repo, ['worktree', 'add', '--detach', worktree])
  expect(readPreviewWrappers(worktree, registry)).toHaveLength(2)
  const clone = path.join(temp, 'clone'); git(repo, ['clone', '-q', repo, clone])
  expect(readPreviewWrappers(clone, registry)).toEqual([])
  expect(readPreviewWrappers(temp, registry)).toEqual([])
  expect(readPreviewWrappers(repo, path.join(temp, 'missing.json'))).toEqual([])
})
it('rejects changed, missing or symlinked wrappers before cleaning output and never registers sibling JSON or traversal', async () => {
  const file = path.join(wrappers, names[0])
  fs.writeFileSync(file, 'Changed after review')
  expect(() => readPreviewWrappers(repo, registry)).toThrow('changed')
  const outDir = path.join(temp, 'existing-output'); fs.mkdirSync(outDir)
  fs.writeFileSync(path.join(outDir, 'keep.html'), 'Existing output')
  await expect(build({ configFile: false, root: repo, logLevel: 'silent', plugins: [privatePreviewWrappers(registry)], build: { outDir, emptyOutDir: true } })).rejects.toThrow('changed')
  expect(fs.readFileSync(path.join(outDir, 'keep.html'), 'utf8')).toBe('Existing output')
  fs.unlinkSync(file); expect(() => readPreviewWrappers(repo, registry)).toThrow()
  fs.symlinkSync(path.join(temp, 'private/secret.json'), file)
  expect(() => readPreviewWrappers(repo, registry)).toThrow('Invalid private preview wrapper')
  for (const name of ['../secret.json', 'secret.json', '../secret-access.html']) expect(() => registerPreviewWrappers(repo, [name], registry)).toThrow('filename')
})
