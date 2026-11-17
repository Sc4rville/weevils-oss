// Living-link pages (docs/LINKS.md). A session or an automation publishes a small page with `weevils page`; weevilsd
// keeps a registry (<data>/pages/index.json) and serves each page at /p/<kind>/<slug>, behind the weevils login:
//
//   /p/<kind>/<slug>            the address everyone shares. Signed in (cookie, or this machine): 302 to the keyed
//                               address below. Not signed in: the app itself, which asks for the code, then opens it.
//   /api/page/<key>/<slug>/…    the page's files. The key (HMAC of the access code and the slug) stands for the cookie,
//                               which a sandboxed document does not carry; it opens this one page and nothing else.
//                               Served with CSP sandbox (no allow-same-origin): the page's script never gets weevils'
//                               origin, so it cannot drive the API.
//
// A page is a folder (or one HTML file) that stays where it was made: the address follows its updates. Two builders
// make real pages from data: `list` (an actionable list from a JSON of leads/items) and `library` (media folders,
// organised by project and series, rebuilt when opened if older than ten minutes).
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { isPageKind, PAGE_KINDS, pagePath, slugOf, type PageInfo, type PageKind } from '../shared/pages.ts'
import { lang, tr } from './i18n.ts'
import M from './i18n/pages.ts'

export interface PageMeta extends PageInfo {
  /** The folder served (absolute). */
  root: string
  /** The file opened at the page's address, relative to root. */
  entry: string
  /** Built pages: what they are made from, so they rebuild themselves. */
  build?: { type: 'list'; source: string; mtime: number } | { type: 'library'; roots: string[]; at: number } | { type: 'machine' }
  from?: string
  createdAt: number
}

export class PageRefused extends Error {}

export const KEY_RE = /^\/api\/page\/([\w-]{22})\/([a-z0-9-]{1,80})(\/.*)?$/

const MEDIA_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
}
const MIME: Record<string, string> = {
  ...MEDIA_EXT,
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
}
const LIBRARY_STALE_MS = 10 * 60_000

/** The machine page's live side (server/index.ts): its state, and the before/after shots it may show. */
export interface MachineLive {
  state(): Promise<unknown>
  /** A shot's file by its id (the media shelf), or null. */
  shot(id: string): string | null
}

export const MACHINE_SLUG = 'weevils-machine'

export class Pages {
  /** Set by the server: without it the machine page says it is not wired. */
  live?: MachineLive
  readonly dir: string
  private index: string
  private secret: string
  private roots: string[]

  /** `roots`: where a published folder may live (the projects, weevils' data). */
  constructor(opts: { dataDir: string; secret: string; roots: string[] }) {
    this.dir = path.join(opts.dataDir, 'pages')
    this.index = path.join(this.dir, 'index.json')
    this.secret = opts.secret
    this.roots = [...opts.roots, opts.dataDir].filter(Boolean).map((r) => path.resolve(r))
  }

  private read(): PageMeta[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.index, 'utf8'))
      return Array.isArray(list) ? list.filter((p) => p && isPageKind(p.kind) && typeof p.slug === 'string') : []
    } catch {
      return []
    }
  }

  private write(list: PageMeta[]) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.index}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1))
    fs.renameSync(tmp, this.index)
  }

  /** Pages whose folder still exists, newest first. */
  list(): PageInfo[] {
    return this.read()
      .filter((p) => fs.existsSync(path.join(p.root, p.entry)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ slug, kind, title, path, updatedAt }) => ({ slug, kind, title, path, updatedAt }))
  }

  get(slug: string): PageMeta | undefined {
    return this.read().find((p) => p.slug === slug)
  }

  key(slug: string): string {
    return crypto.createHmac('sha256', this.secret).update(`weevils-page:${slug}`).digest('base64url').slice(0, 22)
  }

  keyOk(key: string, slug: string): boolean {
    const a = Buffer.from(key)
    const b = Buffer.from(this.key(slug))
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  private inside(abs: string): boolean {
    let real: string
    try {
      real = fs.realpathSync(abs)
    } catch {
      return false
    }
    return this.roots.some((r) => {
      let rr = r
      try {
        rr = fs.realpathSync(r)
      } catch {}
      return real === rr || real.startsWith(rr + path.sep)
    })
  }

  private check(title: unknown, kind: unknown): { title: string; kind: PageKind } {
    const t = tr(M)
    const tt = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
    if (!tt) throw new PageRefused(t.noTitle)
    if (!isPageKind(kind)) throw new PageRefused(t.badKind(PAGE_KINDS.join(', ')))
    return { title: tt, kind }
  }

  /** Same kind and title: same page (its address stays). Otherwise a free slug. */
  private save(meta: Omit<PageMeta, 'slug' | 'path' | 'createdAt' | 'updatedAt'>, wanted?: string): PageMeta {
    const list = this.read()
    const base = slugOf(wanted || meta.title)
    const same = list.find((p) => p.slug === base || (p.kind === meta.kind && p.title === meta.title))
    let slug = same?.slug ?? base
    for (let i = 2; !same && list.some((p) => p.slug === slug); i++) slug = `${base}-${i}`
    const now = Date.now()
    const page: PageMeta = { ...meta, slug, path: pagePath(meta.kind, slug), createdAt: same?.createdAt ?? now, updatedAt: now }
    this.write([...list.filter((p) => p.slug !== slug), page])
    return page
  }

  /** A folder (its index.html opens) or one file, served where it is. */
  publish(o: { path: string; title: unknown; kind: unknown; from?: string; slug?: string }): PageMeta {
    const t = tr(M)
    const { title, kind } = this.check(o.title, o.kind)
    const abs = path.resolve(o.path)
    if (!fs.existsSync(abs)) throw new PageRefused(t.missing)
    if (!this.inside(abs)) throw new PageRefused(t.outside)
    const dir = fs.statSync(abs).isDirectory()
    const root = dir ? abs : path.dirname(abs)
    const entry = dir ? 'index.html' : path.basename(abs)
    if (!fs.existsSync(path.join(root, entry))) throw new PageRefused(t.missing)
    return this.save({ kind, title, root, entry, from: o.from }, o.slug)
  }

  /** An actionable list from a JSON file of items or leads, rebuilt when that file changes. */
  publishList(o: { source: string; title: unknown; kind: unknown; from?: string; slug?: string }): PageMeta {
    const t = tr(M)
    const { title, kind } = this.check(o.title, o.kind)
    const source = path.resolve(o.source)
    if (!fs.existsSync(source)) throw new PageRefused(t.missing)
    if (!this.inside(source)) throw new PageRefused(t.outside)
    const items = listItems(source) // refuses an unreadable file now, not at the first visit
    const slug = this.slugFor(title, kind, o.slug)
    const root = path.join(this.dir, slug)
    writeListPage(root, title, kind, items)
    return this.save({ kind, title, root, entry: 'index.html', from: o.from, build: { type: 'list', source, mtime: fs.statSync(source).mtimeMs } }, slug)
  }

  /** The weevils machine: one per install, a live page of the stack, what runs and what lands (docs/LINKS.md). */
  publishMachine(from?: string): PageMeta {
    const title = tr(M).machineTitle
    const slug = this.read().find((p) => p.build?.type === 'machine')?.slug ?? MACHINE_SLUG
    const root = path.join(this.dir, slug)
    writeMachinePage(root, title)
    return this.save({ kind: 'report', title, root, entry: 'index.html', from, build: { type: 'machine' } }, slug)
  }

  /** The media of some folders, organised by project and series; rebuilt when opened if older than ten minutes. */
  publishLibrary(o: { roots: string[]; title: unknown; from?: string; slug?: string }): PageMeta {
    const t = tr(M)
    const { title } = this.check(o.title, 'library')
    const roots = (o.roots ?? []).map((r) => path.resolve(r)).filter((r) => fs.existsSync(r) && fs.statSync(r).isDirectory())
    if (!roots.length) throw new PageRefused(t.noRoots)
    if (roots.some((r) => !this.inside(r))) throw new PageRefused(t.outside)
    const slug = this.slugFor(title, 'library', o.slug)
    const root = path.join(this.dir, slug)
    writeLibraryPage(root, title, roots)
    return this.save({ kind: 'library', title, root, entry: 'index.html', from: o.from, build: { type: 'library', roots, at: Date.now() } }, slug)
  }

  private slugFor(title: string, kind: PageKind, wanted?: string): string {
    const list = this.read()
    const base = slugOf(wanted || title)
    const same = list.find((p) => p.slug === base || (p.kind === kind && p.title === title))
    if (same) return same.slug
    let slug = base
    for (let i = 2; list.some((p) => p.slug === slug); i++) slug = `${base}-${i}`
    return slug
  }

  /** Forgets a page; a page weevils built (list, library) loses its folder too. A published folder is never touched. */
  remove(slug: string): boolean {
    const list = this.read()
    const page = list.find((p) => p.slug === slug)
    if (!page) return false
    this.write(list.filter((p) => p !== page))
    if (page.build && path.dirname(page.root) === this.dir) fs.rmSync(page.root, { recursive: true, force: true })
    return true
  }

  /** A built page whose data moved on is rebuilt before it is served (the address never changes). */
  private fresh(page: PageMeta): void {
    const b = page.build
    if (!b) return
    if (b.type === 'machine') return void writeMachinePage(page.root, page.title)
    try {
      if (b.type === 'list') {
        const m = fs.statSync(b.source).mtimeMs
        if (m === b.mtime) return
        writeListPage(page.root, page.title, page.kind, listItems(b.source))
        b.mtime = m
      } else {
        if (Date.now() - b.at < LIBRARY_STALE_MS) return
        writeLibraryPage(page.root, page.title, b.roots)
        b.at = Date.now()
      }
      const list = this.read()
      const i = list.findIndex((p) => p.slug === page.slug)
      if (i >= 0) {
        list[i] = { ...page, updatedAt: Date.now() }
        this.write(list)
      }
    } catch {
      // The data is unreadable for now: the last good build stays.
    }
  }

  /** GET /api/page/<key>/<slug>/… : the page's files, Range included (a phone plays a video only that way). */
  serve(req: http.IncomingMessage, res: http.ServerResponse, key: string, slug: string, rest: string | undefined): void {
    const gone = () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(tr(M).gone)
    }
    const page = this.get(slug)
    if (!page || !this.keyOk(key, slug)) return gone()
    if (rest === undefined || rest === '/') {
      if (rest === undefined) {
        res.writeHead(302, { location: `/api/page/${key}/${slug}/` })
        return void res.end()
      }
      this.fresh(page)
    }
    if (page.build?.type === 'machine' && rest === '/state.json') return void this.machineState(res)
    const shot = page.build?.type === 'machine' ? /^\/shot\/([\w-]{1,40})$/.exec(rest) : null
    if (shot) {
      const f = this.live?.shot(shot[1])
      return f && fs.existsSync(f) ? sendFile(req, res, f) : gone()
    }
    let rel: string
    try {
      rel = decodeURIComponent(rest)
    } catch {
      return gone()
    }
    if (rel === '/') rel = `/${page.entry}`
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return gone()
    // A library serves only the files it lists, not everything below its folders.
    if (page.build?.type === 'library' && rel.startsWith('/m/') && !libraryFiles(page.root).has(rel.slice(1))) return gone()
    const root = page.root
    let file = path.resolve(root, `.${rel}`)
    if (file !== root && !file.startsWith(root + path.sep)) return gone()
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) return gone()
    sendFile(req, res, file)
  }

  /** The page's script asks from a sandboxed (opaque) origin: no cookie travels, the key in the address is the access. */
  private async machineState(res: http.ServerResponse) {
    const head = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
    try {
      const body = this.live ? await this.live.state() : { unwired: true }
      res.writeHead(200, head)
      res.end(JSON.stringify(body))
    } catch {
      res.writeHead(503, head)
      res.end('{}')
    }
  }
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  const size = fs.statSync(file).size
  const head: Record<string, string | number> = {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
    'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && size > 0 && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return void res.end()
    }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') return void res.end()
    return void fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...head, 'content-length': size })
  if (req.method === 'HEAD') return void res.end()
  fs.createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------- list pages

export interface ListItem {
  title: string
  source?: string
  url?: string
  why?: string
  date?: string
  fit?: number
  /** Text the user copies (a ready reply), then opens url. */
  copy?: string
  /** A link for the action other than url (apply, buy…). */
  actionUrl?: string
  actionLabel?: string
}

const str = (v: unknown, n = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
const https = (v: unknown) => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : undefined)
const DROPPED = new Set(['skip', 'skipped', 'closed', 'stale', 'ineligible', 'done', 'dismissed'])

/** Items or leads, whatever their exact shape (the Opportunity and Funding hunters' leads.json included). */
export function listItems(source: string): ListItem[] {
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(source, 'utf8'))
  } catch {
    throw new PageRefused(tr(M).badList)
  }
  const raw = Array.isArray(data) ? data : Array.isArray((data as any)?.items) ? (data as any).items : Array.isArray((data as any)?.leads) ? (data as any).leads : null
  if (!raw) throw new PageRefused(tr(M).badList)
  const out: ListItem[] = []
  for (const r of raw as any[]) {
    if (!r || typeof r !== 'object' || DROPPED.has(String(r.status ?? '').toLowerCase())) continue
    const title = str(r.title, 200) ?? str(r.name, 200)
    if (!title) continue
    const deadline = str(r.deadlineDate, 20) ?? (str(r.deadline, 40) && r.deadline !== 'unknown' ? str(r.deadline, 40) : undefined)
    out.push({
      title,
      source: str(r.source, 80) ?? ([str(r.platform, 30), str(r.author, 60) ?? str(r.organisation, 80)].filter(Boolean).join(' · ') || undefined),
      url: https(r.url) ?? https(r.officialUrl) ?? https(r.link),
      why: str(r.why, 300) ?? str(r.summary, 300) ?? str(r.fitWhy, 300) ?? str(r.benefit, 300),
      date: deadline ? `→ ${deadline}` : str(r.date, 30) ?? str(r.postedAt, 30) ?? str(r.firstSeen, 30),
      fit: typeof r.fit === 'number' ? r.fit : undefined,
      copy: str(r.copy, 2000) ?? str(r.reply, 2000),
      actionUrl: https(r.action?.url),
      actionLabel: str(r.action?.label, 40),
    })
  }
  return out.sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0) || String(b.date ?? '').localeCompare(String(a.date ?? '')))
}

/** JSON inside a <script> element: nothing in it can close the element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Hue pairs of each kind, the same as the app's living links (src/ui/living-link.css). */
const HUES: Record<PageKind, [number, number]> = { opportunities: [150, 115], library: [300, 335], preview: [215, 250], report: [70, 40], render: [15, 350] }

function shell(title: string, kind: PageKind, body: string, script: string, data: unknown): string {
  const [h1, h2] = HUES[kind]
  return `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>
:root{--h1:${h1};--h2:${h2};--bg:#fff;--ink:#000;--mute:#0009;--a1:oklch(.5 .17 var(--h1));--a2:oklch(.5 .17 var(--h2));color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#000;--ink:#fff;--mute:#fff9;--a1:oklch(.82 .15 var(--h1));--a2:oklch(.82 .15 var(--h2))}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,BlinkMacSystemFont,system-ui,'Segoe UI',Roboto,sans-serif;padding:18px 18px calc(28px + env(safe-area-inset-bottom))}
h1{font-size:22px;line-height:1.15;margin:4px 0 2px;font-weight:800;letter-spacing:-.01em}
.meta{color:var(--mute);font-size:12px}
a{color:inherit}
.live{font-weight:800;text-decoration:none;background:linear-gradient(100deg,var(--a1),var(--a2),var(--a1));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:drift 6s ease-in-out infinite alternate}
@keyframes drift{to{background-position:100% 0}}
@media (prefers-reduced-motion:reduce){.live{animation:none}}
button{font:inherit;background:none;border:0;padding:0;color:inherit;cursor:pointer}
${body}</style></head><body><h1>${esc(title)}</h1><div class="meta" id="when"></div><main id="m"></main>
<script id="data" type="application/json">${scriptJson(data)}</script><script>
const D=JSON.parse(document.getElementById('data').textContent);const T=D.t;
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const ago=(ms)=>{const s=(Date.now()-ms)/1000;return s<3600?Math.max(1,Math.round(s/60))+' min':s<86400?Math.round(s/3600)+' h':Math.round(s/86400)+' d'};
document.getElementById('when').textContent=T.updated+' '+ago(D.at)+(D.count!=null?' · '+D.count:'');
${script}</script></body></html>`
}

function writeAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function writeListPage(root: string, title: string, kind: PageKind, items: ListItem[]) {
  const t = tr(M)
  const css = `.it{padding:14px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}
.it .src{color:var(--mute);font-size:12px}.it .tt{display:block;font-weight:700;font-size:16px;margin:2px 0;text-decoration:none}
.it .why{margin:2px 0 6px}.it .act{font-size:14px}.it pre{white-space:pre-wrap;font:inherit;font-size:13px;color:var(--mute);margin:6px 0 0}`
  // i18n-ignore: the page's script, its words come from T (the catalog above)
  const js = `const m=document.getElementById('m');if(!D.items.length)m.append(el('p','meta',T.empty));
for(const it of D.items){const d=el('div','it');d.append(el('div','src',[it.source,it.date].filter(Boolean).join(' · ')));
const a=el(it.url?'a':'span','tt',it.title);if(it.url){a.href=it.url;a.target='_blank';a.rel='noopener noreferrer'}d.append(a);
if(it.why)d.append(el('div','why',it.why));
if(it.copy){const b=el('button','act live',T.copyReply);const pre=el('pre',null,it.copy);
b.onclick=()=>{const done=()=>{b.textContent=T.copied;b.onclick=null;if(it.url){const o=el('a','act live',T.copied);o.href=it.url;o.target='_blank';o.rel='noopener noreferrer';b.replaceWith(o)}};
const fb=()=>{const ta=el('textarea');ta.value=it.copy;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();done()};
navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(it.copy).then(done,fb):fb()};d.append(b,pre)}
else if(it.actionUrl||it.url){const o=el('a','act live',it.actionLabel||T.open);o.href=it.actionUrl||it.url;o.target='_blank';o.rel='noopener noreferrer';d.append(o)}
m.append(d)}`
  const data = { at: Date.now(), count: items.length, items, t: { updated: t.updated, open: t.open, copyReply: t.copyReply, copied: t.copied, empty: t.empty } }
  writeAtomic(path.join(root, 'index.html'), shell(title, kind, css, js, data))
}

// ---------------------------------------------------------------- library pages

export interface LibraryItem {
  type: 'video' | 'clip' | 'still' | 'card'
  name: string
  /** Relative to the page: m/<root index>/<path in that root>. */
  src: string
  poster?: string
  series?: string
  mtime: number
  size: number
}

/** Folders whose files are finished work; when a root has some, only their media count. */
const FINISHED = new Set(['out', 'final', 'finals', 'export', 'exports', 'shipped', 'published', 'release', 'releases', 'previews', 'og', 'cards'])
/** Never walked: tools, caches and work in progress. */
const SKIP = new Set(['node_modules', 'site-packages', 'venv', '.venv', '__pycache__', 'dist', 'build', 'renders', 'frames', 'tmp', 'cache'])
/** Containers that say nothing about the project ("productions/recursivite" is "recursivite"). */
const GENERIC = new Set(['productions', 'projects', 'content', 'media', 'src', 'assets', 'work'])
const MAX_FILES = 600

/** Media under the roots, grouped by project (the folders above the finished one) and series (the folder inside it). */
export function scanLibrary(roots: string[]): { group: string; items: LibraryItem[] }[] {
  const groups = new Map<string, LibraryItem[]>()
  roots.forEach((root, ri) => {
    const found: { rel: string; st: fs.Stats }[] = []
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > 7 || found.length > MAX_FILES * 4) return
      let ents: fs.Dirent[]
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name.startsWith('_')) continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!SKIP.has(e.name.toLowerCase())) walk(path.join(dir, e.name), r, depth + 1)
        } else if (e.isFile() && MEDIA_EXT[path.extname(e.name).toLowerCase()] && !/\.poster\.\w+$/i.test(e.name)) {
          try {
            found.push({ rel: r, st: fs.statSync(path.join(dir, e.name)) })
          } catch {}
        }
      }
    }
    walk(root, '', 0)
    const finishedIdx = (rel: string) => rel.split('/').slice(0, -1).findIndex((s) => FINISHED.has(s.toLowerCase()))
    const anyFinished = found.some((f) => finishedIdx(f.rel) >= 0)
    const rootName = path.basename(root)
    for (const f of found) {
      const segs = f.rel.split('/')
      const fi = finishedIdx(f.rel)
      if (anyFinished && fi < 0) continue
      const above = (fi >= 0 ? segs.slice(0, fi) : segs.slice(0, -1)).filter((s) => !GENERIC.has(s.toLowerCase()))
      const group = above.join(' · ') || (fi >= 0 ? segs[fi] : rootName)
      const inside = fi >= 0 ? segs.slice(fi + 1, -1) : []
      const name = segs.at(-1)!
      const ext = path.extname(name).toLowerCase()
      const video = MEDIA_EXT[ext].startsWith('video/')
      const audio = MEDIA_EXT[ext].startsWith('audio/')
      if (audio) continue
      const lower = f.rel.toLowerCase()
      const type: LibraryItem['type'] = video
        ? /clip|loop|teaser|short|snippet/.test(lower) || f.st.size < 2_500_000 ? 'clip' : 'video'
        : /(^|[/._-])(og|card|cards|share|cover|thumb)([/._-]|$)/.test(lower) ? 'card' : 'still'
      const posterRel = video ? f.rel.replace(/\.\w+$/, '.poster.jpg') : undefined
      const item: LibraryItem = {
        type,
        name: name.replace(/\.\w+$/, '').replace(/[-_]+/g, ' '),
        src: `m/${ri}/${f.rel}`,
        poster: posterRel && fs.existsSync(path.join(root, posterRel)) ? `m/${ri}/${posterRel}` : undefined,
        series: inside.length ? inside.join(' · ') : undefined,
        mtime: f.st.mtimeMs,
        size: f.st.size,
      }
      groups.set(group, [...(groups.get(group) ?? []), item])
    }
  })
  return [...groups.entries()]
    .map(([group, items]) => ({ group, items: items.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES) }))
    .sort((a, b) => b.items[0].mtime - a.items[0].mtime)
}

const libraryCache = new Map<string, { at: number; files: Set<string> }>()

function libraryFiles(root: string): Set<string> {
  const file = path.join(root, 'files.json')
  let at = 0
  try {
    at = fs.statSync(file).mtimeMs
  } catch {
    return new Set()
  }
  const hit = libraryCache.get(root)
  if (hit && hit.at === at) return hit.files
  let files = new Set<string>()
  try {
    files = new Set(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {}
  libraryCache.set(root, { at, files })
  return files
}

function writeLibraryPage(root: string, title: string, roots: string[]) {
  const t = tr(M)
  const groups = scanLibrary(roots)
  fs.mkdirSync(path.join(root, 'm'), { recursive: true })
  roots.forEach((r, i) => {
    const link = path.join(root, 'm', String(i))
    try {
      if (fs.readlinkSync(link) === r) return
      fs.rmSync(link, { force: true })
    } catch {}
    fs.symlinkSync(r, link)
  })
  const files = groups.flatMap((g) => g.items.flatMap((it) => [it.src, ...(it.poster ? [it.poster] : [])]))
  writeAtomic(path.join(root, 'files.json'), JSON.stringify(files))
  const css = `nav{margin:12px 0 4px;display:flex;gap:14px;flex-wrap:wrap;font-size:14px}nav button{color:var(--mute);font-weight:600}nav button.on{color:var(--ink);font-weight:800}
h2{font-size:15px;margin:22px 0 8px;font-weight:800}h2 small{color:var(--mute);font-weight:500;margin-left:6px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.t video,.t img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:color-mix(in srgb,var(--ink) 8%,transparent)}
.t .n{font-size:12px;margin:3px 0 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.t .s{color:var(--mute)}
.t.wide{grid-column:1/-1}.t.wide video{aspect-ratio:auto;max-height:70vh;object-fit:contain;background:#000}`
  const js = `const m=document.getElementById('m');const kinds=['video','clip','still','card'].filter(k=>D.groups.some(g=>g.items.some(i=>i.type===k)));
let on='all';const nav=el('nav');const draw=()=>{m.textContent='';m.append(nav);nav.textContent='';
for(const k of ['all',...kinds]){const b=el('button',k===on?'on':null,T[k]);b.onclick=()=>{on=k;draw()};nav.append(b)}
let any=false;for(const g of D.groups){const items=g.items.filter(i=>on==='all'||i.type===on);if(!items.length)continue;any=true;
const h=el('h2',null,g.group);h.append(el('small',null,String(items.length)));m.append(h);const grid=el('div','g');
for(const it of items){const c=el('div','t');let media;
if(it.type==='video'||it.type==='clip'){media=el('video');media.controls=true;media.playsInline=true;media.preload=it.poster?'none':'metadata';if(it.poster)media.poster=it.poster;media.src=it.src+(it.poster?'':'#t=0.5');
media.onplay=()=>{if(it.type==='video')c.classList.add('wide')};}
else{media=el('img');media.loading='lazy';media.src=it.src;media.alt=it.name;media.onclick=()=>window.open(it.src,'_blank')}
c.append(media);const n=el('div','n',it.name);if(it.series){n.append(' ');n.append(el('span','s','· '+it.series))}c.append(n);grid.append(c)}
m.append(grid)}if(!any)m.append(el('p','meta',T.empty))};draw();`
  const data = { at: Date.now(), count: groups.reduce((n, g) => n + g.items.length, 0), groups, t: { updated: t.updated, empty: t.empty, all: t.all, video: t.video, clip: t.clip, still: t.still, card: t.card } }
  writeAtomic(path.join(root, 'index.html'), shell(title, 'library', css, js, data))
}

// ---------------------------------------------------------------- the weevils machine

/** A commit subject as a plain sentence and the feature it belongs to: « feat(for-you): a card … — details » →
 *  { group: 'For you', text: 'A card …' }. The part after an em dash (the how) is dropped. */
export function commitSentence(subject: string): { group: string; text: string } {
  const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(subject.trim())
  const scope = (m?.[2] ?? '').split(/[,/]/)[0].replace(/[-_]+/g, ' ').trim()
  let text = (m ? m[3] : subject).split(/\s+—\s+|\s+--\s+|;\s+|\s+\(/)[0].trim()
  if (text.length > 140) text = `${text.slice(0, 139).replace(/\s+\S*$/, '')}…`
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
  const g = scope || m?.[1] || ''
  return { group: g.length <= 3 ? g.toUpperCase() : cap(g), text: cap(text) }
}

function writeMachinePage(root: string, title: string) {
  const t = tr(M)
  const css = `h2{font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:30px 0 8px}
#dia{margin:18px 0 4px}.row{display:flex;justify-content:space-around;gap:6px;text-align:center}
.nd{flex:1;min-width:0;padding:2px 0}.nd b{display:block;font-size:14px;line-height:1.2}.nd small{display:block;color:var(--mute);font-size:11px;min-height:14px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-bottom:4px;background:var(--c);transition:background .6s}
.up{--c:oklch(.7 .16 150)}.busy{--c:var(--a1)}.idle{--c:color-mix(in srgb,var(--ink) 28%,transparent)}.error{--c:oklch(.62 .2 25)}
.off{--c:transparent}.off .dot{box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ink) 28%,transparent)}
.busy .dot{animation:beat 1.6s ease-in-out infinite}@keyframes beat{50%{transform:scale(1.5);opacity:.6}}
.ln{width:2px;height:20px;margin:3px auto;background:color-mix(in srgb,var(--ink) 14%,transparent);border-radius:2px}
.ln.flow{background:linear-gradient(180deg,transparent,var(--a1),var(--a2),transparent);background-size:100% 300%;animation:flow 1.4s linear infinite}
@keyframes flow{from{background-position:0 100%}to{background-position:0 -200%}}
.oiled .dot{animation:oil 1.8s ease-out}@keyframes oil{0%{box-shadow:0 0 0 0 var(--a2)}100%{box-shadow:0 0 0 22px transparent}}
#pulse{display:flex;flex-wrap:wrap;gap:2px 12px;color:var(--mute);font-size:13px;font-variant-numeric:tabular-nums;margin-bottom:6px}#pulse span{white-space:nowrap}
.ln1{display:flex;gap:8px;align-items:baseline;padding:5px 0}.ln1 .dot{flex:none;margin:0;transform:translateY(-1px)}
.ln1 .tx{min-width:0;flex:1}.ln1 .tx b{font-weight:600}.ln1 .tx i{font-style:normal;color:var(--mute)}.ln1 time{color:var(--mute);font-size:12px;flex:none}
.grp{font-weight:800;font-size:15px;margin:16px 0 2px}.cm{padding:4px 0 4px 12px;border-left:2px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.cm time{color:var(--mute);font-size:12px;margin-left:6px;white-space:nowrap}
.cm.new{animation:land 2.4s ease-out;border-left-color:var(--a1)}
@keyframes land{0%{opacity:0;transform:translateY(-8px);background:color-mix(in srgb,var(--a2) 26%,transparent)}25%{opacity:1;transform:none}100%{background:transparent}}
.gl{padding:5px 0}.bar{height:3px;border-radius:3px;background:color-mix(in srgb,var(--ink) 10%,transparent);margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--a1),var(--a2));transition:width 1s}
#shots{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;margin:0 -18px;padding:0 18px}
#shots a{flex:none;width:78%;scroll-snap-align:start;text-decoration:none}#shots img{width:100%;border-radius:10px;display:block}
#shots small{display:block;color:var(--mute);font-size:12px;margin-top:4px}
@media (prefers-reduced-motion:reduce){.busy .dot,.ln.flow,.cm.new,.oiled .dot{animation:none}}`
  // i18n-ignore: the page's script, its words come from T (the catalog above)
  const js = `const m=document.getElementById('m');const when=document.getElementById('when');
const ROWS=[['app'],['weevilsd'],['boss','autos','pages'],['tmux','hooks','codex'],['sessions']];
const sec=(id,h)=>{if(h)m.append(el('h2',null,h));const d=el('div');d.id=id;m.append(d);return d};
const dia=sec('dia');const pulse=sec('pulse',T.now);const run=sec('run');const goals=sec('goals',T.goals);const shots=sec('shots',T.shots);const feed=sec('feed',T.better);
const fill=(s,n)=>s.replace('{n}',n);const seen=new Set();let first=true;
const nodes={};for(const [i,r] of ROWS.entries()){if(i){const l=el('div','ln');l.dataset.i=i;dia.append(l)}const row=el('div','row');for(const id of r){const n=el('div','nd idle');n.append(el('span','dot'),el('b',null,T.p[id]),el('small'));nodes[id]=n;row.append(n)}dia.append(row)}
function draw(S){if(S.unwired){when.textContent=T.unwired;return}
when.textContent=T.live+' · '+new Date(S.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const st={};for(const p of S.parts){st[p.id]=p.state;const n=nodes[p.id];if(!n)continue;n.className='nd '+p.state+(n.classList.contains('oiled')?' oiled':'');n.title=T.s[p.state];n.querySelector('small').textContent=p.note||T.s[p.state]}
for(const l of dia.querySelectorAll('.ln')){const i=+l.dataset.i;l.classList.toggle('flow',[...ROWS[i-1],...ROWS[i]].some(id=>st[id]==='busy'))}
pulse.replaceChildren(...S.pulse.map(x=>el('span',null,x.label+' '+x.value)));
run.replaceChildren();for(const r of S.running){const d=el('div','ln1 '+r.state);d.append(el('span','dot'));const tx=el('div','tx');tx.append(el('b',null,r.title));if(r.note)tx.append(el('i',null,' — '+r.note));d.append(tx);if(r.at)d.append(el('time',null,ago(r.at)));run.append(d)}
if(S.more)run.append(el('div','meta',fill(T.more,S.more)));if(!S.running.length)run.append(el('div','meta',T.quiet));
goals.previousSibling.hidden=goals.hidden=!S.goals.length;goals.replaceChildren(...S.goals.map(g=>{const d=el('div','gl');d.append(el('span',null,g.title+' '),el('span','meta',g.done+'/'+g.total));const b=el('div','bar');const f=el('i');f.style.width=(g.total?Math.round(100*g.done/g.total):0)+'%';b.append(f);d.append(b);return d}));
shots.previousSibling.hidden=shots.hidden=!S.shots.length;if(shots.dataset.k!==S.shots.map(s=>s.id).join()){shots.dataset.k=S.shots.map(s=>s.id).join();shots.replaceChildren(...S.shots.map(s=>{const a=el('a');a.href='shot/'+s.id;a.target='_blank';const im=el('img');im.src='shot/'+s.id;im.loading='lazy';im.alt=s.name;a.append(im,el('small',null,s.name+' · '+ago(s.at)));return a}))}
let fresh=0;feed.replaceChildren();const groups=new Map();for(const c of S.commits){if(!groups.has(c.group))groups.set(c.group,[]);groups.get(c.group).push(c)}
for(const [g,list] of groups){if(g)feed.append(el('div','grp',g));for(const c of list){const d=el('div','cm');d.append(document.createTextNode(c.text),el('time',null,ago(c.at)));if(!first&&!seen.has(c.sha)){d.classList.add('new');fresh++}seen.add(c.sha);if(Date.now()-c.at<60000&&first)d.classList.add('new');feed.append(d)}}
if(!S.commits.length)feed.append(el('div','meta',S.git?T.noCommits:T.noGit));
if(fresh){const n=nodes.weevilsd;n.classList.remove('oiled');void n.offsetWidth;n.classList.add('oiled');setTimeout(()=>n.classList.remove('oiled'),1900)}first=false}
let wait=4000;async function tick(){try{const r=await fetch('state.json',{cache:'no-store'});if(r.ok){draw(await r.json());wait=4000}else wait=Math.min(wait*2,30000)}catch(e){wait=Math.min(wait*2,30000)}setTimeout(tick,document.hidden?15000:wait)}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});tick()`
  const s = { up: t.mUp, busy: t.mBusy, idle: t.mIdle, error: t.mError, off: t.mOff }
  const p = { app: t.mApp, weevilsd: t.mDaemon, boss: t.mBoss, autos: t.mAutos, pages: t.mPages, tmux: t.mTmux, hooks: t.mHooks, codex: t.mCodex, sessions: t.mSessions }
  const data = { at: Date.now(), t: { updated: t.updated, live: t.mLive, unwired: t.mUnwired, now: t.mNow, goals: t.mGoals, shots: t.mShots, better: t.mBetter, more: t.mMore, quiet: t.mQuiet, noCommits: t.mNoCommits, noGit: t.mNoGit, s, p } }
  const html = shell(title, 'report', css, js, data)
  const file = path.join(root, 'index.html')
  // Rewritten when opened only if it changed (the words follow the install's language).
  const strip = (x: string) => x.replace(/"at":\d+/, '')
  try {
    if (strip(fs.readFileSync(file, 'utf8')) === strip(html)) return
  } catch {}
  writeAtomic(file, html)
}
