import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Reservoir, RELEASE_MS } from './foryou-reservoir.ts'
let dir: string
let file: string
const refs = new Set(['goals'])
const now = 1_800_000_000_000
const idea = (text: string, format = 'idea') => ({ title: 'A concrete suggestion', text, sources: ['goals'], format })
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reservoir-')); file = path.join(dir, 'queue.json') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
it('publishes at most once per 30 seconds across restarts, without catch-up bursts', () => {
  let q = new Reservoir(file)
  const texts = ['A café scene could begin with a customer ordering a cloud.', 'Try a silent storyboard where an avatar loses its shadow.', 'Ask the first contributor to describe their hardest installation step.', 'Show a shop owner how a tiny rehearsal becomes a live performance.', 'A paper theatre can illustrate the difference between an idea and a film.', 'Use a kitchen timer as the visual villain of the sketch.']
  q.add(texts.map(t => idea(t)), refs, [], now, 'en')
  expect(q.queue).toHaveLength(6)
  const out: string[] = []
  const send = (s: { id: string }) => out.push(s.id)
  for (let n = 0; n < 6; n++) {
    q.publish(now + n * RELEASE_MS, refs, 'en', send)
    q = new Reservoir(file)
    q.publish(now + n * RELEASE_MS + 1, refs, 'en', send)
    expect(out).toHaveLength(n + 1)
  }
  expect(new Set(out).size).toBe(6)
  q.add([idea('Let an empty theatre seat narrate the performance.')], refs, [], now + 3600_000, 'en')
  q.publish(now + 3600_000, refs, 'en', send)
  q.publish(now + 3600_001, refs, 'en', send)
  expect(out).toHaveLength(7)
})
it('rejects ungrounded content, ACKs and duplicates even after restart and publication', () => {
  const q = new Reservoir(file)
  const good = idea('Try a silent storyboard where an avatar loses its shadow.')
  q.add([good, good, { ...good, text: 'An unrelated discovery', sources: ['missing'] }, idea('Bien reçu, coordination confirmée.'), { ...good, title: '' }], refs, [], now, 'fr')
  expect(q.queue).toHaveLength(1)
  q.publish(now, refs, 'fr', () => {})
  const restored = new Reservoir(file)
  restored.add([good], refs, [], now + RELEASE_MS, 'fr')
  expect(restored.queue).toHaveLength(0)
})
it('drops expired or removed sources, honors language and keeps failed sends queued', () => {
  const q = new Reservoir(file)
  q.add([idea('A paper theatre can illustrate the difference between an idea and a film.')], refs, [], now, 'fr')
  q.publish(now, refs, 'en', () => { throw Error('wrong language') })
  expect(q.queue).toHaveLength(1)
  expect(() => q.publish(now, refs, 'fr', () => { throw Error('failed') })).toThrow('failed')
  expect(q.queue).toHaveLength(1)
  q.publish(now + 6 * 3600_000, refs, 'fr', () => { throw Error('expired') })
  expect(new Reservoir(file).queue).toHaveLength(0)
  q.add([idea('Use a kitchen timer as the visual villain of the sketch.')], refs, [], now, 'fr')
  q.publish(now, new Set(), 'fr', () => { throw Error('removed') })
  expect(new Reservoir(file).queue).toHaveLength(0)
})
it('alternates available formats and caps stored candidates', () => {
  const q = new Reservoir(file)
  q.add([idea('A café scene could begin with a customer ordering a cloud.'), idea('Try a silent storyboard where an avatar loses its shadow.'), idea('Ask the first contributor to describe their hardest installation step.', 'question')], refs, [], now, 'en')
  const formats: string[] = []
  q.publish(now, refs, 'en', s => formats.push(s.format))
  q.publish(now + RELEASE_MS, refs, 'en', s => formats.push(s.format))
  expect(formats).toEqual(['idea', 'question'])
})

it('imports a private editorial batch once, preserving deduplication and source validation', () => {
  const q = new Reservoir(file)
  const incoming = file + '.incoming.json'
  const items = [idea('A paper theatre can illustrate the difference between an idea and a film.'), { ...idea('This item has no reliable source.'), sources: ['absent'] }]
  fs.writeFileSync(incoming, JSON.stringify({ lang: 'fr', items }), { mode: 0o600 })
  q.ingest(refs, [], now, 'fr')
  expect(q.queue).toHaveLength(1)
  expect(fs.existsSync(incoming)).toBe(false)
  fs.writeFileSync(incoming, JSON.stringify({ lang: 'fr', items }))
  const restored = new Reservoir(file)
  restored.ingest(refs, [], now, 'fr')
  expect(restored.queue).toHaveLength(1)
})
