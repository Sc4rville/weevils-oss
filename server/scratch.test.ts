import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { isScratchDir } from './scratch.ts'

const home = process.env.HOME
afterEach(() => { process.env.HOME = home })

describe('scratch folders', () => {
  it('a probe in /tmp is scratch; a project folder, the home and an empty cwd are not', () => {
    process.env.HOME = '/home/someone'
    expect(isScratchDir('/tmp/sa-codex/work')).toBe(true)
    expect(isScratchDir('/var/tmp/x')).toBe(true)
    expect(isScratchDir('/tmpfoo/x')).toBe(false)
    expect(isScratchDir('/home/someone/projects/weevils')).toBe(false)
    expect(isScratchDir(undefined)).toBe(false)
  })
  it('a home that itself lives in a temporary folder (tests, a throwaway copy) keeps its projects real', () => {
    process.env.HOME = `${os.tmpdir()}/wv-home`
    expect(isScratchDir(`${os.tmpdir()}/wv-home/projects/app`)).toBe(false)
    expect(isScratchDir(`${os.tmpdir()}/elsewhere`)).toBe(true)
  })
})
