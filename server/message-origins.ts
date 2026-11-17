// Approved repairs key exact target IDs. Prose is only an integrity guard, never an author classifier.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Message } from '../shared/api.ts'
export interface RecordedOrigin {
  threadId:string; messageId:string; sourceThreadId:string; sourceCallId:string
  author:'codex'|'claude'|'weevboss'|'agent'; textHash:string; verifiedAt:number; evidence:'recorded-helper-dispatch'
}
export const originTextHash=(text:string)=>crypto.createHash('sha256').update(text.trim()).digest('hex')
const valid=(x:RecordedOrigin)=>x && ['threadId','messageId','sourceThreadId','sourceCallId'].every(k=>typeof x[k as keyof RecordedOrigin]==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(String(x[k as keyof RecordedOrigin]))) && ['codex','claude','weevboss','agent'].includes(x.author) && /^[a-f0-9]{64}$/.test(x.textHash) && Number.isFinite(x.verifiedAt) && x.evidence==='recorded-helper-dispatch'
const key=(thread:string,message:string)=>thread+':'+message
export class MessageOrigins {
  readonly file:string
  private stamp=''
  private entries=new Map<string,RecordedOrigin>()
  constructor(file:string){this.file=file}
  private refresh(){
    try{
      const stat=fs.statSync(this.file),stamp=`${stat.ino}:${stat.mtimeMs}:${stat.size}`
      if(stamp===this.stamp)return
      this.stamp=stamp
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'))
      this.entries=new Map(data.version===1&&Array.isArray(data.entries)?data.entries.filter(valid).map((e:RecordedOrigin)=>[key(e.threadId,e.messageId),e]):[])
    }catch{this.stamp='';this.entries.clear()}
  }
  snapshot(){this.refresh();return (threadId:string,message:Message)=>this.find(threadId,message)}
  private find(threadId:string,message:Message):RecordedOrigin|undefined{
    const entry=this.entries.get(key(threadId,message.id))
    return message.role==='user' && entry?.textHash===originTextHash(message.text) ? entry : undefined
  }
  /** Local owner operation after checking the recorded outgoing call; no HTTP author-claim endpoint. */
  record(entry:RecordedOrigin){
    if(!valid(entry))throw new TypeError('Invalid recorded message origin') // i18n-ignore: local administrative schema error
    this.refresh()
    if(fs.existsSync(this.file)){
      const old=JSON.parse(fs.readFileSync(this.file,'utf8'))
      if(old.version!==1||!Array.isArray(old.entries)||!old.entries.every(valid))throw new TypeError('Invalid origin registry') // i18n-ignore: local administrative schema error
    }
    this.entries.set(key(entry.threadId,entry.messageId),entry)
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700})
    fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,entries:[...this.entries.values()]},null,2),{mode:0o600})
    fs.renameSync(this.file+'.tmp',this.file);this.stamp=''
  }
}
