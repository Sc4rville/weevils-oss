import fs from 'node:fs'
import path from 'node:path'
import { emptyBoard,validateBoard,type ThinkBoard } from '../shared/think.ts'
/** One authoritative writer per installation. CAS prevents a stale tab from overwriting another tab. */
export class ThinkStore {
 private file: string
 constructor(file: string) { this.file=file }
 read(): ThinkBoard {
  try { const b=JSON.parse(fs.readFileSync(this.file,'utf8'));validateBoard(b);return b }
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return emptyBoard();throw e}
 }
 write(input:unknown): ThinkBoard | null {
  validateBoard(input);const current=this.read();if(input.revision!==current.revision)return null
  const next={...input,revision:current.revision+1};const dir=path.dirname(this.file)
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  const temp=this.file+'.tmp';const fd=fs.openSync(temp,'w',0o600)
  try{fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(temp,this.file);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
  return next
 }
}
