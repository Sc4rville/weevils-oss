import { preferredTool, providerStatus, providerUnavailable } from './provider.ts'
// Renommage des sessions : le sujet reste stable ; seule l’activité suit les étapes du travail.
// Juge LLM sur l'abonnement (codex exec éphémère, comme le classement), par lots, sans coût d'API.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tr, user, type Lang } from './i18n.ts'
import M from './i18n/titles.ts'
import { haiku } from './fast.ts'

export interface TitleInput {
  id: string
  tool: string
  /** Repo ou dossier, pour le contexte. */
  where: string
  previousTitle?: string
  debut: string
  recents: string[]
}

export interface Titled {
  titleLang?: Lang
  nowLang?: Lang
  title: string
  now: string
  /** Quand le titre a été écrit, et sur combien de messages : pour savoir quand renommer à nouveau. */
  at: number
  messageCount: number
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'now', 'topicChanged'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          now: { type: 'string' },
          topicChanged: { type: 'boolean' },
        },
      },
    },
  },
}

const clean = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').replace(/[.。]\s*$/, '').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Raccourci au mot entier (pas de phrase coupée en plein milieu) : une ligne de téléphone, ~40 caractères. */
export const shortNow = (s: string, max = 40) => {
  const t = s.replace(/\s+/g, ' ').replace(/[.。]\s*$/, '').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max / 2 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:·–-]+$/, '')
}

export async function llmTitles(items: TitleInput[], workdir: string): Promise<{ id: string; title: string; now: string; topicChanged?: boolean }[]> {
  fs.mkdirSync(workdir, { recursive: true })
  const schemaFile = path.join(workdir, 'schema.json')
  const outFile = path.join(workdir, `out-${Date.now()}.json`)
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA))
  const t = tr(M)
  const prompt = t.prompt(user(), `[${items.map((i) => t.item(i.id, i.tool, i.where, i.debut, i.recents, i.previousTitle)).join(',')}]`)
  // Sans Codex (la plupart des nouveaux venus n'ont que Claude Code) : haiku, sur l'abonnement Claude.
  if (preferredTool() === 'claude') {
    const out = await haiku(`${prompt}\n\n${t.jsonOnly}`, 90_000)
    const raw = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { items?: { id: string; title: string; now: string; topicChanged?: boolean }[] }
    fs.rmSync(schemaFile, { force: true })
    return (raw.items ?? []).filter((x) => x.title?.trim()).map((x) => ({ id: x.id, title: clean(x.title, 42), topicChanged: x.topicChanged === true, now: shortNow(x.now ?? '') }))
  }
  const selected = providerStatus('codex')
  if (!selected.installed || !selected.logged) throw new Error(providerUnavailable('codex'))
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'codex',
      ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--output-schema', schemaFile, '-o', outFile, '-c', 'model_reasoning_effort="low"', prompt],
      { cwd: workdir, timeout: 180_000, maxBuffer: 16 << 20 },
      (err, _out, stderr) => (err ? reject(new Error(stderr?.toString().slice(-300) || err.message)) : resolve()),
    )
    child.stdin?.end()
  })
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { items: { id: string; title: string; now: string; topicChanged?: boolean }[] }
  fs.rmSync(outFile, { force: true })
  return raw.items.filter((x) => x.title?.trim()).map((x) => ({ id: x.id, title: clean(x.title, 42), topicChanged: x.topicChanged === true, now: shortNow(x.now ?? '') }))
}

/** Faut-il (re)nommer cette session ? Un nouveau titre quand le fil a avancé, pas à chaque message. */
export function needsTitle(prev: Titled | undefined, messageCount: number, live: boolean, now: number): boolean {
  if (messageCount < 2) return false
  if (!prev) return true
  const grown = messageCount - prev.messageCount
  if (grown <= 0) return false
  const age = now - prev.at
  // Activité effacée par un nouveau message : à réécrire tout de suite.
  if (!prev.now && live) return true
  // Pendant le travail, l'activité suit : toutes les 2 min dès que le fil a bougé.
  if (live) return age >= 2 * 60_000
  // Session finie : un dernier titre quand le fil a bougé depuis.
  return age >= 2 * 60_000
}

/** Micro-actions never rename the topic; only an explicit switch of subject does. */
export const stableTitle = (previous: string | undefined, proposed: string, topicChanged = false) => previous && !topicChanged ? previous : proposed

/** Failed metadata calls must not be retried by every incoming transcript event. */
export class TitleRetry {
  private failures = 0
  private until = 0
  ready(now: number) { return now >= this.until }
  failed(now: number) {
    this.failures = Math.min(this.failures + 1, 5)
    this.until = now + Math.min(60 * 60_000, 5 * 60_000 * 2 ** (this.failures - 1))
  }
  succeeded() { this.failures = 0; this.until = 0 }
}
