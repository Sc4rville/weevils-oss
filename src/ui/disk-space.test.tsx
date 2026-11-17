// @vitest-environment happy-dom
// The machine page's « where your disk space goes »: sizes as measured, growth only from real measurements, and a
// plain sentence (never a number) while there are not enough of them.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DiskView } from '../../shared/infra.ts'
import { setLang } from '../i18n'

vi.mock('../api', () => ({ api: {} }))
const { DiskSpace } = await import('./infra')

const GB = 1024 ** 3
const NOW = Date.now()
let root: Root
let host: HTMLElement
const opened: string[] = []

const base: DiskView = {
  at: NOW - 60_000,
  measuring: false,
  next: NOW + 6 * 3600_000,
  samples: 1,
  since: NOW - 60_000,
  used: 100 * GB,
  folders: [
    { name: 'projects', kind: 'folder', path: '/home/user/projects', bytes: 40 * GB, inside: [{ name: 'game', bytes: 11 * GB }, { name: 'site', bytes: 5 * GB }] },
    { name: 'rest', kind: 'rest', bytes: 31 * GB, inside: [{ name: 'Build Cache', bytes: 21e9, reclaimable: 13e9 }, { name: 'Images', bytes: 14e9 }, { name: 'Local Volumes', bytes: 5e6, reclaimable: 1e6 }] },
    { name: 'swap', kind: 'swap', bytes: 12 * GB, inside: [] },
    { name: 'usr', kind: 'system', path: '/usr', bytes: 4 * GB, inside: [] },
  ],
  growth: null,
  recent: [{ name: 'trailer', parent: 'work', bytes: 10 * GB, path: '/home/user/work/trailer' }],
}

const render = (v: DiskView) => act(() => root.render(<DiskSpace v={v} open={(p) => opened.push(p)} />))
const text = () => host.textContent ?? ''

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  opened.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLang(null)
})

it('lists folders with their size, plain names, and what is inside', () => {
  render(base)
  expect(text()).toContain('where your disk space goes')
  expect(text()).toContain('projects40.0 GB')
  // One row per folder: its name and size, nothing listed under it.
  expect(text()).not.toContain('game 11.0 GB')
  expect(text()).toContain('Docker and system data31.0 GB')
  expect(text()).not.toContain('per Docker')
  expect(text()).not.toContain('volumes')
  expect(text()).toContain('swap files12.0 GB')
  expect(text()).toContain('system programs4.0 GB')
  ;(host.querySelector('button.disk-row') as HTMLButtonElement).click()
  expect(opened).toEqual(['/home/user/projects'])
})

it('before growth is known: the folders alone, no note about later and no stand-in list', () => {
  render(base)
  expect(text()).not.toContain('Growth shows after')
  expect(text()).not.toMatch(/a day/)
  expect(text()).not.toContain('written in the last 7 days')
})

it('ranks growth per day once measured, one row each', () => {
  render({ ...base, samples: 5, growth: { since: NOW - 2 * 86400_000, perDay: 3 * GB, items: [{ name: 'trailer', parent: 'work', kind: 'folder', path: '/home/user/work/trailer', perDay: 2 * GB, bytes: 10 * GB }, { name: 'work', kind: 'loose', path: '/home/user/work', perDay: 0.5 * GB, bytes: 1 * GB }] } })
  expect(text()).toContain('growing fastest')
  expect(text()).toContain('trailer+2.0 GB a day')
  expect(text()).toContain('files directly in work+512 MB a day')
  expect(text()).not.toContain('The whole disk')
  expect(text()).not.toContain('written in the last 7 days')
  expect(text()).not.toContain('Growth shows after')
})

it('before the first measurement, shows nothing at all', () => {
  render({ ...base, at: null, samples: 0, since: null, used: 0, folders: [], recent: [] })
  expect(text()).toBe('')
})
