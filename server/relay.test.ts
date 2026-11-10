// Relais Codex pendant la limite de Claude (server/relay.ts) : heure de reset lue dans le message, quota le plus plein,
// plans écrits d'avance à 90 %, bascule préventive à 97 %, filet de sécurité (message de limite, erreurs répétées),
// décision sur un plan (valider, ajuster, attendre Claude), mode automatique, retour sur Claude à l'heure de reset.
// Tout est simulé : hôte factice, quota factice, Codex factice. Aucun appel à Claude dans la chaîne.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '../shared/api.ts'
import type { QuotaInfo } from '../shared/infra.ts'
import { PLAN_MARKER, Relay, clockOf, hottest, parseReset, type RelayDeps, type RelayHost } from './relay.ts'
import { MACHINE } from './config.ts'
import { setLang } from './i18n.ts'
import type { StopError, Transcript } from './transcripts.ts'

const NOW = Date.parse('2026-11-10T14:00:00Z')
const MIN = 60_000
const H = 3600_000

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'demo',
  repo: 'demo',
  machineId: MACHINE.id,
  tool: 'claude',
  title: 'refonte du panier',
  status: 'working',
  cwd: '/work/demo',
  openedAt: NOW - 60 * MIN,
  lastActivityAt: NOW - MIN,
  workStartedAt: NOW - 5 * MIN,
  origin: 'weevils',
  controllable: true,
  live: true,
  hasScreen: true,
  subagents: [],
  background: 0,
  messageCount: 4,
  queued: 0,
  ...over,
})
const cut = (text: string, over: Partial<Session> = {}): Session => session({ status: 'interrupted', workStartedAt: null, interrupted: { at: NOW - MIN, reason: 'quota', detail: text }, ...over })

function world(opts: { mode?: 'auto' | 'ask' | 'never'; codex?: boolean; switchAt?: number } = {}) {
  const x = {
    sessions: [] as Session[],
    quota: { ok: true, windows: [], source: 'test', at: NOW } as QuotaInfo,
    quotaReads: 0,
    probeOk: false,
    probes: 0,
    boss: undefined as StopError | undefined,
    sent: [] as { id: string; text: string; from?: string }[],
    resumed: [] as string[],
    settled: [] as string[],
    opened: [] as { cwd: string; title: string; text: string }[],
    written: [] as { cwd: string; prompt: string }[],
    notes: [] as { title: string; body: string; url: string }[],
    said: [] as string[],
    bossCuts: 0,
    now: NOW,
    plan: 'Fait\n- le panier\nReste\n- les tests\nRisques\n- aucun\nCe que je compte faire\n1. lancer les tests',
    writeFails: false,
  }
  const host: RelayHost = {
    sessions: () => x.sessions,
    transcript: (id) => ({ id, file: `/claude/${id}.jsonl`, firstPrompt: 'refais le panier', messages: [{ id: 'm1', role: 'user', text: 'refais le panier', at: NOW - 30 * MIN }, { id: 'm2', role: 'assistant', text: 'je commence par le modèle', at: NOW - 20 * MIN }], subagents: [] }) as unknown as Transcript,
    send: async (id, text, from) => void x.sent.push({ id, text, from }),
    resume: async (id) => void x.resumed.push(id),
    settle: (id) => void x.settled.push(id),
    openCodex: async (cwd, title, text) => (x.opened.push({ cwd, title, text }), `wv-codex-${x.opened.length}`),
    resolve: (id) => (id === 'wv-codex-1' ? 'codex-thread-1' : id),
    bossStop: () => x.boss,
    bossRelayCut: async () => void x.bossCuts++,
    notify: (title, body, url) => void x.notes.push({ title, body, url }),
    say: (text) => void x.said.push(text),
    bump: () => undefined,
  }
  const deps: RelayDeps = {
    quota: async () => (x.quotaReads++, x.quota),
    codexReady: () => opts.codex ?? true,
    write: async (cwd, prompt) => {
      x.written.push({ cwd, prompt })
      if (x.writeFails) throw new Error('codex down')
      return x.plan
    },
    git: async () => 'git status:\n M panier.ts',
    probe: async () => (x.probes++, x.probeOk),
    now: () => x.now,
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wv-relay-')), 'relay.json')
  // Le réglage, écrit comme l'app l'aurait fait (relay.set relit aussitôt le quota, à l'heure réelle).
  fs.writeFileSync(file, JSON.stringify({ mode: opts.mode ?? 'ask', tz: 'Europe/Paris', switchAt: opts.switchAt ?? 97, plans: [] }))
  const relay = new Relay(host, deps, file)
  clocks.set(relay, x)
  return { x, relay, file, host, deps }
}
/** Laisse finir ce que tick() a lancé sans l'attendre (écriture d'un plan, lancement d'une session). */
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))
}
const clocks = new WeakMap<Relay, { now: number }>()
const run = async (relay: Relay, now: number) => {
  clocks.get(relay)!.now = now
  await settle()
  await relay.tick(now)
  await settle()
}
const windows = (five: number, week = 10): QuotaInfo => ({ ok: true, source: 'test', at: NOW, windows: [{ kind: 'session', percent: five, resetsAt: NOW + 3 * H }, { kind: 'week', percent: week, resetsAt: NOW + 4 * 24 * H }] })

beforeEach(() => void setLang('fr', true))

describe('heure de reset', () => {
  it('lue dans le message de limite, dans son fuseau', () => {
    // 14 h UTC le 10 novembre = 15 h à Paris.
    expect(parseReset("You've hit your session limit · resets 6pm (Europe/Paris)", NOW)?.until).toBe(Date.parse('2026-11-10T17:00:00Z'))
    expect(parseReset('Claude usage limit reached. Your limit will reset at 18:30 (Europe/Paris).', NOW)?.until).toBe(Date.parse('2026-11-10T17:30:00Z'))
    // Une heure déjà passée aujourd'hui : demain.
    expect(parseReset('5-hour limit reached ∙ resets 9am (Europe/Paris)', NOW)?.until).toBe(Date.parse('2026-11-11T08:00:00Z'))
    expect(parseReset('Weekly limit reached · resets Nov 12, 9am (Europe/Paris)', NOW)?.until).toBe(Date.parse('2026-11-12T08:00:00Z'))
    expect(parseReset('limit reached, resets in 2h 15m', NOW)?.until).toBe(NOW + 135 * MIN)
    expect(parseReset('Claude AI usage limit reached|1794330000', NOW)?.until).toBe(1794330000_000)
    // Sans fuseau dans le message : celui de l'appareil de l'utilisateur.
    expect(parseReset('usage limit reached · resets 6pm', NOW, 'Europe/Paris')?.until).toBe(Date.parse('2026-11-10T17:00:00Z'))
    expect(parseReset('API Error: overloaded', NOW)).toBeNull()
  })
  it('dite courte : « 18 h », avec le jour au-delà de 20 h', () => {
    expect(clockOf(Date.parse('2026-11-10T17:00:00Z'), NOW, 'Europe/Paris')).toBe('18 h')
    expect(clockOf(Date.parse('2026-11-10T17:30:00Z'), NOW, 'Europe/Paris')).toBe('18 h 30')
    expect(clockOf(Date.parse('2026-11-12T08:00:00Z'), NOW, 'Europe/Paris')).toBe('jeudi 9 h')
  })
  it('quota : la plus pleine des fenêtres 5 h et semaine, jamais une fenêtre par modèle ni une fenêtre déjà remise à zéro', () => {
    expect(hottest({ ok: true, source: '', at: NOW, windows: [{ kind: 'session', percent: 40, resetsAt: NOW + H }, { kind: 'week', percent: 93, resetsAt: NOW + 24 * H }, { kind: 'model', percent: 100, resetsAt: NOW + H }] }, NOW)).toMatchObject({ percent: 93, window: 'week' })
    expect(hottest({ ok: true, source: '', at: NOW, windows: [{ kind: 'session', percent: 100, resetsAt: NOW - MIN }] }, NOW)).toBeNull()
    expect(hottest({ ok: false, source: '', at: NOW, windows: [] }, NOW)).toBeNull()
  })
})

describe('anticipation', () => {
  it('R1 à 92 % : un plan écrit d’avance par Codex pour chaque session au travail, une ligne à l’utilisateur, personne n’est arrêté', async () => {
    const { x, relay } = world()
    x.sessions = [session(), session({ id: 's2', title: 'au repos', status: 'idle' })]
    x.quota = windows(92)
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    expect(x.written).toHaveLength(1)
    expect(x.written[0].cwd).toBe('/work/demo')
    expect(x.written[0].prompt.startsWith(PLAN_MARKER)).toBe(true)
    expect(x.written[0].prompt).toContain('/claude/s1.jsonl')
    expect(x.written[0].prompt).toContain('refais le panier')
    expect(x.written[0].prompt).toContain('M panier.ts')
    expect(x.written[0].prompt).toContain('Tu ne modifies RIEN')
    expect(x.notes).toEqual([{ title: 'Claude approche de sa limite', body: "t'es à 92 % de ta fenêtre 5 h, je garde Codex au chaud", url: '/#relay' }])
    expect(x.said).toEqual(["T'es à 92 % de ta fenêtre 5 h, je garde Codex au chaud."])
    // Écrit d'avance, pas encore montré ; aucun épisode, weevboss reste sur Claude.
    expect(relay.view(NOW).plans).toEqual([])
    expect(relay.view(NOW).limit).toBeUndefined()
    expect(relay.bossOn()).toBe(false)
    expect(x.sent).toEqual([])
    // Une seule annonce par fenêtre.
    await run(relay, NOW + 6 * MIN)
    expect(x.notes).toHaveLength(1)
  })

  it('R2 à 97 % : bascule avant la coupure — weevboss passe sur Codex, la session finit son étape, son plan (déjà prêt) attend un oui', async () => {
    const { x, relay } = world()
    x.sessions = [session()]
    x.quota = windows(92)
    await run(relay, NOW)
    x.quota = windows(97)
    await run(relay, NOW + 6 * MIN)
    expect(relay.view(NOW).limit).toMatchObject({ kind: 'near', percent: 97, window: 'session', until: NOW + 3 * H })
    expect(relay.bossOn()).toBe(true)
    expect(x.sent).toHaveLength(1)
    expect(x.sent[0]).toMatchObject({ id: 's1', from: 'weevboss' })
    expect(x.sent[0].text).toContain('Finis seulement l\'étape en cours')
    expect(x.notes.at(-1)).toEqual({ title: 'Claude à 97 % de sa fenêtre 5 h', body: "Codex prépare les plans de reprise jusqu'à 18 h", url: '/#relay' })
    // Elle travaille encore : son plan n'est pas encore sur la table.
    expect(relay.view(NOW).plans).toEqual([])
    // Elle s'arrête : le plan écrit d'avance est là tout de suite, et se met à jour (elle a travaillé depuis).
    x.sessions = [session({ status: 'idle', workStartedAt: null, lastActivityAt: NOW + 7 * MIN })]
    await relay.tick(NOW + 8 * MIN)
    expect(relay.view(NOW + 8 * MIN).plans).toMatchObject([{ sessionId: 's1', state: 'ready', refreshing: true }])
    await run(relay, NOW + 8 * MIN + 5000)
    expect(x.written).toHaveLength(2)
    expect(x.written[1].prompt).toContain('Ton plan précédent')
    expect(relay.view(NOW + 9 * MIN).plans).toMatchObject([{ sessionId: 's1', state: 'ready', title: 'refonte du panier' }])
    expect(relay.view(NOW + 9 * MIN).plans[0].refreshing).toBeUndefined()
    // Mode « proposer » : rien n'est lancé, un message dit que le plan attend.
    expect(x.opened).toEqual([])
    expect(x.notes.at(-1)).toMatchObject({ title: 'un plan de reprise à valider', url: '/#relay' })
    expect(x.said.at(-1)).toContain('Rien n\'est touché tant que tu n\'as pas validé')
    // Pas deux fois le message d'arrêt.
    expect(x.sent).toHaveLength(1)
    // Aucun appel à Claude dans toute la chaîne.
    expect(x.probes).toBe(0)
  })
})

describe('un seul message par seuil', () => {
  it('R1b le quota monte point par point et son heure de reset bouge de quelques millisecondes : un message à 90 %, un à la bascule, aucun plan réécrit, jamais de doublon', async () => {
    const { x, relay } = world()
    x.sessions = [session()]
    const week = (percent: number, jitter: number): QuotaInfo => ({ ok: true, source: 'test', at: NOW, windows: [{ kind: 'week', percent, resetsAt: NOW + 3 * 24 * H + jitter }] })
    let at = NOW
    for (const [percent, jitter] of [[90, 494], [91, -326], [91, 12], [92, 494], [93, 495], [94, -1], [94, 733], [95, 2], [96, 494]] as const) {
      x.quota = week(percent, jitter)
      await run(relay, at)
      await run(relay, at + 5000)
      at += 2 * MIN
    }
    expect(x.notes).toEqual([{ title: 'Claude approche de sa limite', body: "t'es à 90 % de ta semaine, je garde Codex au chaud", url: '/#relay' }])
    expect(x.said).toEqual(["T'es à 90 % de ta semaine, je garde Codex au chaud."])
    expect(x.written).toHaveLength(1)
    // La bascule : un second message, un seul, même si l'épisode se referme et se rouvre autour du seuil.
    for (const percent of [97, 98, 91, 97, 99]) {
      x.quota = week(percent, percent)
      await run(relay, at)
      await run(relay, at + 5000)
      at += 2 * MIN
    }
    expect(x.said).toHaveLength(2)
    expect(x.said[1]).toMatch(/^Claude à 97 % de sa semaine, Codex prépare les plans de reprise jusqu'à /)
    expect(x.notes).toHaveLength(2)
    // Un redémarrage de weevilsd ne redit rien.
    const again = world()
    fs.copyFileSync((relay as unknown as { file: string }).file, (again.relay as unknown as { file: string }).file)
    const { Relay: R2 } = await import('./relay.ts')
    const r2 = new R2(again.host, again.deps, (again.relay as unknown as { file: string }).file)
    again.x.sessions = [session()]
    again.x.quota = week(99, 5)
    again.x.now = at
    await r2.tick(at)
    await settle()
    expect(again.x.said).toEqual([])
    expect(again.x.notes).toEqual([])
  })
})

describe('filet de sécurité', () => {
  it('R3 message de limite dans un transcript : épisode jusqu’à l’heure écrite, plan par Codex, session Codex seulement après validation', async () => {
    const { x, relay } = world()
    x.sessions = [cut("You've hit your session limit · resets 6pm (Europe/Paris)")]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    expect(relay.view(NOW).limit).toMatchObject({ kind: 'limit', until: Date.parse('2026-11-10T17:00:00Z') })
    expect(x.notes[0]).toEqual({ title: 'limite Claude atteinte', body: "Codex prépare les plans de reprise jusqu'à 18 h", url: '/#relay' })
    expect(x.written).toHaveLength(1)
    expect(relay.view(NOW).plans).toMatchObject([{ sessionId: 's1', state: 'ready', text: x.plan }])
    expect(relay.covers(x.sessions[0])).toBe(true)
    expect(relay.holds('s1')).toBe(true)
    expect(x.opened).toEqual([])
    await relay.decide('s1', 'go')
    await settle()
    expect(x.opened).toHaveLength(1)
    expect(x.opened[0]).toMatchObject({ cwd: '/work/demo', title: 'refonte du panier' })
    expect(x.opened[0].text.startsWith('[from:weevboss]')).toBe(true)
    expect(x.opened[0].text).toContain('Plan validé :\nFait')
    expect(x.opened[0].text).toContain('/claude/s1.jsonl')
    expect(x.settled).toEqual(['s1'])
    expect(relay.view(NOW).plans).toMatchObject([{ state: 'running', relayTo: 'codex-thread-1' }])
    // Les deux sessions sont liées, dans les deux sens.
    expect(relay.relayedBy('s1')).toBe('codex-thread-1')
    expect(relay.relayOf('codex-thread-1')).toBe('s1')
    expect(relay.relayOf(undefined, 'wv-codex-1')).toBe('s1')
    // Une seule session Codex, même si on revalide.
    await relay.decide('s1', 'go').catch(() => undefined)
    await run(relay, NOW + 10_000)
    expect(x.opened).toHaveLength(1)
  })

  it('R4 mode automatique : le plan est écrit puis exécuté sans attendre, une seule notification', async () => {
    const { x, relay } = world({ mode: 'auto' })
    x.sessions = [cut('usage limit reached · resets 6pm'), cut('usage limit reached · resets 6pm', { id: 's2', title: 'les tests', cwd: '/work/tests' })]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    await run(relay, NOW + 10_000)
    expect(x.notes).toEqual([{ title: 'limite Claude atteinte', body: "Codex prend le relais jusqu'à 18 h", url: '/#relay' }])
    expect(x.said).toEqual(["Limite Claude atteinte, Codex prend le relais jusqu'à 18 h."])
    expect(x.written).toHaveLength(2)
    expect(x.opened.map((o) => o.cwd).sort()).toEqual(['/work/demo', '/work/tests'])
    expect(x.settled.sort()).toEqual(['s1', 's2'])
  })

  it('durable automatic authorization releases a waiting plan, survives restart and handles future plans once', async () => {
    const { x, relay, host, deps, file } = world()
    x.sessions = [cut('usage limit reached · resets 6pm')]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    await relay.decide('s1', 'wait')
    expect(relay.view(NOW).plans[0].state).toBe('waiting')
    relay.set({ mode: 'auto' })
    await run(relay, NOW + 10_000)
    expect(x.opened).toHaveLength(1)
    expect(relay.view(NOW).plans[0].state).toBe('running')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mode).toBe('auto')
    const again = new Relay(host, deps, file)
    clocks.set(again, x)
    expect(again.mode).toBe('auto')
    x.sessions.push(cut('usage limit reached · resets 6pm', { id: 's2', cwd: '/work/tests' }))
    await run(again, NOW + 15_000)
    await run(again, NOW + 20_000)
    expect(x.opened.map((o) => o.cwd).sort()).toEqual(['/work/demo', '/work/tests'])
    await run(again, NOW + 25_000)
    expect(x.opened).toHaveLength(2)
    x.sessions = []
    x.probeOk = true
    x.quota = windows(10)
    await run(again, NOW + 5 * H)
    expect(again.bossOn()).toBe(false)
    expect(again.autoOnCodex()).toBe(false)
    expect(again.mode).toBe('auto')
  })

  it('R5 plusieurs plans : tout valider d’un coup ; ajuster réécrit le plan avec la note ; attendre Claude reprend la session à l’heure de reset', async () => {
    const { x, relay } = world()
    const limit = 'usage limit reached · resets 6pm (Europe/Paris)'
    x.sessions = [cut(limit), cut(limit, { id: 's2', title: 'les tests', cwd: '/work/tests' }), cut(limit, { id: 's3', title: 'la doc', cwd: '/work/doc' })]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    await run(relay, NOW + 10_000)
    expect(relay.view(NOW).plans.map((p) => p.state)).toEqual(['ready', 'ready', 'ready'])
    expect(x.notes.at(-1)).toMatchObject({ title: '3 plans de reprise à valider' })
    await relay.decide('s3', 'wait')
    await relay.decide('s2', 'adjust', 'ne touche pas au CI')
    await settle()
    await run(relay, NOW + 15_000)
    expect(x.written.at(-1)?.prompt).toContain('ne touche pas au CI')
    expect(x.written.at(-1)?.prompt).toContain('Ton plan précédent')
    await relay.decide('all', 'go')
    await settle()
    await run(relay, NOW + 20_000)
    expect(x.opened.map((o) => o.cwd).sort()).toEqual(['/work/demo', '/work/tests'])
    expect(x.opened.find((o) => o.cwd === '/work/tests')?.text).toContain('ne touche pas au CI')
    expect(relay.view(NOW).plans.find((p) => p.sessionId === 's3')?.state).toBe('waiting')
    // 18 h à Paris : Claude revient, la session laissée à Claude est reprise, weevboss retourne sur Claude.
    const reset = Date.parse('2026-11-10T17:00:00Z')
    await run(relay, reset + 1000)
    expect(relay.view(reset + 1000).limit).toBeUndefined()
    expect(relay.bossOn()).toBe(false)
    expect(x.resumed).toEqual(['s3'])
    expect(x.said.at(-1)).toBe('Claude est de retour : je reprends sur Claude.')
    expect(relay.takeBossBack()).toBe(NOW)
    expect(relay.takeBossBack()).toBeUndefined()
    // La même coupure, toujours affichée, ne rouvre pas d'épisode.
    await run(relay, reset + 10_000)
    expect(relay.view(reset + 10_000).limit).toBeUndefined()
  })

  it('R6 erreurs d’API répétées : Claude interrogé une fois — il répond, pas d’épisode ; il ne répond pas, relais, puis retour dès qu’il répond', async () => {
    const { x, relay } = world()
    const api = (id: string) => session({ id, status: 'interrupted', workStartedAt: null, interrupted: { at: NOW - MIN, reason: 'api', detail: 'API Error: 529 overloaded' } })
    x.sessions = [api('s1'), api('s2')]
    x.probeOk = true
    await run(relay, NOW)
    expect(x.probes).toBe(1)
    expect(relay.view(NOW).limit).toBeUndefined()
    const w2 = world()
    w2.x.sessions = [api('s1'), api('s2')]
    await run(w2.relay, NOW)
    await run(w2.relay, NOW + 5000)
    expect(w2.relay.view(NOW).limit).toMatchObject({ kind: 'down', until: null })
    expect(w2.x.notes[0]).toMatchObject({ title: 'Claude ne répond plus' })
    expect(w2.relay.view(NOW).plans).toHaveLength(2)
    w2.x.probeOk = true
    await run(w2.relay, NOW + 6 * MIN)
    await run(w2.relay, NOW + 6 * MIN + 5000)
    expect(w2.relay.view(NOW + 7 * MIN).limit).toBeUndefined()
  })

  it('R7 quota à 100 % sans message : limite ; une seule coupure nette avec un quota à 95 % : limite aussi', async () => {
    const { x, relay } = world()
    x.quota = windows(30, 100)
    await run(relay, NOW)
    expect(relay.view(NOW).limit).toMatchObject({ kind: 'limit', window: 'week', until: NOW + 4 * 24 * H })
    const w2 = world()
    w2.x.quota = windows(95)
    await run(w2.relay, NOW)
    expect(w2.relay.view(NOW).limit).toBeUndefined()
    w2.x.quota = windows(98)
    w2.x.sessions = [session({ status: 'interrupted', workStartedAt: null, interrupted: { at: NOW + MIN, reason: 'died' } })]
    await run(w2.relay, NOW + 2 * MIN)
    expect(w2.relay.view(NOW + 2 * MIN).limit).toMatchObject({ kind: 'limit', window: 'session', percent: 98 })
  })
})

describe('réglage', () => {
  it('R8 jamais : rien n’est détecté ni lancé ; sans Codex : rien non plus ; défaut : proposer un plan', async () => {
    const never = world({ mode: 'never' })
    never.x.sessions = [cut('usage limit reached · resets 6pm')]
    never.x.quota = windows(100)
    await run(never.relay, NOW)
    expect(never.relay.view(NOW)).toMatchObject({ mode: 'never', plans: [] })
    expect(never.relay.view(NOW).limit).toBeUndefined()
    expect(never.x.written).toEqual([])
    expect(never.relay.covers(never.x.sessions[0])).toBe(false)
    const bare = world({ codex: false })
    bare.x.sessions = [cut('usage limit reached · resets 6pm')]
    await run(bare.relay, NOW)
    expect(bare.x.written).toEqual([])
    expect(bare.x.notes).toEqual([])
    expect(bare.relay.bossOn()).toBe(false)
    expect(bare.relay.covers(bare.x.sessions[0])).toBe(false)
    const { deps, host } = world()
    expect(new Relay(host, deps, path.join(os.tmpdir(), `wv-relay-none-${Date.now()}.json`)).view(NOW)).toMatchObject({ mode: 'ask', switchAt: 97 })
  })

  it('R9 seuil de bascule réglable ; l’état survit à un redémarrage ; un plan impossible à écrire se valide quand même', async () => {
    const { x, relay, file, host, deps } = world({ switchAt: 95 })
    x.sessions = [session()]
    x.quota = windows(95)
    x.writeFails = true
    await run(relay, NOW)
    expect(relay.view(NOW).limit).toMatchObject({ kind: 'near' })
    x.sessions = [session({ status: 'idle', workStartedAt: null })]
    await run(relay, NOW + 10_000)
    await run(relay, NOW + 15_000)
    expect(relay.view(NOW).plans).toMatchObject([{ state: 'failed', error: "Codex n'a pas pu écrire le plan" }])
    const again = new Relay(host, deps, file)
    expect(again.view(NOW)).toMatchObject({ mode: 'ask', switchAt: 95, limit: { kind: 'near' } })
    expect(again.view(NOW).plans).toHaveLength(1)
    await again.decide('s1', 'go')
    await settle()
    expect(x.opened).toHaveLength(1)
    expect(x.opened[0].text).toContain('aucun plan écrit')
  })

  it('R10 weevboss coupé en pleine réponse : son message resté sans réponse part chez Codex, une fois', async () => {
    const { x, relay } = world()
    x.boss = { at: NOW - MIN, reason: 'quota', text: 'usage limit reached · resets 6pm (Europe/Paris)' }
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    expect(relay.view(NOW)).toMatchObject({ boss: true, limit: { kind: 'limit' } })
    expect(x.bossCuts).toBe(1)
  })
})


describe('quota window history', () => {
  it('keeps preparation announcements across week / five-hour alternation and restart', async () => {
    const { x, relay, file, host, deps } = world()
    x.sessions = [session()]
    let active = relay
    for (const [i, q] of [windows(91, 92), windows(94, 92), windows(91, 95), windows(96, 95), windows(91, 96)].entries()) {
      x.quota = q
      const at = NOW + i * 6 * MIN
      x.now = at
      await active.tick(at)
      await settle()
      active = new Relay(host, deps, file)
    }
    expect(x.notes).toHaveLength(2)
    expect(x.written).toHaveLength(1)
  })
  it('announces a fresh window after the previous reset', async () => {
    const { x, relay } = world()
    x.quota = windows(92)
    await run(relay, NOW)
    x.quota = { ...windows(92), windows: [{ kind: 'session', percent: 92, resetsAt: NOW + 8 * H }] }
    await run(relay, NOW + 4 * H)
    expect(x.notes).toHaveLength(2)
  })
  it('migrates the old warning without repeating it and preserves auto mode', async () => {
    const { x, file, host, deps } = world({ mode: 'auto' })
    fs.writeFileSync(file, JSON.stringify({ mode: 'auto', warned: NOW + 3 * H, plans: [] }))
    const relay = new Relay(host, deps, file)
    x.quota = windows(92)
    await relay.tick(NOW)
    await settle()
    expect(x.notes).toEqual([])
    expect(relay.view(NOW).mode).toBe('auto')
  })
})


it('remembers each switch across alternating quota episodes and restart', async () => {
  const { x, relay, file, host, deps } = world({ mode: 'auto' })
  let active = relay
  for (const [i, q] of [windows(90, 97), windows(10, 10), windows(98, 90), windows(10, 10), windows(90, 98)].entries()) {
    const at = NOW + i * 6 * MIN
    x.quota = { ...q, at }
    x.now = at
    await active.tick(at)
    await settle()
    active = new Relay(host, deps, file)
  }
  expect(x.notes.filter(n => n.title.startsWith('Claude à'))).toHaveLength(2)
})


describe('resolved relay requests', () => {
  it('persists an answered plan across restart and reopens a distinct request on launch failure', async () => {
    const { x, relay, host, deps, file } = world()
    x.sessions = [cut('usage limit reached · resets 6pm')]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    const first = relay.view().plans[0]
    await relay.decide('s1', 'wait')
    expect(relay.view().plans[0]).toMatchObject({ resolved: true, state: 'waiting' })
    const again = new Relay(host, deps, file)
    expect(again.view().plans[0]).toMatchObject({ resolved: true, state: 'waiting' })
    host.openCodex = async () => { throw new Error('launch failed') }
    await again.decide('s1', 'go')
    await settle()
    const failed = again.view().plans[0]
    expect(failed.resolved).toBeUndefined()
    expect(failed.error).toBe('launch failed')
    expect(failed.at).toBeGreaterThan(first.at)
    expect(new Relay(host, deps, file).view().plans[0]).toMatchObject({ error: 'launch failed' })
  })
  it('a revised plan becomes a new request only when its rewrite finishes', async () => {
    const { x, relay } = world()
    x.sessions = [cut('usage limit reached · resets 6pm')]
    await run(relay, NOW)
    await run(relay, NOW + 5000)
    const first = relay.view().plans[0]
    await relay.decide('s1', 'adjust', 'add tests')
    await settle()
    const revised = relay.view().plans[0]
    expect(revised.resolved).toBeUndefined()
    expect(revised.at).toBeGreaterThan(first.at)
    expect(revised.state).toBe('ready')
  })
})
