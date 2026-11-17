import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Message, Project, Session } from '../../shared/api.ts'
import { useT } from '../i18n'
import M from '../i18n/preview'
import { Icon } from './icons'
import { PreviewChat } from './preview-chat'

/** Où vivent les serveurs de preview (WEEVILS_EXPOSE_DOMAIN : <nom>.<domaine>) et l'app elle-même : lus dans la config du serveur. */
export interface PreviewConfig {
  exposeDomain: string
  publicHost: string
  /** Pages statiques des repos servies par weevilsd (/api/site/<clé>/<repo>/), quand il n'y a pas de domaine de preview. */
  siteKey?: string
}
const KEY = (id: string) => `weevils-preview:${id}`

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g
const trimPunct = (u: string) => u.replace(/[.,;:!?)]+$/, '')

/** Les URL d'une appli en cours de développement, la plus récente d'abord : exposées, puis locales avec port, puis les autres. */
export function urlsInMessages(messages: Message[], cfg: PreviewConfig): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const raw of messages[i].text.match(URL_RE) ?? []) {
      const u = trimPunct(raw)
      if (seen.has(u) || (cfg.publicHost && u.includes(cfg.publicHost)) || /github\.com|anthropic\.com|claude\.ai|npmjs\.com/.test(u)) continue
      seen.add(u)
      out.push(u)
    }
  }
  const rank = (u: string) => (cfg.exposeDomain && u.includes(`.${cfg.exposeDomain}`) ? 0 : /localhost|127\.0\.0\.1|:\d{4,5}/.test(u) ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b))
}

/** URL proposée : celle citée dans la conversation (sauf une adresse locale, que le téléphone ne joint pas, quand weevilsd
 * sert le repo lui-même), sinon https://<repo>.<domaine configuré>, sinon la page statique du repo servie par weevilsd. */
export function guessPreviewUrl(messages: Message[], session: Session, project: Project | undefined, cfg: PreviewConfig): string {
  const repo = session.repo ?? project?.repos[0]
  const site = repo && !cfg.exposeDomain && cfg.siteKey ? `${location.origin}/api/site/${cfg.siteKey}/${repo}/` : ''
  const found = urlsInMessages(messages, cfg).find((u) => !(site && /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/.test(u)))
  if (found) return found
  return repo && cfg.exposeDomain ? `https://${repo}.${cfg.exposeDomain}` : site
}

interface Saved {
  url?: string
  open?: boolean
  /** Sur téléphone, la page vue prend tout l'écran (le fil de la session se cache). */
  full?: boolean
}

function load(id: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY(id)) ?? '{}') as Saved
  } catch {
    return {}
  }
}

function save(id: string, v: Saved) {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(v))
  } catch {
    /* stockage indisponible */
  }
}

/** Choix mémorisés par session : volet ouvert ou non, URL réglée à la main. */
export function usePreviewState(id: string) {
  const [state, setState] = useState<Saved>(() => load(id))
  useEffect(() => setState(load(id)), [id])
  const update = (patch: Saved) =>
    setState((s) => {
      const next = { ...s, ...patch }
      save(id, next)
      return next
    })
  return [state, update] as const
}

/** An address only this machine can open (localhost, 127.0.0.1…): never offered as a chip to the phone. */
const LOCAL = /\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i
/** A chip shows the host name only, never a scheme, port or path. */
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return u.replace(/^https?:\/\//, '')
  }
}

const normalize = (raw: string) => {
  const t = raw.trim()
  if (!t) return ''
  return /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`
}

/** Le navigateur intégré : une barre d'adresse et la page, pour voir en live ce que l'agent construit. */
export function Preview({ url, suggestions, onUrl, onClose, full, onFull, session }: { session?: Session; project?: Project; url: string; suggestions: string[]; onUrl: (u: string) => void; onClose: () => void; full?: boolean; onFull?: (full: boolean) => void }) {
  const t = useT(M)
  const [draft, setDraft] = useState(url)
  const [gen, setGen] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => setDraft(url), [url])
  // Ouvert sans adresse : le champ attend la saisie (rien d'autre à faire dans ce volet).
  useEffect(() => {
    if (!url) input.current?.focus({ preventScroll: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const others = useMemo(() => {
    const seen = new Set([url && hostOf(url)])
    return suggestions.filter((s) => {
      if (s === url || LOCAL.test(s) || seen.has(hostOf(s))) return false
      seen.add(hostOf(s))
      return true
    }).slice(0, 3)
  }, [suggestions, url])

  const go = (e: FormEvent) => {
    e.preventDefault()
    const next = normalize(draft)
    if (!next) return
    if (next === url) setGen((g) => g + 1)
    else onUrl(next)
  }

  return (
    <div className={full ? 'preview full' : 'preview'}>
      <form className="preview-bar" onSubmit={go}>
        <button type="button" className="key" onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.placeholder}
          aria-label={t.address}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button type="submit" className="key" aria-label={t.reload}>
          <Icon name="reload" />
        </button>
        {onFull && (
          <button type="button" className="key preview-full" onClick={() => onFull(!full)} aria-label={full ? t.shrink : t.grow} aria-pressed={!!full}>
            <Icon name="chevron" dir={full ? 'down' : 'up'} />
          </button>
        )}
        {url && (
          <a className="key" href={url} target="_blank" rel="noreferrer" aria-label={t.openTab}>
            <Icon name="external" />
          </a>
        )}
      </form>
      {others.length > 0 && (
        <div className="preview-hints meta">
          {others.map((s) => (
            <button key={s} className="link" onClick={() => onUrl(s)}>
              {hostOf(s)}
            </button>
          ))}
        </div>
      )}
      {/* L'iframe est posée en absolu dans un cadre flex : iOS Safari ignore la hauteur flex d'une iframe et la réduit à presque rien. */}
      {!url && <div className="preview-hints meta">{t.noUrl}</div>}
      <div className="preview-body">
        {url && (
          <iframe
            ref={frame}
            key={`${url}#${gen}`}
            className="preview-frame"
            src={url}
            title={t.frame}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
      {session && <PreviewChat key={session.id} viewerId={`session:${session.id}`} sessionId={session.id} projectId={session.projectId} frame={frame} />}
    </div>
  )
}
