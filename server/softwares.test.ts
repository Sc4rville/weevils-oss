import { describe, expect, it, vi } from 'vitest'
import {
  alive,
  allocatePort,
  declaredPort,
  detectKind,
  emptySignals,
  frameEmbeddable,
  groupRepos,
  heldBy,
  heuristic,
  listeners,
  macChromes,
  macStart,
  normOrigin,
  parseCaddySite,
  parseEstimates,
  parseListeners,
  parsePsPgid,
  parseUnit,
  pgids,
  playwrightCache,
  redact,
  portInCode,
  signalsHash,
  slugify,
  stripAnsi,
  tailLines,
  talkSignals,
  userUnits,
  visitorsIn,
  wildcard,
  type KindFacts,
  type RepoFacts,
  type Signals,
} from './softwares.ts'

const repo = (name: string, origin?: string, extra: Partial<RepoFacts> = {}): RepoFacts => ({
  name,
  dir: `/p/${name}`,
  origin: normOrigin(origin),
  branch: 'main',
  lastCommitAt: 1000,
  git: true,
  ...extra,
})

describe('regroupement des repos', () => {
  const GAME = 'https://github.com/Sc4rville/mygame.git'
  const list = [
    repo('mygame', GAME),
    repo('mygame-trailer', GAME, { branch: 'trailer-v2', lastCommitAt: 5000 }),
    repo('mygame-v3-action', 'git@github.com:Sc4rville/mygame.git', { branch: 'trailer-v2' }),
    repo('weevils', 'https://github.com/Sc4rville/weevils.git'),
    repo('weevils-content', 'https://github.com/Sc4rville/weevils-content.git', { lastCommitAt: 9000 }),
    repo('lws-demo', 'https://github.com/Sc4rville/lastwebstudios.git', { lastCommitAt: 3000 }),
    repo('lws-wip', undefined, { lastCommitAt: 2000 }),
    repo('lws-oss', undefined, { git: false, branch: undefined, lastCommitAt: 9999 }),
    repo('pli', 'https://github.com/Sc4rville/pli.git', { branch: 'master' }),
  ]
  const groups = groupRepos(list)
  const by = (k: string) => groups.find((g) => g.key === k)!

  it('fusionne les variantes et worktrees de même origine', () => {
    expect(by('mygame').repos.map((r) => r.name)).toEqual(['mygame', 'mygame-trailer', 'mygame-v3-action'])
    expect(by('mygame').main.name).toBe('mygame')
    expect(by('mygame').name).toBe('mygame')
  })

  it("sépare un repo de la famille dont l'origine diffère (weevils-content ≠ weevils)", () => {
    expect(by('weevils').repos.map((r) => r.name)).toEqual(['weevils'])
    expect(by('weevils-content').repos.map((r) => r.name)).toEqual(['weevils-content'])
    expect(by('weevils-content').name).toBe('weevils-content')
  })

  it("les copies sans origine rejoignent l'origine dominante ; le principal est sur la branche par défaut, avec git", () => {
    const lws = by('lws')
    expect(lws.repos.map((r) => r.name).sort()).toEqual(['lws-demo', 'lws-oss', 'lws-wip'])
    expect(lws.main.name).toBe('lws-demo')
    expect(lws.name).toBe('lws')
  })

  it('la copie principale et la clé ne changent pas avec un commit récent', () => {
    const lws = [
      repo('lws-demo', 'https://github.com/x/lastwebstudios.git', { lastCommitAt: 1000 }),
      repo('lws-wip', undefined, { lastCommitAt: 9000 }),
      repo('lws-rookie', undefined, { lastCommitAt: 5000 }),
    ]
    const g = groupRepos(lws)
    expect(g).toHaveLength(1)
    expect(g[0].main.name).toBe('lws-demo')
    // Deux origines à une copie chacune : la clé ne suit pas le dernier commit.
    const a = groupRepos([repo('shop-api', 'https://github.com/x/a.git', { lastCommitAt: 1 }), repo('shop-web', 'https://github.com/x/b.git', { lastCommitAt: 2 })])
    const b = groupRepos([repo('shop-api', 'https://github.com/x/a.git', { lastCommitAt: 3 }), repo('shop-web', 'https://github.com/x/b.git', { lastCommitAt: 2 })])
    expect(a.map((x) => [x.key, x.main.name])).toEqual(b.map((x) => [x.key, x.main.name]))
    // Un dossier sans git qui porte le nom de la famille ne passe pas devant la copie git.
    expect(groupRepos([repo('shop', undefined, { git: false }), repo('shop-web', 'https://github.com/x/b.git')])[0].main.name).toBe('shop-web')
  })
  it('un repo seul garde son nom', () => {
    expect(by('pli').name).toBe('pli')
    expect(groups).toHaveLength(5)
  })

  it('une famille sans aucune origine reste un seul logiciel', () => {
    const g = groupRepos([repo('shop-api'), repo('shop-web', undefined, { lastCommitAt: 3000 })])
    expect(g).toHaveLength(1)
    expect(g[0].key).toBe('shop')
    expect(g[0].main.name).toBe('shop-web')
  })

  it('normalise les origines', () => {
    expect(normOrigin('https://github.com/Sc4rville/mygame.git')).toBe('github.com/sc4rville/mygame')
    expect(normOrigin('git@github.com:Sc4rville/mygame.git')).toBe('github.com/sc4rville/mygame')
    expect(normOrigin('ssh://git@gitlab.com:2222/a/b/')).toBe('gitlab.com/a/b')
    expect(normOrigin('')).toBeUndefined()
  })
})

describe('port du projet', () => {
  it('lit server.port puis preview.port dans la config vite', () => {
    const vite = `export default defineConfig({ plugins: [react()], server: { proxy: { '/api': { target: 'http://localhost:4179' } }, port: 5173 }, preview: { port: 4300 } })`
    expect(declaredPort({ name: 'x', vite })).toBe(5173)
    expect(declaredPort({ name: 'x', vite: 'defineConfig({ preview: { port: 4300 } })' })).toBe(4300)
  })

  it('lit les scripts (--port, -p, PORT=)', () => {
    expect(declaredPort({ name: 'x', scripts: { dev: 'vite --host 127.0.0.1 --port 4174' } })).toBe(4174)
    expect(declaredPort({ name: 'x', scripts: { dev: 'next dev -p 3001' } })).toBe(3001)
    expect(declaredPort({ name: 'x', scripts: { start: 'PORT=8088 node server.js' } })).toBe(8088)
    expect(declaredPort({ name: 'x', scripts: { build: 'vite build --port 1234' } })).toBeUndefined()
  })

  it('lit .env et le défaut du code (avec la variable qui le change)', () => {
    expect(declaredPort({ name: 'x', env: '# local\nPORT=3456\n' })).toBe(3456)
    expect(declaredPort({ name: 'x', code: 'const PORT = Number(process.env.PORT || 5174);' })).toBe(5174)
    expect(portInCode('const PORT = +(process.env.GESTE_PORT || 7790)')).toEqual({ port: 7790, env: 'GESTE_PORT' })
    expect(portInCode('port = int(os.environ.get("PORT", 8000))')).toEqual({ port: 8000, env: 'PORT' })
  })

  it('lit la doc seulement près du nom du projet', () => {
    expect(declaredPort({ name: 'mygame', docs: 'mygame tourne en local sur le port 4173.' })).toBe(4173)
    expect(declaredPort({ name: 'mygame', docs: 'weevilsd écoute sur le port 4179.' + ' '.repeat(400) + 'mygame' })).toBeUndefined()
  })

  it('alloue un port stable, libre, non retenu par un autre logiciel', () => {
    const busy = new Set([4174, 4179, 4180])
    expect(allocatePort('a', {}, busy)).toBe(4175)
    expect(allocatePort('a', { b: 4175 }, busy)).toBe(4176)
    expect(allocatePort('a', { a: 4190, b: 4175 }, busy)).toBe(4190)
    // Son port retenu écoute maintenant (autre chose) : on en prend un autre.
    expect(allocatePort('a', { a: 4174 }, busy)).toBe(4175)
  })
})

describe('genre', () => {
  const base: KindFacts = { name: 'x', deps: [], scripts: {}, bin: false, html: false, staticSite: false, url: false, unit: false, container: false, listening: false }
  it('reconnaît web, bot, api, service, cli, lib', () => {
    expect(detectKind({ ...base, deps: ['vite', 'three'] })).toBe('web')
    expect(detectKind({ ...base, html: true })).toBe('web')
    expect(detectKind({ ...base, url: true, unit: true })).toBe('web')
    expect(detectKind({ ...base, deps: ['express', 'telegraf'] })).toBe('bot')
    expect(detectKind({ ...base, name: 'my-bot' })).toBe('bot')
    expect(detectKind({ ...base, deps: ['fastify'] })).toBe('api')
    expect(detectKind({ ...base, unit: true })).toBe('service')
    expect(detectKind({ ...base, listening: true })).toBe('api')
    expect(detectKind({ ...base, bin: true })).toBe('cli')
    expect(detectKind(base)).toBe('lib')
  })
})

describe('sites Caddy', () => {
  it('lit un proxy localhost (format expose)', () => {
    expect(parseCaddySite('demo.caddy', 'demo.example.com {\n\treverse_proxy localhost:4174\n\tlog {\n\t\toutput file /var/log/caddy/demo.log\n\t}\n}\n')).toEqual({
      name: 'demo',
      host: 'demo.example.com',
      proxies: [{ host: 'localhost', port: 4174 }],
      log: '/var/log/caddy/demo.log',
    })
  })
  it('lit un proxy 127.0.0.1 derrière un matcher, et une racine statique, sans les commentaires', () => {
    const s = parseCaddySite('mygame.caddy', `# site PERMANENT : reverse_proxy localhost:1\nmygame.example.com {\n\thandle /api/* {\n\t\treverse_proxy 127.0.0.1:4173\n\t}\n\thandle {\n\t\troot * /home/u/projects/mygame/dist\n\t\tfile_server\n\t}\n}\n`)!
    expect(s.proxies).toEqual([{ host: '127.0.0.1', port: 4173 }])
    expect(s.root).toBe('/home/u/projects/mygame/dist')
  })
  it('lit un amont distant (conteneur)', () => {
    expect(parseCaddySite('essai.caddy', 'essai.example.com {\n\treverse_proxy 172.30.99.10:8080\n}')!.proxies).toEqual([{ host: '172.30.99.10', port: 8080 }])
  })
})

describe('affichage dans un cadre', () => {
  const app = 'https://weevils.example.com'
  it("suit X-Frame-Options et frame-ancestors (qui l'emporte)", () => {
    expect(frameEmbeddable({}, 'https://a.example.com', app)).toBe(true)
    expect(frameEmbeddable({ xfo: 'DENY' }, 'https://a.example.com', app)).toBe(false)
    expect(frameEmbeddable({ xfo: 'SAMEORIGIN' }, 'https://a.example.com', app)).toBe(false)
    expect(frameEmbeddable({ xfo: 'SAMEORIGIN' }, `${app}/x`, app)).toBe(true)
    expect(frameEmbeddable({ csp: "default-src 'self'; frame-ancestors 'none'" }, 'https://a.example.com', app)).toBe(false)
    expect(frameEmbeddable({ csp: "frame-ancestors 'self'" }, 'https://a.example.com', app)).toBe(false)
    expect(frameEmbeddable({ csp: 'frame-ancestors https://*.example.com' }, 'https://a.example.com', app)).toBe(true)
    expect(frameEmbeddable({ csp: 'frame-ancestors https://other.org' }, 'https://a.example.com', app)).toBe(false)
    expect(frameEmbeddable({ csp: 'frame-ancestors *', xfo: 'DENY' }, 'https://a.example.com', app)).toBe(true)
  })
})

describe('sortie', () => {
  it('retire les codes ANSI et les barres de progression, coupe les lignes longues', () => {
    expect(stripAnsi('\x1b[32m  VITE v6\x1b[39m ready')).toBe('  VITE v6 ready')
    const lines = tailLines(`\x1b[1mone\x1b[0m\r\n\nprogress 10%\rprogress 100%\n${'x'.repeat(300)}\n`)
    expect(lines[0]).toBe('one')
    expect(lines[1]).toBe('progress 100%')
    expect(lines[2]).toHaveLength(160)
    expect(tailLines(Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n'))).toHaveLength(40)
  })
  it('lit un service systemd', () => {
    expect(parseUnit('[Service]\nWorkingDirectory=%h/projects/mygame\nExecStart=/usr/bin/env node ops/vps/server.mjs\n').workdir).toMatch(/\/projects\/mygame$/)
    expect(parseUnit('ExecStart=/usr/bin/python3 /srv/bot/main.py --x').paths).toEqual(['/srv/bot/main.py'])
  })
  it('nom DNS sûr', () => {
    expect(slugify('Mon Éditeur_2')).toBe('mon-editeur-2')
    expect(slugify('***')).toBe('app')
  })
})

describe('avancement', () => {
  const sig = (s: Partial<Signals>): Signals => ({ ...emptySignals(), ...s })
  it('un repo tout jeune, peu de commits, sans tests : phase 1, bas', () => {
    const p = heuristic(sig({ commits: 3, readme: 100 }))
    expect(p.phase).toBe(1)
    expect(p.percent).toBeLessThan(25)
    expect(p.source).toBe('heuristic')
    expect(p.reason).toContain('3 commits')
  })
  it('déployé et qui marche : phase 2', () => {
    const p = heuristic(sig({ commits: 120, tests: 8, usage: true, readme: 3000, deployed: true, recent: 6 }))
    expect(p.phase).toBe(2)
    expect(p.percent).toBeGreaterThan(50)
    expect(p.reason.length).toBeLessThanOrEqual(60)
  })
  it('une version 1.0 avec quelques commits compte comme utilisable, pas avec un seul', () => {
    expect(heuristic(sig({ commits: 20, version: '1.2.0' })).phase).toBe(2)
    expect(heuristic(sig({ commits: 20, version: '1.0.0', tags: 1 })).phase).toBe(2)
    // La version d'office de npm init n'est pas une sortie.
    expect(heuristic(sig({ commits: 20, version: '1.0.0' })).phase).toBe(1)
    expect(heuristic(sig({ commits: 1, version: '1.0.0' })).phase).toBe(1)
  })
  it('des visiteurs ou des étoiles venus d’ailleurs : phase 3, échelle log', () => {
    const few = heuristic(sig({ commits: 50, deployed: true, visitors: 6 }))
    const many = heuristic(sig({ commits: 50, deployed: true, visitors: 600 }))
    expect(few.phase).toBe(3)
    expect(many.phase).toBe(3)
    expect(many.percent).toBeGreaterThan(few.percent)
    expect(heuristic(sig({ stars: 4 })).phase).toBe(3)
  })
  it("l'empreinte ignore les petits bruits et suit les vrais changements", () => {
    const a = sig({ commits: 100, visitors: 6 })
    expect(signalsHash(a)).toBe(signalsHash({ ...a, visitors: 7 }))
    expect(signalsHash(a)).not.toBe(signalsHash({ ...a, deployed: true }))
  })
  it('lit la réponse du modèle avec méfiance', () => {
    const raw = 'Voici : {"items":[{"id":"mygame","phase":2,"percent":140,"reason":"en ligne"},{"id":"inconnu","phase":1,"percent":5,"reason":""},{"id":"pli","phase":7,"percent":5}]}'
    const m = parseEstimates(raw, new Set(['mygame', 'pli']))
    expect([...m.keys()]).toEqual(['mygame'])
    expect(m.get('mygame')).toEqual({ phase: 2, percent: 100, reason: 'en ligne' })
    expect(parseEstimates('pas de json', new Set(['x'])).size).toBe(0)
  })
  it('compte les visiteurs distincts : de vraies personnes seulement, sans robots, scanners ni adresses de l’utilisateur', () => {
    const now = Math.floor(Date.now() / 1000)
    const line = (ip: string, ua: string, uri = '/assets/app.js', status = 200, ts = now, lang = 'fr-FR') =>
      JSON.stringify({ ts, status, request: { client_ip: ip, uri, headers: { 'User-Agent': [ua], ...(lang ? { 'Accept-Language': [lang] } : {}) } } })
    const text = [
      line('1.1.1.1', 'Mozilla/5.0 iPhone', '/', 200, now - 600),
      line('1.1.1.1', 'Mozilla/5.0 iPhone'), // resté 10 minutes
      line('2.2.2.2', 'Googlebot/2.1'),
      line('3.3.3.3', 'Mozilla/5.0', '/api/scores', 200, now - 2 * 86400),
      line('3.3.3.3', 'Mozilla/5.0', '/'), // revenu un autre jour
      line('4.4.4.4', 'Mozilla/5.0', '/app.js', 200, now - 30 * 86400),
      line('4.4.4.4', 'Mozilla/5.0', '/app.js', 200, now - 29 * 86400), // trop vieux
      line('5.5.5.5', 'Mozilla/5.0', '/app.js', 200, now - 600),
      line('5.5.5.5', 'Mozilla/5.0'), // l'utilisateur lui-même
      line('6.6.6.6', 'Mozilla/5.0', '/', 200, now - 600),
      line('6.6.6.6', 'Mozilla/5.0', '/'), // la page seule : un sondage
      line('7.7.7.7', "Mozilla/5.0 (compatible; Let's Encrypt validation server)", '/.well-known/acme-challenge/x'),
      line('8.8.8.8', 'Mozilla/5.0', '/style.css', 200, now - 600),
      line('8.8.8.8', 'Mozilla/5.0', '/.env', 404), // a sondé : plus compté du tout
      line('9.9.9.9', 'Mozilla/5.0', '/app.js', 404, now - 600),
      line('9.9.9.9', 'Mozilla/5.0', '/app.js', 404), // fichier jamais servi
      line('10.0.0.1', 'Mozilla/5.0', '/'),
      line('10.0.0.1', 'Mozilla/5.0', '/app.js'),
      line('10.0.0.1', 'Mozilla/5.0', '/logo.png'), // une rafale : un robot qui se fait passer pour un navigateur
      line('11.0.0.1', 'Mozilla/5.0', '/app.js', 200, now - 600, ''),
      line('11.0.0.1', 'Mozilla/5.0', '/app.js', 200, now, ''), // sans langue : pas un navigateur
    ].join('\n')
    expect([...visitorsIn(text, Date.now() - 7 * 86400_000, new Set(['5.5.5.5']))].sort()).toEqual(['1.1.1.1', '3.3.3.3'])
  })
  it('lit les échanges avec les sessions', () => {
    const t = talkSignals(['ça marche nickel', 'on le met en prod ce soir', 'mes premiers clients ont payé', 'il y a un bug sur la carte'])
    expect(t).toEqual({ works: 1, prod: 1, users: 1, bugs: 1 })
  })
})

describe('masquage des secrets dans les aperçus', () => {
  it('masque jetons, clés et liens d’appairage, garde le reste', () => {
    expect(redact('link: sgnl://linkdevice?uuid=9acF9Kxr&pub_key=BQx')).toBe('link: sgnl://•••')
    expect(redact('GET /api?token=abcdef123456&page=2')).toBe('GET /api?token=•••&page=2')
    expect(redact('Authorization: Bearer abcdefghijklmnop123')).not.toContain('abcdefghijklmnop123')
    expect(redact('sent with Bearer abcdefghijklmnop123')).toBe('sent with Bearer •••')
    expect(redact('key sk-ant-api03-abcdefghijklmnopqrstu used')).toBe('key ••• used')
    expect(redact('PASSWORD=hunter2hunter')).toBe('PASSWORD=•••')
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('•••')
    expect(redact('✓ built in 336ms, 12 modules')).toBe('✓ built in 336ms, 12 modules')
    expect(redact('a412083 Rendu : écriture dans le canvas')).toBe('a412083 Rendu : écriture dans le canvas')
  })
})

describe('ports à l’écoute', () => {
  it('lit toutes les lignes de ss, même sans processus (root, docker-proxy)', () => {
    const out = [
      'LISTEN 0      511        127.0.0.1:4179  0.0.0.0:* users:(("node",pid=3523328,fd=30))',
      'LISTEN 0      4096       127.0.0.1:4178  0.0.0.0:*',
      'LISTEN 0      4096       0.0.0.0:22      0.0.0.0:*',
      'LISTEN 0      4096       [::]:8080       [::]:*    users:(("python3",pid=12,fd=3),("python3",pid=13,fd=3))',
      'LISTEN 0      4096       [fe80::1%eth0]:9000 [::]:*',
    ].join('\n')
    const l = parseListeners(out)
    expect(l.map((x) => [x.port, x.addr, x.pids])).toEqual([
      [4179, '127.0.0.1', [3523328]],
      [4178, '127.0.0.1', []],
      [22, '0.0.0.0', []],
      [8080, '::', [12, 13]],
      [9000, 'fe80::1', []],
    ])
    expect(l.filter((x) => wildcard(x.addr)).map((x) => x.port)).toEqual([22, 8080])
  })
})

// macOS has no ss and no /proc: lsof says what listens, ps the process group and the start time. Run on Linux with the
// platform and the command runner injected; the outputs are canned (written from the documented formats, not captured
// on a Mac).
describe('macOS — a server launched from the app is seen listening', () => {
  const LSOF = ['p61234', 'cnode', 'f23', 'n127.0.0.1:5173', 'f24', 'n[::1]:5173', 'p61240', 'cnode', 'f23', 'n127.0.0.1:5173', 'p700', 'cPython', 'f3', 'n*:8000', ''].join('\n')

  it('listeners(): lsof, one entry per address and port with every pid that holds it; ss is never started', async () => {
    const run = vi.fn(async () => LSOF)
    const l = await listeners('darwin', run)
    expect(l).toEqual([
      { port: 5173, addr: '127.0.0.1', pids: [61234, 61240] },
      { port: 5173, addr: '::1', pids: [61234] },
      { port: 8000, addr: '*', pids: [700] },
    ])
    expect(run.mock.calls).toEqual([['/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']]])
    // A dev server bound to every interface is still caught (lsof writes the wildcard as *).
    expect(l.filter((x) => wildcard(x.addr)).map((x) => x.port)).toEqual([8000])
    expect(await listeners('darwin', async () => '')).toEqual([])
  })

  it('on Linux listeners() still reads ss', async () => {
    const run = vi.fn(async () => 'LISTEN 0      511        127.0.0.1:4179  0.0.0.0:* users:(("node",pid=3523328,fd=30))\n')
    expect(await listeners('linux', run)).toEqual([{ port: 4179, addr: '127.0.0.1', pids: [3523328] }])
    expect(run.mock.calls).toEqual([['ss', ['-ltnpH']]])
  })

  it('the process group of each listener comes from one ps call; the port is ours when one of them is in our group', async () => {
    // `ps -o pid= -o pgid= -p 61234,61240`: right-aligned columns, no header; a pid that is gone has no line.
    const PS = '61234 61200\n61240 61200\n'
    expect(parsePsPgid('  412     1\n61234 61200\n\nps: illegal\n')).toEqual(new Map([[412, 1], [61234, 61200]]))
    const run = vi.fn(async () => PS)
    expect(await pgids([61234, 61240], 'darwin', run)).toEqual(new Map([[61234, 61200], [61240, 61200]]))
    expect(run.mock.calls).toEqual([['/bin/ps', ['-o', 'pid=', '-o', 'pgid=', '-p', '61234,61240']]])
    const mine = (await listeners('darwin', async () => LSOF)).filter((x) => x.port === 5173)
    // sh -c (pid 61200, the group leader weevils started) → npm → node: the listener is a grandchild, same group.
    expect(await heldBy(mine, 61200, 'darwin', run)).toBe(true)
    expect(await heldBy(mine, 999, 'darwin', run)).toBe(false)
    // Nobody on the port yet: ps is not even started.
    run.mockClear()
    expect(await heldBy([], 61200, 'darwin', run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    // ps failing (no output): not ours, the launch keeps waiting.
    expect(await heldBy(mine, 61200, 'darwin', async () => '')).toBe(false)
  })

  it('a launched process is the same one while ps gives the same start time; a reused pid is not', async () => {
    const started = 'Fri Nov 13 19:28:34 2026'
    const run = vi.fn(async () => `${started}\n`)
    expect(await macStart(4242, run)).toBe(started)
    expect(run.mock.calls).toEqual([['/bin/ps', ['-o', 'lstart=', '-p', '4242']]])
    // This test's own pid exists: alive when the start time matches, or when none was recorded, or when ps says nothing.
    expect(await alive(process.pid, started, 'darwin', run)).toBe(true)
    expect(await alive(process.pid, 'Fri Nov 13 08:00:00 2026', 'darwin', run)).toBe(false)
    expect(await alive(process.pid, '', 'darwin', run)).toBe(true)
    expect(await alive(process.pid, started, 'darwin', async () => '')).toBe(true)
    // No such pid: never alive, whatever ps says.
    expect(await alive(2 ** 30, started, 'darwin', run)).toBe(false)
  })

  it('no systemd service on a Mac: nothing read, nothing started', async () => {
    expect(await userUnits('darwin')).toEqual([])
  })

  it('Chromium for the screenshots: the apps and Playwright’s cache where a Mac keeps them', () => {
    expect(macChromes('/Users/sam')).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Users/sam/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/sam/Applications/Chromium.app/Contents/MacOS/Chromium',
    ])
    expect(playwrightCache('/Users/sam', 'darwin')).toBe('/Users/sam/Library/Caches/ms-playwright')
    expect(playwrightCache('/home/sam', 'linux')).toBe('/home/sam/.cache/ms-playwright')
  })
})
