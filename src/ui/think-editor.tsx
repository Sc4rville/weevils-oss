import { useLayoutEffect, useRef } from 'react'
/** A native editor outside the gesture surface: selection, dictation and IME stay browser-owned. */
export function ThinkEditor({value,width,maxHeight,label,onChange,onFinish}:{value:string;width:number;maxHeight:number;label:string;onChange:(text:string)=>void;onFinish:()=>void}){
 const ref=useRef<HTMLTextAreaElement>(null)
 useLayoutEffect(()=>{const el=ref.current;if(!el)return;el.style.height='0px';el.style.height=`${Math.min(Math.max(28,el.scrollHeight),maxHeight)}px`},[value,width,maxHeight])
 return <textarea ref={ref} autoFocus className="think-native-editor" aria-label={label} value={value} style={{width,maxHeight}} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'&&!e.nativeEvent.isComposing)onFinish()}}/>
}

export function ThinkText({text,width,onHeight,onEdit}:{text:string;width:number;onHeight:(height:number)=>void;onEdit:()=>void}){
 const ref=useRef<HTMLDivElement>(null),report=useRef(onHeight);report.current=onHeight
 useLayoutEffect(()=>{const el=ref.current;if(!el)return;const measure=()=>{if(el.scrollHeight>0)report.current(Math.max(28,Math.ceil(el.scrollHeight)))};measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(el);return()=>observer?.disconnect()},[text,width])
 return <div ref={ref} className="think-text" onClick={onEdit}>{text}</div>
}
