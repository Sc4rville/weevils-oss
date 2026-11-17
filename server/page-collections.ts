// Read existing records only. Publication never starts work or changes routing/origin.
import type { Session } from '../shared/api.ts'
import type { Ledger } from './boss-ledger.ts'
import type { RecapAuto } from './sleep.ts'
import type { ListItem } from './pages.ts'
import { tr } from './i18n.ts'
import M from './i18n/pages.ts'

type LedgerReader = Pick<Ledger, 'asks' | 'goals'>
export function collectionReaders(o: {
  ledger(): LedgerReader | null | undefined
  automations(): RecapAuto[]
  repositories(): string[]
  sessions(): Session[]
}): Record<string, () => ListItem[]> {
  return {
    requests: () => {
      const t = tr(M), ledger = o.ledger()
      if (!ledger) return []
      return [
        ...ledger.goals(true).map((g) => ({ title: g.title, source: t.goal, why: [t.state(g.status), g.progress || g.why].filter(Boolean).join(' · '), details: JSON.stringify({ id: g.id, at: g.at, progressAt: g.progressAt }, null, 2) })),
        ...ledger.asks('all').sort((a, b) => b.at - a.at).slice(0, 150).map((a) => ({ title: a.text, source: t.request, date: new Date(a.at).toISOString(), why: [t.state(a.status), a.note].filter(Boolean).join(' · '), details: JSON.stringify({ id: a.id, goal: a.goal, source: a.src, author: a.from, quote: a.quote, dispatches: a.dispatches.map((d) => ({ session: d.session, label: d.label, at: d.at, outcome: d.outcome, report: d.report })) }, null, 2) })),
      ]
    },
    automations: () => {
      const t = tr(M)
      return o.automations().flatMap((a) => a.runs.map((r) => ({ title: a.title, source: r.ok ? t.recordedSuccess : t.recordedFailure, date: new Date(r.at).toISOString(), why: r.note, details: JSON.stringify({ origin: 'automation-run', automationId: a.id, startedAt: r.startedAt, endedAt: r.at, sessionId: r.sessionId, softwareId: r.softwareId, sourceRevision: r.sourceRevision, configRevision: r.configRevision, files: r.files }, null, 2) }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 150)
    },
    repositories: () => {
      const t = tr(M), sessions = o.sessions()
      return o.repositories().sort().map((name) => {
        const known = sessions.filter((s) => s.repo === name)
        return { title: name, why: t.sessions(known.length), details: JSON.stringify(known.map((s) => ({ sessionId: s.id, title: s.title, status: s.status, tool: s.tool })), null, 2) }
      })
    },
  }
}
