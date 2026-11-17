// @vitest-environment happy-dom
// Software page: the header says how it runs and what it is, never the machine id or the port; the empty preview speaks
// plain words, never « visual interface ». The open-in-a-new-tab button keeps the address.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Software } from '../../shared/softwares'

const sw: Software = { id: 'vps:mygame', name: 'mygame', kind: 'web', machine: 'vps-7f3a', port: 4173, url: 'https://mygame.example.tech', embeddable: false, repo: '/home/alex/projects/mygame', repos: [], run: 'running', tail: [], tailSource: 'log', hosts: [], lastCommitAt: 0, lastActivityAt: 0, blurb: 'a small game', progress: { phase: 2, percent: 50, source: 'heuristic', reason: '', at: 0 } } as Software
vi.mock('../api', () => ({ api: { software: async () => sw }, softwareShot: () => '', ApiError: class extends Error {} }))
vi.mock('./app-context', () => ({ useApp: () => ({ snap: { projects: [], sessions: [] }, colors: {}, push: () => {} }) }))
vi.mock('./shell', () => ({ Shell: ({ children, title, meta }: { children: React.ReactNode; title: string; meta?: string }) => <section><h1>{title}</h1><p data-meta>{meta}</p>{children}</section> }))
vi.mock('./preview-chat', () => ({ PreviewChat: () => null }))
const { setLang } = await import('../i18n')
const { SoftwarePage } = await import('./softwares')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement
beforeEach(() => { setLang('en'); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLang(null) })

it('header: « running · a small game », no machine id, no port; preview empty state in plain words', async () => {
  await act(async () => root.render(<SoftwarePage id="vps:mygame" />))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
  expect(host.querySelector('[data-meta]')!.textContent).toBe('running · a small game')
  expect(host.textContent).not.toContain('4173')
  expect(host.textContent).not.toContain('vps-7f3a')
  expect(host.textContent).toContain('No preview yet')
  expect(host.textContent).not.toMatch(/visual/i)
  expect(host.querySelector('[aria-label="open in a new tab"]')).not.toBeNull()
})
