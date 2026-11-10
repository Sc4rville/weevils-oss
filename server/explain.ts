// Questions rapides depuis la vue d'un fichier, un fil de conversation ou la page mémoire : « explique », « où c'est
// utilisé », « demande ».
// Modèle rapide (gpt-4.1 ~1 s, sinon haiku) avec le contexte de la page ; une demande d'action part au vrai weevboss.

import { execFile } from 'node:child_process'
import type { ExplainReply, ExplainRequest, UsageHit } from '../shared/api.ts'
import type { Weevils } from './core.ts'
import type { Memory } from './memory.ts'
import { ORCHESTRATOR } from './config.ts'
import { quick } from './fast.ts'
import { tr, user } from './i18n.ts'
import M, { ACTION } from './i18n/explain.ts'

const MAX_HITS = 60
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Le terme cherché par « où c'est utilisé » : la sélection sur une ligne, sinon rien. */
export function usageTerm(selection: string): string | null {
  const q = selection.trim()
  if (!q || q.includes('\n') || q.length > 80) return null
  return q
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 6000, maxBuffer: 4 << 20 }, (err, stdout) => {
      // Code 1 : aucune occurrence.
      if (err && (err as { code?: number }).code !== 1) reject(err)
      else resolve(stdout.toString())
    }),
  )

/** « chemin:ligne:texte » → occurrences. */
export function parseHits(out: string): UsageHit[] {
  const hits: UsageHit[] = []
  for (const l of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(l)
    if (m) hits.push({ path: m[1].replace(/^\.\//, ''), line: Number(m[2]), text: clip(m[3].trim(), 160) })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

/** Occurrences d'un terme dans un repo de cette machine (git grep, sinon grep). */
export async function grepRepo(w: Weevils, repo: string, term: string): Promise<UsageHit[]> {
  if (!usageTerm(term)) return []
  const dir = w.repoDir(repo)
  const word = /^[\p{L}\p{N}_$]+$/u.test(term) ? ['-w'] : []
  try {
    return parseHits(await run('git', ['-C', dir, 'grep', '-n', '-I', '-F', '--max-count=4', ...word, '-e', term, '--', '.', ':!*.lock', ':!package-lock.json', ':!dist']))
  } catch {
    return parseHits(await run('grep', ['-rnIF', '--max-count=4', ...word, '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '-e', term, dir]).then((o) => o.split(`${dir}/`).join('')))
  }
}

/** Occurrences, là où le repo vit : ici, sur une autre machine, ou nulle part (repo GitHub seulement). */
async function hitsFor(w: Weevils, req: ExplainRequest, term: string): Promise<UsageHit[]> {
  const remote = w.remoteById(req.machine)
  if (remote) return (await remote.call<{ hits: UsageHit[] }>('GET', `/api/repos/${encodeURIComponent(req.repo)}/grep?q=${encodeURIComponent(term)}`)).hits
  if (!w.repoRoot(req.repo)) return []
  return grepRepo(w, req.repo, term)
}

/** Une réponse sans markdown résiduel, en une seule respiration. */
const tidy = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').trim()

/**
 * Head of a question asked on the memory page: the memory item (its text, the weevil question and answer it came
 * from), a few other memories. Read from the store here, never trusted from the app; on a machine without the memory
 * (secondary), what the app sent (`around`) stands in.
 */
export function memoryHead(memory: Memory | null, req: ExplainRequest, sel: string): string {
  const t = tr(M)
  const item = req.path ? memory?.get(req.path) : undefined
  const others = (memory?.list() ?? [])
    .filter((m) => m.id !== item?.id)
    .slice(0, item ? 12 : 40)
    .map((m) => `- ${m.text}`)
    .join('\n')
  if (!item) return t.headMemoryAll(user(), clip(others || req.around, 6000), sel)
  return t.headMemory(user(), item.text, item.source === 'answer' ? (item.q ?? '') : '', item.source === 'answer' ? clip(item.a ?? '', 1200) : '', clip(others, 3000), sel)
}

export async function explain(w: Weevils, req: ExplainRequest): Promise<ExplainReply> {
  const t = tr(M)
  const sel = clip(req.selection.trim(), 1500)
  const conv = req.kind === 'conv'
  const mem = req.kind === 'memory'
  const head = mem
    ? memoryHead(w.memory, req, sel)
    : conv
      ? t.headConv(user(), req.title ?? '', req.tool ?? '', req.project ?? '', req.repo, clip(req.around, 7000), sel)
      : t.head(user(), req.repo, req.path, clip(req.around, 6000), sel, req.from, req.to)
  if (req.mode === 'usage' && !mem) {
    const term = usageTerm(req.selection)
    const hits = term && req.repo ? await hitsFor(w, req, term).catch(() => []) : []
    const list = hits.slice(0, 30).map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
    return { text: tidy(await quick(head + t.usage(list))), hits }
  }
  if (req.mode === 'ask') {
    const q = (req.question ?? '').trim()
    if (!q) return { text: '' }
    const out = await quick(head + t.ask(q))
    if (out.includes(ACTION) && ORCHESTRATOR) {
      const item = mem && req.path ? w.memory?.get(req.path) : undefined
      await w.sendMain(
        mem
          ? t.forwardMemory(item ? clip(item.text, 300) : '', item?.id ?? '', clip(sel, 300), q)
          : conv
            ? t.forwardConv(req.title ?? '', clip(sel, 300), q)
            : t.forward(req.repo, req.path, req.from, req.to, clip(sel, 300), q),
      )
      return { text: '', forwarded: true }
    }
    return { text: tidy(out.replace(ACTION, '')) }
  }
  return { text: tidy(await quick(head + (mem ? t.explainMemory : t.explain))) }
}

/** Corps reçu de l'app, rendu sûr (types, tailles). */
export function readExplain(b: any): ExplainRequest {
  const mode = b?.mode === 'usage' || b?.mode === 'ask' ? b.mode : 'explain'
  const str = (v: unknown, n = 200) => (v ? String(v).slice(0, n) : undefined)
  return {
    mode,
    kind: b?.kind === 'conv' || b?.kind === 'memory' ? b.kind : 'file',
    title: str(b?.title),
    tool: str(b?.tool, 40),
    project: str(b?.project),
    repo: String(b?.repo ?? ''),
    path: String(b?.path ?? ''),
    machine: b?.machine ? String(b.machine) : undefined,
    selection: String(b?.selection ?? '').slice(0, 4000),
    from: Math.max(1, Number(b?.from) || 1),
    to: Math.max(1, Number(b?.to) || Number(b?.from) || 1),
    around: String(b?.around ?? '').slice(0, 12000),
    question: b?.question ? String(b.question).slice(0, 2000) : undefined,
  }
}
