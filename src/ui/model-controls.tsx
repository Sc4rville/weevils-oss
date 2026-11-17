import { useEffect, useRef, useState } from 'react'
import type { ModelControls, ModelSelection } from '../../shared/model-controls'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/model-controls'
import { Shell } from './shell'
import './model-controls.css'

/**
 * Model and effort as two rows of words, in the page flow (never an overlay). A tap is the whole action: the choice
 * goes to the thread's next-turn settings at once and is read back silently. The tapped word shows a pending mark
 * until the readback confirms it; a failed readback puts the confirmed word back and says so in one inline line.
 * Taps made while a change is in flight are kept in order: only the latest one is sent next.
 */
export function ModelPicker({id,onPicked}:{id:string;onPicked?:()=>void}) {
 const t=useT(M)
 const [data,setData]=useState<ModelControls|null>(null)
 const [pending,setPending]=useState<ModelSelection|null>(null)
 const [error,setError]=useState(''),[loadError,setLoadError]=useState('')
 const [reload,setReload]=useState(0)
 const want=useRef<ModelSelection|null>(null),running=useRef(false),alive=useRef(true)
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false}},[])
 useEffect(()=>{
  let stale=false;setLoadError('');setError('');setPending(null);setData(null)
  api.modelControls(id).then(d=>{if(!stale)setData(d)}).catch(e=>{if(!stale)setLoadError(e instanceof Error?e.message:t.failed)})
  return ()=>{stale=true}
 },[id,reload,t.failed])
 const flush=async()=>{
  running.current=true
  try{
   while(want.current){
    const sel=want.current;want.current=null
    try{const d=await api.setModelControls(id,sel);if(!alive.current)return;setData(d);if(!want.current)setPending(null)}
    catch(e){if(!alive.current)return;if(!want.current){setPending(null);setError(e instanceof Error?e.message:t.failed)}}
   }
  }finally{running.current=false}
 }
 const pick=(sel:ModelSelection)=>{
  setError('')
  if(!pending&&sel.model===data?.selected.model&&sel.effort===data?.selected.effort)return
  want.current=sel;setPending(sel);onPicked?.()
  if(!running.current)void flush()
 }
 const word=(value:string)=>t[value as 'low']??value
 const shown=pending??data?.selected
 const model=data?.models.find(m=>m.id===shown?.model)
 const chip=(on:boolean,busy:boolean)=>`word${on?' on':''}${busy?' pending':''}`
 return <div className="in model-controls">
  {data&&<>
   <div className="mc-row">
    <div className="words" role="group" aria-label={t.model}>
     {shown?.model&&!model&&<button type="button" className="word on" aria-pressed disabled>{shown.model}</button>}
     {data.models.map(m=>{const on=m.id===shown?.model,busy=on&&pending?.model===m.id&&pending.model!==data.selected.model
      return <button type="button" key={m.id} className={chip(on,busy)} aria-pressed={on} aria-busy={busy||undefined}
       onClick={()=>pick({model:m.id,effort:m.efforts.includes(shown?.effort??'')?shown!.effort!:m.defaultEffort??m.efforts[0]??''})}>{m.label}</button>})}
    </div>
   </div>
   {model&&model.efforts.length>0&&<div className="mc-row">
    <div className="words" role="group" aria-label={t.effort}>
     {model.efforts.map(e=>{const on=e===shown?.effort,busy=on&&!!pending&&(pending.effort!==data.selected.effort||pending.model!==data.selected.model)
      return <button type="button" key={e} className={chip(on,busy)} aria-pressed={on} aria-busy={busy||undefined}
       onClick={()=>pick({model:model.id,effort:e})}>{word(e)}</button>})}
    </div>
   </div>}
   {error&&<p className="meta mc-error" role="alert">! {error}</p>}
  </>}
  {loadError&&<><p className="meta mc-error" role="alert">! {loadError}</p>
   <button type="button" className="link" onClick={()=>setReload(n=>n+1)}>{t.reload}</button></>}
 </div>
}
export function ModelControlsPage({id}:{id:string}) {
 const t=useT(M)
 return <Shell slot="agent" kicker="weevils" title={t.title}><ModelPicker key={id} id={id}/></Shell>
}
