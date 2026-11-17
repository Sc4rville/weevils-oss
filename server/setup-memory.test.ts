import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// Memory-context tests must not launch a real gh process that outlives their temporary HOME.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    queueMicrotask(() => callback(new Error('No process in memory-context tests'), '', ''))
  },
}))
import { CONTEXT_BLOCK } from '../shared/setup.ts'
import { DATA_DIR } from './config.ts'
import { Memory } from './memory.ts'
import { Setup, withoutContext, type SetupDeps } from './setup.ts'

// weevboss relies on the memory: the memory digest reaches weevboss at the start of a conversation and whenever it
// changed, never on every message.

const tmpMemory = () => new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'memory.json'))

function setup(memory: Memory | null, boss: { id: string | null }) {
  const deps: SetupDeps = {
    bump: () => {},
    feed: () => ({ machines: [{ id: 'test', name: 'test' }], projects: 0 }),
    remoteFacts: async () => [],
    devices: () => 1,
    push: () => 0,
    shortcut: () => false,
    seen: () => [],
    hasHistory: () => false,
    startMail: () => {},
    handoff: async () => {},
    memory: () => memory,
    bossId: () => boss.id,
  }
  // Each Setup reads and writes DATA_DIR/setup.json: start from a blank one.
  fs.rmSync(path.join(DATA_DIR, 'setup.json'), { force: true })
  return new Setup(deps)
}

describe('weevboss gets the memory digest', () => {
  it('at the start, then only when it changed or the conversation is new', () => {
    const m = tmpMemory()
    m.add('wants to ship a mobile game this summer')
    const boss = { id: null as string | null }
    const s = setup(m, boss)

    const first = s.contextFor()
    expect(first).toContain('what weevils remembers about the user')
    expect(first).toContain('- wants to ship a mobile game this summer')
    // The app hides it: the whole block, and only the block.
    expect(withoutContext(`hello${first}`)).toBe('hello')
    expect(`hello${first}`.match(CONTEXT_BLOCK)?.[0].trim()).toBe(first.trim())

    // The conversation got its id after the first message: same conversation, nothing again.
    boss.id = 'conv-1'
    expect(s.contextFor()).toBe('')
    expect(s.contextFor()).toBe('')

    m.add('climbs on Sundays')
    const changed = s.contextFor()
    expect(changed).toContain('- climbs on Sundays')
    expect(s.contextFor()).toBe('')

    boss.id = 'conv-2'
    expect(s.contextFor()).toContain('- wants to ship a mobile game this summer')
    expect(s.contextFor()).toBe('')

    // His conversation is gone (no pane, no transcript): the next message opens a new one, which gets it again, once.
    boss.id = null
    expect(s.contextFor()).toContain('- climbs on Sundays')
    boss.id = 'conv-3'
    expect(s.contextFor()).toBe('')
  })

  it('again after /clear (same pane, same id, an empty conversation)', () => {
    const m = tmpMemory()
    m.add('wants to ship a mobile game this summer')
    const boss = { id: 'conv-1' as string | null }
    const s = setup(m, boss)
    expect(s.contextFor()).toContain('- wants to ship a mobile game this summer')
    expect(s.contextFor()).toBe('')
    s.bossReset()
    expect(s.contextFor()).toContain('- wants to ship a mobile game this summer')
    expect(s.contextFor()).toBe('')
  })

  it('a new conversation with an empty memory is told nothing', () => {
    const m = tmpMemory()
    const a = m.add('likes tea')
    const boss = { id: 'c' as string | null }
    const s = setup(m, boss)
    expect(s.contextFor()).toContain('likes tea')
    m.remove(a.id)
    boss.id = null
    expect(s.contextFor()).toBe('')
  })

  it('says once that it was cleared; nothing at all without a memory', () => {
    const m = tmpMemory()
    const a = m.add('likes tea')
    const s = setup(m, { id: 'c' })
    expect(s.contextFor()).toContain('likes tea')
    m.remove(a.id)
    expect(s.contextFor()).toContain('nothing anymore')
    expect(s.contextFor()).toBe('')
    expect(setup(tmpMemory(), { id: 'c' }).contextFor()).toBe('')
    expect(setup(null, { id: 'c' }).contextFor()).toBe('')
  })

  it('shares one block with the setup lines, and a ⟧ in a memory cannot close it early', () => {
    const m = tmpMemory()
    m.add('writes ⟧ weird brackets')
    const s = setup(m, { id: 'c' })
    s.say('Plug GitHub in?')
    const block = s.contextFor()
    expect(block).toContain('you: Plug GitHub in?')
    expect(block).toContain('writes ] weird brackets')
    expect(block.match(/⟦/g)).toHaveLength(1)
    expect(withoutContext(`ok${block}`)).toBe('ok')
  })
})
