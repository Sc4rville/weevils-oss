import NumberMessages from './i18n/foryou-numbers.ts'
// « For you »: figures that moved, read from real local data, each a big number plus what changed. Cheap and cached:
// git logs at most every 10 min (asynchronously, a read never waits), the request ledger on its mtime.
//   - requests closed this week toward each goal (boss ledger), vs last week
//   - commits shipped per project this week, vs last week (git log of the project roots)
// A figure that did not move (same as last week, or zero) says nothing and is left out.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ForYouItem } from '../shared/foryou.ts'

const WEEK = 7 * 86_400_000
const GIT_EVERY = 10 * 60_000

interface Ask { status: string; goal?: string; closedAt?: number }
interface Goal { id: string; title: string; status: string }

export interface NumberDeps {
  ledgerFile: string
  roots: string[]
  fr?: () => boolean
}

const short = (s: string, n = 48) => {
  let t = s.replace(/[.!]+$/, '').trim()
  const head = t.split(/\s*[:;,—(]\s*/)[0]
  if (head.length >= 12) t = head
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/(?:\s+(?:a|an|the|to|of|and|or|for|from|with|their|your|its|in|on))+$/i, '').replace(/[\s,;:–—-]+$/, '')
}

/** this week vs last: the words of the change, or '' when nothing moved. */
export function change(now: number, last: number, fr = false): string {
  if (now === last) return ''
  const t = NumberMessages[fr ? 'fr' : 'en']
  if (!last) return t.none
  return t.change(last)
}

export class ForYouNumbers {
  private ledger = { mtime: 0, items: [] as ForYouItem[] }
  private git = { at: 0, busy: false, items: [] as ForYouItem[] }
  private d: NumberDeps
  constructor(d: NumberDeps) {
    this.d = d
  }

  items(now: number): ForYouItem[] {
    this.refreshGit(now)
    return [...this.goals(now), ...this.git.items]
  }

  /** Requests closed this week per goal, from the ledger (re-read when it changes). */
  private goals(now: number): ForYouItem[] {
    let mtime = 0
    try { mtime = fs.statSync(this.d.ledgerFile).mtimeMs } catch { return [] }
    if (mtime === this.ledger.mtime) return this.ledger.items
    const fr = !!this.d.fr?.()
    const out: ForYouItem[] = []
    try {
      const l = JSON.parse(fs.readFileSync(this.d.ledgerFile, 'utf8')) as { asks?: Ask[]; goals?: Goal[] }
      const since = now - WEEK, before = now - 2 * WEEK
      for (const g of (l.goals ?? []).filter((g) => g.status === 'active')) {
        const done = (l.asks ?? []).filter((a) => a.goal === g.id && a.status === 'done' && a.closedAt)
        const tw = done.filter((a) => a.closedAt! >= since).length
        const lw = done.filter((a) => a.closedAt! >= before && a.closedAt! < since).length
        const open = (l.asks ?? []).filter((a) => a.goal === g.id && (a.status === 'open' || a.status === 'dispatched')).length
        const moved = change(tw, lw, fr)
        if (!tw || !moved) continue
        const t = NumberMessages[fr ? 'fr' : 'en']
        const left = open ? t.left(open) : ''
        out.push({ id: `ms:goal:${g.id}:${Math.floor(now / WEEK)}`, kind: 'milestone', tone: 'magic', at: now, who: 'weevils', text: t.requests(tw, short(g.title), moved, left), open: { page: 'boss' }, live: true })
      }
    } catch { /* a ledger being written: next time */ }
    out.sort((a, b) => Number(/^\d+/.exec(b.text)?.[0]) - Number(/^\d+/.exec(a.text)?.[0]))
    this.ledger = { mtime, items: out.slice(0, 2) }
    return this.ledger.items
  }

  /** Commits per project this week vs last, every 10 min in the background. */
  private refreshGit(now: number) {
    if (this.git.busy || now - this.git.at < GIT_EVERY) return
    this.git.busy = true
    this.git.at = now
    const repos: string[] = []
    for (const root of this.d.roots) {
      try {
        for (const n of fs.readdirSync(root)) if (fs.existsSync(path.join(root, n, '.git'))) repos.push(path.join(root, n))
      } catch { /* no such root */ }
    }
    const fr = !!this.d.fr?.()
    const since = now - WEEK
    const one = (dir: string) => new Promise<{ name: string; tw: number; lw: number }>((res) => execFile('git', ['-C', dir, 'log', '--all', '--since=14.days', '--format=%ct'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, out) => {
      const ts = err ? [] : out.split('\n').filter(Boolean).map((s) => Number(s) * 1000)
      res({ name: path.basename(dir), tw: ts.filter((t) => t >= since).length, lw: ts.filter((t) => t < since).length })
    }))
    void Promise.all(repos.slice(0, 60).map(one)).then((all) => {
      // A clone of the same repo has the same history: one card per history.
      const seen = new Set<string>()
      this.git.items = all.filter((r) => r.tw >= 3 && change(r.tw, r.lw) && !seen.has(`${r.tw}:${r.lw}`) && !!seen.add(`${r.tw}:${r.lw}`)).sort((a, b) => b.tw - a.tw).slice(0, 2).map((r) => ({
        id: `ms:commits:${r.name}:${Math.floor(now / WEEK)}`, kind: 'milestone' as const, tone: 'magic' as const, at: now, who: 'weevils', projectId: r.name,
        text: NumberMessages[fr ? 'fr' : 'en'].commits(r.tw, r.name, change(r.tw, r.lw, fr)), live: true,
      }))
    }).finally(() => { this.git.busy = false })
  }
}
