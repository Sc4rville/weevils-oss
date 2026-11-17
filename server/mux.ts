// Pilotage des sessions tmux « wv-* » : tmux est le registre (options @wv_*), weevils ne fait que lire et écrire.
// Une session wv-* = un agent (claude ou codex) dans un dossier. Lancées par weevils ou par le lanceur `wv`.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ORCH_DIR } from './config.ts'
import type { Tool } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/mux.ts'
import { readScreen, workingOnScreen, type Agent } from './terminal.ts'

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

/**
 * The tmux guard (server/tmux-guard, installed as ~/.local/bin/tmux) refuses to close the live weevils sessions
 * (kill-server, kill-session on this socket) unless the caller carries this server's token. Only weevils' own tmux
 * calls carry it: never process.env, never the agent panes (NO_TMUX drops it from their environment).
 */
let guardToken: string | undefined
export function tmuxGuardToken(): string {
  if (guardToken) return guardToken
  const dir = path.join(process.env.HOME ?? os.homedir(), '.local/share/weevils')
  const file = path.join(dir, 'tmux-token')
  try { guardToken = fs.readFileSync(file, 'utf8').trim() } catch { /* first start */ }
  if (!guardToken) {
    guardToken = randomBytes(24).toString('hex')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, guardToken + '\n', { mode: 0o600 })
  }
  // The live socket of this server, for the guard (it resolves the path the way tmux does).
  const base = process.env.TMUX_TMPDIR && fs.existsSync(process.env.TMUX_TMPDIR) ? process.env.TMUX_TMPDIR : '/tmp'
  try { fs.writeFileSync(path.join(dir, 'tmux-live'), path.join(base, `tmux-${os.userInfo().uid}`, SOCKET) + '\n', { mode: 0o600 }) } catch { /* the default path stays protected */ }
  return guardToken
}

function tmux(args: string[], cwd?: string, socket: string[] = ['-L', SOCKET]): Promise<string> {
  return new Promise((resolve, reject) => {
    // tmux silently falls back to /tmp when TMUX_TMPDIR does not exist. A throwaway HOME
    // must never discover or reap the real user's sessions, including on the legacy socket.
    if (!process.env.TMUX_TMPDIR && process.env.HOME && process.env.HOME !== os.userInfo().homedir) {
      process.env.TMUX_TMPDIR = path.join(process.env.HOME, '.local/share/weevils/tmux')
    }
    if (process.env.TMUX_TMPDIR) fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
    // -u: tmux takes the terminal for UTF-8 whatever the locale. A launchd service on a Mac has none, and tmux would
    // then replace the field separator of list-sessions (and every accent of a title) with « _ ».
    execFile('tmux', ['-u', ...socket, ...args], { cwd, timeout: 8000, maxBuffer: 4 << 20, env: { ...process.env, WEEVILS_TMUX_TOKEN: tmuxGuardToken() } }, (err, stdout, stderr) => {
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
  /** 'structured': a Claude session driven through server/claude-pump.mjs (messages, not keystrokes). */
  mode?: 'structured'
}

const SEP = '\u001f'
/** Le séparateur tel que tmux le rend : brut, ou échappé en octal par tmux 3.4. */
const SEP_OUT = /\u001f|\\037/

const FORMAT = ['#{session_name}', '#{@wv_tool}', '#{@wv_session_id}', '#{@wv_title}', '#{@wv_cwd}', '#{pane_current_path}', '#{session_created}', '#{pane_pid}', '#{@wv_mode}'].join(SEP)

function parse(out: string): WvSession[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('wv-'))
    .map((l) => {
      // tmux 3.4 (Ubuntu 24.04) écrit les caractères de contrôle d'un format en octal : « \037 » au lieu du séparateur.
      const [name, tool, sessionId, title, cwd, current, created, pid, mode] = l.split(SEP_OUT)
      const s: WvSession = {
        name,
        tool: tool === 'codex' ? 'codex' : 'claude',
        sessionId: sessionId || undefined,
        title: title || tr(M).newSession,
        cwd: cwd || current,
        createdAt: Number(created) * 1000,
      }
      if (Number(pid) > 0) s.pid = Number(pid)
      if (mode === 'structured') s.mode = 'structured'
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
export const NO_TMUX = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'WEEVILS_TMUX_TOKEN']

/** Nom d'une session wv-* pour un dossier. tmux remplace « . » et « : » par « _ » dans un nom de session : sans ce
 * remplacement fait d'avance, un dossier comme « .ad9651b0c8 » (tâche auto sans repo) ou « mon.site » donnait une
 * session lancée sous un autre nom que celui retenu, introuvable ensuite (« no such session ») mais au travail. */
export const wvName = (dir: string, short: string) => `wv-${dir.slice(0, 18).replace(/[.:]/g, '_')}-${short}`

export async function spawnWv(name: string, cwd: string, tool: Tool, title: string, command: string[], sessionId?: string, mode?: 'structured') {
  // Plusieurs arguments : tmux lance la commande directement, sans shell (pas d'injection possible) ; env non plus.
  const env = Object.entries({...QUIET_ENV, WEEVILS_FROM:cwd===ORCH_DIR?'weevboss':tool}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await tmux(['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd, ...env, ...NO_TMUX, ...command], cwd)
  if (mode) await setOpt(name, '@wv_mode', mode)
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

// What the screen means (questions, automatic answers, settings menus, status lines) lives in server/terminal.ts.
// These wrappers keep the older names for callers and tests.

/** The plain question on screen, when the agent is waiting for an answer from a person. */
export function attentionFromScreen(text: string, agent?: Agent): string | undefined {
  const s = readScreen(text, agent).state
  return s.kind === 'question' ? s.question : undefined
}

/** Something covers the input box (a question, a dialog weevils answers itself, a settings menu): its name or question. */
export function dialogOnScreen(text: string, agent?: Agent): string | undefined {
  const s = readScreen(text, agent).state
  return s.kind === 'question' ? s.question : s.kind === 'auto' || s.kind === 'picker' ? s.name : undefined
}

/** Ce qui est écrit à l'écran, aplati, pour y retrouver un message qu'on vient d'envoyer. */
export const flatScreen = (text: string) => text.replace(/[│╭╮╰╯─┃━>❯›]/g, ' ').replace(/\s+/g, ' ').toLowerCase()

export { workingOnScreen }

export interface ScreenDialog {
  kind?: 'settings'
  question: string
  /** What exactly is asked (the command, the reason), when the dialog says it. */
  detail?: string
  options: { id: string; label: string }[]
  selected: number
}

/** A question with its labeled answers, or a settings menu (kind 'settings'); never the ordinary composer. */
export function screenDialog(text: string, agent?: Agent): ScreenDialog | undefined {
  const s = readScreen(text, agent).state
  if (s.kind === 'question') return { question: s.question, ...(s.detail ? { detail: s.detail } : {}), options: s.choices, selected: s.menu?.selected ?? -1 }
  if (s.kind === 'picker') return { kind: 'settings', question: s.name, options: (s.menu?.options ?? []).map((o, i) => ({ id: String(i), label: o.raw })), selected: s.menu?.selected ?? -1 }
  return undefined
}

export const codexDialogOnScreen = (text: string) => attentionFromScreen(text, 'codex')
