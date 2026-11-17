export interface ThinkObject { id: string; type: 'text' | 'image'; x: number; y: number; width: number; height: number; content: string; source: string; updatedAt: number }
export interface ThinkEdge { id: string; from: string; to: string; label: string }
export interface ThinkBoard { version: 1; revision: number; objects: ThinkObject[]; edges: ThinkEdge[] }
export interface ThinkCamera { x: number; y: number; zoom: number }
export const validCamera = (value: unknown): value is ThinkCamera => {
 const c=value as ThinkCamera
 return !!c && [c.x,c.y,c.zoom].every(Number.isFinite) && c.zoom>=.1 && c.zoom<=4
}
export const emptyBoard = (): ThinkBoard => ({ version: 1, revision: 0, objects: [], edges: [] })
export const worldPoint = (p: {x:number;y:number}, c: ThinkCamera) => ({ x: (p.x-c.x)/c.zoom, y: (p.y-c.y)/c.zoom })
export function zoomAt(c: ThinkCamera, p: {x:number;y:number}, zoom: number): ThinkCamera {
  const w = worldPoint(p,c); const z = Math.min(4,Math.max(.1,zoom))
  return { x:p.x-w.x*z,y:p.y-w.y*z,zoom:z }
}
export function viewportContext(b: ThinkBoard,c: ThinkCamera,width:number,height:number,selected:string[],recent:unknown[]) {
  const p=worldPoint({x:0,y:0},c), q=worldPoint({x:width,y:height},c)
  const visible=b.objects.filter(o=>o.x+o.width>=p.x&&o.y+o.height>=p.y&&o.x<=q.x&&o.y<=q.y)
  const ids=new Set([...visible.map(o=>o.id),...selected])
  return { boardRevision:b.revision, bounds:{left:p.x,top:p.y,right:q.x,bottom:q.y},viewport:{width,height},zoom:c.zoom,detail:c.zoom<.45?'groups':'local',selected,objects:b.objects.filter(o=>ids.has(o.id)).map(o=>({...o,content:o.type==='image'?'[Image: visual content not captured]':o.content})),relationships:b.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),recent:recent.slice(-12),capture:'No viewport screenshot supplied' }
}
export function validateBoard(v: unknown): asserts v is ThinkBoard {
 const b=v as ThinkBoard
 if(!b||b.version!==1||!Number.isSafeInteger(b.revision)||b.revision<0||!Array.isArray(b.objects)||b.objects.length>2000||!Array.isArray(b.edges)||b.edges.length>5000) throw Error('Invalid board') // i18n-ignore: internal validation code, translated at the UI boundary
 const ids=new Set<string>()
 for(const o of b.objects){
  if(!o||typeof o.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(o.id)||ids.has(o.id)||!['text','image'].includes(o.type)||![o.x,o.y,o.width,o.height,o.updatedAt].every(Number.isFinite)||Math.abs(o.x)>1e7||Math.abs(o.y)>1e7||o.width<20||o.width>10000||o.height<20||o.height>10000||typeof o.content!=='string'||o.content.length>6e6||typeof o.source!=='string'||o.source.length>2000) throw Error('Invalid object') // i18n-ignore: internal validation code, translated at the UI boundary
  if(o.type==='image'&&!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(o.content))throw Error('Invalid image') // i18n-ignore: internal validation code, translated at the UI boundary
  ids.add(o.id)
 }
 const edges=new Set<string>();for(const e of b.edges){if(!e||typeof e.id!=='string'||edges.has(e.id)||!ids.has(e.from)||!ids.has(e.to)||typeof e.label!=='string'||e.label.length>500)throw Error('Invalid relationship');edges.add(e.id)} // i18n-ignore: internal validation code, translated at the UI boundary
}
