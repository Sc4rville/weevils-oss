// Pilotage des sessions tmux « wv-* » : tmux est le registre (options @wv_*), weevils ne fait que lire et écrire.
// Une session wv-* = un agent (claude ou codex) dans un dossier. Lancées par weevils ou par le lanceur `wv`.

import { execFile } from 'node:child_process'
import type { Tool } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/mux.ts'

// weevilsd lancé à la main depuis une pane tmux hérite de $TMUX, qui l'emporte sur TMUX_TMPDIR : il lirait (et son
// nettoyage fermerait) les sessions wv-* du serveur tmux de cette pane, même avec un autre HOME. Le serveur tmux de
// weevils est celui de TMUX_TMPDIR (ou le défaut), jamais celui du terminal d'où il part. Sous systemd : sans effet.
delete process.env.TMUX

function tmux(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { cwd, timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message))
      else resolve(stdout.toString())
    })
  })
}

export interface WvSession {
  /** Nom tmux, sert aussi d'identifiant provisoire. */
  name: string
  tool: Tool
  /** Identifiant de la session Claude/Codex, connu d'avance pour Claude, relié après coup pour Codex. */
  sessionId?: string
  title: string
  cwd: string
  createdAt: number
  /** Pid du processus de la pane (l'agent lui-même : lancé sans shell). */
  pid?: number
}

const SEP = '\u001f'
/** Le séparateur tel que tmux le rend : brut, ou échappé en octal par tmux 3.4. */
const SEP_OUT = /\u001f|\\037/

export async function listWv(): Promise<WvSession[]> {
  let out = ''
  try {
    out = await tmux(['list-sessions', '-F', ['#{session_name}', '#{@wv_tool}', '#{@wv_session_id}', '#{@wv_title}', '#{@wv_cwd}', '#{pane_current_path}', '#{session_created}', '#{pane_pid}'].join(SEP)])
  } catch {
    return [] // pas de serveur tmux = aucune session
  }
  return out
    .split('\n')
    .filter((l) => l.startsWith('wv-'))
    .map((l) => {
      // tmux 3.4 (Ubuntu 24.04) écrit les caractères de contrôle d'un format en octal : « \037 » au lieu du séparateur.
      const [name, tool, sessionId, title, cwd, current, created, pid] = l.split(SEP_OUT)
      const s: WvSession = {
        name,
        tool: tool === 'codex' ? 'codex' : 'claude',
        sessionId: sessionId || undefined,
        title: title || tr(M).newSession,
        cwd: cwd || current,
        createdAt: Number(created) * 1000,
      }
      if (Number(pid) > 0) s.pid = Number(pid)
      return s
    })
}

/** Rien ne doit interrompre une session pilotée : pas de mise à jour auto, pas de télémétrie ni de conseils, pas de dialogue connu. */
export const QUIET_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_COST_WARNINGS: '1',
  DISABLE_TIPS: '1',
}

/**
 * tmux donne TMUX et TMUX_PANE à chaque pane, et TMUX l'emporte sur TMUX_TMPDIR et -S : un agent qui lance dans sa pane
 * « TMUX_TMPDIR=/tmp/x tmux kill-server » pour un serveur de test tuerait le serveur de weevils et toutes les sessions
 * (arrivé le 10/11 à 03:48). L'agent part donc sans ces deux variables : son tmux vise son propre serveur.
 */
export const NO_TMUX = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE']

export async function spawnWv(name: string, cwd: string, tool: Tool, title: string, command: string[], sessionId?: string) {
  // Plusieurs arguments : tmux lance la commande directement, sans shell (pas d'injection possible) ; env non plus.
  const env = Object.entries(QUIET_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd, ...env, ...NO_TMUX, ...command], cwd)
  await setOpt(name, '@wv_tool', tool)
  await setOpt(name, '@wv_title', title)
  await setOpt(name, '@wv_cwd', cwd)
  if (sessionId) await setOpt(name, '@wv_session_id', sessionId)
}

export const setOpt = (name: string, key: string, value: string) => tmux(['set-option', '-t', `=${name}:`, key, value]).then(() => undefined)

/** Ferme proprement une session tmux wv-* (l'agent reçoit SIGHUP et s'arrête ; son transcript reste, --resume le reprend). */
export const killWv = (name: string) => tmux(['kill-session', '-t', `=${name}:`]).then(() => undefined)

/** Écrit un message puis Entrée. Les retours à la ligne enverraient trop tôt : on les aplatit. */
export async function sendText(name: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim()
  await tmux(['send-keys', '-t', `=${name}:`, '-l', flat])
  await new Promise((r) => setTimeout(r, 150))
  await tmux(['send-keys', '-t', `=${name}:`, 'Enter'])
}

const KEYS: Record<string, string> = {
  enter: 'Enter',
  esc: 'Escape',
  tab: 'Tab',
  'shift-tab': 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
}

/** Touches autorisées : flèches, Entrée, Échap, Tab, chiffres 1–9, y/n. Rien d'autre. */
export async function sendKey(name: string, key: string): Promise<void> {
  if (KEYS[key]) return void (await tmux(['send-keys', '-t', `=${name}:`, KEYS[key]]))
  if (/^[1-9yn]$/.test(key)) return void (await tmux(['send-keys', '-t', `=${name}:`, '-l', key]))
  throw new Error(tr(M).keyRefused(key))
}

export async function capture(name: string): Promise<string> {
  const out = await tmux(['capture-pane', '-p', '-J', '-t', `=${name}:`])
  return out.replace(/\s+$/g, '')
}

/**
 * Repère une vraie question à l'écran (permission, confiance, menu de choix) et renvoie la phrase à montrer.
 * Exigeant exprès : il faut le pied de dialogue (« Enter to confirm · Esc to cancel », « (y/n) »…) dans les
 * dernières lignes. Un mot comme « approve » ou « do you want » dans le fil normal ne suffit plus : ça créait
 * des faux « à toi » dès qu'un fichier ou une réponse contenait ces mots.
 */
export function attentionFromScreen(text: string): string | undefined {
  const lines = text
    .split('\n')
    .slice(-30)
    .map((l) => l.replace(/[│╭╮╰╯─┃━]/g, '').replace(/^[●○•⎿]\s*/, '').trim())
  const footer = /(enter to (confirm|continue|select|submit)|enter continue|esc (to cancel|to go back|back|cancel)|\(y\/n\)|\by\/n\b|tab to toggle|↑\/↓ to (navigate|select))/i
  const option = /^[❯›>]\s*(\d+[.)]\s*)?\S|^\d+[.)]\s+\S|^[❯›>]?\s*(yes|no)\b/i
  const tail = lines.length - 1
  const at = lines.findLastIndex((l) => footer.test(l))
  if (at < 0 || tail - at > 12) return undefined
  // Un dialogue a des options : au moins une ligne d'option entre la question et le pied.
  const from = Math.max(0, at - 16)
  if (!lines.slice(from, at).some((l) => option.test(l))) return undefined
  const skip = (l: string) => !l || option.test(l) || footer.test(l) || /\+\d+ lines|ctrl\+[a-z]|\(esc\)|^[·…\-=_ ]+$/i.test(l)
  // La question elle-même : la ligne la plus proche au-dessus du pied qui contient « ? », coupée après.
  for (let i = at; i >= from; i--) {
    const q = lines[i].indexOf('?')
    if (q > 3 && !option.test(lines[i])) return lines[i].slice(0, q + 1).slice(0, 180)
  }
  const line = lines.slice(from, at).find((l) => !skip(l) && l.length > 12)
  return (line ?? tr(M).choiceWaiting).slice(0, 180)
}

/**
 * Dialogue ou menu qui bloque l'écran, même sans pied de dialogue classique : un menu avec un curseur ❯ sur une
 * option et une touche indiquée (esc, enter, ↑/↓, y/n) dans les dernières lignes, ou une question « [y/n] » en fin de ligne.
 * Sert à repérer qu'une session est coincée (autocompact proposé, mise à jour, choix…), pas seulement les permissions.
 */
export function dialogOnScreen(text: string): string | undefined {
  const strict = attentionFromScreen(text)
  if (strict) return strict
  const lines = text
    .split('\n')
    .slice(-18)
    .map((l) => l.replace(/[│╭╮╰╯─┃━]/g, '').trim())
  const yn = lines.slice(-6).find((l) => /[\[(]\s*y(es)?\s*\/\s*n(o)?\s*[\])]\s*:?\s*$/i.test(l))
  if (yn) return yn.slice(0, 180)
  const cursor = lines.findLastIndex((l) => /^[❯›]\s*\S/.test(l))
  if (cursor < 0) return undefined
  const keys = /\besc\b|escape|\benter\b|↑|↓|\btab\b|to (select|confirm|cancel|continue|dismiss|skip)/i
  // Un menu numéroté (❯ 1. … / 2. …) est un dialogue même sans touches indiquées (« Switch model? » de Claude Code).
  const numbered = /^[❯›]\s*\d+[.)]\s+\S/.test(lines[cursor]) && lines.some((l, i) => i !== cursor && /^\d+[.)]\s+\S/.test(l))
  if (!numbered && !lines.slice(Math.max(0, cursor - 8)).some((l) => keys.test(l))) return undefined
  // Le champ de saisie de Claude Code commence aussi par ❯ : il faut au moins une autre option ou une question au-dessus.
  const others = lines.filter((l, i) => i !== cursor && /^(\d+[.)]\s+\S|[○•]\s+\S|\s*(yes|no)\b)/i.test(l)).length
  const question = lines.slice(Math.max(0, cursor - 8), cursor).find((l) => /\?\s*$|\b(update|compact|would you|do you|choose|select|enable|continue)\b/i.test(l))
  if (!others && !question) return undefined
  return (question ?? lines[cursor]).slice(0, 180)
}

/** Ce qui est écrit à l'écran, aplati, pour y retrouver un message qu'on vient d'envoyer. */
export const flatScreen = (text: string) => text.replace(/[│╭╮╰╯─┃━>❯›]/g, ' ').replace(/\s+/g, ' ').toLowerCase()
