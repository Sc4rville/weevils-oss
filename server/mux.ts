// Pilotage des sessions tmux « wv-* » : tmux est le registre (options @wv_*), weevils ne fait que lire et écrire.
// Une session wv-* = un agent (claude ou codex) dans un dossier. Lancées par weevils ou par le lanceur `wv`.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Tool } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/mux.ts'

// weevilsd lancé à la main depuis une pane tmux hérite de $TMUX, qui l'emporte sur TMUX_TMPDIR : il lirait (et son
// nettoyage fermerait) les sessions wv-* du serveur tmux de cette pane, même avec un autre HOME. Le serveur tmux de
// weevils est celui de TMUX_TMPDIR (ou le défaut), jamais celui du terminal d'où il part. Sous systemd : sans effet.
delete process.env.TMUX

/**
 * Serveur tmux dédié (« tmux -L weevils ») : un « tmux kill-server » ou « tmux kill-session -a » lancé par un agent,
 * dans sa pane ou ailleurs, vise le serveur par défaut et ne touche plus aux sessions de weevils (le 10/11 à 03:48,
 * un kill-server a fermé six sessions au travail). WEEVILS_TMUX_SOCKET pour un autre nom (tests, deuxième instance).
 */
export const SOCKET = process.env.WEEVILS_TMUX_SOCKET?.trim() || 'weevils'
/** Où vit chaque session wv-* (lu par listWv) : le serveur dédié, ou l'ancien serveur par défaut (sessions d'avant). */
const legacy = new Set<string>()
const sockArgs = (name?: string) => (name && legacy.has(name) ? [] : ['-L', SOCKET])

function tmux(args: string[], cwd?: string, socket: string[] = ['-L', SOCKET]): Promise<string> {
  return new Promise((resolve, reject) => {
    // tmux silently falls back to /tmp when TMUX_TMPDIR does not exist. A throwaway HOME
    // must never discover or reap the real user's sessions, including on the legacy socket.
    if (!process.env.TMUX_TMPDIR && process.env.HOME && process.env.HOME !== os.userInfo().homedir) {
      process.env.TMUX_TMPDIR = path.join(process.env.HOME, '.local/share/weevils/tmux')
    }
    if (process.env.TMUX_TMPDIR) fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
    execFile('tmux', [...socket, ...args], { cwd, timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message))
      else resolve(stdout.toString())
    })
  })
}
/** Commande qui vise une session : sur le serveur où elle vit. */
const on = (name: string, args: string[]) => tmux(args, undefined, sockArgs(name))

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

const FORMAT = ['#{session_name}', '#{@wv_tool}', '#{@wv_session_id}', '#{@wv_title}', '#{@wv_cwd}', '#{pane_current_path}', '#{session_created}', '#{pane_pid}'].join(SEP)

function parse(out: string): WvSession[] {
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

/** Sessions wv-* du serveur dédié, puis celles lancées avant lui sur le serveur par défaut (elles y finissent leur vie). */
export async function listWv(): Promise<WvSession[]> {
  const read = (socket: string[]) => tmux(['list-sessions', '-F', FORMAT], undefined, socket).then(parse, () => [] as WvSession[]) // pas de serveur = aucune session
  const [own, old] = await Promise.all([read(['-L', SOCKET]), read([])])
  const seen = new Set(own.map((s) => s.name))
  legacy.clear()
  for (const s of old) if (!seen.has(s.name)) legacy.add(s.name)
  return [...own, ...old.filter((s) => legacy.has(s.name))]
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

/** Nom d'une session wv-* pour un dossier. tmux remplace « . » et « : » par « _ » dans un nom de session : sans ce
 * remplacement fait d'avance, un dossier comme « .ad9651b0c8 » (tâche auto sans repo) ou « mon.site » donnait une
 * session lancée sous un autre nom que celui retenu, introuvable ensuite (« no such session ») mais au travail. */
export const wvName = (dir: string, short: string) => `wv-${dir.slice(0, 18).replace(/[.:]/g, '_')}-${short}`

export async function spawnWv(name: string, cwd: string, tool: Tool, title: string, command: string[], sessionId?: string) {
  // Plusieurs arguments : tmux lance la commande directement, sans shell (pas d'injection possible) ; env non plus.
  const env = Object.entries(QUIET_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd, ...env, ...NO_TMUX, ...command], cwd)
  await setOpt(name, '@wv_tool', tool)
  await setOpt(name, '@wv_title', title)
  await setOpt(name, '@wv_cwd', cwd)
  if (sessionId) await setOpt(name, '@wv_session_id', sessionId)
}

export const setOpt = (name: string, key: string, value: string) => on(name, ['set-option', '-t', `=${name}:`, key, value]).then(() => undefined)

/** Ferme proprement une session tmux wv-* (l'agent reçoit SIGHUP et s'arrête ; son transcript reste, --resume le reprend). */
export const killWv = (name: string) => on(name, ['kill-session', '-t', `=${name}:`]).then(() => undefined)

/** Écrit un message puis Entrée. Les retours à la ligne enverraient trop tôt : on les aplatit. */
export async function sendText(name: string, text: string, submit: 'Enter' | 'Tab' = 'Enter'): Promise<void> {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim()
  await on(name, ['send-keys', '-t', `=${name}:`, '-l', flat])
  await new Promise((r) => setTimeout(r, 150))
  await on(name, ['send-keys', '-t', `=${name}:`, submit])
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
  if (KEYS[key]) return void (await on(name, ['send-keys', '-t', `=${name}:`, KEYS[key]]))
  if (/^[1-9yn]$/.test(key)) return void (await on(name, ['send-keys', '-t', `=${name}:`, '-l', key]))
  throw new Error(tr(M).keyRefused(key))
}

export async function capture(name: string): Promise<string> {
  const out = await on(name, ['capture-pane', '-p', '-J', '-t', `=${name}:`])
  return out.replace(/\s+$/g, '')
}

/**
 * Repère une vraie question à l'écran (permission, confiance, menu de choix) et renvoie la phrase à montrer.
 * Exigeant exprès : il faut le pied de dialogue (« Enter to confirm · Esc to cancel », « (y/n) »…) dans les
 * dernières lignes. Un mot comme « approve » ou « do you want » dans le fil normal ne suffit plus : ça créait
 * des faux « à toi » dès qu'un fichier ou une réponse contenait ces mots.
 */
export function attentionFromScreen(text: string): string | undefined {
  const dialog = screenDialog(text)
  return dialog?.kind === 'settings' ? undefined : dialog?.question
}

/**
 * Dialogue ou menu qui bloque l'écran, même sans pied de dialogue classique : un menu avec un curseur ❯ sur une
 * option et une touche indiquée (esc, enter, ↑/↓, y/n) dans les dernières lignes, ou une question « [y/n] » en fin de ligne.
 * Sert à repérer qu'une session est coincée (autocompact proposé, mise à jour, choix…), pas seulement les permissions.
 */
export function dialogOnScreen(text: string): string | undefined {
  return screenDialog(text)?.question
}

/** Ce qui est écrit à l'écran, aplati, pour y retrouver un message qu'on vient d'envoyer. */
export const flatScreen = (text: string) => text.replace(/[│╭╮╰╯─┃━>❯›]/g, ' ').replace(/\s+/g, ' ').toLowerCase()

/** Only the live bottom-of-screen progress indicator counts, never quoted command output. */
export function workingOnScreen(text: string): boolean {
  return text.trimEnd().split('\n').slice(-14).some((l) => /^\s*(?:[•●◦∙]\s+Working\s*\(|[✢✳✶✻✽]\s+[^\n]+…)/u.test(l))
}

export interface ScreenDialog {
  kind?: 'settings'

  question: string
  options: { id: string; label: string }[]
  selected: number
}

/** A selector with actual options and an interaction footer, never a user's ordinary composer. */
export function screenDialog(text: string): ScreenDialog | undefined {
  const lines = text.trimEnd().split('\n').map((l) => l.replace(/[│╭╮╰╯─┃━]/g, '').trim())
  const yn = lines.slice(-6).find((l) => /\?\s*\[y\/n\]:?\s*$/i.test(l))
  if (yn) {
    const question = yn.replace(/\s*\[y\/n\]:?\s*$/i, '')
    const token = createHash('sha256').update(question).digest('hex').slice(0, 12)
    return { question, options: [{ id: `${token}:y`, label: tr(M).yes }, { id: `${token}:n`, label: tr(M).no }], selected: -1 }
  }
  const cursor = lines.findLastIndex((l) => /^[›❯>]\s*\S/.test(l))
  if (cursor < 0) return undefined
  const selected = /^[›❯>]\s*(?:\d+[.)]\s+|(?=(?:yes|no|allow|deny|accept|cancel|continue|oui|non|autoriser|refuser)\b))(.+)/i.exec(lines[cursor])
  if (!selected) return undefined
  let footer = lines.findLastIndex((l) => /enter(?: to)? (confirm|select|continue)|esc (?:to )?(cancel|back|dismiss|skip)|escape to cancel|↑.*↓|\(y\/n\)/i.test(l))
  if (footer < cursor) {
    // Some Claude selectors omit the footer; the cursor must still be a numbered option,
    // the last content must be options, and no normal composer may follow it.
    if (!/^[›❯>]\s*\d+[.)]\s/.test(lines[cursor]) || !lines.slice(cursor + 1).some((l) => /^\d+[.)]\s/.test(l))) return undefined
    if (lines.slice(cursor + 1).some((l) => l && !/^\d+[.)]\s/.test(l))) return undefined
    footer = lines.length
  }
  if (lines.length - footer > 8) return undefined
  if (workingOnScreen(lines.slice(cursor + 1).join("\n"))) return undefined
  const start = Math.max(0, cursor - 12)
  const optionRE = /^(?:[›❯>]\s*)?(?:\d+[.)]\s+|(?=(?:yes|no|allow|deny|accept|cancel|continue|oui|non|autoriser|refuser)\b))(.+)/i
  const entries = lines.slice(start, footer).map((l, i) => ({ line: start + i, match: optionRE.exec(l) })).filter((x) => x.match)
  if (!entries.length) return undefined
  const question = lines.slice(Math.max(0, entries[0].line - 12), entries[0].line).reverse().find((l) => l.includes('?'))?.replace(/^[●•]\s*/, '').split('?')[0].concat('?') ?? tr(M).choiceWaiting
  const labels = entries.map((x) => x.match![1].replace(/\s*\([^)]*(?:esc|enter|tab)[^)]*\)\s*$/i, '').trim())
  const token = createHash('sha256').update(JSON.stringify([question, labels])).digest('hex').slice(0, 12)
  const permission = /Would you like to run (?:the following|this) command|(?:Bash|Shell) command/i.test(text)
  const display = (label: string) => {
    const clean = label.replace(/\s*\((?:y|n|p|esc|enter|tab)\)\s*$/i, '')
    if (!permission) return clean
    if (/^yes,? (?:proceed|allow|run)(?:\s|$)/i.test(clean)) return tr(M).allowCommand
    if (/^yes,? and don.t ask again/i.test(clean)) return tr(M).allowRule(clean.replace(/^yes,? and don.t ask again for /i, ''))
    if (/^no,? (?:and tell|cancel|deny)/i.test(clean) || /^no$/i.test(clean)) return tr(M).denyCommand
    return clean
  }
  const settings = lines.slice(Math.max(0, entries[0].line - 5), entries[0].line).some((line) => /^Select (?:Reasoning Level|Model)(?:\s|$)/i.test(line))
  return { ...(settings ? { kind: 'settings' as const } : {}), question: question.replace(/^Reason:\s*/i, ''), options: labels.map((label, i) => ({ id: `${token}:${i}`, label: display(label) })), selected: entries.findIndex((x) => x.line === cursor) }
}

export const codexDialogOnScreen = (text: string) => attentionFromScreen(text)
