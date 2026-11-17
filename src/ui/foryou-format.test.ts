// The five internal layouts of « For you »: every legacy kind maps to one of them or is hidden, the lines stay short.
import { describe, expect, it } from 'vitest'
import type { ForYouItem } from '../../shared/foryou.ts'
import { bigNumber, cardLine, cleanSubject, detailLine, formatOf, LINE_MAX, looksOf, mixDepths, richItem, shortLine, STREAM_CAP, streamOf } from './foryou-format'

const it0 = (o: Partial<ForYouItem>): ForYouItem => ({ id: 'x', kind: 'boss', tone: 'neutral', at: 1, who: 'weevils', text: 'Something.', ...o })
const media = [{ id: 'm', type: 'image' as const, url: '/m', name: 'm.png', bytes: 1 }]

describe('formatOf', () => {
  it.each<[string, Partial<ForYouItem>, ReturnType<typeof formatOf>]>([
    ['live proposals ask for a tap', { kind: 'proposals', cards: [{ id: 'c', title: 'T', why: '', source: 'tip', kind: 'k' }] }, 'action'],
    ['empty proposals hide', { kind: 'proposals', cards: [] }, null],
    ['an alert asks for a look', { kind: 'alert', tone: 'alert' }, 'action'],
    ['a mail asks for a look', { kind: 'mail' }, 'action'],
    ['weevboss relay mail hides', { kind: 'mail', title: '[weevboss] ACTION — brief' }, null],
    ['a question asks for an answer', { kind: 'session', tone: 'question' }, 'action'],
    ['a cut session asks for a look', { kind: 'session', tone: 'alert' }, 'action'],
    ['a result is progress', { kind: 'session', tone: 'result' }, 'progress'],
    ['a result with media is visual', { kind: 'session', tone: 'result', media }, 'visual'],
    ['a neutral session hides', { kind: 'session', tone: 'neutral' }, null],
    ['media is visual', { kind: 'media', media }, 'visual'],
    ['a result group is visual', { kind: 'media', resultGroup: { key: 'tlo-alcove', final: media[0], finalAt: 1, history: [], otherMedia: [], newerUpdate: false } }, 'visual'],
    ['a boss idea with buttons is action', { kind: 'boss', actions: [{ id: 'a', label: 'do' }] }, 'action'],
    ['a boss word without buttons is a thought', { kind: 'boss' }, 'think'],
    ['an automation start is chatter', { kind: 'boss', id: 'auto:go:1' }, null],
    ['an automation wrap-up is chatter', { kind: 'boss', id: 'auto:done:1' }, null],
    ['an automation proposal is action', { kind: 'boss', id: 'auto:proposed:1' }, 'action'],
    ['improve with buttons is action', { kind: 'improve', actions: [{ id: 'a', label: 'do' }] }, 'action'],
    ['improve without is a thought', { kind: 'improve' }, 'think'],
    ['an insight is learn', { kind: 'insight' }, 'learn'],
    ['the token audit hides', { kind: 'insight', id: 'cost:audit:1' }, null],
    ['a milestone that compares is progress', { kind: 'milestone', text: '100 turns, twice last week' }, 'progress'],
    ['a bare count is a readout', { kind: 'milestone', text: '3 projects moved today, good day.' }, null],
    ['the overnight tally is a readout', { kind: 'stat', recap: { lines: [{ state: 'done', src: 'auto', title: 'x' }] } as any }, null],
    ['a repeated saving line hides', { kind: 'stat', id: 'cost:gain:1', text: 'saved 12 %' }, null],
    ['plain bars without a figure hide', { kind: 'stat', text: '' }, null],
    ['a stat that compares is progress', { kind: 'stat', text: '12 turns today, up from 4' }, 'progress'],
    ['work in progress is chatter', { work: { intentId: 'i', status: 'running' } }, null],
    ['work done is progress', { work: { intentId: 'i', status: 'completed' } }, 'progress'],
  ])('%s', (_, o, want) => expect(formatOf(it0(o))).toBe(want))
})

describe('short lines', () => {
  it('keeps the first sentence, drops markdown, clamps on a word', () => {
    expect(shortLine('**Shipped** the `menu`. Then a long tail of details nobody needs here.')).toBe('Shipped the menu.')
    const long = 'word '.repeat(80)
    const line = shortLine(long)
    expect(line.length).toBeLessThanOrEqual(LINE_MAX)
    expect(line.endsWith('…')).toBe(false)
  })
  it('never ends on an ellipsis or a dangling word', () => {
    const l = shortLine('We moved the whole render queue onto the cheaper pod, and every clip now finishes before breakfast, which frees the afternoon for the trailer and the edit of the')
    expect(l).not.toMatch(/…|\.\.\.$/)
    expect(l).not.toMatch(/\b(the|and|of|for)$/)
    expect(shortLine('Brief ready…')).toBe('Brief ready')
  })
  it('a big number comes out of a milestone', () => {
    expect(bigNumber(it0({ kind: 'milestone', text: '100 turns delivered' }))).toEqual({ n: '100', rest: 'turns delivered' })
    expect(bigNumber(it0({ kind: 'milestone', text: 'a first time' }))).toBeNull()
  })
  it('an own proposal keeps its title (the card renders it as the user’s)', () => {
    expect(cardLine(it0({ kind: 'proposals', cards: [{ id: 'c', title: 'Run the backup nightly', why: 'x', source: 'optimizer', kind: 'k', own: true }] }))).toBe('Run the backup nightly')
  })
})

describe('streamOf', () => {
  it('keeps only items with a layout, at most STREAM_CAP', () => {
    const many = Array.from({ length: 200 }, (_, i) => it0({ id: `b${i}`, kind: i % 2 ? 'boss' : 'stat', text: i % 2 ? `A thought number ${i} worth chewing on.` : '', ...(i % 2 ? { actions: [{ id: 'go', label: 'Go' }] } : {}) }))
    const out = streamOf(many)
    expect(out.length).toBe(STREAM_CAP)
    expect(out.every((i) => i.kind === 'boss')).toBe(true)
    expect(STREAM_CAP).toBeLessThanOrEqual(60)
  })
})

describe('plainLine paths', () => {
  it('drops file paths but keeps before/after words', async () => {
    const { plainLine } = await import('./foryou-format')
    expect(plainLine('Fixed src/ui/foryou.tsx and ~/x/y today')).toBe('Fixed and today')
    expect(plainLine('before/after shots')).toBe('before/after shots')
  })
})

const short = (id: string, text: string, o: Partial<ForYouItem> = {}) => it0({ id, kind: 'insight', text, ...o })

describe('junk filters', () => {
  it('strips [tags] and shouted prefixes from subjects', () => {
    expect(cleanSubject('[weevboss] ACTION — HOW TO TAKE OVER PARIS EP01 — brief…')).toBe('How to take over paris ep01 — brief')
    expect(cleanSubject('FYI: the pod is down')).toBe('the pod is down')
    expect(cardLine(it0({ kind: 'mail', title: '[x] URGENT - Invoice from Hostinger' }))).toBe('Invoice from Hostinger')
  })
  it('hides automation lifecycle notices and bare titles', () => {
    const out = streamOf([
      it0({ id: 'a', kind: 'boss', text: 'The automation "Index your content ideas" is wrapped up.' }),
      it0({ kind: 'boss', id: 'auto:go:1', text: 'The automation "X" is running.' }),
      short('c', 'content ideas index'),
      short('d', 'Shorts posted before 9 am get twice the reach of evening ones.'),
    ])
    expect(out.map((i) => i.id)).toEqual(['d'])
  })
  it('repeated advice of one family shows once', () => {
    const adv = (id: string, who: string) => it0({ id, kind: 'improve', text: `“${who}” is doing a simple task on Opus; Sonnet would do it for less.` })
    expect(streamOf([adv('cost:model:a', 'nav'), adv('cost:model:b', 'ads')]).map((i) => i.id)).toEqual(['cost:model:a'])
  })
  it('a session result says its outcome, not its bare title', () => {
    expect(cardLine(it0({ kind: 'session', tone: 'result', title: 'content ideas index', text: 'I built an index of 40 content ideas, ranked by effort.' }))).toBe('Built an index of 40 content ideas, ranked by effort.')
  })
  it('dedupes contained text and same subjects, keeping the richest', () => {
    const out = streamOf([
      short('n', 'weevils install drop-off is down to twelve percent this week'),
      it0({ id: 'r', kind: 'session', tone: 'result', title: 'Install drop-off', text: 'The weevils install drop-off is down to twelve percent this week, after the new onboarding.', media }),
      it0({ id: 'm1', kind: 'mail', title: 'Invoice from Hostinger for November' }),
      it0({ id: 'm2', kind: 'mail', title: '[billing] Invoice from Hostinger for November', actions: [{ id: 'pay', label: 'Pay' }] }),
    ])
    expect(out.map((i) => i.id).sort()).toEqual(['m2', 'r'])
  })
})

describe('rhythm', () => {
  it('interleaves rich and short items inside a window', () => {
    const s = (id: string) => short(id, `A plain sentence about item ${id} worth reading.`)
    const r = (id: string) => it0({ id, kind: 'media', media })
    const out = mixDepths([s('1'), s('2'), s('3'), r('4'), r('5'), s('6')])
    expect(out.map(richItem)).toEqual([false, true, false, true, false, false])
    expect(new Set(out.map((i) => i.id)).size).toBe(6)
  })
  it('no two neighbours share a look', () => {
    const items = [short('a', 'One learned thing here.'), short('b', 'Another learned thing.'), it0({ id: 'c', kind: 'boss', text: 'A thought to chew.' }), it0({ id: 'd', kind: 'boss', text: 'Another thought.' })]
    const looks = looksOf(items)
    for (let i = 1; i < looks.length; i++) expect(looks[i]).not.toBe(looks[i - 1])
  })
  it('a tap reveals one more line from the body', () => {
    expect(detailLine(short('x', 'Shorts posted early do better.', { body: 'Posted before 9 am they got 2.1x the views over 30 days.' }))).toBe('Posted before 9 am they got 2.1x the views over 30 days.')
  })
})

describe('results first', () => {
  it('a session sentence and the media it posted are one card: the media, captioned with the words', () => {
    const s = it0({ id: 's', kind: 'session', tone: 'result', sessionId: 'S', text: 'I built the new menu for the café, live on staging now.' })
    const v = it0({ id: 'v', kind: 'media', sessionId: 'S', text: '', media })
    const out = streamOf([s, v])
    expect(out.map((i) => i.id)).toEqual(['v'])
    expect(out[0].title).toBe('Built the new menu for the café, live on staging now.')
  })
  it('outcome words, not a diary', () => {
    expect(shortLine("I couldn't run the install test because Docker was blocked.")).toBe("Couldn't run the install test because Docker was blocked.")
  })
  it('at most three sentence-only cards per screen', () => {
    const many = Array.from({ length: 6 }, (_, i) => it0({ id: `l${i}`, kind: 'insight', text: `Lesson number ${i} learned the hard way today.` }))
    expect(streamOf(many).length).toBe(3)
  })
})

describe('figures spread out', () => {
  it('one figure card per screen, the others further down', () => {
    const num = (id: string) => it0({ id, kind: 'milestone', text: `${id.length + 40} commits this week, vs 12 last week.` })
    const act = (id: string) => it0({ id, kind: 'boss', text: `Something to decide about item ${id} today.`, actions: [{ id: 'a', label: 'Go' }] })
    const out = streamOf([num('n1'), num('n22'), num('n333'), act('a1'), act('a2'), act('a3'), act('a4'), act('a5'), act('a6')]).map((i) => i.id)
    expect(out.indexOf('n22') - out.indexOf('n1')).toBeGreaterThanOrEqual(6)
    expect(out).toHaveLength(9)
  })
})
