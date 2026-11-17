import crypto from 'node:crypto'
import { tr } from './i18n.ts'
import M from './i18n/automation-workspaces.ts'
// Local source ownership is separate from runtime/credentials and from the project an automation edits.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface AutomationSoftware {
  id:string; repository:string; revision:string; status:'ready'|'pending-running'; legacyWorkspace:string
  excluded:string[]
}
const atomic=(file:string,value:unknown)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file)}
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','user.name=weevils','-c','user.email=automation@localhost','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15_000}).trim()
/** Stable source IDs; no translated title, absolute private path or user instruction is written to Git. */
export const automationRepoName=(id:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error(tr(M).invalidId);return `auto-${id}`}
const runner=`// Explicit agent step adapter. The scheduler supplies its configured provider command and task parameters.\n// No secrets, schedules, output state or provider defaults belong in source.\nimport {spawn} from 'node:child_process'\nconst split=process.argv.indexOf('--')\nconst command=split>=0?process.argv.slice(split+1):[]\nif(!command.length){console.error('A scheduler-supplied command is required');process.exit(2)}\nconst child=spawn(command[0],command.slice(1),{stdio:'inherit',shell:false})\nfor(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal))\nchild.on('error',error=>{console.error(error.message);process.exitCode=1})\nchild.on('exit',(code,signal)=>{if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal)}else process.exitCode=code??1})\n`

export class AutomationWorkspaces {
  readonly root:string
  constructor(root:string){this.root=root}
  private owned(dir:string,id:string){
    if(fs.existsSync(dir)){
      if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory())throw new Error(tr(M).invalidDirectory)
      const marker=path.join(dir,'.weevils-owner.json')
      if(!fs.existsSync(marker)||JSON.parse(fs.readFileSync(marker,'utf8')).id!==id)throw new Error(tr(M).collision)
    }else{
      fs.mkdirSync(path.dirname(dir),{recursive:true})
      const stage=path.join(path.dirname(dir),'.'+path.basename(dir)+'.provision-'+crypto.randomUUID())
      fs.mkdirSync(stage,{mode:0o700});atomic(path.join(stage,'.weevils-owner.json'),{id})
      try{fs.renameSync(stage,dir)}catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error}
    }
  }
  private commit(dir:string,files:string[],message:string){
    if(!fs.existsSync(path.join(dir,'.git')))git(dir,'init','--template=','--initial-branch=main')
    git(dir,'add','--',...files)
    if(git(dir,'diff','--cached','--name-only','--',...files))git(dir,'commit','--only','-m',message,'--',...files)
    return git(dir,'rev-parse','HEAD')
  }
  /** Resumable provisioning. Existing source is never overwritten; only known, owned paths are changed. */
  adopt(id:string,legacyWorkspace:string,running:boolean,previous?:AutomationSoftware):AutomationSoftware{
    const name=automationRepoName(id)
    fs.mkdirSync(path.dirname(this.root),{recursive:true})
    this.owned(this.root,'weevils-automation-workspace-v1')
    const lock=path.join(this.root,'.provision-lock')
    const candidate=lock+'.'+crypto.randomUUID()
    fs.writeFileSync(candidate,String(process.pid),{mode:0o600,flag:'wx'})
    try{
      try{fs.linkSync(candidate,lock)}catch(e){
        if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e
        const pid=Number(fs.readFileSync(lock,'utf8'))
        if(!Number.isSafeInteger(pid)||pid<1)throw new Error(tr(M).incompleteLock)
        try{process.kill(pid,0);throw new Error(tr(M).busy)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
        fs.unlinkSync(lock);fs.linkSync(candidate,lock)
      }
    }finally{fs.unlinkSync(candidate)}
    try{
      const registry=path.join(this.root,'registry');this.owned(registry,'weevils-automation-registry-v1')
      const dir=path.join(this.root,'projects',name);this.owned(dir,id)
      const manifest=path.join(dir,'automation.json')
      {
        fs.mkdirSync(path.join(dir,'src'),{recursive:true})
        if(!fs.existsSync(manifest))atomic(manifest,{schemaVersion:1,id,kind:'automation',purpose:{configuration:'optimizer',id,fields:['title','why']},entrypoint:'src/run.mjs',steps:[{id:'agent-task',type:'agent',instructions:{configuration:'optimizer',id,field:'prompt'},target:{configuration:'optimizer',id,field:'repo'}}],runtime:{configuration:'installation',state:'outside-source',secrets:'references-only'}})
        if(!fs.existsSync(path.join(dir,'src/run.mjs')))fs.writeFileSync(path.join(dir,'src/run.mjs'),runner)
        if(!fs.existsSync(path.join(dir,'README.md')))fs.writeFileSync(path.join(dir,'README.md'),`# Automation ${id}\n\nAn independently versioned automation software project, adopted from the existing Auto record.\n\nPurpose and task parameters are the title, why and prompt fields of the private local optimizer record with this stable ID. The explicit agent-task step uses the installation provider policy and isolated target workspace. It is an agent workflow, not a hidden cron prompt.\n\nRun: the scheduler invokes node src/run.mjs -- <provider command and arguments>. The adapter forwards its exit status and signals. Never run an unreviewed source version outside the scheduler sandbox.\n\nThe schedule links to this source revision; each run records that revision. Logs, reports, outputs, local paths, credentials and mutable state remain outside this repository. Source changes affect future runs only; select a prior commit to recover an earlier implementation. Existing target project worktrees and history remain intact.\n`)
        if(!fs.existsSync(path.join(dir,'config.example.json')))atomic(path.join(dir,'config.example.json'),{automationId:id,parameters:{title:null,why:null,prompt:null,repo:null},secrets:{}})
        if(!fs.existsSync(path.join(dir,'.gitignore')))fs.writeFileSync(path.join(dir,'.gitignore'),'.weevils-owner.json\n.env*\n*.log\nstate/\noutputs/\nnode_modules/\n')
      }
      if(JSON.parse(fs.readFileSync(manifest,'utf8')).id!==id)throw new Error(tr(M).identity)
      const files=['automation.json','src/run.mjs','README.md','config.example.json','.gitignore']
      const excluded=[...(previous?.excluded??[])]
      // Active working directories are never scanned or edited. Standalone legacy files remain private and
      // referenced by the local binding, avoiding an accidental commit of credentials or render outputs.
      if(!running&&fs.existsSync(legacyWorkspace)&&!previous?.excluded.length)excluded.push('legacy-workspace-retained-outside-git')
      let revision=previous?.revision
      if(!revision){try{revision=git(dir,'rev-parse','--verify','HEAD')}catch{revision=this.commit(dir,files,'chore(auto): adopt automation software source')}}
      fs.mkdirSync(path.join(registry,'automations'),{recursive:true})
      atomic(path.join(registry,'automations',id+'.json'),{schemaVersion:1,id,repository:`../projects/${name}`})
      const readme=path.join(registry,'README.md')
      if(!fs.existsSync(readme))fs.writeFileSync(readme,'# Automation registry\n\nIndependent sibling source repositories. This repository stores identities and relative references only. Runtime configuration, schedules, credentials and run histories stay in private installation storage. No remote is created automatically.\n')
      if(!fs.existsSync(path.join(registry,'.gitignore')))fs.writeFileSync(path.join(registry,'.gitignore'),'.weevils-owner.json\n')
      let initialized=false;try{git(registry,'rev-parse','--verify','HEAD');initialized=true}catch{}
      this.commit(registry,initialized?[`automations/${id}.json`]:['README.md','.gitignore',`automations/${id}.json`],'chore(auto): register automation source')
      return {id,repository:dir,revision,status:running?'pending-running':'ready',legacyWorkspace,excluded}
    }finally{fs.unlinkSync(lock)}
  }
  select(software:AutomationSoftware,revision:string):AutomationSoftware{
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Error(tr(M).revisionRequired)
    const manifest=JSON.parse(git(software.repository,'show',revision+':automation.json'))
    if(manifest.id!==software.id||manifest.entrypoint!=='src/run.mjs')throw new Error(tr(M).contract)
    const selected={...software,revision}
    this.pin(selected)
    return selected
  }
  /** Immutable known revision exported before launch. Git hooks/filters and dirty source are never executed. */
  pin(software:AutomationSoftware):string{
    const head=git(software.repository,'rev-parse',software.revision+'^{commit}')
    if(head!==software.revision)throw new Error(tr(M).revisionMismatch)
    const dir=path.join(this.root,'.versions',software.id,head);this.owned(dir,software.id+'@'+head)
    const files=git(software.repository,'ls-tree','-r','-z',head).split('\0').filter(Boolean)
    if(files.length>500)throw new Error(tr(M).tooLarge)
    let total=0
    for(const entry of files){
      const match=/^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry)
      if(!match)throw new Error(tr(M).unsafeFiles)
      const rel=match[2]
      if(path.isAbsolute(rel)||rel.split('/').some(p=>p==='..'||p==='.git'||p.startsWith('.env')))throw new Error(tr(M).invalidPath)
      const data=execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',software.repository,'show',head+':'+rel],{stdio:['ignore','pipe','pipe'],timeout:15_000,maxBuffer:20<<20})
      total+=data.length;if(total>20<<20)throw new Error(tr(M).tooLarge)
      const file=path.join(dir,rel)
      fs.mkdirSync(path.dirname(file),{recursive:true})
      if(fs.existsSync(file)&&!fs.readFileSync(file).equals(data))throw new Error(tr(M).pinnedChanged)
      if(!fs.existsSync(file))fs.writeFileSync(file,data,{mode:match[1]==='100755'?0o500:0o400})
    }
    const file=path.join(dir,'src/run.mjs')
    if(!fs.existsSync(file))throw new Error(tr(M).entrypoint)
    return file
  }
}

/** Repository discovery includes only this product-owned workspace, never arbitrary nested Git trees. */
export function automationSourceRoot(projectRoot:string):string|undefined{
  const workspace=path.join(projectRoot,'automations')
  try{if(JSON.parse(fs.readFileSync(path.join(workspace,'.weevils-owner.json'),'utf8')).id==='weevils-automation-workspace-v1')return path.join(workspace,'projects')}catch{}
  return undefined
}
