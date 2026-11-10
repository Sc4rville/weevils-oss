import type { SessionStatus } from '../../shared/api.ts'
import { tr } from '../i18n'
import M from '../i18n/format'
import S from '../i18n/setup'
import { isBrick, isSecretName, type Brick } from '../../shared/setup.ts'

/** Une puce : « [[setup:mail]] » (une brique) ou « [[setup:key:RUNPOD_API_KEY]] » (un secret demandé). */
const ANY_CHIP = /\[\[setup:(?:key:([A-Z][A-Z0-9_]{1,63})|([a-z]+))\]\]/g
/** Une puce dans la phrase : une brique, ou « key:NOM ». */
export type ChipId = Brick | `key:${string}`

/** Une puce de branchement écrite dans le texte de weevboss (« [[setup:mail]] »), par son libellé : « brancher le pont e-mail ». */
export const chipLabel = (c: ChipId): string => (c.startsWith('key:') ? tr(S).keyChip(c.slice(4)) : tr(S)[`chip_${c as Brick}`])
/** Le texte avec ses puces lues comme leur libellé (aperçus, copie) : la phrase reste lisible, jamais « via . ». */
export const chipLabels = (text: string): string => text.replace(ANY_CHIP, (m, k: string | undefined, b: string | undefined) => chipOf(k, b) ? chipLabel(chipOf(k, b)!) : m)
const chipOf = (k: string | undefined, b: string | undefined): ChipId | null => (k ? (isSecretName(k) ? `key:${k}` : null) : isBrick(b) ? b : null)

/** Durée compacte, façon croquis : 12m, 1h36, 14h01, 2j (2d en anglais). */
export function dur(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`
  return tr(M).days(Math.floor(h / 24))
}

/** Durée lisible pour les phrases : « 12 min », « 14 h 01 », « 2 jours ». */
export function durLong(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  const t = tr(M)
  if (m < 1) return t.lessThanMinute
  if (m < 60) return t.minutes(m)
  const h = Math.floor(m / 60)
  if (h < 24) return t.hours(h, String(m % 60).padStart(2, '0'))
  return t.daysLong(Math.floor(h / 24))
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 1) return tr(M).justNow
  return tr(M).ago(durLong(ms))
}

/** Caractère et libellé de chaque état ; le libellé suit la langue (lu à chaque accès). */
const statusKey = { working: 'working', needs_user: 'needsUser', idle: 'idle', done: 'done', interrupted: 'interrupted' } as const
const statusCh: Record<SessionStatus, string> = { working: '*', needs_user: '!', idle: '_', done: '✓', interrupted: '×' }
export const status = Object.fromEntries(
  (Object.keys(statusCh) as SessionStatus[]).map((s) => [
    s,
    {
      ch: statusCh[s],
      get label() {
        return tr(M)[statusKey[s]]
      },
    },
  ]),
) as Record<SessionStatus, { readonly ch: string; readonly label: string }>

/** Texte d'agent simplifié : on enlève la mise en forme markdown qui n'apporte rien sur le téléphone.
 *  `keep` garde les liens et les `commandes`, que le fil rend cliquables et copiables. */
export function plain(text: string, keep = false): string {
  const t = keep ? text : chipLabels(text).replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
  return t
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/^\s*[-*•]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Morceau d'une ligne de texte : prose, lien, ou commande entre accents graves. */
export type Inline = { kind: 'text'; s: string } | { kind: 'url'; href: string; label: string } | { kind: 'cmd'; s: string } | { kind: 'chip'; brick: ChipId }

/** Domaines nus reconnus sans https:// (« myaccount.google.com/… ») : seulement des extensions courantes, pour ne pas prendre « core.ts » pour un site. */
const TLD = 'com|org|net|io|dev|app|tech|fr|ai|co|me|gg|xyz|eu|uk|de|be|ch|ca|us|tv|ly|cloud|site|page'
const URL_RE = new RegExp(
  String.raw`\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|` + '`([^`\\n]+)`' + String.raw`|(https?:\/\/[^\s<>"'` + '`' + String.raw`]+)|(?<![@\w.\/-])((?:[a-z0-9-]+\.)+(?:${TLD})(?:\/[^\s<>"'` + '`' + String.raw`]*)?)(?![\w@-])`,
  'gi',
)

/** Ponctuation collée à la fin d'une URL nue : elle appartient à la phrase, pas au lien. */
function trimUrl(u: string): string {
  let out = u.replace(/[.,;:!?»”’"']+$/, '')
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1).replace(/[.,;:!?»”’"']+$/, '')
  return out
}

/** Repère les liens (nus ou markdown) et, si `code`, les commandes `…` ; le reste reste du texte. */
export function inline(text: string, code = true): Inline[] {
  // Les puces de branchement (« [[setup:mail]] ») d'abord, à leur place dans la phrase ; le reste comme avant.
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(ANY_CHIP)) {
    const c = chipOf(m[1], m[2])
    if (!c) continue
    const i = m.index ?? 0
    out.push(...inlineText(text.slice(last, i), code), { kind: 'chip', brick: c })
    last = i + m[0].length
  }
  if (!last) return inlineText(text, code)
  out.push(...inlineText(text.slice(last), code))
  return out
}

function inlineText(text: string, code: boolean): Inline[] {
  const out: Inline[] = []
  let last = 0
  const push = (s: string) => {
    if (!s) return
    const prev = out[out.length - 1]
    if (prev?.kind === 'text') prev.s += s
    else out.push({ kind: 'text', s })
  }
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0
    if (m[1] && m[2]) {
      push(text.slice(last, i))
      out.push({ kind: 'url', href: m[2], label: m[1] })
      last = i + m[0].length
    } else if (m[3] !== undefined) {
      push(text.slice(last, i))
      if (code) out.push({ kind: 'cmd', s: m[3] })
      else push(m[0])
      last = i + m[0].length
    } else if (m[4]) {
      const u = trimUrl(m[4])
      push(text.slice(last, i))
      out.push({ kind: 'url', href: u, label: u })
      last = i + u.length
    } else if (m[5]) {
      const u = trimUrl(m[5])
      push(text.slice(last, i))
      out.push({ kind: 'url', href: `https://${u}`, label: u })
      last = i + u.length
    }
  }
  push(text.slice(last))
  return out
}

/** Une commande vaut un bouton copier quand elle ressemble à une ligne à taper (plusieurs mots), pas à un simple nom. */
export const isCommand = (s: string) => /\S\s+\S/.test(s.trim()) && s.trim().length >= 6

/** Découpe un texte en prose et blocs de code (``` … ```), pour replier le code. */
export function segments(text: string): { kind: 'text' | 'code'; body: string }[] {
  const out: { kind: 'text' | 'code'; body: string }[] = []
  const re = /```[^\n]*\n([\s\S]*?)```/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ kind: 'text', body: text.slice(last, i) })
    out.push({ kind: 'code', body: m[1].replace(/\s+$/, '') })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', body: text.slice(last) })
  return out.filter((s) => s.body.trim())
}

/** Nom d'outil (Claude Code, Codex) → clé du verbe affiché. */
const VERBS: Record<string, keyof (typeof M)['fr']> = {
  read: 'read',
  edit: 'edit',
  multiedit: 'edit',
  write: 'write',
  notebookedit: 'edit',
  bash: 'run',
  grep: 'search',
  glob: 'search',
  agent: 'delegate',
  task: 'delegate',
  webfetch: 'fetch',
  websearch: 'webSearch',
  todowrite: 'plan',
  askuserquestion: 'ask',
  skill: 'skill',
  shell: 'run',
  exec_command: 'run',
  local_shell: 'run',
  apply_patch: 'edit',
  update_plan: 'plan',
  view_image: 'look',
}

/** « Bash · Show hostname » → « lance : Show hostname ». Chemins raccourcis, outils MCP nommés par leur fin. */
export function step(text: string): string {
  const i = text.indexOf(' · ')
  const rawName = i < 0 ? text : text.slice(0, i)
  const detail = i < 0 ? '' : text.slice(i + 3)
  const name = rawName.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/^mcp__.*?__/, '')
  const key = Object.hasOwn(VERBS, name.toLowerCase()) ? VERBS[name.toLowerCase()] : undefined
  const verb = key ? (tr(M)[key] as string) : name.replace(/_/g, ' ').toLowerCase()
  const d = detail.replace(/\/home\/[a-z0-9_-]+\//g, '~/')
  return d ? `${verb} · ${d}` : verb
}

/** Activité d'un sous-agent : « Outil · détail » d'un outil connu passe par step() (verbe traduit, chemins en ~/) ;
 *  une phrase reste telle quelle (step() la mettrait en minuscules). */
export function activityText(text: string): string {
  const i = text.indexOf(' · ')
  const name = i < 0 ? text : text.slice(0, i)
  return /^mcp__/.test(name) || Object.hasOwn(VERBS, name.toLowerCase()) ? step(text) : text
}

/** Ce que l'utilisateur a écrit, sans les balises techniques du collage ni les marqueurs d'images. */
export function userText(text: string): string {
  return text
    // Display only: the transcript and the prompt sent to the model keep their context.
    // A terminal excerpt can end inside the injected block, before its closing bracket.
    .replace(/\s*⟦weevils\b[^⟧]*(?:⟧|$)/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/\[Image #\d+\]/g, '(image)')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Photo annotations are transport metadata; use their paths only for authenticated previews. */
export function userPhotos(text: string): string[] {
  return [...userText(text).matchAll(/\(photo\s*:\s*(\/[^)\n]+)\)/g)].map((m) => m[1].trim())
}

export function userCaption(text: string): string {
  return userText(text).replace(/\(photo\s*:\s*\/[^)\n]+\)/g, '').trim()
}
