import { Icon } from './icons'
import { ThinkEditor, ThinkText } from './think-editor'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import { useT } from '../i18n'
import M from '../i18n/think'
import { useApp } from './app-context'
import { Composer, Messages } from './bits'
import type { Message } from '../../shared/api'
import { OutboxStatus } from './outbox-status'
import { loadPayload, storePayload, removePayload } from '../outbox-payload'
import { usePageChrome } from './shell'
import { validCamera, emptyBoard, worldPoint, zoomAt, viewportContext, validateBoard, type ThinkBoard, type ThinkCamera, type ThinkObject } from '../../shared/think'
import './think.css'
const draftKey=()=>{try{let id=sessionStorage.getItem('think-client');if(!id){id=crypto.randomUUID();sessionStorage.setItem('think-client',id)}return `think-draft-v1:${id}`}catch{return `think-draft-v1:${crypto.randomUUID()}`}}
function ThinkChrome({page}:{page:React.RefObject<HTMLElement|null>}){usePageChrome('agent',page);return null}
export function ThinkPage({enabled=true}:{enabled?:boolean}={}){
 // A preparation started before off/on must not dispatch later without fresh intent.
 const availability=useRef({enabled,epoch:0})
 if(availability.current.enabled!==enabled)availability.current={enabled,epoch:availability.current.epoch+1}
 const [key]=useState(draftKey)
 const t=useT(M),{back,snap,push}=useApp()
 const root=useRef<HTMLElement>(null),canvas=useRef<HTMLDivElement>(null)
 const [board,setBoard]=useState<ThinkBoard>(emptyBoard), live=useRef(board)
 const [ready,setReady]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('')
 const [camera,setCamera]=useState<ThinkCamera>(()=>{try{const value=JSON.parse(localStorage.getItem('think-camera')||'null');return validCamera(value)?value:{x:80,y:80,zoom:1}}catch{return{x:80,y:80,zoom:1}}})
 const cam=useRef(camera);cam.current=camera
 const [selected,setSelected]=useState<string[]>([]),[editing,setEditing]=useState<string|null>(null),[chat,setChat]=useState(false),[target,setTarget]=useState('')
 const [watch,setWatch]=useState<{id:string;at:number}|null>(null),[replies,setReplies]=useState<Message[]>([])
 useEffect(()=>{if(!enabled||!watch)return;let cancelled=false;const refresh=async()=>{if(!availability.current.enabled)return;try{const d=await api.session(watch.id);if(!cancelled)setReplies(d.messages.filter(m=>m.at>=watch.at))}catch{}};void refresh();const interval=setInterval(()=>void refresh(),3000);return()=>{cancelled=true;clearInterval(interval)}},[watch,enabled])
 useEffect(()=>{void loadPayload(key+':request').then(value=>{const r=value as {target?:string}|undefined;if(r?.target)setTarget(r.target)}).catch(()=>undefined)},[key])
 const [menu,setMenu]=useState(false),[objectMenu,setObjectMenu]=useState<string|null>(null),[moving,setMoving]=useState<string|null>(null)
 const [viewSize,setViewSize]=useState({width:window.innerWidth,height:window.visualViewport?.height??window.innerHeight})
 useEffect(()=>{const resize=()=>setViewSize({width:window.innerWidth,height:window.visualViewport?.height??window.innerHeight});window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);return()=>{window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize)}},[])
 const [layoutBusy,setLayoutBusy]=useState(false)
 const [relation,setRelation]=useState('')
 const [proposal,setProposal]=useState<{base:string;objects:ThinkObject[]}|null>(null)
 const editHistory=useRef<string|null>(null)
 const history=useRef<ThinkBoard[]>([]),future=useRef<ThinkBoard[]>([]),recent=useRef<unknown[]>([])
 const dirty=useRef(false),blocked=useRef(false),busy=useRef(false),pendingLocal=useRef(Promise.resolve()),alive=useRef(true)
 const active=()=>alive.current&&availability.current.enabled
 const prepared=(epoch:number)=>active()&&availability.current.epoch===epoch
 const persistLocal=(next:ThinkBoard)=>{pendingLocal.current=pendingLocal.current.then(()=>storePayload(key,next)).then(()=>undefined).catch(()=>{setError(t.error)})}
 const record=(action:string,id?:string)=>{recent.current=[...recent.current.slice(-11),{action,id,at:Date.now()}]}
 const update=(next:ThinkBoard,remember=true)=>{
  if(!active())return
  if(remember){history.current.push(structuredClone(live.current));future.current=[]}
  live.current=next;dirty.current=true;setBoard(next);setStatus(t.saving)
  persistLocal(next)
 }
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const started=useRef(false)
 useEffect(()=>{if(!enabled||started.current)return;started.current=true;void Promise.allSettled([api.think(),loadPayload(key)]).then(([remote,local])=>{
  const saved=remote.status==='fulfilled'?remote.value:null,draft=local.status==='fulfilled'?local.value:null
  let next=saved
  if(draft){try{validateBoard(draft);next=draft;dirty.current=true;if(saved&&draft.revision!==saved.revision){blocked.current=true;setError(t.conflict)}else setStatus(t.local)}catch{setError(t.badImport)}}
  if(!next){setError(t.error);return}
  if(!saved)setError(t.error)
  live.current=next;setBoard(next);setReady(true)
 }).catch(()=>setError(t.error))
 },[enabled])
 useEffect(()=>{if(!enabled)return
 const timer=setInterval(async()=>{
  if(!active()||!dirty.current||busy.current||blocked.current||pointers.current.size)return
  busy.current=true
  const epoch=availability.current.epoch
  try{await pendingLocal.current;if(!prepared(epoch))return;const sending=live.current;const saved=await api.saveThink(sending)
   if(live.current===sending){dirty.current=false;live.current=saved;if(alive.current){setBoard(saved);setStatus(t.saved);setError(e=>e===t.error?'':e)}pendingLocal.current=pendingLocal.current.then(()=>removePayload(key));await pendingLocal.current}
   else{live.current={...live.current,revision:saved.revision};if(alive.current)setBoard(live.current);const current=live.current;pendingLocal.current=pendingLocal.current.then(()=>storePayload(key,current));await pendingLocal.current}
  }catch(e){if(e instanceof ApiError&&e.status===409){blocked.current=true;setError(t.conflict)}else setError(t.error)}finally{busy.current=false}
 },800)
 return()=>clearInterval(timer)
 },[enabled])
 useEffect(()=>{try{localStorage.setItem('think-camera',JSON.stringify(camera))}catch{}},[camera])
 const change=(id:string,patch:Partial<ThinkObject>,remember=true)=>{update({...live.current,objects:live.current.objects.map(o=>o.id===id?{...o,...patch,updatedAt:Date.now()}:o)},remember)}
 const add=(type:'text'|'image',content='',point={x:24,y:80})=>{if(!active())return;const p=worldPoint(point,cam.current),id=crypto.randomUUID();update({...live.current,objects:[...live.current.objects,{id,type,...p,width:Math.min(480,Math.max(240,viewSize.width-48))/cam.current.zoom,height:type==='image'?210:28,content,source:'',updatedAt:Date.now()}]});setSelected([id]);if(type==='text')setEditing(id);record('create',id)}
 const undo=(redo=false)=>{if(!active())return;const from=redo?future.current:history.current,to=redo?history.current:future.current;const previous=from.pop();if(!previous)return;to.push(structuredClone(live.current));update({...previous,revision:live.current.revision},false);record(redo?'redo':'undo')}
 useEffect(()=>{const keydown=(e:KeyboardEvent)=>{if(!active())return;if([...document.querySelectorAll('.page,.think-page')].at(-1)!==root.current)return;if((e.metaKey||e.ctrlKey)&&['z','y'].includes(e.key.toLowerCase())&&!(e.target instanceof HTMLTextAreaElement)&&!(e.target instanceof HTMLInputElement)){e.preventDefault();undo(e.shiftKey||e.key.toLowerCase()==='y')}};window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown)},[])
 const pointers=useRef(new Map<number,{x:number;y:number}>()),gesture=useRef<any>(null)
 useEffect(()=>{if(enabled)return
  // A drag can be paused before pointerup: retain its last position locally and release the gesture.
  const g=gesture.current
  if(g?.kind==='object'&&g.moved){history.current.push(g.before);future.current=[];dirty.current=true;persistLocal(live.current);setStatus(t.saving)}
  pointers.current.clear();gesture.current=null;setMoving(null)
 },[enabled])
 const relative=(e:{clientX:number;clientY:number})=>{const r=canvas.current!.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
 const down=(e:React.PointerEvent,id?:string)=>{
  if(!active())return
  if(!id&&moving)id=moving
  setObjectMenu(null);setMenu(false)
  if(e.button!==0&&e.button!==1)return
  const p=relative(e);pointers.current.set(e.pointerId,p);e.currentTarget.setPointerCapture(e.pointerId)
  if(pointers.current.size===2){const previous=gesture.current;if(previous?.kind==='object'&&previous.moved){history.current.push(previous.before);future.current=[];update(live.current,false)}const [a,b]=[...pointers.current.values()];gesture.current={kind:'pinch',distance:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},camera:cam.current};return}
  const obj=live.current.objects.find(o=>o.id===id)
  gesture.current={kind:obj?'object':'pan',p,camera:cam.current,obj,moved:false,blank:e.target===canvas.current,hitId:(e.target as HTMLElement).closest('[data-think-id]')?.getAttribute('data-think-id'),before:structuredClone(live.current)}
 }
 const move=(e:React.PointerEvent)=>{
  if(!active())return
  if(!pointers.current.has(e.pointerId))return;const p=relative(e);pointers.current.set(e.pointerId,p);const g=gesture.current;if(!g)return
  if(g.kind==='pinch'&&pointers.current.size===2){const[a,b]=[...pointers.current.values()];const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};const z=zoomAt(g.camera,g.mid,g.camera.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,g.distance));setCamera({...z,x:z.x+mid.x-g.mid.x,y:z.y+mid.y-g.mid.y});return}
  if(g.kind==='pinch')return // Wait until all fingers lift before starting another gesture.
  const dx=p.x-g.p.x,dy=p.y-g.p.y;if(Math.hypot(dx,dy)<5&&!g.moved)return;g.moved=true
  if(g.kind==='pan')setCamera({...g.camera,x:g.camera.x+dx,y:g.camera.y+dy})
  if(g.kind==='object'){const next={...live.current,objects:live.current.objects.map(o=>o.id===g.obj.id?{...o,x:g.obj.x+dx/cam.current.zoom,y:g.obj.y+dy/cam.current.zoom}:o)};live.current=next;setBoard(next)}
 }
 const up=(e:React.PointerEvent,cancel=false)=>{
  if(!active())return
  pointers.current.delete(e.pointerId);const g=gesture.current;if(pointers.current.size)return;gesture.current=null
  if(g?.kind==='object'&&g.moved){history.current.push(g.before);future.current=[];update(live.current,false);record('move',g.obj.id);setMoving(null)}
  if(!cancel&&g?.kind==='pan'&&!g.moved&&g.hitId){setSelected([g.hitId]);if(live.current.objects.find(o=>o.id===g.hitId)?.type==='text'){editHistory.current=null;setEditing(g.hitId)}}
  if(!cancel&&g?.kind==='pan'&&!g.moved&&g.blank){setEditing(null);add('text','',relative(e))}
 }
 useEffect(()=>{const el=canvas.current;if(!el)return;const wheel=(e:WheelEvent)=>{if(!active())return;e.preventDefault();if(e.ctrlKey||e.metaKey)setCamera(c=>zoomAt(c,relative(e),c.zoom*Math.exp(-e.deltaY*.01)));else setCamera(c=>({...c,x:c.x-e.deltaX,y:c.y-e.deltaY}))};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel)},[ready])
 const context=()=>{const r=canvas.current?.getBoundingClientRect();return viewportContext(live.current,cam.current,r?.width??0,r?.height??0,selected,recent.current)}
 const exportBoard=()=>{if(!ready)return;const url=URL.createObjectURL(new Blob([JSON.stringify(live.current,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='think.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 const file=useRef<HTMLInputElement>(null),importFile=useRef<HTMLInputElement>(null)
 const send=async(text:string)=>{
  const epoch=availability.current.epoch
  const requireActive=()=>{if(!prepared(epoch))throw Error(t.paused)}
  requireActive()
  if(!target)throw Error(t.target)
  const requestKey=key+':request'
  let frozen=await loadPayload(requestKey) as {target:string;text:string;body:string}|undefined
  requireActive()
  if(frozen&&(frozen.text!==text||frozen.target!==target))throw Error(t.pending)
  if(!frozen){frozen={target,text,body:t.sharedContext(text,JSON.stringify(context()))};await storePayload(requestKey,frozen)}
  requireActive()
  setWatch({id:frozen.target,at:Date.now()});await api.send(frozen.target,frozen.body);await removePayload(requestKey);record('send',target);setStatus(t.sent)
 }
 const aiPreview=async()=>{
  if(!active()||layoutBusy)return
  if(dirty.current||busy.current){setError(t.aiWait);return}
  setLayoutBusy(true)
  const base=JSON.stringify(live.current),r=canvas.current!.getBoundingClientRect();setStatus(t.organising)
  try{const result=await api.thinkLayout({revision:live.current.revision,camera:cam.current,width:r.width,height:r.height,selected});if(JSON.stringify(live.current)!==base){setError(t.stale);return}setProposal({base,objects:live.current.objects.filter(o=>result.positions.some(p=>p.id===o.id)).map(o=>{const p=result.positions.find(p=>p.id===o.id)!;return {...o,x:p.x,y:p.y}})});record('layout-proposal');setStatus('')}catch{setError(t.aiFailed)}finally{setLayoutBusy(false);setStatus(dirty.current?t.saving:t.saved)}
 }
 const preview=()=>{const objects=live.current.objects.filter(o=>!selected.length||selected.includes(o.id));const p=worldPoint({x:60,y:60},cam.current);setProposal({base:JSON.stringify(live.current),objects:objects.map((o,i)=>({...o,x:p.x+(i%3)*340,y:p.y+Math.floor(i/3)*270}))})}
 return <section ref={root} hidden={!enabled} inert={!enabled} aria-hidden={!enabled||undefined} onClickCapture={e=>{if(!active()){e.preventDefault();e.stopPropagation()}}} className="think-page tone" style={{'--c':'var(--agent)',display:enabled?undefined:'none'} as React.CSSProperties}>
  {enabled&&<ThinkChrome page={root}/>}
  <nav className="think-topbar"><button onClick={back} aria-label={t.back}>←</button><strong>{t.title}</strong><span className="think-status" role="status">{status}</span>{editing?<button onClick={()=>setEditing(null)}>{t.done}</button>:<><button aria-label={t.note} disabled={!ready} onClick={()=>add('text')}>＋</button><button aria-label={t.chat} onClick={()=>setChat(!chat)}><Icon name="bubble"/></button></>}<button aria-label={t.options} aria-expanded={menu} onClick={()=>{setMenu(!menu);setObjectMenu(null)}}>⋯</button></nav>
  {menu&&<div className="think-menu" role="dialog" aria-label={t.options}><button disabled={!ready} onClick={()=>{file.current?.click();setMenu(false)}}>{t.image}</button><button disabled={!history.current.length} onClick={()=>undo()}>{t.undo}</button><button disabled={!future.current.length} onClick={()=>undo(true)}>{t.redo}</button><button onClick={()=>{setCamera({x:24,y:40,zoom:1});setMenu(false)}}>{t.fit}</button><button onClick={exportBoard}>{t.export}</button><button disabled={!ready} onClick={()=>importFile.current?.click()}>{t.import}</button><button onClick={()=>{preview();setMenu(false)}}>{t.organise}</button><div><button onClick={()=>setCamera(c=>zoomAt(c,{x:160,y:120},c.zoom/1.25))}>−</button><span>{Math.round(camera.zoom*100)}%</span><button onClick={()=>setCamera(c=>zoomAt(c,{x:160,y:120},c.zoom*1.25))}>＋</button></div></div>}
  {error&&<div role="alert" className="think-error">{error}<button onClick={exportBoard}>{t.export}</button><button onClick={()=>{void api.think().then(async b=>{await removePayload(key);blocked.current=false;dirty.current=false;live.current=b;setBoard(b);setError('');setReady(true);history.current=[];future.current=[]})}}>{t.reload}</button></div>}
  <div ref={canvas} className="think-canvas" onPointerDown={e=>{if(ready&&!pointers.current.has(e.pointerId)&&!(e.target as HTMLElement).closest('button,input,textarea,a'))down(e)}} onPointerMove={move} onPointerUp={e=>up(e)} onPointerCancel={e=>up(e,true)}>
   {!board.objects.length&&<p className="think-empty">{t.empty}</p>}
   <div className="think-world" style={{transform:`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`}}>
    <svg className="think-edges">{board.edges.map(edge=>{const a=board.objects.find(o=>o.id===edge.from),b=board.objects.find(o=>o.id===edge.to);return a&&b?<g key={edge.id}><line x1={a.x+a.width/2} y1={a.y+a.height/2} x2={b.x+b.width/2} y2={b.y+b.height/2}/><text x={(a.x+b.x)/2+140} y={(a.y+b.y)/2+70}>{edge.label}</text></g>:null})}</svg>
    {board.objects.map(o=><article key={o.id} data-think-id={o.id} className={`think-object ${selected.includes(o.id)?'selected':''}`} style={{left:o.x,top:o.y,width:o.width,height:o.type==='image'?o.height:undefined,visibility:editing===o.id?'hidden':undefined}} onContextMenu={e=>{e.preventDefault();setSelected([o.id]);setObjectMenu(o.id);setEditing(null)}} onClick={e=>{e.stopPropagation();setSelected(e.shiftKey?[...new Set([...selected,o.id])]:[o.id])}}>
      {o.type==='image'?<img draggable={false} src={o.content} alt={o.source} onPointerDown={e=>{e.stopPropagation();down(e,o.id)}}/>:<ThinkText text={o.content} width={o.width} onHeight={height=>{if(height!==o.height)change(o.id,{height},false)}} onEdit={()=>{editHistory.current=null;setEditing(o.id)}}/>}
    </article>)}
    {proposal?.objects.map(o=><div key={o.id} className="think-ghost" style={{left:o.x,top:o.y,width:o.width,height:o.height}}>{o.type==='text'?o.content:t.image}</div>)}
   </div>
  </div>
  {!editing&&board.objects.filter(o=>selected.includes(o.id)).map(o=>{const canvasTop=(canvas.current?.getBoundingClientRect().top??56)-(root.current?.getBoundingClientRect().top??0);return <button key={o.id} className="think-note-menu" aria-label={t.noteOptions} style={{left:Math.max(12,Math.min(viewSize.width-56,(o.x+o.width)*camera.zoom+camera.x-44)),top:Math.max(canvasTop+4,Math.min(viewSize.height-48,canvasTop+o.y*camera.zoom+camera.y-40))}} onClick={()=>setObjectMenu(objectMenu===o.id?null:o.id)}>⋯</button>})}
  {moving&&<div className="think-move-hint">{t.moveHint}<button onClick={()=>setMoving(null)}>{t.cancel}</button></div>}
  {objectMenu&&board.objects.filter(o=>o.id===objectMenu).map(o=><div className="think-menu" role="dialog" aria-label={t.noteOptions} key={o.id}><button onClick={()=>{setEditing(null);setMoving(o.id);setObjectMenu(null)}}>{t.move}</button><label>{t.width}<input type="range" aria-label={t.width} min="160" max="900" step="10" value={o.width} onChange={e=>change(o.id,{width:Number(e.target.value)})}/></label><label>{t.source}<input aria-label={t.source} value={o.source} onChange={e=>change(o.id,{source:e.target.value})}/></label>{/^https?:\/\//i.test(o.source)&&<a href={o.source} target="_blank" rel="noreferrer">{t.openSource}</a>}<label>{t.relation}<input aria-label={t.relation} value={relation} onChange={e=>setRelation(e.target.value)}/></label><select aria-label={t.link} value="" onChange={e=>{if(e.target.value)update({...live.current,edges:[...live.current.edges,{id:crypto.randomUUID(),from:o.id,to:e.target.value,label:relation.trim()||t.relation}]})}}><option value="">{t.link}</option>{board.objects.filter(n=>n.id!==o.id).map(n=><option key={n.id} value={n.id}>{n.type==='text'?n.content.slice(0,60):t.image}</option>)}</select>{board.edges.filter(edge=>edge.from===o.id||edge.to===o.id).map(edge=><label key={edge.id}><input aria-label={t.relation} value={edge.label} onChange={e=>update({...live.current,edges:live.current.edges.map(item=>item.id===edge.id?{...item,label:e.target.value}:item)})}/><button onClick={()=>update({...live.current,edges:live.current.edges.filter(item=>item.id!==edge.id)})}>{t.remove}</button></label>)}<button onClick={()=>{update({...live.current,objects:live.current.objects.filter(x=>x.id!==o.id),edges:live.current.edges.filter(x=>x.from!==o.id&&x.to!==o.id)});setObjectMenu(null)}}>{t.remove}</button></div>)}
  {editing&&board.objects.filter(o=>o.id===editing).map(o=>{const width=Math.min(viewSize.width-48,Math.max(320,o.width*camera.zoom));const canvasTop=(canvas.current?.getBoundingClientRect().top??56)-(root.current?.getBoundingClientRect().top??0);const top=Math.max(canvasTop+8,Math.min(canvasTop+o.y*camera.zoom+camera.y,viewSize.height-80));return <div key={o.id} className="think-edit-layer" style={{left:Math.max(24,Math.min(o.x*camera.zoom+camera.x,viewSize.width-width-24)),top}}><ThinkEditor value={o.content} width={width} maxHeight={Math.max(48,viewSize.height-top-24)} label={t.note} onFinish={()=>setEditing(null)} onChange={text=>{change(o.id,{content:text},editHistory.current!==o.id);editHistory.current=o.id}}/></div>})}
  {proposal&&<div className="think-tools"><span>{t.layout}</span><button onClick={()=>{if(pointers.current.size||JSON.stringify(live.current)!==proposal.base){setError(t.stale);return}update({...live.current,objects:live.current.objects.map(o=>proposal.objects.find(p=>p.id===o.id)??o)});setProposal(null)}}>{t.apply}</button><button onClick={()=>setProposal(null)}>{t.cancel}</button></div>}
  {chat&&<div className="think-chat"><p>{t.privacy}</p><button disabled={layoutBusy} onClick={()=>void aiPreview()}>{t.aiLayout}</button><select aria-label={t.target} value={target} onChange={e=>setTarget(e.target.value)}><option value="">{t.target}</option>{snap.sessions.filter(s=>!s.archived).map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select><Messages session plain messages={replies} author={snap.sessions.find(s=>s.id===watch?.id)?.tool??'codex'}/><Composer label={t.send} placeholder={t.request} onSend={send} disabled={!enabled||!target} sayErrors draftKey="think-request"/><OutboxStatus scope={target?`/api/sessions/${encodeURIComponent(target)}/`:'/api/think'}/>{target&&<button onClick={()=>push({kind:'session',id:target})}>{t.openConversation}</button>}</div>}
  <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>4e6||!['image/png','image/jpeg','image/webp','image/gif'].includes(f.type)){setError(t.invalid);return}const r=new FileReader();r.onerror=()=>setError(t.invalid);r.onload=()=>add('image',String(r.result));r.readAsDataURL(f);e.target.value=''}}/>
  <input hidden ref={importFile} type="file" accept="application/json" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>48*1024*1024){setError(t.badImport);return}try{const b=JSON.parse(await f.text());validateBoard(b);update({...b,revision:live.current.revision})}catch{setError(t.badImport)}e.target.value=''}}/>
 </section>
}
