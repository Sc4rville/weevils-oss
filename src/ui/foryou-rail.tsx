import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import M from '../i18n/foryou-rail'
import { Icon } from './icons'
import './foryou-rail.css'
export interface FeedSlide { id: string; label: string; content: ReactNode }
/** Native scrolling keeps vertical reading, media controls and every slide's DOM alive. */
export function FeedRail({ label, slides }: { label: string; slides: FeedSlide[] }) {
 const t=useT(M), id=useId(), ref=useRef<HTMLDivElement>(null), scope=useRef<HTMLElement>(null)
 const [selected,setSelected]=useState(slides[0]?.id)
 const index=Math.max(0,slides.findIndex(s=>s.id===selected))
 const many=slides.length>1
 useEffect(()=>{
  const el=scope.current;if(!el)return
  // Motion listens on ancestor DOM nodes, before React's delegated handlers.
  const claim=(e:PointerEvent)=>e.stopPropagation()
  el.addEventListener('pointerdown',claim)
  return()=>el.removeEventListener('pointerdown',claim)
 },[!!slides.length])
 const move=(n:number)=>{
  const el=ref.current;if(!el)return
  n=Math.max(0,Math.min(slides.length-1,n))
  const target=el.children[n] as HTMLElement|undefined;if(!target)return
  setSelected(slides[n].id)
  const left=el.scrollLeft+target.getBoundingClientRect().left-el.getBoundingClientRect().left
  const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({left,behavior:reduced?'instant':'smooth'})
 }
 const track=()=>{
  const el=ref.current;if(!el)return
  const left=el.getBoundingClientRect().left
  let closest=0,distance=Infinity
  Array.from(el.children).forEach((child,n)=>{const d=Math.abs(child.getBoundingClientRect().left-left);if(d<distance){closest=n;distance=d}})
  if(slides[closest])setSelected(slides[closest].id)
 }
 if(!slides.length)return null
 return <section ref={scope} className="fy-rail" aria-label={label} aria-roledescription={many?t.carousel:undefined}>
  <div id={id} ref={ref} className="fy-rail-track" tabIndex={many?0:undefined} role="group" aria-label={label} onScroll={track} onKeyDown={e=>{
   if(e.target!==e.currentTarget||e.altKey||e.ctrlKey||e.metaKey)return
   const target=e.key==='ArrowRight'?index+1:e.key==='ArrowLeft'?index-1:e.key==='Home'?0:e.key==='End'?slides.length-1:null
   if(target===null)return
   e.preventDefault();e.stopPropagation();move(target)
  }}>
   {slides.map((slide,n)=><div className="fy-rail-slide" key={slide.id} role="group" aria-current={n===index?true:undefined} aria-label={`${t.position(n+1,slides.length)} · ${slide.label}`}>{slide.content}</div>)}
  </div>
  {/* Short: ‹ 2 / 3 ›, the words stay for screen readers. */}
  {many&&<div className="fy-rail-controls"><button type="button" aria-controls={id} aria-label={t.previous} disabled={index===0} onClick={()=>move(index-1)}><Icon name="chevron" dir="left"/></button><span className="meta" aria-live="polite" aria-atomic="true" aria-label={t.position(index+1,slides.length)}>{index+1} / {slides.length}</span><button type="button" aria-controls={id} aria-label={t.next} disabled={index===slides.length-1} onClick={()=>move(index+1)}><Icon name="chevron" dir="right"/></button></div>}
 </section>
}
