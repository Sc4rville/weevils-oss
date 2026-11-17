import { expect, it } from 'vitest'
import { collectionReaders } from './page-collections.ts'
import { setLang } from './i18n.ts'

it('reports recorded runs and preserves authors and source IDs without treating a queued task as a result', () => {
  setLang('en', true)
  const readers = collectionReaders({
    ledger: () => ({ asks: () => [{ id: 'r1', text: 'Review the result', quote: 'Keep my exact words', src: 'message-1', from: 'agent-codex', at: 1000, status: 'dispatched', dispatches: [{ session: 'project-thread', at: 2000 }], kind: 'task', progressAt: 2000 }], goals: () => [] }),
    automations: () => [{ id: 'queued', title: 'Never run', state: 'queued', runs: [] }, { id: 'actual', title: 'A real run', state: 'queued', runs: [{ at: 5000, startedAt: 3000, ok: false, note: 'Could not read the source', sourceRevision: 'verified-revision', sessionId: 'ordinary-project-thread' }] }],
    repositories: () => ['demo'], sessions: () => [],
  })
  expect(readers.automations()).toHaveLength(1)
  expect(readers.automations()[0]).toMatchObject({ source: 'Reported failure', why: 'Could not read the source' })
  expect(readers.automations()[0].details).toContain('verified-revision')
  expect(readers.automations()[0].details).toContain('ordinary-project-thread')
  expect(readers.requests()[0].details).toContain('agent-codex')
  expect(readers.requests()[0].details).toContain('Keep my exact words')
  expect(readers.repositories()[0].why).toContain('0 known')
})
