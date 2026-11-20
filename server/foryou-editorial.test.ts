import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { ForYouItem } from '../shared/foryou.ts'
import { editorialText, reviewedEditorial } from './foryou-editorial.ts'
import reviewed from './foryou-editorial-reviewed.json' with { type: 'json' }
import { FeedLocalization, presentation } from './foryou-localization.ts'
import { ForYou } from './foryou.ts'

it('simplifies delegation without inventing an outcome, in either locale', () => {
  expect(editorialText('I suggest asking weevboss to prepare a project rotation.', 400)).toBe('Prepare a project rotation.')
  expect(editorialText('Demande à weevboss de préparer une palette pour TLO.', 400)).toBe('Préparer une palette pour TLO.')
  const progress = 'Chat is being added beside the preview. It is not ready yet.'
  expect(editorialText(progress, 400)).toBe(progress)
})
it('never clips away caveats or edits attributed quotations', () => {
  const text = 'The render is ready. Publishing still needs your approval.'
  expect(editorialText(text, 30)).toBe('')
  expect(editorialText(text, 400)).toBe(text)
  const quote = 'Scarville wrote: « Ask weevboss to prepare the café ». The preview is ready.'
  expect(editorialText(quote, 400)).toBe(quote)
  expect(editorialText('Great progress: 1307 tests passed.', 400)).toBe('')
  expect(editorialText('One result. Another result. An unrelated status.', 400)).toBe('')
})
it('reviews only exact generated sources, retaining original wording and every non-text field', () => {
  for (const edit of reviewed) {
    const item = { id: edit.id, kind: edit.kind, tone: 'neutral', who: 'weevboss', at: 42, text: edit.source, seen: true, actions: [{ id: 'a1', label: 'Review' }], media: [{ id: 'pic', name: 'source.png', url: '/api/media/pic', type: 'image', bytes: 42 }] } as ForYouItem
    const source = structuredClone(item)
    const result = reviewedEditorial(item, item.text)
    expect(result.text).toBe(edit.text)
    expect(result.editorial?.original.text).toBe(edit.source)
    expect({ ...result, text: item.text, editorial: undefined }).toEqual({ ...item, editorial: undefined })
    expect(item).toEqual(source)
    expect(reviewedEditorial({ ...item, text: 'A later result.' }, 'A later result.').text).toBe('A later result.')
    expect(reviewedEditorial({ ...item, id: 'b:custom' }, item.text)).toEqual({ ...item, id: 'b:custom' })
    expect(reviewedEditorial({ ...item, kind: 'media' }, item.text).text).toBe(item.text)
  }
})
it('uses a new translation revision, preserves old cache and original wording on reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editorial-'))
  try {
    const file = path.join(dir, 'cache.json'), cache = new FeedLocalization(file)
    const edit = reviewed[0]
    const source = { id: edit.id, kind: edit.kind, tone: 'neutral', who: 'weevboss', at: 42, text: edit.source } as ForYouItem
    const previous = cache.project(source, 'fr', 'en')
    const next = reviewedEditorial(source, source.text)
    const french = cache.project(next, 'fr', 'en')
    expect(french.localization?.revision).not.toBe(previous.localization?.revision)
    expect(french.localization?.status).toBe('pending')
    expect(presentation(next)).not.toHaveProperty('editorial')
    expect(new FeedLocalization(file).project(next, 'fr', 'en')).toEqual(french)
    expect(cache.project(next, 'en', 'en')).toEqual(next)
    expect(cache.project(source, 'fr', 'en').localization?.revision).toBe(previous.localization?.revision)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('projects a stored real card through EN FR EN without rewriting its source or action brief', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editorial-store-'))
  try {
    const now = Date.now(), file = path.join(dir, 'foryou.json')
    const edit = reviewed.find(e => e.id === 'i:1b6e4c74eee3')!
    const original = { id: edit.id, kind: 'improve', who: 'weevboss', tone: 'neutral', at: now, text: edit.source, lang: 'en', seen: true, actions: [{ id: 'a1', label: 'Prepare project rotation', brief: 'Prepare the rotation without changing any underlying records.' }] }
    fs.writeFileSync(file, JSON.stringify({ rev: 5, items: [original] }))
    const host = { snapshot: () => ({ sessions: [], projects: [], optimizers: [], machines: [], config: {} }), bump() {} } as unknown as ConstructorParameters<typeof ForYou>[0]
    const make = () => new ForYou(host, { file, now: () => now, dataDir: dir, machineId: 'test', later: () => undefined })
    const fy = make()
    const views = ['en', 'fr', 'en'].map(l => fy.feed(now, l).items.find(i => i.id === edit.id)!)
    expect(views.every(Boolean)).toBe(true)
    for (const item of views) {
      expect(item).toMatchObject({ id: edit.id, at: now, seen: true, text: edit.text, editorial: { original: { text: edit.source } }, actions: [{ id: 'a1', label: original.actions[0].label }] })
      expect(item.actions![0]).not.toHaveProperty('brief')
    }
    expect(views[1].localization?.status).toBe('pending')
    expect(make().feed(now, 'en').items.find(i => i.id === edit.id)).toEqual(views[0])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).items).toEqual([original])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
