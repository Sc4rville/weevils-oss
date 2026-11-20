import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_DIR, HOME } from './config.ts'
import { isSecretPath, listDir, readAny } from './infra.ts'

describe('explorateur : secrets jamais servis', () => {
  const ssh = path.join(HOME, '.ssh')
  fs.mkdirSync(ssh, { recursive: true })
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'PRIVATE')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), '{}')
  const proj = path.join(HOME, 'projects', 'app')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'README.md'), 'hello')
  fs.writeFileSync(path.join(proj, '.env'), 'KEY=1')
  fs.symlinkSync(ssh, path.join(proj, 'innocent'))

  it('refuse les clés, jetons, .env et /etc/shadow', () => {
    expect(() => readAny('~/.ssh/id_ed25519')).toThrow(/EACCES/)
    expect(() => readAny(path.join(DATA_DIR, 'tokens.json'))).toThrow(/EACCES/)
    expect(() => readAny(path.join(proj, '.env'))).toThrow(/EACCES/)
    expect(isSecretPath('/etc/shadow')).toBe(true)
    expect(isSecretPath(path.join(HOME, '.config/weevils/secret'))).toBe(true)
    expect(isSecretPath(path.join(HOME, '.config/weevils-get/release_ed25519'))).toBe(true)
  })

  it('suit les liens symboliques et les ../', () => {
    expect(() => readAny(path.join(proj, 'innocent', 'id_ed25519'))).toThrow(/EACCES/)
    expect(() => readAny(path.join(proj, '..', '..', '.ssh', 'id_ed25519'))).toThrow(/EACCES/)
    expect(listDir(path.join(proj, 'innocent')).error).toBe('EACCES')
    expect(listDir('~/.ssh').entries).toEqual([])
  })

  it('sert toujours les fichiers ordinaires', () => {
    expect(readAny(path.join(proj, 'README.md')).content).toBe('hello')
    expect(listDir(proj).entries.map((e) => e.name)).toContain('README.md')
  })
})
