// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/api'
import { Messages } from './bits'
import { setLang } from '../i18n'
vi.mock('./app-context', () => ({ useApp: () => ({ snap: { config: { authors: [], userName: 'Yann' }, projects: [], machines: [], sessions: [] }, push: vi.fn() }) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const m = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ id, role, text, at: 1, ...extra })
beforeEach(() => { setLang('en'); MotionGlobalConfig.skipAnimations = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLang(null) })
const thread = [
  m('a', 'assistant', 'I will start by looking at the checkout code to understand how payment is wired. Then I will fix the button and run everything.'),
  ...['CheckoutForm.tsx', 'PayButton.tsx', 'cart.ts'].map((f, i) => m(`r${i}`, 'event', `Read · /home/user/projects/shop/src/${f}`)),
  m('g', 'event', 'Grep · handlePay --include=*.ts'),
  m('e', 'event', 'Edit · /home/user/projects/shop/src/PayButton.tsx'),
  m('t', 'event', 'Bash · npx vitest run --reporter=dot', { toolDetails: { commands: ['npx vitest run --reporter=dot'], output: '3 failed' } }),
]
const FORBIDDEN = /\/home|src\/|\.tsx|\.ts\b|--|npx|vitest|\bBash\b|\bRead\b|\bGrep\b|\bEdit ·/
const tapMessage = async () => act(async () => host.querySelector<HTMLElement>('[data-mid="a"] .text, [data-mid="a"]')!.click())
it('finished steps show nothing; a tap on the message they led to opens them, collapsed, in plain words', async () => {
  await act(async () => root.render(<Messages session plain messages={thread} author="claude" />))
  expect(host.querySelector('.steps-head')).toBeNull()
  expect(host.textContent).not.toMatch(/Reading the code|Running/)
  await tapMessage()
  const head = host.querySelector('.steps-head')!
  expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(head.textContent).toMatch(/Reading the code, editing the code/)
  expect(head.textContent).not.toMatch(FORBIDDEN)
  expect(host.querySelector('.steps-list')).toBeNull()
  expect(host.textContent).not.toMatch(/\/home|\.tsx|npx vitest|--reporter/)
})
it('while it works, only the live step says what happens now', async () => {
  await act(async () => root.render(<Messages session plain working messages={thread} author="claude" />))
  expect(host.querySelectorAll('.steps-head')).toHaveLength(1)
  expect(host.querySelector('.steps-head .spin')).not.toBeNull()
})
it('expanded: one plain line per goal; raw commands and results only inside closed details; missing evidence said', async () => {
  await act(async () => root.render(<Messages session plain messages={thread} author="claude" />))
  await tapMessage()
  await act(async () => host.querySelector<HTMLButtonElement>('.steps-head')!.click())
  const lines = [...host.querySelectorAll('.steps-list .step-head .text')].map((e) => e.textContent)
  expect(lines).toEqual(['Reading the code · 3', 'Searching the code', 'Editing the pay button code', 'Running tests'])
  for (const l of lines) expect(l).not.toMatch(FORBIDDEN)
  for (const d of host.querySelectorAll('.step-detail')) expect((d as HTMLDetailsElement).open).toBe(false)
  expect(host.querySelector('.step-content')!.textContent).toContain('CheckoutForm.tsx')
  expect(host.querySelector('.step-content')!.textContent).toContain('No result recorded')
  expect(host.textContent).toContain('3 failed')
})
it('French mode speaks French, and the weevboss thread (not plain) is untouched', async () => {
  setLang('fr')
  await act(async () => root.render(<Messages session plain messages={thread} author="claude" />))
  await tapMessage()
  expect(host.querySelector('.steps-head')!.textContent).toMatch(/Lecture du code/)
  await act(async () => root.render(<Messages messages={thread} author="weevboss" />))
  expect(host.querySelector('.steps-head')!.textContent).toMatch(/6 étapes/)
})
it('the request that started a session stays on top when 150 tool steps and 70 messages push it out of the window', async () => {
  const long = [m('b0', 'orchestrator', 'Bring old chats into weevils in one tap. Then report back.', { author: 'weevboss' }), ...Array.from({ length: 150 }, (_, i) => m(`e${i}`, 'event', 'Bash · ls')), ...Array.from({ length: 70 }, (_, i) => m(`x${i}`, 'assistant', `Update ${i} is done.`))]
  await act(async () => root.render(<Messages session plain messages={long} author="claude" />))
  const pinned = host.querySelector('.session-asked-line')!
  expect(pinned.textContent).toContain('Bring old chats into weevils in one tap.')
  expect(pinned.textContent).not.toContain('Then report back')
  expect(host.textContent).toContain('10 older messages')
  await act(async () => (pinned as HTMLButtonElement).click())
  expect(host.querySelector('.session-asked-full')!.textContent).toContain('Then report back')
})
it('a short thread full of tool steps hides nothing: steps never count toward the window', async () => {
  const t2 = [m('b0', 'orchestrator', 'Do it.', { author: 'weevboss' }), ...Array.from({ length: 150 }, (_, i) => m(`e${i}`, 'event', 'Bash · ls')), m('x', 'assistant', 'Done.')]
  await act(async () => root.render(<Messages session plain messages={t2} author="claude" />))
  expect(host.textContent).not.toMatch(/older message/)
  expect(host.querySelector('.session-asked-line')).toBeNull()
  expect(host.textContent).toContain('Do it.')
})

import { liveNote } from './plain-steps'
import PM from '../i18n/plain-steps'
import { tr } from '../i18n'
const H = (w: any) => ({ waiting: String(w.liveWaiting), stopped: String(w.liveStopped), done: String(w.liveDone), idle: String(w.liveIdle) })
it('header live note: plain words, 6 max, never a path or a command, calm when nothing runs', () => {
  const w = tr(PM)
  const note = (s: object, last?: Message) => liveNote({ status: 'working', ...s }, last, w, H(w))
  expect(note({ now: 'running the full check' })).toEqual({ text: 'running the full check', state: 'working' })
  expect(note({ now: 'fixing i18n labels and the evidence strings for every page' }).text).toBe('fixing i18n labels and the evidence…')
  // a raw tool step in `now` is never shown: the last action, in plain words, takes over
  const raw = note({ now: 'cd ~/projects/weevils-wt/f && npm run check' }, thread.at(-1))
  expect(raw).toEqual({ text: 'Running tests', state: 'working' })
  expect(note({ now: 'tail -30 /tmp/evidence-check.log' }, m('x', 'event', 'Read · /home/user/a/PayButton.tsx')).text).toBe('Reading the pay button code')
  expect(note({ now: '' }).text).toBe('Working')
  for (const l of [note({ now: 'cd /x' }, thread.at(-1)).text, note({ now: 'ls -la ~/x' }).text]) expect(l).not.toMatch(/\/|~|--|npm|cd /)
  // calm states: a stale `now` is ignored once nothing runs
  expect(note({ status: 'done', now: 'running the full check' })).toEqual({ text: 'done', state: 'calm' })
  expect(note({ status: 'idle', now: 'x' }).text).toBe('idle')
  expect(note({ status: 'needs_user' })).toEqual({ text: 'waiting for you', state: 'waiting' })
  expect(note({ status: 'interrupted' }).text).toBe('stopped')
})
