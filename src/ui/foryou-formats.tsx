import { FeedRail } from './foryou-rail'
import { TranslationStatus } from './foryou-localization'
import { OutboxStatus } from './outbox-status'
import { api } from '../api'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ForYouItem, ForYouMedia, VisualProposal } from '../../shared/foryou'
import { useApp } from './app-context'
import { Shell } from './shell'
import { useForYou, type ForYouStore } from './foryou-store'
import { useLang, useT } from '../i18n'
import M from '../i18n/foryou-formats'
import './foryou-formats.css'
import { SaveMediaButton, useLongPressSave } from './save-media'

const tone = (slot: string) => ({ '--c': `var(--${slot})`, background: `var(--${slot})` }) as CSSProperties
/** Retry same-origin media with a fresh URL; never alter signed third-party URLs. */
function mediaAttempt(url: string, attempt: number) {
  if (!attempt) return url
  try {
    const parsed = new URL(url, location.href)
    if (parsed.origin !== location.origin) return url
    parsed.searchParams.set('retry', String(attempt))
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch { return url }
}
export function FullImage({ media, description }: { media: ForYouMedia; description: string }) {
  const { push } = useApp()
  const host = useRef<HTMLDivElement>(null)
  const target = { url: media.url, name: media.name, type: 'image' as const }
  const notOpen = useLongPressSave(host, target)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const t = useT(M)
  useEffect(() => { setFailed(false); setAttempt(0) }, [media.id, media.url])
  if (failed) return <div className="formats-media-error"><p role="alert">{t.imageUnavailable}</p><button type="button" onClick={() => { setAttempt(n => n + 1); setFailed(false) }}>{t.retryImage}</button></div>
  return <div ref={host} className="save-media-host formats-image-host"><button type="button" className="formats-image" onClickCapture={notOpen} onClick={() => push({ kind: 'media', url: media.url, type: 'image', name: description })} aria-label={`${t.open} · ${description}`}>
    <img key={`${media.id}:${media.url}:${attempt}`} src={mediaAttempt(media.url, attempt)} alt={description} loading="lazy" onError={() => setFailed(true)} />
  </button><SaveMediaButton target={target} /></div>
}

export function PreviewClip({ media, poster, title }: { media: ForYouMedia; poster?: string; title: string }) {
  const { push } = useApp()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const t = useT(M)
  useEffect(() => { setFailed(false); setAttempt(0) }, [media.id, media.url])
  if (failed) return <div className="formats-media-error"><p role="alert">{t.clipUnavailable}</p><button type="button" onClick={() => { setAttempt(n => n + 1); setFailed(false) }}>{t.retryClip}</button></div>
  return <div className="formats-clip save-media-host"><SaveMediaButton target={{ url: media.url, name: media.name, type: 'video' }} /><video key={`${media.id}:${media.url}:${attempt}`} controls playsInline preload="none" poster={poster} aria-label={title} src={mediaAttempt(media.url, attempt)} onError={() => setFailed(true)} /><button type="button" onClick={() => push({ kind: 'media', url: media.url, type: 'video', name: title })}>{t.openClip}</button></div>
}

export function PictureJourney({ media, frames, label }: { media: ForYouMedia[]; frames: VisualProposal['frames']; label?: string }) {
  const t = useT(M)
  const count = Math.min(media.length, frames.length)
  if (!count) return <p>{t.missing}</p>
  return <FeedRail label={label ?? t.storyTitle} slides={media.slice(0,count).map((m,n)=>({
    id:m.id,label:frames[n].title,content:<div className="formats-journey"><div className="formats-story-copy"><h3>{frames[n].title}</h3><p>{frames[n].description}</p></div><FullImage media={m} description={frames[n].description}/></div>
  }))}/>
}

export function ProposalView({ item, fy }: { item: ForYouItem; fy: ForYouStore }) {
  const t = useT(M)
  const [choice, setChoice] = useState(item.visualProposal?.selected ?? '')
  const p = item.visualProposal
  useEffect(() => setChoice(item.visualProposal?.selected ?? ''), [item.id, item.visualProposal?.selected])
  if (!p) return null
  const selected = p.options.find(o => o.id === choice)
  const pending = fy.acting(item.id)
  const sent = !!p.selected || fy.leftAs(item.id) === 'sent'
  return <section className="formats-proposal in">
    {/* i18n-ignore: project name */}
    <p className="meta">TLO</p><h2>{item.title}</h2><p>{item.text}</p>
    <TranslationStatus item={item} />
    <div className="formats-contact">{(item.media ?? []).map((m, n) => <figure key={m.id}><figcaption><strong>{n + 1} · {p.frames[n]?.title}</strong><p>{p.frames[n]?.description}</p></figcaption><FullImage media={m} description={p.frames[n]?.description ?? m.name} /></figure>)}</div>
    <fieldset disabled={pending || sent}><legend>{p.question}</legend><p>{p.recommendation}</p>
      <div className="formats-options">{p.options.map(o => <label key={o.id} className={choice === o.id ? 'selected' : ''}><input type="radio" name={`choice-${item.id}`} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} /><span><strong>{o.label}{o.recommended ? ` · ${t.recommended}` : ''}</strong><span>{o.description}</span></span></label>)}</div>
    </fieldset>
    <p className="meta">{p.caveat}</p>
    {selected && <details key={selected.id}><summary>{t.instruction}</summary><p className="formats-instruction">{selected.instruction}</p></details>}
    <button type="button" className="formats-send" disabled={!selected || pending || sent} onClick={() => selected && void fy.act(item.id, `choice:${selected.id}`)}>{sent ? t.sent : pending ? t.sending : t.send}</button>
    <OutboxStatus scope={`/api/foryou/${encodeURIComponent(item.id)}/act`} />
    {fy.error(item.id) && <p role="alert">{fy.error(item.id)}</p>}
  </section>
}

/** The same visual components inside existing feed cards; no new post, route or automatic playback. */
export function InlineMediaFormats({ item }: { item: ForYouItem }) {
  const t = useT(M)
  const allMedia = item.media ?? []
  const used = new Set<string>()
  const panels = (item.composition?.panels ?? []).map((panel, index) => {
    const media = allMedia.find(m => m.id === panel.mediaId)
    if (media) used.add(media.id)
    return { id: `${panel.mediaId}:${index}`, label: panel.title || media?.name || t.imageUnavailable, content: <div className="formats-journey"><div className="formats-story-copy">{panel.title && <h3>{panel.title}</h3>}{panel.text && <p>{panel.text}</p>}</div>{!media ? <p role="status">{t.imageUnavailable}</p> : media.type === 'video' ? <PreviewClip media={media} title={panel.title || media.name}/> : <FullImage media={media} description={panel.text || panel.title || media.name}/>}</div> }
  })
  const media = allMedia.filter(m => !used.has(m.id))
  const images = media.filter(m => m.type === 'image')
  const captions: Record<string, { title: string; description: string }> = {
    '341ba5be815fb245': { title: t.streetTitle, description: t.streetText },
    'b3fdac9f32927919': { title: t.cafeTitle, description: t.cafeText },
    'b442c5405b86603a': { title: t.alcoveTitle, description: t.alcoveText },
  }
  let knownPrefix = 0
  while (knownPrefix < images.length && captions[images[knownPrefix].id]) knownPrefix++
  const journey = knownPrefix > 1
  const rest = journey ? images.slice(knownPrefix) : images
  return <div className="formats-inline in">
    {!!panels.length && (item.composition?.layout === 'rail' ? <FeedRail label={item.title || t.browseImages} slides={panels}/> : <div className="formats-composition">{panels.map(panel=><div key={panel.id}>{panel.content}</div>)}</div>)}
    {journey && <PictureJourney media={images.slice(0,knownPrefix)} frames={images.slice(0,knownPrefix).map(m=>captions[m.id])} label={t.browseImages} />}
    {!!rest.length && <FeedRail label={item.title || t.browseImages} slides={rest.map(m=>({id:m.id,label:captions[m.id]?.title || m.name,content:<figure>{captions[m.id] && <figcaption>{captions[m.id].description}</figcaption>}<FullImage media={m} description={captions[m.id]?.description || item.title || item.text || t.step(images.indexOf(m)+1,images.length)} /></figure>}))}/>}
    {media.filter(m=>m.type==='video').map(m=><PreviewClip key={m.id} media={m} title={item.title || item.text || t.clipTitle} />)}
  </div>
}

export function FormatsPage() {
  const appLang = useLang()
  const t = useT(M)
  const fy = useForYou()
  const items = fy.feed?.items ?? []
  const media = items.flatMap(i => i.media ?? [])
  const alcove = media.find(m => m.id === 'b442c5405b86603a')
  const clip = media.find(m => m.id === '241bbd0062433326')
  const [example, setExample] = useState<ForYouItem | null>(null)
  useEffect(() => { let live = true; void api.foryouFormats().then(r => { if (live) setExample(r.proposal) }).catch(() => {}); return () => { live = false } }, [appLang])
  const proposal = items.find(i => i.visualProposal) ?? example
  const [kept, setKept] = useState(() => { try { return localStorage.getItem('weevils:format-choice') ?? '' } catch { return '' } })
  const keep = (id: string) => { setKept(id); try { localStorage.setItem('weevils:format-choice', id) } catch { /* storage unavailable */ } }
  const pick = (id: string) => <button type="button" className="formats-keep" aria-pressed={kept === id} onClick={() => keep(id)}>{kept === id ? t.kept : t.keep}</button>
  return <Shell slot="agent" kicker="weevils · TLO" title={t.title}>
    <div className="formats-gallery">
      <div className="in formats-intro"><p>{t.intro}</p><p className="meta">{t.preference}</p></div>
      <section className="band formats-section" style={tone('p3')}><div className="in">
        <p className="meta">{t.result}</p><div className="formats-result"><div><h2>{t.resultTitle}</h2><p>{t.resultText}</p>{pick('result')}</div>{alcove ? <FullImage media={alcove} description={t.resultText} /> : <p>{t.missing}</p>}</div>
      </div></section>
      <section className="band formats-section" style={tone('p6')}><div className="in">
        <p className="meta">{t.story}</p><h2>{t.storyTitle}</h2><p>{t.storyText}</p>
        {proposal?.visualProposal ? <PictureJourney media={proposal.media ?? []} frames={proposal.visualProposal.frames} /> : <p>{t.missing}</p>}{pick('story')}
      </div></section>
      <section className="band formats-section" style={tone('p10')}><div className="in">
        <p className="meta">{t.clip}</p><h2>{t.clipTitle}</h2><p>{t.clipText}</p>
        {clip ? <PreviewClip media={clip} poster={media.find(m => m.id === '341ba5be815fb245')?.url} title={t.clipTitle} /> : <p>{t.missing}</p>}{pick('clip')}
      </div></section>
      <section className="band formats-section" style={tone('agent')}><p className="in meta">{t.proposal}</p>{proposal ? <ProposalView item={proposal} fy={fy} /> : <p className="in">{t.missing}</p>}<div className="in">{pick('proposal')}</div></section>
    </div>
  </Shell>
}
