import {describe,it,expect} from 'vitest'
import {emptyBoard,worldPoint,zoomAt,viewportContext,validateBoard} from './think.ts'
describe('Think coordinates and evidence',()=>{
 it('keeps the world point under the pointer while zooming, including negative coordinates',()=>{const c={x:125,y:-300,zoom:.4},p={x:13,y:555};expect(worldPoint(p,zoomAt(c,p,2.3))).toEqual(worldPoint(p,c))})
 it('clamps zoom and keeps semantic content when zoomed out',()=>{const b=emptyBoard();b.objects.push({id:'a',type:'text',x:-10,y:-10,width:100,height:100,content:'Remember the launch decision',source:'',updatedAt:1});const ctx=viewportContext(b,{x:0,y:0,zoom:.1},500,400,[],[]);expect(ctx.objects[0].content).toContain('launch decision');expect(ctx.detail).toBe('groups');expect(ctx.bounds.right).toBe(5000);expect(zoomAt({x:0,y:0,zoom:1},{x:10,y:10},0).zoom).toBe(.1)})
 it('rejects duplicate IDs, unsafe media and broken relationships',()=>{const b=emptyBoard();b.objects.push({id:'a',type:'image',x:0,y:0,width:100,height:100,content:'https://tracker.example/image',source:'',updatedAt:1});expect(()=>validateBoard(b)).toThrow();b.objects[0].type='text';b.edges.push({id:'e',from:'a',to:'missing',label:'depends on'});expect(()=>validateBoard(b)).toThrow()})
})
