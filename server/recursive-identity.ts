import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { InstallationInfo, SourceAccess, WorkstreamIdentity } from '../shared/api.ts'

/** Git identity includes linked worktrees, but not unrelated repositories sharing a name or remote. */
export function repositoryIdentity(directory:string):string|null {
  let dir:string
  try{dir=fs.realpathSync(directory)}catch{return null}
  for(;;){
    const dot=path.join(dir,'.git')
    try{
      let git=fs.statSync(dot).isDirectory()?dot:path.resolve(dir,/^gitdir: (.+)\s*$/m.exec(fs.readFileSync(dot,'utf8'))?.[1]?.trim() ?? '')
      if(git===dir)return null
      const common=path.join(git,'commondir')
      if(fs.existsSync(common))git=path.resolve(git,fs.readFileSync(common,'utf8').trim())
      return fs.realpathSync(git)
    }catch{/* Ascend only filesystem parents; never inspect prose or remote URLs. */}
    const parent=path.dirname(dir);if(parent===dir)return null;dir=parent
  }
}
export class InstallationIdentity {
  private identity:string|null
  private cache=new Map<string,{at:number;identity:string|null}>()
  readonly installationId:string
  readonly repositoryDirectory:string|null
  readonly directory:string
  private machineId:string
  constructor(directory:string,machineId:string){
    try{this.directory=fs.realpathSync(directory)}catch{this.directory=path.resolve(directory)}
    this.machineId=machineId;this.identity=repositoryIdentity(directory)
    const candidate=this.identity&&path.basename(this.identity)==='.git'?path.dirname(this.identity):path.resolve(directory)
    this.repositoryDirectory=this.identity&&repositoryIdentity(candidate)===this.identity?candidate:null
    this.installationId=crypto.createHash('sha256').update(machineId+'\0'+(this.identity??this.directory)).digest('hex').slice(0,24)
  }
  info():InstallationInfo {return {id:this.installationId,machineId:this.machineId,source:this.repositoryDirectory?'checkout':'artifact'}}
  /** Recheck filesystem evidence at dispatch; the identity cache must never cache permission grants. */
  access(directory:string):SourceAccess|undefined {
    const source=this.repositoryDirectory
    let actual:string
    try{actual=fs.realpathSync(directory)}catch{actual=path.resolve(directory)}
    if(!this.identity||!source){
      return actual===this.directory||actual.startsWith(this.directory+path.sep)
        ? {repo:null,machineId:this.machineId,canExecute:false,reason:'no-checkout'} : undefined
    }
    const withinSource=actual===source||actual.startsWith(source+path.sep)
    const identity=repositoryIdentity(directory)
    if(identity!==this.identity&&!withinSource)return undefined
    const result=(reason:SourceAccess['reason']):SourceAccess=>({repo:path.basename(source),machineId:this.machineId,canExecute:reason==='owned-writable',reason})
    if(identity!==this.identity||repositoryIdentity(source)!==this.identity)return result('unavailable')
    const uid=process.geteuid?.()
    if(uid===undefined)return result('unavailable')
    try{
      for(const dir of new Set([source,this.identity,actual])){
        const stat=fs.statSync(dir)
        if(!stat.isDirectory())return result('unavailable')
        if(stat.uid!==uid)return result('not-owned')
        // Mode check also keeps root from silently treating a read-only checkout as editable.
        if(!(stat.mode&0o200)||!(stat.mode&0o100))return result('not-writable')
        try{fs.accessSync(dir,fs.constants.W_OK|fs.constants.X_OK)}catch{return result('not-writable')}
      }
      return result('owned-writable')
    }catch{return result('unavailable')}
  }
  classify(directory:string,projectId:string,repo:string|null,evidence:WorkstreamIdentity['evidence']='repository-identity'):WorkstreamIdentity|undefined {
    if(!this.identity||!repo)return undefined
    let cached=this.cache.get(directory)
    if(!cached||Date.now()-cached.at>30000){cached={at:Date.now(),identity:repositoryIdentity(directory)};this.cache.set(directory,cached)}
    return cached.identity===this.identity?{kind:'self-improvement',installationId:this.installationId,target:{machineId:this.machineId,projectId,repo},evidence}:undefined
  }
}
