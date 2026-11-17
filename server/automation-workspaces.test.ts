import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {expect,it,afterEach} from 'vitest'
import {AutomationWorkspaces,automationSourceRoot} from './automation-workspaces.ts'
import {place} from './projects.ts'
const dirs:string[]=[]
const fixture=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-source-'));dirs.push(dir);return {dir,manager:new AutomationWorkspaces(path.join(dir,'automations'))}}
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})})
it('creates independent versioned source and registry exactly once without nested Git or copying private input',()=>{
 const {dir,manager}=fixture();const legacy=path.join(dir,'legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'.env'),'TOKEN=private-sentinel');fs.writeFileSync(path.join(legacy,'source.js'),'console.log("legacy")')
 const a=manager.adopt('a',legacy,false);const b=manager.adopt('a',legacy,false,a)
 expect(b.revision).toBe(a.revision);expect(fs.existsSync(path.join(manager.root,'.git'))).toBe(false)
 expect(fs.existsSync(path.join(a.repository,'.git'))).toBe(true)
 expect(fs.existsSync(path.join(manager.root,'registry','.git'))).toBe(true)
 const tree=execFileSync('git',['-C',a.repository,'show','HEAD:automation.json'],{encoding:'utf8'});expect(tree).toContain('agent-task');expect(tree).not.toContain('private-sentinel')
 expect(fs.readFileSync(path.join(legacy,'.env'),'utf8')).toBe('TOKEN=private-sentinel')
 expect(a.excluded).toContain('legacy-workspace-retained-outside-git');expect(execFileSync('git',['-C',a.repository,'remote'],{encoding:'utf8'})).toBe('')
 expect(automationSourceRoot(dir)).toBe(path.join(manager.root,'projects'))
 expect(place(a.repository,[dir]).projectId).toBe('auto-a')
 const other=manager.adopt('b',path.join(dir,'none'),false);expect(place(other.repository,[dir]).projectId).toBe('auto-b')
})
it('defers adoption of a running workspace and pins a runnable source revision without executing dirty edits',()=>{
 const {dir,manager}=fixture();const legacy=path.join(dir,'legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'in-progress'),'keep')
 const running=manager.adopt('a',legacy,true);expect(running.status).toBe('pending-running');expect(running.excluded).toEqual([])
 expect(fs.readFileSync(path.join(legacy,'in-progress'),'utf8')).toBe('keep')
 const ready=manager.adopt('a',legacy,false,running);expect(ready.status).toBe('ready')
 fs.writeFileSync(path.join(ready.repository,'src/run.mjs'),'throw new Error("dirty source must not execute")')
 const runner=manager.pin(ready)
 expect(execFileSync('node',[runner,'--',process.execPath,'-e','process.stdout.write("real result")'],{encoding:'utf8'})).toBe('real result')
 expect(()=>execFileSync('node',[runner,'--',process.execPath,'-e','process.exit(7)'],{stdio:'pipe'})).toThrow()
})
it('fails closed on occupied paths and resumes after a recorded source commit without duplicating repositories',()=>{
 const {manager}=fixture();fs.mkdirSync(manager.root);fs.writeFileSync(path.join(manager.root,'unowned'),'keep')
 expect(()=>manager.adopt('a','none',false)).toThrow('collision');expect(fs.readFileSync(path.join(manager.root,'unowned'),'utf8')).toBe('keep')
 fs.rmSync(manager.root,{recursive:true});const a=manager.adopt('a','none',false)
 fs.rmSync(path.join(manager.root,'registry','automations','a.json'))
 const retry=manager.adopt('a','none',false,a);expect(retry.revision).toBe(a.revision)
 expect(fs.readdirSync(path.join(manager.root,'projects'))).toEqual(['auto-a'])
 expect(()=>manager.adopt('../escape','none',false)).toThrow('Invalid automation ID')
})
it('promotes only a committed compatible revision and preserves an already pinned old implementation',()=>{
 const {dir,manager}=fixture();const first=manager.adopt('a',path.join(dir,'legacy'),false)
 const old=manager.pin(first)
 fs.writeFileSync(path.join(first.repository,'src/run.mjs'),'process.stdout.write("new implementation")\n')
 const args=['-C',first.repository,'-c','user.name=test','-c','user.email=test@localhost','-c','commit.gpgSign=false']
 execFileSync('git',[...args,'add','src/run.mjs']);execFileSync('git',[...args,'commit','-m','Upgrade runner'],{stdio:'pipe'})
 const revision=execFileSync('git',[...args,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
 const next=manager.select(first,revision)
 expect(execFileSync('node',[manager.pin(next)],{encoding:'utf8'})).toBe('new implementation')
 expect(execFileSync('node',[old,'--',process.execPath,'-e','process.stdout.write("old implementation")'],{encoding:'utf8'})).toBe('old implementation')
 expect(manager.select(next,first.revision).revision).toBe(first.revision)
 expect(()=>manager.select(first,'HEAD')).toThrow('full committed')
})

it('recovers a completed lock record from a crashed provisioning process',()=>{
 const {manager}=fixture();manager.adopt('a','none',false)
 fs.writeFileSync(path.join(manager.root,'.provision-lock'),'2147483647')
 expect(manager.adopt('b','none',false).status).toBe('ready')
 expect(fs.existsSync(path.join(manager.root,'.provision-lock'))).toBe(false)
})

it('completes missing scaffold files after interruption without overwriting an existing source file',()=>{
 const {manager}=fixture();const a=manager.adopt('a','none',false)
 fs.rmSync(path.join(a.repository,'config.example.json'))
 fs.writeFileSync(path.join(a.repository,'src/run.mjs'),'// user edit preserved')
 const retry=manager.adopt('a','none',false)
 expect(retry.revision).toBe(a.revision)
 expect(fs.existsSync(path.join(a.repository,'config.example.json'))).toBe(true)
 expect(fs.readFileSync(path.join(a.repository,'src/run.mjs'),'utf8')).toBe('// user edit preserved')
})

it('does not commit unrelated user-staged registry files while adopting another automation',()=>{
 const {manager}=fixture();manager.adopt('a','none',false)
 const registry=path.join(manager.root,'registry');fs.writeFileSync(path.join(registry,'private-user-file'),'keep staged, not committed')
 execFileSync('git',['-C',registry,'add','private-user-file'])
 manager.adopt('b','none',false)
 expect(execFileSync('git',['-C',registry,'diff','--cached','--name-only'],{encoding:'utf8'})).toContain('private-user-file')
 expect(execFileSync('git',['-C',registry,'ls-tree','-r','--name-only','HEAD'],{encoding:'utf8'})).not.toContain('private-user-file')
})
