import type { Lang } from '../shared/i18n.ts'
import type { FeedLocalization } from './foryou-localization.ts'
import type { Titled } from './titles.ts'

/** Translate presentation, never rename the canonical topic. Activity revisions cannot invalidate its title. */
export function titlePresentation(id: string, source: Titled, target: Lang, cache?: FeedLocalization, names: string[] = []) {
  const project = (field: 'title' | 'now', sourceLang?: Lang) => {
    const text = source[field]
    if (!cache || !text) return text
    return cache.project({ id: `session-${field}:${id}`, kind: 'session', tone: 'neutral', who: 'session', at: source.at, text }, target, sourceLang ?? 'unknown', names).text
  }
  return { title: project('title', source.titleLang), now: project('now', source.nowLang) }
}
