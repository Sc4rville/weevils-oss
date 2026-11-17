// Project session agents (Claude Code and Codex) start with the plain-voice rule; weevboss never does.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE, CODEX_FLAGS, plainVoice, projectInstructions, projectClaude, projectCodexFlags } from './agent-launch.ts'
import PlainVoice from './i18n/plain-voice.ts'

const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')

describe('the plain-voice rule', () => {
  it('is short, plain, and in the app language', () => {
    expect(plainVoice('fr')).toBe(PlainVoice.fr.rule)
    expect(plainVoice('en')).toBe(PlainVoice.en.rule)
    expect(plainVoice('fr')).toMatch(/en français/)
    expect(plainVoice('en')).toMatch(/in English/)
    for (const l of ['fr', 'en'] as const) {
      expect(plainVoice(l)).toMatch(/2 (à|to) 4/)
      expect(plainVoice(l).length).toBeLessThan(700)
    }
  })

  it('Claude: appended to the system prompt of a project session, in either language', () => {
    for (const l of ['fr', 'en'] as const) {
      const c = projectClaude(l)
      expect(c.slice(0, CLAUDE.length)).toEqual([...CLAUDE])
      expect(c.slice(CLAUDE.length)).toEqual(['--append-system-prompt', projectInstructions(l)])
    }
  })

  it('Codex: developer instructions, a TOML string that reads back as the rule', () => {
    for (const l of ['fr', 'en'] as const) {
      const f = projectCodexFlags(l)
      expect(f.slice(0, CODEX_FLAGS.length)).toEqual([...CODEX_FLAGS])
      const [flag, kv] = f.slice(CODEX_FLAGS.length)
      expect(flag).toBe('-c')
      const [key, value] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]
      expect(key).toBe('developer_instructions')
      // A JSON string with only \" \\ \n \t \uXXXX escapes is a valid TOML basic string.
      expect(value).toMatch(/^"(?:[^"\\]|\\["\\nt]|\\u[0-9a-f]{4})*"$/)
      expect(JSON.parse(value)).toBe(projectInstructions(l))
      expect(projectInstructions(l)).toContain('weevils page')
      expect(projectInstructions(l)).toContain('weevils post')
    }
  })

  it('weevboss keeps the bare commands', () => {
    const bare = [...CLAUDE, ...CODEX_FLAGS].join(' ')
    expect(bare).not.toContain('--append-system-prompt')
    expect(bare).not.toContain('developer_instructions')
    // boss-turns builds weevboss's own command from core's bare one.
    expect(src('boss-turns.ts')).not.toMatch(/projectClaude|projectCodexFlags|plain-voice/)
    const core = src('core.ts')
    const bossSpawns = core.split('\n').filter((l) => /this\.spawn\('(claude|codex)', ORCH_DIR/.test(l))
    expect(bossSpawns.length).toBeGreaterThanOrEqual(3)
    for (const l of bossSpawns) expect(l).not.toMatch(/project(Claude|CodexFlags)/)
    // ... and the commands they spawn (resumed or new, Claude or Codex) are built from the bare ones.
    for (const l of core.split('\n').filter((x) => /const command = known \?/.test(x))) expect(l).not.toMatch(/project(Claude|CodexFlags)/)
    expect(core).toContain('turns.prepare({ id, claude: [...CLAUDE]')
  })
})
