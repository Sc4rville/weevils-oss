// Qui écrit dans une session, à part l'utilisateur : weevboss (l'orchestrateur) et les agents externes déclarés
// dans le fichier de config (~/.config/weevils/env), une ligne par auteur :
//   WEEVILS_AUTHOR_<ID>=nom affiché | couleur | e-mails autorisés (virgules) | secret partagé (optionnel)
// Un message signé commence par « [from:<id>] » ; l'ancien préfixe « [weevils] » reste lu comme weevboss.
import type { Author } from '../shared/api.ts'

export interface AuthorConfig extends Author {
  /** Adresses e-mail autorisées à écrire au nom de cet auteur (minuscules). */
  emails: string[]
  /** Secret partagé : prouve l'auteur quand SPF/DKIM ne suffisent pas (ou quand deux auteurs partagent une adresse). */
  secret?: string
}

export const BOSS = 'weevboss'
const ID_RE = /^[a-z0-9_-]{1,32}$/

/** Lit les auteurs du fichier de config (déjà chargé dans process.env par config.ts). weevboss est toujours là, en premier. */
export function loadAuthors(env: Record<string, string | undefined> = process.env): AuthorConfig[] {
  const out: AuthorConfig[] = [{ id: BOSS, name: BOSS, color: '', emails: [] }]
  for (const [key, value] of Object.entries(env)) {
    const m = /^WEEVILS_AUTHOR_([A-Z0-9_]+)$/.exec(key)
    if (!m || !value?.trim()) continue
    const id = m[1].toLowerCase()
    if (!ID_RE.test(id)) continue
    const [name, color, emails, secret] = value.split('|').map((x) => x.trim())
    const a: AuthorConfig = {
      id,
      name: name || id,
      color: /^#[0-9a-f]{3,8}$|^(oklch|rgb|hsl)\(.+\)$/i.test(color ?? '') ? color : '',
      emails: (emails ?? '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')),
      secret: secret || undefined,
    }
    const i = out.findIndex((x) => x.id === id)
    if (i >= 0) out[i] = { ...a, emails: a.emails, color: a.color || out[i].color }
    else out.push(a)
  }
  return out
}

let cache: AuthorConfig[] | undefined
/** Relit les auteurs (un auteur vient d’être ajouté depuis l’app). */
export const resetAuthors = () => void (cache = undefined)
export const authors = () => (cache ??= loadAuthors())
export const authorById = (id: string | undefined) => (id ? authors().find((a) => a.id === id) : undefined)
/** Ce que l'app reçoit : ni adresses ni secrets. */
export const publicAuthors = (): Author[] => authors().map(({ id, name, color }) => ({ id, name, color }))

/** « from » d'une requête ou d'un appel interne → id d'auteur connu (« weevils » = weevboss), sinon undefined. */
export function normalizeFrom(from: unknown): string | undefined {
  if (typeof from !== 'string' || !from) return undefined
  const id = from === 'weevils' ? BOSS : from.toLowerCase()
  return ['codex', 'claude', 'agent'].includes(id) || authorById(id) ? id : undefined
}

/** The verified outer author wins; a foreign inner signature remains quoted content. */
export function signAs(author: string, text: string, sourceThreadId?: string): string {
  const signed = parseSigned(text)
  if (signed?.author === author && signed.sourceThreadId === sourceThreadId) return text
  const source = sourceThreadId && /^[a-zA-Z0-9_-]{1,100}$/.test(sourceThreadId) ? `;thread:${sourceThreadId}` : ''
  return `[from:${author}${source}] ${signed?.author === author ? signed.text : text}`
}

// Le préfixe est retiré par motif, jamais par une longueur : seul ce qu'il a lui-même reconnu part (« [from:x] » ou
// « [weevils] » et les espaces qui suivent), quel que soit l'auteur et quoi que dise ensuite le message.
const SIGNED_RE = /^(?:\[from:([a-z0-9_-]{1,32})(?:;thread:([a-z0-9_-]{1,100}))?\]|\[weevils\])[ \t]*/i

/** Un message signé : son auteur et le texte sans le préfixe. null : message de l'utilisateur. */
export function parseSigned(text: string): { author: string; text: string; sourceThreadId?: string } | null {
  const m = SIGNED_RE.exec(text)
  if (!m) return null
  return { author: m[1] ? m[1].toLowerCase() : BOSS, text: text.replace(SIGNED_RE, '').trim(), ...(m[2] ? {sourceThreadId:m[2]} : {}) }
}

/** Nom affiché d'un auteur (son id s'il n'est plus déclaré). */
export const authorName = (id: string | undefined) => authorById(id ?? BOSS)?.name ?? id ?? BOSS

/** Local runtime provenance, not an inference from message wording or the recipient. */
export function threadAuthor(id:string, lookup:(id:string)=>{tool:string;cwd:string}|undefined, bossId:string|null, orchestratorDir:string):string|undefined {
  const source=lookup(id)
  if(!source)return undefined
  if(id===bossId||source.cwd===orchestratorDir)return BOSS
  return source.tool==='codex'||source.tool==='claude'?source.tool:'agent'
}
