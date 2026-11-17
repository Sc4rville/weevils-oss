import {it,expect} from 'vitest'
import {proposeThinkLayout} from './think-ai.ts'
import {emptyBoard} from '../shared/think.ts'
it('rejects invented objects and accepts only placements for the supplied evidence',async()=>{const b=emptyBoard();b.objects=[{id:'note',type:'text',x:0,y:0,width:200,height:100,content:'Keep my exact words',source:'',updatedAt:1}];const input={camera:{x:0,y:0,zoom:1},width:500,height:500,selected:[]};await expect(proposeThinkLayout(b,input,async()=>JSON.stringify({positions:[{id:'fake',x:0,y:0}]}))).rejects.toThrow();const r=await proposeThinkLayout(b,input,async prompt=>{expect(prompt).toContain('Keep my exact words');return JSON.stringify({positions:[{id:'note',x:300,y:-200}]})});expect(r.evidence).toEqual(['note']);expect(b.objects[0].x).toBe(0);expect(b.objects[0].content).toBe('Keep my exact words')})
it('strips model fields that could overwrite user text, media or manual metadata',async()=>{
 const b=emptyBoard();b.objects=[{id:'note',type:'text',x:0,y:0,width:200,height:100,content:'Original text',source:'https://example.com',updatedAt:1}]
 const result=await proposeThinkLayout(b,{camera:{x:0,y:0,zoom:1},width:500,height:500,selected:[]},async()=>JSON.stringify({positions:[{id:'note',x:30,y:40,content:'REPLACED',type:'image',source:'https://untrusted.example',width:1}]}))
 expect(result.positions).toEqual([{id:'note',x:30,y:40}]);expect(b.objects[0].content).toBe('Original text')
})
