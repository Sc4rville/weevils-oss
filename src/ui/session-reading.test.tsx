// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Message, Session } from '../../shared/api'
import { Composer, Messages } from './bits'
import { useThreadAsk } from './askthread'
import { setLang } from '../i18n'
const state = vi.hoisted(() => ({ word: true, sessions: [] as Session[] }))
vi.mock('./app-context', () => ({ useApp: () => ({ snap: { config: { authors: [], userName: 'Yann' }, projects: [], machines: [], sessions: state.sessions }, push: vi.fn() }) }))
vi.mock('./ask', () => ({ useAsk: () => ({ reset() {} }), AskVoice: () => null, AskPanel: () => <div data-actions /> }))
vi.mock('./textpick', async original => ({ ...await original<typeof import('./textpick')>(), wordUnder: () => state.word ? { col: 0, word: [0, 5] } : null, anchorRow: () => () => {} }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const message = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ id, role, text, at: 1, ...extra })
beforeEach(() => { state.sessions = []; setLang('en'); MotionGlobalConfig.skipAnimations = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLang(null) })
it('keeps human messages and boss briefs fully readable, folding only bridge coordination', async () => {
 const long = 'A complete paragraph. '.repeat(35)
 const msgs = [message('user', 'user', long), message('boss', 'orchestrator', long, { author: 'weevboss', coordination: true }), message('coord', 'orchestrator', 'Technical exchange', { author: 'codex', coordination: true }), message('external', 'orchestrator', long, { author: 'friend' }), message('answer', 'assistant', long)]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" />))
 expect(host.querySelectorAll('.clamp')).toHaveLength(0)
 expect(host.textContent).not.toContain('read all')
 expect(host.querySelectorAll('details')).toHaveLength(1)
 const detail = host.querySelector('details')!
 expect(detail.open).toBe(false)
 expect(detail.querySelector('[data-mid="coord"]')).not.toBeNull()
 for (const id of ['user', 'boss', 'external', 'answer']) expect(host.querySelector(`[data-mid="${id}"]`)!.closest('details')).toBeNull()
 await act(async () => { detail.open = true })
 expect(detail.textContent).toContain('Technical exchange')
})
it('groups consecutive tools, stays folded on updates, and does not fold assistant prose', async () => {
 const msgs = [message('a', 'assistant', 'I am checking the result.'), message('t1', 'event', 'Read files'), message('t2', 'event', 'Run checks')]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" working />))
 expect(host.querySelector('.steps-head')?.getAttribute('aria-expanded')).toBe('false')
 expect(host.querySelector('.steps-list')).toBeNull()
 await act(async () => root.render(<Messages session messages={[...msgs, message('t3', 'event', 'Inspect status')]} author="codex" working />))
 expect(host.querySelector('.steps-head')?.getAttribute('aria-expanded')).toBe('false')
 expect(host.textContent).toContain('I am checking the result.')
 await act(async () => host.querySelector<HTMLButtonElement>('.steps-head')!.click())
 expect(host.querySelectorAll('.steps-list .text')).toHaveLength(3)
})
function Selection() {
 const th = useThreadAsk([message('m', 'assistant', 'Hello there')], { title: 'session', tool: 'codex', selectionOnly: true })
 return <div ref={th.ref}><div data-mid="m">Hello there</div>{th.after('m')}</div>
}
it('does not open contextual actions on an ordinary tap, but opens them after a deliberate selection', async () => {
 await act(async () => root.render(<Selection />))
 const row = host.querySelector<HTMLElement>('[data-mid]')!
 const pointer = (type: string, x: number) => row.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: x, clientY: 50 }))
 await act(async () => { pointer('pointerdown', 100); pointer('pointerup', 100) })
 expect(host.querySelector('[data-actions]')).toBeNull()
 vi.spyOn(document, 'elementFromPoint').mockReturnValue(row)
 await act(async () => { pointer('pointerdown', 100); pointer('pointermove', 130); pointer('pointerup', 130) })
 expect(host.querySelector('[data-actions]')).not.toBeNull()
 vi.restoreAllMocks()
})
it('hides leading agent machine tags without rewriting user words or stored messages', async () => {
 const msgs = [message('u', 'user', '[PC] ma question'), message('a', 'assistant', '[VPS] Résultat prêt.'), message('b', 'orchestrator', '[GPU] Le GPU est arrêté.', { author: 'weevboss' })]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" />))
 expect(host.querySelector('[data-mid="u"]')!.textContent).toContain('[PC] ma question')
 expect(host.querySelector('[data-mid="a"]')!.textContent).not.toContain('[VPS]')
 expect(host.querySelector('[data-mid="b"]')!.textContent).toContain('Le GPU est arrêté.')
 expect(host.querySelector('[data-mid="b"]')!.textContent).not.toContain('[GPU]')
 expect(msgs[1].text).toBe('[VPS] Résultat prêt.')
})
it('opens each recorded step independently and preserves disclosure across results and language changes', async () => {
 const first = message('t1', 'event', 'Runs a command', { toolDetails: { kinds: ['test'], commands: ['npm test -- --run'], output: '12 tests passed\nTOKEN=[redacted]\n<script>not markup</script>' } })
 const second = message('t2', 'event', 'Runs a command', { toolDetails: { kinds: ['read'], commands: ['cat README.md'] } })
 const render = (messages: Message[]) => act(async () => root.render(<Messages session messages={messages} author="codex" working />))
 await render([first, second])
 const group = host.querySelector<HTMLButtonElement>('.steps-head')!
 expect(group.getAttribute('aria-expanded')).toBe('false')
 expect(host.querySelector('pre')).toBeNull()
 await act(async () => group.click())
 const details = host.querySelectorAll<HTMLDetailsElement>('.step-detail')
 expect(details).toHaveLength(2)
 expect([...details].every(d => !d.open)).toBe(true)
 expect(details[0].querySelector('summary')!.textContent).toBe('Runs tests')
 expect(details[1].querySelector('summary')!.textContent).toBe('Reads files')
 expect(host.querySelectorAll('.step-plus, .step-toggle')).toHaveLength(0)
 await act(async () => { details[0].open = true })
 expect(details[0].querySelectorAll('pre')[0].textContent).toBe('npm test -- --run')
 expect(details[0].querySelectorAll('pre')[1].textContent).toContain('TOKEN=[redacted]')
 expect(details[0].querySelector('script')).toBeNull()
 expect(details[1].open).toBe(false)
 await act(async () => setLang('fr'))
 expect(details[0].open).toBe(true)
 expect(details[0].querySelector('summary')!.textContent).toBe('Lance les tests')
 expect(details[0].textContent).toContain('Sortie enregistrée')
 await render([first, { ...second, toolDetails: { ...second.toolDetails!, output: 'Actual file content' } }])
 expect(host.querySelectorAll('.step-detail')[0]).toBe(details[0])
 expect(details[0].open).toBe(true)
 expect(details[1].open).toBe(false)
 expect(details[1].textContent).toContain('Actual file content')
 await act(async () => setLang('en'))
 expect(details[0].open).toBe(true)
 expect(details[0].textContent).toContain('Recorded output')
})
it('keeps even a single legacy step inspectable without inventing a command or result', async () => {
 await act(async () => root.render(<Messages session messages={[message('single', 'event', 'Runs a command')]} author="codex" />))
 const group = host.querySelector<HTMLButtonElement>('.steps-head')!
 expect(group.textContent).toContain('1 step')
 expect(group.getAttribute('aria-expanded')).toBe('false')
 await act(async () => group.click())
 const detail = host.querySelector<HTMLDetailsElement>('.step-detail')!
 expect(detail.open).toBe(false)
 await act(async () => { detail.open = true })
 expect(detail.textContent).toContain('No command recorded')
 expect(detail.textContent).toContain('No output recorded')
 expect(detail.querySelector('pre')).toBeNull()
})

it('accepts one submission, exposes activity and its recorded result, then allows a new message without replay', async () => {
 let acknowledge!: () => void
 const send = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve }))
 const transcript: Message[] = []
 const render = (working = false, draft = { text: 'Check this', n: 1 }) => act(async () => root.render(<>
   <Messages session messages={[...transcript]} author="codex" working={working} />
   <Composer label="acceptance-session" placeholder="Message" onSend={send} draft={draft} />
 </>))
 await render()
 await act(async () => {
   host.querySelector('form')!.requestSubmit()
   host.querySelector('form')!.requestSubmit()
 })
 expect(send).toHaveBeenCalledTimes(1)
 transcript.push(message('user', 'user', 'Check this'), message('tool', 'event', 'Runs tests', { toolDetails: { commands: ['npm test'], kinds: ['test'] } }))
 await act(async () => acknowledge())
 await render(true)
 expect(host.querySelector('.steps-head .spin')).not.toBeNull()
 await act(async () => host.querySelector<HTMLButtonElement>('.steps-head')!.click())
 const detail = host.querySelector<HTMLDetailsElement>('.step-detail')!
 await act(async () => { detail.open = true })
 expect(detail.querySelector('pre')!.textContent).toBe('npm test')
 transcript[1] = { ...transcript[1], toolDetails: { ...transcript[1].toolDetails!, output: 'Tests passed' } }
 transcript.push(message('answer', 'assistant', 'Checks passed.'))
 await render()
 expect(host.querySelector('.steps-head .spin')).toBeNull()
 expect(detail.open).toBe(true)
 expect(detail.textContent).toContain('Tests passed')
 expect(send).toHaveBeenCalledTimes(1)
 await render(false, { text: 'Continue', n: 2 })
 await act(async () => host.querySelector('form')!.requestSubmit())
 expect(send).toHaveBeenCalledTimes(2)
 expect(send).toHaveBeenLastCalledWith('Continue')
 await act(async () => acknowledge())
})

it('identifies excerpts explicitly in both languages without claiming they are complete', async () => {
 const event = message('truncated', 'event', 'Runs a command', { toolDetails: { commands: ['safe excerpt'], output: 'partial result', commandsTruncated: true, outputTruncated: true } })
 await act(async () => root.render(<Messages session messages={[event]} author="codex" />))
 await act(async () => host.querySelector<HTMLButtonElement>('.steps-head')!.click())
 const detail = host.querySelector<HTMLDetailsElement>('.step-detail')!
 await act(async () => { detail.open = true })
 expect(detail.textContent).toContain('Command truncated')
 expect(detail.textContent).toContain('Output truncated')
 await act(async () => setLang('fr'))
 expect(detail.textContent).toContain('Commande tronquée')
 expect(detail.textContent).toContain('Sortie tronquée')
 expect(detail.open).toBe(true)
})
it('shows concrete command summaries and literal tool descriptions without inventing per-call results', async () => {
 const event = message('concrete', 'event', 'Runs a command', { toolDetails: {
  kinds: ['git'], summaryCommands: ['git status', 'git log'],
  calls: [{ name: 'exec_command', description: 'Inspecter le dépôt <script>literal</script>' }, { name: 'write_stdin' }],
  commands: ['git status --short; git log -3 --oneline'], output: 'One recorded wrapper result',
 } })
 await act(async () => root.render(<Messages session messages={[event]} author="codex" />))
 expect(host.querySelector('.steps-head')!.textContent).toContain('Checks the Git repository · git status, git log')
 expect(host.querySelector('.step-calls')).toBeNull()
 await act(async () => host.querySelector<HTMLButtonElement>('.steps-head')!.click())
 const detail = host.querySelector<HTMLDetailsElement>('.step-detail')!
 expect(detail.open).toBe(false)
 await act(async () => { detail.open = true })
 expect(detail.querySelectorAll('.step-calls li')).toHaveLength(2)
 expect(detail.querySelector('.step-calls')!.textContent).toContain('exec_command')
 expect(detail.querySelector('.step-calls')!.textContent).toContain('write_stdin')
 expect(detail.querySelector('.step-calls p')!.textContent).toBe('Inspecter le dépôt <script>literal</script>')
 expect(detail.querySelector('script')).toBeNull()
 expect(detail.querySelectorAll('pre')).toHaveLength(2)
 expect(detail.querySelectorAll('pre')[1].textContent).toBe('One recorded wrapper result')
 await act(async () => setLang('fr'))
 expect(detail.querySelector('summary')!.textContent).toContain('Vérifie le dépôt Git · git status, git log')
 expect(detail.textContent).toContain('Outils de l’appel enregistré')
 expect(detail.open).toBe(true)
})

it('identifies coordination by exact source session and keeps disclosure open across locale/title refresh', async () => {
 state.sessions = [{ id: 'source-thread-exact', title: 'Think' }] as Session[]
 const msgs = [message('coord-source', 'orchestrator', 'Technical exchange', { author: 'codex', coordination: true, sourceThreadId: 'source-thread-exact' })]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" />))
 const disclosure = host.querySelector<HTMLDetailsElement>('.session-coordination')!
 expect(disclosure.open).toBe(false)
 expect(disclosure.querySelector('summary')!.textContent).toBe('message from codex · Think')
 await act(async () => { disclosure.open = true; setLang('fr') })
 state.sessions = [{ id: 'source-thread-exact', title: 'Notes de projet' }] as Session[]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" />))
 expect(disclosure.open).toBe(true)
 expect(disclosure.querySelector('summary')!.textContent).toContain('Notes de projet')
 expect(disclosure.textContent).toContain('Technical exchange')
})
it('omits the source when its session is absent: never a raw id nor a title guessed from the message', async () => {
 const msgs = [message('coord-unknown', 'orchestrator', 'From Think — claimed in text only', { author: 'claude', coordination: true, sourceThreadId: '01a1c624-8308-7321-9492-bfc0924fd135' })]
 await act(async () => root.render(<Messages session messages={msgs} author="claude" />))
 expect(host.querySelector('.session-coordination summary')?.textContent).toBe('message from claude')
 expect(host.textContent).not.toContain('01a1c624')
})
it('never folds human messages or boss briefs based on source ids or body signatures', async () => {
 const msgs = [
  message('human-source', 'user', '[from:codex] literal user quotation', { author: 'codex', sourceThreadId: 'thread-id', coordination: true }),
  message('boss-default', 'orchestrator', 'Actual boss brief', { sourceThreadId: 'thread-id', coordination: true }),
  message('boss-signed', 'orchestrator', 'Signed boss brief', { author: 'weevboss', sourceThreadId: 'thread-id', coordination: true }),
  message('ordinary', 'orchestrator', 'Ordinary agent update', { author: 'codex', sourceThreadId: 'thread-id' }),
 ]
 await act(async () => root.render(<Messages session messages={msgs} author="codex" />))
 expect(host.querySelector('.session-coordination')).toBeNull()
 expect(host.querySelectorAll('[data-mid]')).toHaveLength(4)
 expect(host.textContent).toContain('literal user quotation')
 expect(host.textContent).toContain('Actual boss brief')
})
