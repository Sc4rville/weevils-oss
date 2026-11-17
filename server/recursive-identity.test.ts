import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach,expect,it,vi } from 'vitest'
import { InstallationIdentity } from './recursive-identity.ts'
const dirs:string[]=[]
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})})
it('uses canonical Git identity across renamed installations/worktrees, not project words or a matching remote',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wv-recursive-'));dirs.push(root)
 const app=path.join(root,'renamed-app'),other=path.join(root,'weevils'),tree=path.join(root,'linked')
 const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,stdio:'pipe'})
 fs.mkdirSync(app);fs.mkdirSync(other)
 for(const dir of [app,other]){git(dir,'init');git(dir,'remote','add','origin','https://example.invalid/shared.git')}
 git(app,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','base')
 git(app,'worktree','add','-b','test-tree',tree)
 const identity=new InstallationIdentity(app,'machine-a')
 expect(identity.classify(tree,'actual-project','renamed-app')).toMatchObject({kind:'self-improvement',evidence:'repository-identity',target:{machineId:'machine-a'}})
 expect(identity.classify(other,'weevils','weevils')).toBeUndefined()
 expect(identity.classify(other,'tlo','tlo')).toBeUndefined()
 expect(identity.classify(app,'actual-project','renamed-app','automation-target')?.evidence).toBe('automation-target')
 expect(new InstallationIdentity(app,'machine-b').installationId).not.toBe(identity.installationId)
 expect(new InstallationIdentity(tree,'machine-a').installationId).toBe(identity.installationId)
 expect(identity.classify(app,'actual-project',null)).toBeUndefined()
 expect(identity.access(tree)).toMatchObject({canExecute:true,reason:'owned-writable',repo:'renamed-app'})
 expect(identity.access(other)).toBeUndefined()
 // Permissions change without invalidating identity or restarting the daemon.
 fs.chmodSync(path.join(app,'.git'),0o500)
 expect(identity.access(tree)).toMatchObject({canExecute:false,reason:'not-writable'})
 expect(identity.classify(tree,'actual-project','renamed-app')).toBeDefined()
 fs.chmodSync(path.join(app,'.git'),0o700)
 expect(identity.access(tree)?.canExecute).toBe(true)
 const stat=fs.statSync.bind(fs)
 vi.spyOn(fs,'statSync').mockImplementation(((file:any,options:any)=>{
   const s=stat(file,options)
   return String(file)===app?Object.assign(s,{uid:(process.geteuid?.()??0)+1}):s
 }) as any)
 expect(identity.access(tree)).toMatchObject({canExecute:false,reason:'not-owned'})
 vi.restoreAllMocks()
 fs.renameSync(path.join(app,'.git'),path.join(app,'.git-missing'))
 expect(identity.access(app)).toMatchObject({canExecute:false,reason:'unavailable'})
})
it('fails closed without repository evidence, including a familiar directory name',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weevils-'));dirs.push(root)
 expect(new InstallationIdentity(root,'machine').classify(root,'weevils','weevils')).toBeUndefined()
 expect(new InstallationIdentity(root,'machine').access(root)).toEqual({repo:null,machineId:'machine',canExecute:false,reason:'no-checkout'})
 expect(new InstallationIdentity(root,'machine').info()).toMatchObject({source:'artifact',machineId:'machine'})
 expect(new InstallationIdentity(root,'machine').access(path.dirname(root))).toBeUndefined()
})
