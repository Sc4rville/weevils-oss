import { expect, it } from 'vitest'
import { splitVoiceChunk } from './voice-recordings'
it('preserves every byte of a large delayed recorder event while keeping uploads below the body limit',async()=>{
 const bytes=new Uint8Array(9*1024*1024+37)
 for(let i=0;i<bytes.length;i++)bytes[i]=i%251
 const original=new Blob([bytes],{type:'audio/mp4'})
 const parts=splitVoiceChunk(original)
 expect(parts).toHaveLength(19)
 expect(parts.every(p=>p.size<=512*1024)).toBe(true)
 expect(parts.every(p=>p.type==='audio/mp4')).toBe(true)
 const rebuilt=new Uint8Array(await new Blob(parts).arrayBuffer())
 expect(rebuilt.length).toBe(bytes.length)
 expect(rebuilt.every((byte, index)=>byte===bytes[index])).toBe(true)
})
it('does not invent a chunk for an empty recorder event',()=>{
 expect(splitVoiceChunk(new Blob([]))).toEqual([])
})
