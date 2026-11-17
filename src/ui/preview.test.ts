import { describe, expect, it } from 'vitest'
import type { Message, Project, Session } from '../../shared/api.ts'
import { guessPreviewUrl, urlsInMessages } from './preview'

const msg = (text: string, i: number): Message => ({ id: String(i), role: 'assistant', text, at: i })
const session = { repo: 'mygame' } as Session
const project = { repos: ['mygame', 'other'] } as Project
const cfg = { exposeDomain: 'example.com', publicHost: 'weevils.example.com' }

describe('navigateur intégré : URL proposée', () => {
  it('prend l’URL exposée citée dans la conversation, la plus récente d’abord', () => {
    const m = [msg('voir http://localhost:4173/ pour tester.', 1), msg('publié : https://mygame.example.com/jeu (et https://github.com/x/y)', 2)]
    expect(urlsInMessages(m, cfg)).toEqual(['https://mygame.example.com/jeu', 'http://localhost:4173/'])
    expect(guessPreviewUrl(m, session, project, cfg)).toBe('https://mygame.example.com/jeu')
  })
  it('sinon construit l’adresse à partir du repo', () => {
    expect(guessPreviewUrl([], session, project, cfg)).toBe('https://mygame.example.com')
    expect(guessPreviewUrl([], { repo: null } as Session, project, cfg)).toBe('https://mygame.example.com')
    expect(guessPreviewUrl([], { repo: null } as Session, undefined, cfg)).toBe('')
  })
  it('ignore weevils lui-même', () => {
    expect(urlsInMessages([msg('ouvre https://weevils.example.com', 1)], cfg)).toEqual([])
  })
})
